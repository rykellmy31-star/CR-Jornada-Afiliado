import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {addMonitorGroup,saveMonitorSettings,ingestMonitorEvent,inspectMonitorShortlink} from '../src/whatsapp-link-monitor.js';
import {backgroundReviewState,queueBackgroundReview,runBackgroundReview} from '../src/monitor-background-review.js';
import {MONITOR_CLIENT_JS} from '../src/ui-whatsapp-monitor.js';

const GROUP='120363000111222333@g.us';
const PRODUCT='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
function setup(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={
  prepare(sql){
   let params=[];
   return {
    bind(...values){params=values;return this;},
    first(){return sqlite.prepare(sql).get(...params)||null;},
    all(){return {results:sqlite.prepare(sql).all(...params)};},
    run(){const row=sqlite.prepare(sql).run(...params);return {meta:{changes:Number(row.changes),last_row_id:Number(row.lastInsertRowid)}};}
   };
  },
  async batch(commands){
   sqlite.exec('BEGIN');
   try{const results=commands.map(x=>x.run());sqlite.exec('COMMIT');return results;}
   catch(error){sqlite.exec('ROLLBACK');throw error;}
  },
  close(){sqlite.close();}
 };
 return {DB,env:{DB,MONITOR_WEBHOOK_TOKEN:'strong-test-token-1234567890'}};
}
async function insertReview(env,link,id){
 const message={event:'messages.upsert',instance:'cr-jornada-afiliados',
  data:{key:{remoteJid:GROUP,fromMe:false,id},message:{extendedTextMessage:{text:'Oferta '+link}}}};
 await ingestMonitorEvent(env,message);
 await env.DB.prepare("UPDATE ml_monitor_shortlinks SET status='review',reason='Vitrine indisponível' WHERE short_url=?")
  .bind(link).run();
}
async function ready(env){
 await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',group_jid:GROUP,
  group_name:'Grupo autorizado',permission_confirmed:true});
 await saveMonitorSettings(env,{enabled:true});
}

test('validação em massa fica no D1 e funciona sem uma aba ou sessão de navegador',async()=>{
 const {DB,env}=setup(),previous=globalThis.fetch;
 try{
  await ready(env);
  await insertReview(env,'https://meli.la/BACKGROUND1234','msg001');
  await insertReview(env,'https://meli.la/BACKGROUND5678','msg002');
  const queued=await queueBackgroundReview(env);
  assert.equal(queued.job.status,'running');
  assert.equal(queued.job.total,2);
  assert.equal((await queueBackgroundReview(env)).already_running,true);
  globalThis.fetch=async url=>{
   const text=String(url);
   if(text.startsWith('https://meli.la/BACKGROUND'))
    return new Response(null,{status:302,headers:{location:PRODUCT}});
   throw Error('Destino inesperado: '+text);
  };
  const first=await runBackgroundReview(env);
  assert.equal(first.status,'running');
  assert.equal(first.resolved,1);
  assert.equal((await backgroundReviewState(env)).resolved,1);
  // Agora só o Worker: nenhum pedido HTTP do painel, nenhuma aba aberta.
  const next=Number((await backgroundReviewState(env)).next_run_at);
  const second=await runBackgroundReview(env,{now:next});
  assert.equal(second.resolved,1);
  assert.equal((await backgroundReviewState(env)).status,'completed');
  assert.equal((await backgroundReviewState(env)).resolved,2);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_shortlinks WHERE status='resolved'").first().total,2);
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0,
   'A validação não pode publicar ofertas');
 }finally{globalThis.fetch=previous;DB.close();}
});

test('tarefa antiga parada em 120 continua na mesma hora sem limpar progresso',async()=>{
 const {DB,env}=setup(),previous=globalThis.fetch;
 try{
  await ready(env);
  await insertReview(env,'https://meli.la/BACKGROUND9999','msg003');
  const now=Math.floor(Date.now()/1000);
  const day=new Date(now*1000).toISOString().slice(0,10);
  assert.equal((await queueBackgroundReview(env)).job.status,'running');
  DB.prepare("UPDATE ml_monitor_browser_budget SET daily_count=120,day_key=?,last_at=? WHERE id=1")
   .bind(day,now).run();
  DB.prepare("UPDATE ml_monitor_background_review SET status='waiting_budget',next_run_at=?,processed=5,not_confirmed=5 WHERE id=1")
   .bind(now+86400).run();
  globalThis.fetch=async url=>{
   if(String(url)==='https://meli.la/BACKGROUND9999')
    return new Response(null,{status:302,headers:{location:PRODUCT}});
   throw Error('Destino inesperado: '+url);
  };
  const resumed=await runBackgroundReview(env,{now});
  assert.equal(resumed.resolved,1,'deve prosseguir imediatamente, mesmo com uso diário de 120');
  const job=await backgroundReviewState(env);
  assert.equal(job.status,'completed');
  assert.equal(job.resolved,1);
  assert.equal(job.processed,6,'progresso anterior preservado');
  assert.equal(job.not_confirmed,5,'falhas registradas anteriormente preservadas');
  assert.equal(DB.prepare('SELECT status FROM ml_monitor_shortlinks').first().status,'resolved');
  assert.equal((await queueBackgroundReview(env)).job.status,'completed');
 }finally{globalThis.fetch=previous;DB.close();}
});

test('monitor pausado preserva job e grupo pausado não impede revisão de link autorizado',async()=>{
 const {DB,env}=setup();
 try{
  await ready(env);
  await insertReview(env,'https://meli.la/BACKGROUNDONLY','msg004');
  await queueBackgroundReview(env);
  await saveMonitorSettings(env,{enabled:false});
  const waiting=await runBackgroundReview(env);
  assert.equal(waiting.skipped,'monitor_off');
  assert.equal((await backgroundReviewState(env)).status,'waiting_monitor');
  assert.equal(DB.prepare('SELECT status FROM ml_monitor_shortlinks').first().status,'review');
 }finally{DB.close();}
});

test('o botão apenas agenda no servidor; UI não exige manter a aba aberta',()=>{
 assert.match(MONITOR_CLIENT_JS,/Validação em segundo plano na Cloudflare/);
 assert.match(MONITOR_CLIENT_JS,/\/api\/monitor\/review-all/);
 assert.doesNotMatch(MONITOR_CLIENT_JS,/Mantenha esta aba aberta/);
 assert.doesNotMatch(MONITOR_CLIENT_JS,/setTimeout\(resolve,5500\)/);
 assert.match(MONITOR_CLIENT_JS,/sem teto diário interno/);
 assert.doesNotMatch(MONITOR_CLIENT_JS,/de 120 verificações hoje/);
});


test('validação em segundo plano prepara 2 links confirmados para conversão sem publicar',async()=>{
 const {DB,env}=setup(),before=globalThis.fetch;
 const first='https://meli.la/CONVERSAO1234';
 const second='https://meli.la/CONVERSAO5678';
 const productTwo='https://www.mercadolivre.com.br/furadeira-de-impacto-qualidade/p/MLB87654321';
 try{
  await ready(env);
  await insertReview(env,first,'CONVERSION1');
  await insertReview(env,second,'CONVERSION2');
  DB.prepare("UPDATE ml_monitor_shortlinks SET message_hint='Furadeira de impacto Bosch com desconto' WHERE status='review'").run();
  const queue=await queueBackgroundReview(env);
  assert.equal(queue.job.status,'running');
  globalThis.fetch=async url=>{
   if(String(url)===first)return new Response(null,{status:302,headers:{location:PRODUCT}});
   if(String(url)===second)return new Response(null,{status:302,headers:{location:productTwo}});
   throw Error('URL fora do teste: '+url);
  };
  const step1=await runBackgroundReview(env);
  assert.equal(step1.resolved,1);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM ml_link_batches WHERE status='awaiting_links'").first().total,0,
   'não criar lote antes de terminar a passagem pelos links revisados');
  const step2=await runBackgroundReview(env,{now:Number((await backgroundReviewState(env)).next_run_at)});
  assert.equal(step2.resolved,1);
  assert.equal(step2.status,'completed');
  const state=await backgroundReviewState(env);
  assert.ok(state.conversion.batch_id>0,'precisa aparecer na aba Conversão de Link em Lote');
  assert.equal(state.conversion.batch_items,2);
  assert.equal(state.conversion.eligible_waiting,0);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_links WHERE status='batched'").first().total,2);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM ml_link_batch_items WHERE status='awaiting_links'").first().total,2);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM offers").first().total,0,
   'preparar links normais não significa convertê-los nem publicar');
  const repeated=await queueBackgroundReview(env);
  assert.equal(repeated.job.conversion.batch_id,state.conversion.batch_id);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM ml_link_batches WHERE status='awaiting_links'").first().total,1,
   'não pode criar lote duplicado em novo clique');
 }finally{globalThis.fetch=before;DB.close();}
});

test('clique prepara produtos já confirmados quando revisão está vazia, sem inventar categoria',async()=>{
 const {DB,env}=setup();
 try{
  await ready(env);
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
   data:{key:{remoteJid:GROUP,fromMe:false,id:'ALREADYPRODUCT1'},
   message:{extendedTextMessage:{text:'Furadeira de impacto em oferta '+PRODUCT}}}});
  const prepared=await queueBackgroundReview(env);
  assert.equal(prepared.job.status,'completed');
  assert.equal(prepared.job.conversion.batch_items,1);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM ml_link_batch_items WHERE status='awaiting_links'").first().total,1);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM offers").first().total,0);
 }finally{DB.close();}
});

test('produto sem categoria permanece disponível, mas não entra em lote automático',async()=>{
 const {DB,env}=setup();
 try{
  await ready(env);
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
   data:{key:{remoteJid:GROUP,fromMe:false,id:'WITHOUTCATEGORY1'},
   message:{extendedTextMessage:{text:'Produto desconhecido '+PRODUCT}}}});
  DB.prepare("UPDATE ml_monitor_links SET category='Geral'").run();
  const state=await queueBackgroundReview(env);
  assert.equal(state.job.conversion.batch_id,0);
  assert.equal(state.job.conversion.needs_category,1);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM ml_link_batches").first().total,0);
 }finally{DB.close();}
});

test('vitrine meli.promo mantém o cartão principal mesmo quando o Content-Length informado ultrapassa 5MB',async()=>{
 const short='https://meli.promo/s/tP8Sm3';
 const social='https://www.mercadolivre.com.br/social/gear';
 const html='<html><div class="rl-card-featured-wrapper">'+
  '<a class="poly-component__link--action-link" href="'+PRODUCT+'">Ir para produto</a>'+
  '</div><section class="rl-card-recommendations"><a href="https://www.mercadolivre.com.br/outro/p/MLB99999999">Ir para produto</a></section>'+
  '</html>';
 const seen=[];
 const response=await inspectMonitorShortlink(short,{fetcher:async value=>{
  seen.push(String(value));
  if(String(value)===short)return new Response(null,{status:302,headers:{location:social}});
  if(String(value)===social)return new Response(html,{headers:{'content-type':'text/html','content-length':'6000000'}});
  throw Error('Não deveria consultar recomendação: '+value);
 }});
 assert.equal(response.product?.product_id,'MLB12345678');
 assert.equal(response.kind,'featured_product');
 assert.deepEqual(seen,[short,social]);
});

test('tela indica lote pronto e acesso direto à conversão',()=>{
 assert.match(MONITOR_CLIENT_JS,/Validar e preparar conversão/);
 assert.match(MONITOR_CLIENT_JS,/data-monitor-open-conversion/);
 assert.match(MONITOR_CLIENT_JS,/Lote #/);
});
