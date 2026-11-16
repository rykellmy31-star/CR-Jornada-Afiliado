import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {addMonitorGroup,saveMonitorSettings,ingestMonitorEvent,ensureMonitor,
 recoverMissingMonitorPrices,refreshMonitorSitePrices,monitorPriceDeepScanStats}
 from '../src/whatsapp-link-monitor.js';
import {groupCopyState,selectGroupCopyPrice} from '../src/group-copy.js';

const PRODUCT='https://www.mercadolivre.com.br/furadeira-profissional/p/MLB12345678';
const GROUP='120363000111222333@g.us';
const INSTANCE='cr-jornada-afiliados';
const now=()=>Math.floor(Date.now()/1000);
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){
  let args=[];return {bind(...p){args=p;return this;},
   first(){return db.prepare(sql).get(...args)||null;},
   all(){return {results:db.prepare(sql).all(...args)};},
   run(){const r=db.prepare(sql).run(...args);
    return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}}
 },async batch(commands){
  db.exec('BEGIN');try{const r=commands.map(c=>c.run());db.exec('COMMIT');return r;}
  catch(e){db.exec('ROLLBACK');throw e;}
 }};
 const env={DB,MONITOR_WEBHOOK_TOKEN:'backfill-test-webhook-token-123456',
  EVOLUTION_API_URL:'https://evolution.example.com',EVOLUTION_API_KEY:'test-key'};
 return {env,DB,close:()=>db.close()};
}
const webhook=(text,id='PRICE-HISTORY-01')=>({
 event:'messages.upsert',instance:INSTANCE,
 data:{key:{remoteJid:GROUP,id,fromMe:false},message:{imageMessage:{caption:text}}}
});
async function seeded(env,caption,id){
 await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo autorizado',permission_confirmed:true});
 await saveMonitorSettings(env,{enabled:true});
 await ingestMonitorEvent(env,webhook(caption,id));
 env.DB.prepare("UPDATE ml_monitor_links SET category='Ferramentas',classification='keywords'").run();
}
function official(id='MLB12345678',price=79.9){
 return Response.json({id,currency_id:'BRL',price});
}
test('busca mensagem histórica antiga na Evolution sem limite de 2 dias nem 3 tentativas permanentes',async()=>{
 const {env,DB,close}=setup(),old=globalThis.fetch;
 try{
  await seeded(env,'Furadeira em oferta '+PRODUCT,'HISTORICAL-PRICE-1');
  const oldAt=now()-10*86400;
  DB.prepare('UPDATE ml_monitor_links SET created_at=?').bind(oldAt).run();
  DB.prepare('UPDATE ml_monitor_product_meta SET last_seen_price_cents=NULL,last_seen_deal_json=NULL,last_seen_at=?')
   .bind(oldAt).run();
  DB.prepare("INSERT INTO ml_monitor_price_recovery(product_id,last_attempt_at,attempts) VALUES('MLB12345678',?,5)")
   .bind(now()-7*3600).run();
  let requested=0;
  globalThis.fetch=async(url,options)=>{
   requested++;
   assert.match(String(url),/\/chat\/findMessages\/cr-jornada-afiliados$/);
   assert.equal(JSON.parse(options.body).where.key.id,'HISTORICAL-PRICE-1');
   return Response.json({messages:{records:[{
    key:{remoteJid:GROUP,id:'HISTORICAL-PRICE-1',fromMe:false},
    message:{imageMessage:{caption:'De: R$ 149,90 Por: R$ 79,90 '+PRODUCT+'?utm_source=grupo'}}
   }]}});
  };
  const recovered=await recoverMissingMonitorPrices(env,{allowEvolution:true,limit:4});
  assert.equal(recovered.recovered,1);
  assert.equal(requested,1);
  const data=DB.prepare('SELECT last_seen_price_cents,last_seen_at,last_seen_deal_json FROM ml_monitor_product_meta').first();
  assert.equal(data.last_seen_price_cents,7990);
  assert.equal(data.last_seen_at,oldAt,'oferta antiga não deve parecer que foi vista hoje');
  assert.equal(JSON.parse(data.last_seen_deal_json).old_price_cents,14990);
  assert.equal(selectGroupCopyPrice({message_id:'HISTORICAL-PRICE-1',
   group_price_cents:7990,group_deal_json:data.last_seen_deal_json,
   group_checked_at:data.last_seen_at},now()),null,'preço antigo não pode entrar na fila');
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{globalThis.fetch=old;close();}
});
test('varredura profunda consulta API oficial de preço antigo e registra nova tentativa sem inventar valores',async()=>{
 const {env,DB,close}=setup();
 try{
  await seeded(env,'Promo furadeira '+PRODUCT);
  const old=now()-10*86400;
  DB.prepare('UPDATE ml_monitor_links SET created_at=?').bind(old).run();
  let calls=0;
  const fetcher=async(url)=>{
   calls++;
   if(String(url)==='https://api.mercadolibre.com/items/MLB12345678')return official();
   throw Error('Não chamar outras fontes se a API confirmou o produto');
  };
  const scanned=await refreshMonitorSitePrices(env,{fetcher,limit:3,deepScan:true});
  assert.deepEqual(scanned,{checked:1,found:1});
  assert.equal(calls,1,'API pública verificada primeiro, sem consultas desnecessárias');
  const meta=DB.prepare("SELECT status,price_cents,method FROM ml_monitor_site_prices WHERE product_id='MLB12345678'").first();
  assert.equal(meta.status,'ok');
  assert.equal(meta.price_cents,7990);
  assert.equal(meta.method,'api.mercadolibre.com');
  const state=await groupCopyState(env);
  assert.equal(state.readiness.needs_price,0);
  assert.equal(state.readiness.with_price,1);
  const stats=await monitorPriceDeepScanStats(env);
  assert.equal(stats.checked,1);
  assert.equal(stats.confirmed,1);
  assert.deepEqual(await refreshMonitorSitePrices(env,{fetcher,deepScan:true}),{checked:0,found:0},
   'não consultar novamente o mesmo produto antes da próxima janela');
 }finally{close();}
});
test('API com ID errado ou sem resposta mantém produto pendente com backoff, não cria preço falso',async()=>{
 const {env,DB,close}=setup();
 try{
  await seeded(env,'Furadeira '+PRODUCT);
  const fetcher=async url=>{
   if(String(url).includes('api.mercadolibre.com'))return official('MLB99999999');
   return new Response('sem preço',{status:403});
  };
  const a=await refreshMonitorSitePrices(env,{fetcher,deepScan:true});
  assert.deepEqual(a,{checked:1,found:0});
  assert.equal(DB.prepare("SELECT price_cents FROM ml_monitor_site_prices").first().price_cents,null);
  assert.equal((await monitorPriceDeepScanStats(env)).awaiting_retry,1);
  assert.deepEqual(await refreshMonitorSitePrices(env,{fetcher,deepScan:true}),{checked:0,found:0});
  assert.equal((await groupCopyState(env)).readiness.needs_price,1);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{close();}
});
test('mensagem duplicada sem preço não apaga preço antigo e contador não acusa falta quando o grupo informou valor recente',async()=>{
 const {env,DB,close}=setup();
 try{
  await seeded(env,'De: R$ 149,90 Por: R$ 79,90 '+PRODUCT);
  const at=now()-75;
  DB.prepare('UPDATE ml_monitor_product_meta SET last_seen_at=?').bind(at).run();
  await ingestMonitorEvent(env,webhook('Um novo link para furadeira '+PRODUCT,'NO-PRICE-REPOST'));
  const price=DB.prepare('SELECT last_seen_price_cents,last_seen_at FROM ml_monitor_product_meta').first();
  assert.equal(price.last_seen_price_cents,7990);
  assert.equal(price.last_seen_at,at);
  const state=await groupCopyState(env);
  assert.equal(state.readiness.needs_price,0,'não deve exigir preço público se há preço de grupo recente');
  assert.equal(state.readiness.with_group_price,1);
  assert.equal(state.readiness.with_price,1);
 }finally{close();}
});
