import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {extractOfferPriceCents,canRequeueProduct,REPEAT_WINDOW_SECONDS} from '../src/monitor-repeat-policy.js';
import {addMonitorGroup,saveMonitorSettings,ingestMonitorEvent,monitorState,prepareMonitorBatch,ensureMonitor} from '../src/whatsapp-link-monitor.js';
import {importLinkBatch,listLinkBatches,readLinkBatch} from '../src/link-batches.js';

const GROUP='120363000111222333@g.us',INSTANCE='cr-jornada-afiliados';
const PRODUCT='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(query){let args=[];return {
  bind(...values){args=values;return this;},
  first(){return db.prepare(query).get(...args)||null;},
  all(){return {results:db.prepare(query).all(...args)};},
  run(){const r=db.prepare(query).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
 };},async batch(queries){db.exec('BEGIN');try{
  const results=queries.map(query=>query.run());db.exec('COMMIT');return results;
 }catch(e){db.exec('ROLLBACK');throw e;}},close(){db.close();}};
 return {env:{DB,MONITOR_WEBHOOK_TOKEN:'webhook-private-test-token-123456789'},DB};
}
function offer(message,price=null){
 const extra=price===null?'':(' agora por R$ '+price);
 return {event:'messages.upsert',instance:INSTANCE,data:{
  key:{remoteJid:GROUP,fromMe:false,id:message},
  message:{extendedTextMessage:{text:'🔥 Furadeira de impacto'+extra+' '+PRODUCT}}
 }};
}
async function prepare(env){
 await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo autorizado',permission_confirmed:true});
 await saveMonitorSettings(env,{enabled:true});
}
test('preço de promoção é interpretado só quando está inequívoco',()=>{
 assert.equal(extractOfferPriceCents('Furadeira por R$ 129,90'),12990);
 assert.equal(extractOfferPriceCents('De R$ 199,90 por R$ 149,90'),14990);
 assert.equal(extractOfferPriceCents('Agora R$ 1.299,90'),129990);
 assert.equal(extractOfferPriceCents('R$ 10,00 e R$ 20,00'),null);
 assert.equal(extractOfferPriceCents('Oferta imperdível e entrega grátis'),null);
 assert.equal(canRequeueProduct(10000,10000,9500,10000+60),true);
 assert.equal(canRequeueProduct(10000,10000,10000,10000+60),false);
 assert.equal(canRequeueProduct(10000,10000,null,10000+60),false);
 assert.equal(canRequeueProduct(10000,null,9000,10000+60),false);
 assert.equal(canRequeueProduct(10000,null,null,10000+REPEAT_WINDOW_SECONDS),true);
});
test('após enfileirar, relatório desaparece, produto só retorna após 7 dias ou novo preço comprovável na mensagem',async()=>{
 const {env,DB}=fixture();
 try{
  await prepare(env);
  assert.equal((await ingestMonitorEvent(env,offer('1','129,90'))).captured,1);
  assert.equal((await ingestMonitorEvent(env,offer('2','129,90'))).captured,0);
  let ready=(await monitorState(env)).links.filter(x=>x.status==='available');
  assert.equal(ready.length,1);
  assert.equal(ready[0].last_seen_price_cents,12990);
  const first=await prepareMonitorBatch(env,{automatic:true});
  const before=DB.prepare('SELECT pending_price_cents,last_queued_at FROM ml_monitor_product_meta').first();
  assert.equal(before.pending_price_cents,12990);
  assert.equal(before.last_queued_at,0);
  await importLinkBatch(env,first.batch.id,{owner_confirmation:true,pairing_confirmation:true,
   links:[{affiliate_url:'https://meli.la/FURADEIRA1',category:first.items[0].category}]});
  const metadata=DB.prepare('SELECT last_queued_price_cents,last_queued_at,pending_price_cents FROM ml_monitor_product_meta').first();
  assert.equal(metadata.last_queued_price_cents,12990);
  assert.ok(metadata.last_queued_at>0);
  assert.equal(metadata.pending_price_cents,null);
  assert.equal((await readLinkBatch(env,first.batch.id)).batch.status,'imported');
  assert.deepEqual((await listLinkBatches(env)).recent,[]); // Relatório arquivado, não apagado do D1.
  assert.equal((await monitorState(env)).links.filter(x=>x.status==='available').length,0);
  assert.equal((await ingestMonitorEvent(env,offer('3','129,90'))).captured,0);
  assert.equal((await ingestMonitorEvent(env,offer('4'))).captured,0);
  assert.equal((await ingestMonitorEvent(env,offer('5','119,90'))).captured,1);
  ready=(await monitorState(env)).links.filter(x=>x.status==='available');
  assert.equal(ready.length,1);
  assert.equal(ready[0].last_seen_price_cents,11990);
  const second=await prepareMonitorBatch(env,{automatic:true});
  assert.equal(second.items[0].category,'Ferramentas e Peças Automotivas');
  await importLinkBatch(env,second.batch.id,{owner_confirmation:true,pairing_confirmation:true,
   links:[{affiliate_url:'https://meli.la/FURADEIRA2',category:second.items[0].category}]});
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,2);
  assert.equal((await ingestMonitorEvent(env,offer('6','119,90'))).captured,0);
  DB.prepare('UPDATE ml_monitor_product_meta SET last_queued_at=?').bind(Math.floor(Date.now()/1000)-8*86400).run();
  assert.equal((await ingestMonitorEvent(env,offer('7','119,90'))).captured,1);
  assert.equal((await monitorState(env)).links.filter(x=>x.status==='available').length,1);
 }finally{DB.close();}
});
test('enquanto o lote não foi convertido, preço novo não cria lote duplicado',async()=>{
 const {env,DB}=fixture();try{
  await prepare(env);
  await ingestMonitorEvent(env,offer('a','79,90'));
  const batch=await prepareMonitorBatch(env,{automatic:true});
  assert.equal((await ingestMonitorEvent(env,offer('b','69,90'))).captured,0);
  assert.equal((await monitorState(env)).links.filter(x=>x.status==='available').length,0);
  await importLinkBatch(env,batch.batch.id,{owner_confirmation:true,pairing_confirmation:true,
   links:[{affiliate_url:'https://meli.la/FURADEIRA3',category:batch.items[0].category}]});
  // Preço enfileirado é o do lote, não o preço de uma mensagem posterior.
  assert.equal(DB.prepare('SELECT last_queued_price_cents FROM ml_monitor_product_meta').first().last_queued_price_cents,7990);
  assert.equal((await ingestMonitorEvent(env,offer('c','69,90'))).captured,1);
 }finally{DB.close();}
});
