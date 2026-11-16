import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureMonitor,refreshMonitorSitePrices} from '../src/whatsapp-link-monitor.js';
import {groupCopyState} from '../src/group-copy.js';
import {renderPage,CLIENT_JS} from '../src/ui.js';
import worker from '../src/index.js';

const PRODUCT='https://www.mercadolivre.com.br/furadeira-profissional/p/MLB12345678';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){
  let args=[];
  return {bind(...values){args=values;return this;},
   first(){return db.prepare(sql).get(...args)||null;},
   all(){return {results:db.prepare(sql).all(...args)};},
   run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}}
 },async batch(ops){db.exec('BEGIN');try{const out=ops.map(op=>op.run());db.exec('COMMIT');return out;}catch(error){db.exec('ROLLBACK');throw error;}}};
 return {env:{DB,SESSION_SECRET:'local testing secret',ADMIN_PASSWORD:'local test password'},db};
}
async function insert(env,{id='MLB12345678',category='Ferramentas e Peças Automotivas',classification='keywords'}={}){
 await ensureMonitor(env);
 env.DB.prepare("INSERT OR IGNORE INTO ml_monitor_groups(instance_name,group_jid,group_name,enabled,authorized,created_at) VALUES('cr-jornada-afiliados','120363000111222333@g.us','Grupo autorizado',1,1,1000)").run();
 const u='https://www.mercadolivre.com.br/furadeira-profissional/p/'+id;
 env.DB.prepare("INSERT INTO ml_monitor_links(group_id,product_id,source_url,title,category,classification,status,created_at) VALUES(1,?,?,?,?,?,'available',1000)")
  .bind(id,u,'Furadeira profissional',category,classification).run();
}
function asJSON(id='MLB12345678',price=4990){
 return new Response(JSON.stringify({id,price:price/100,original_price:null,currency_id:'BRL'}),{
  status:200,headers:{'content-type':'application/json;charset=utf-8'}
 });
}
test('verificação de preço usa API oficial quando o HTML bloqueia, sem inventar dados',async()=>{
 const {env,db}=fixture();
 try{
  await insert(env);
  const visited=[];
  const fetcher=async url=>{
   visited.push(String(url));
   return String(url).startsWith('https://api.mercadolibre.com/items/')?
    asJSON():new Response('Bloqueado',{status:403});
  };
  const result=await refreshMonitorSitePrices(env,{fetcher,limit:2});
  assert.deepEqual(result,{checked:1,found:1});
  assert.ok(visited.some(x=>x.startsWith('https://api.mercadolibre.com/items/MLB12345678')));
  const price=env.DB.prepare("SELECT price_cents,status,method FROM ml_monitor_site_prices WHERE product_id='MLB12345678'").first();
  assert.equal(price.price_cents,4990);
  assert.equal(price.status,'ok');
  assert.equal(price.method,'api.mercadolibre.com');
  const state=await groupCopyState(env);
  assert.equal(state.readiness.with_price,1);
  assert.equal(state.readiness.needs_price,0);
  assert.equal(state.official_categories.waiting,state.readiness.needs_category);
 }finally{db.close();}
});
test('sem preço confirmado o robô não publica e mostra o motivo correto',async()=>{
 const {env,db}=fixture();
 try{
  await insert(env);
  const blocked=async()=>new Response('Acesso limitado',{status:403});
  const res=await refreshMonitorSitePrices(env,{fetcher:blocked});
  assert.deepEqual(res,{checked:1,found:0});
  let state=await groupCopyState(env);
  assert.equal(state.readiness.needs_price,1);
  assert.equal(state.readiness.price_lookup_failed,1);
  assert.equal(state.readiness.with_price,0);
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS total FROM offers").first().total,0);
  // Reconsulta manual obedece intervalo mínimo de 90 segundos para proteger a API.
  assert.deepEqual(await refreshMonitorSitePrices(env,{fetcher:async()=>asJSON(),forceRetry:true}),{checked:0,found:0});
  env.DB.prepare("UPDATE ml_monitor_site_prices SET checked_at=? WHERE product_id='MLB12345678'").bind(Math.floor(Date.now()/1000)-100).run();
  const allowed=await refreshMonitorSitePrices(env,{
   forceRetry:true,fetcher:async url=>String(url).includes('api.mercadolibre.com/items/')?
    asJSON():new Response('Indisponível',{status:403})
  });
  assert.equal(allowed.found,1);
  state=await groupCopyState(env);
  assert.equal(state.readiness.price_lookup_failed,0);
  assert.equal(state.readiness.with_price,1);
 }finally{db.close();}
});
test('API pública com outro item ou outra moeda não gera preço falso',async()=>{
 const {env,db}=fixture();
 try{
  await insert(env);
  const mismatched=await refreshMonitorSitePrices(env,{fetcher:async url=>
   String(url).includes('api.mercadolibre.com')?asJSON('MLB99999999'):new Response('erro',{status:403})});
  assert.equal(mismatched.found,0);
  assert.equal(env.DB.prepare("SELECT price_cents FROM ml_monitor_site_prices WHERE product_id='MLB12345678'").first().price_cents,null);
 }finally{db.close();}
});
test('botão de preços existe no painel e rota continua protegida por sessão',async()=>{
 const page=renderPage();
 assert.match(page,/id="copy-groups-price-check"/);
 assert.match(CLIENT_JS,/\/api\/copy-groups\/prices/);
 const {env,db}=fixture();
 try{
  const res=await worker.fetch(new Request('https://bot.crjornada.com/api/copy-groups/prices',{
   method:'POST',headers:{origin:'https://bot.crjornada.com','content-type':'application/json'},body:'{}'
  }),env);
  assert.equal(res.status,401);
 }finally{db.close();}
});
