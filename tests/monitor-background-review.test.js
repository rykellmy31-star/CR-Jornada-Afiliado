import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {addMonitorGroup,saveMonitorSettings,ingestMonitorEvent} from '../src/whatsapp-link-monitor.js';
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
