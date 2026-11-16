import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureMonitor,addMonitorGroup,saveMonitorSettings,ingestMonitorEvent,prepareMonitorBatch,refreshMonitorSitePrices} from '../src/whatsapp-link-monitor.js';
import {connectAffiliateStore} from '../src/affiliate-stores.js';
import {groupCopyState,saveGroupCopySettings,runGroupCopyScheduled} from '../src/group-copy.js';
import {queueBackgroundReview} from '../src/monitor-background-review.js';
import {CLIENT_JS,renderPage} from '../src/ui.js';

const GROUP='120363000111222333@g.us',INSTANCE='cr-jornada-afiliados';
const PRODUCT1='https://www.mercadolivre.com.br/furadeira-impacto/p/MLB12345678';
const PRODUCT2='https://www.mercadolivre.com.br/furadeira-profissional/p/MLB12345679';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){let args=[];return {bind(...vals){args=vals;return this;},
  first(){return db.prepare(sql).get(...args)||null;},
  all(){return {results:db.prepare(sql).all(...args)};},
  run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}}
 },async batch(ops){db.exec('BEGIN');try{const out=ops.map(o=>o.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const env={DB,MONITOR_WEBHOOK_TOKEN:'valid-test-monitor-token-1234567890',SESSION_SECRET:'test-secret-at-least-32-bytes-long'};
 return {env,db};
}
async function seed(env,n=1){
 await ensureMonitor(env);
 await connectAffiliateStore(env,{official_url:'https://meli.la/2XzEMvr'},async()=>
  new Response(null,{status:302,headers:{location:'https://www.mercadolivre.com.br/social/rykellmy_007?matt_word=rykellmy_007&matt_tool=33321398&ref=example'}}));
 await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo autorizado',permission_confirmed:true});
 await saveMonitorSettings(env,{enabled:true});
 for(const [idx,url] of [PRODUCT1,PRODUCT2].slice(0,n).entries()){
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:INSTANCE,data:{
    key:{remoteJid:GROUP,fromMe:false,id:'msg-'+idx},message:{conversation:'Furadeira profissional em oferta '+url}
  }});
 }
 env.DB.prepare("UPDATE ml_monitor_links SET category='Ferramentas e Peças Automotivas',classification='selected'").run();
}
test('capturados nunca desaparecem: fluxo manual existente aparece em importação automática e volta a ter preço',async()=>{
 const {env,db}=fixture();
 try{
  await seed(env);
  const batch=await prepareMonitorBatch(env,{automatic:true});
  assert.equal(batch.batch.status,'awaiting_links');
  const old=await groupCopyState(env);
  assert.equal(old.total_identified,1);
  assert.equal(old.waiting,1);
  assert.equal(old.awaiting_manual_batch,1);
  assert.equal(old.readiness.needs_price,1);
  await saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true});
  const response=(url)=>new Response('<link rel="canonical" href="'+PRODUCT1+'"><script type="application/ld+json">'+
    JSON.stringify({'@type':'Product',url:PRODUCT1,offers:{price:'49.90',priceCurrency:'BRL'}})+'</script>',
   {status:200,headers:{'content-type':'text/html'}});
  const r=await refreshMonitorSitePrices(env,{fetcher:response,limit:3});
  assert.deepEqual(r,{checked:1,found:1});
  const next=await groupCopyState(env);
  assert.equal(next.readiness.with_price,1);
  const result=await runGroupCopyScheduled(env);
  assert.equal(result.queued,1,JSON.stringify(result));
  const original=env.DB.prepare('SELECT * FROM ml_link_batches WHERE id=?').bind(batch.batch.id).first();
  assert.equal(original.status,'imported');
  const legacy=env.DB.prepare('SELECT status,affiliate_url,offer_id FROM ml_link_batch_items WHERE batch_id=?').bind(batch.batch.id).first();
  assert.equal(legacy.status,'queued');
  assert.match(legacy.affiliate_url,/matt_word=rykellmy_007/);
  assert.equal(Number(legacy.offer_id),Number(result.offer_id));
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,1);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM ml_link_batches').first().n,1,'não cria segundo lote para o mesmo produto');
  const after=await groupCopyState(env);
  assert.equal(after.total_identified,1);
  assert.equal(after.awaiting_manual_batch,0);
  assert.equal(after.queued_count,1);
  assert.equal(after.waiting,0);
  assert.equal((await runGroupCopyScheduled(env)).queued,undefined);
 }finally{db.close();}
});
test('um lote de dois produtos é processado gradualmente sem perder a segunda oferta sem preço',async()=>{
 const {env,db}=fixture();
 try{
  await seed(env,2);
  const batch=await prepareMonitorBatch(env,{automatic:true});
  await saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true});
  const t=Math.floor(Date.now()/1000);
  env.DB.prepare("INSERT INTO ml_monitor_site_prices(product_id,price_cents,status,checked_at,tries,method) VALUES('MLB12345678',4990,'ok',?,0,'test')")
   .bind(t).run();
  let res=await runGroupCopyScheduled(env);
  assert.equal(res.queued,1,JSON.stringify(res));
  const mids=env.DB.prepare('SELECT status FROM ml_link_batch_items WHERE batch_id=? ORDER BY id').bind(batch.batch.id).all().results.map(x=>x.status);
  assert.deepEqual(mids,['queued','awaiting_links']);
  assert.equal(env.DB.prepare('SELECT status FROM ml_link_batches WHERE id=?').bind(batch.batch.id).first().status,'awaiting_links');
  const state=await groupCopyState(env);
  assert.equal(state.total_identified,2);
  assert.equal(state.waiting,1);
  assert.equal(state.awaiting_manual_batch,1);
  env.DB.prepare("INSERT INTO ml_monitor_site_prices(product_id,price_cents,status,checked_at,tries,method) VALUES('MLB12345679',3590,'ok',?,0,'test')")
   .bind(t).run();
  res=await runGroupCopyScheduled(env);
  assert.equal(res.queued,1,JSON.stringify(res));
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM ml_link_batches').first().n,1);
  assert.equal(env.DB.prepare('SELECT status FROM ml_link_batches WHERE id=?').bind(batch.batch.id).first().status,'imported');
  assert.deepEqual(env.DB.prepare('SELECT status FROM ml_link_batch_items WHERE batch_id=? ORDER BY id').bind(batch.batch.id).all().results.map(x=>x.status),['queued','queued']);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,2);
 }finally{db.close();}
});
test('quando usuário ativou automático, revisão antiga não cria novos lotes de conversão manual',async()=>{
 const {env,db}=fixture();
 try{
  await seed(env);
  await saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true});
  const r=await queueBackgroundReview(env);
  assert.equal(r.job.conversion.batch_id,0);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM ml_link_batches').first().n,0);
  const state=await groupCopyState(env);
  assert.equal(state.waiting,1);
 }finally{db.close();}
});
test('painel mostra total capturado e unidades aguardando sem ocultar lotes antigos',()=>{
 const ui=renderPage();
 assert.match(ui,/Produtos identificados \(todos os estados\)/);
 assert.match(ui,/id="copy-groups-flow-status"/);
 assert.match(CLIENT_JS,/awaiting_manual_batch/);
});
