import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureMonitor,refreshMonitorSitePrices} from '../src/whatsapp-link-monitor.js';
import {groupCopyState} from '../src/group-copy.js';

const GROUP='120363000111222333@g.us',INSTANCE='cr-jornada-afiliados';
const PRODUCT='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
const OTHER='https://www.mercadolivre.com.br/kit-de-ferramentas/p/MLB87654321';
const SHORT='https://meli.la/2XzEMvr';
const SOCIAL='https://www.mercadolivre.com.br/social/amigo?matt_word=amigo&matt_tool=999999&ref=EXAMPLE';
function featured(url=PRODUCT){
 return '<div class="rl-card-featured-wrapper"><div class="poly-card">'+
 '<a class="poly-component__title" href="'+url+'">Furadeira de impacto</a>'+
 '<div class="poly-component__price"><div class="poly-price__current">'+
 '<span class="andes-money-amount__currency-symbol">R$</span><span class="andes-money-amount__fraction">211</span>'+
 '<span class="andes-money-amount__cents">07</span></div></div>'+
 '<a class="poly-component__link--action-link" href="'+url+'">Ir para produto</a></div></div>';
}
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){let args=[];return {bind(...a){args=a;return this;},
  first(){return db.prepare(sql).get(...args)||null;},
  all(){return {results:db.prepare(sql).all(...args)};},
  run(){const v=db.prepare(sql).run(...args);return {meta:{changes:Number(v.changes),last_row_id:Number(v.lastInsertRowid)}};}}
 },async batch(ops){db.exec('BEGIN');try{const ret=ops.map(o=>o.run());db.exec('COMMIT');return ret;}catch(error){db.exec('ROLLBACK');throw error;}}};
 return {db,env:{DB}};
}
async function seed(env){
 await ensureMonitor(env);
 env.DB.prepare("INSERT INTO ml_monitor_groups(instance_name,group_jid,group_name,enabled,authorized,created_at) VALUES(?,?,?,?,1,?)")
  .bind(INSTANCE,GROUP,'Grupo de testes',1,1000).run();
 env.DB.prepare("INSERT INTO ml_monitor_links(group_id,message_id,product_id,source_url,title,category,classification,status,created_at) VALUES(1,'MSG123','MLB12345678',?,'Furadeira de impacto profissional','Ferramentas e Peças Automotivas','selected','available',1000)").bind(PRODUCT).run();
 env.DB.prepare("INSERT INTO ml_monitor_shortlinks(group_id,message_id,short_url,message_hint,status,created_at) VALUES(1,'MSG123',?,'Furadeira de impacto','resolved',1000)")
 .bind(SHORT).run();
}
function mockedFetch(u){
 const s=String(u);
 if(s===SHORT)return new Response(null,{status:302,headers:{location:SOCIAL}});
 if(s===SOCIAL)return new Response(featured(),{status:200,headers:{'content-type':'text/html;charset=utf-8'}});
 return new Response('Forbidden',{status:403});
}
test('se página do produto e API não respondem, usa preço do produto principal da vitrine oficial verificada',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  const result=await refreshMonitorSitePrices(env,{fetcher:mockedFetch});
  assert.deepEqual(result,{checked:1,found:1});
  const site=env.DB.prepare("SELECT price_cents,status,method FROM ml_monitor_site_prices WHERE product_id='MLB12345678'").first();
  assert.equal(site.price_cents,21107);
  assert.equal(site.status,'ok');
  assert.match(site.method,/vitrine oficial/);
  const state=await groupCopyState(env);
  assert.equal(state.readiness.with_price,1);
 }finally{db.close();}
});
test('nunca aceita preço de produto diferente destacado em vitrine de outro afiliado',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  const fetcher=(u)=>{
   const s=String(u);
   if(s===SHORT)return new Response(null,{status:302,headers:{location:SOCIAL}});
   if(s===SOCIAL)return new Response(featured(OTHER),{status:200,headers:{'content-type':'text/html'}});
   return new Response('Forbidden',{status:403});
  };
  const result=await refreshMonitorSitePrices(env,{fetcher});
  assert.deepEqual(result,{checked:1,found:0});
  const entry=env.DB.prepare("SELECT status,price_cents FROM ml_monitor_site_prices WHERE product_id='MLB12345678'").first();
  assert.equal(entry.status,'unavailable');
  assert.equal(entry.price_cents,null);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{db.close();}
});
