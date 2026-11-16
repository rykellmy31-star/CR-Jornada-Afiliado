import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {
 requestManualGroupCheck,readManualGroupCheck,executeManualGroupCheck
} from '../src/copy-groups-manual-checks.js';
import {ensureOfficialCategories} from '../src/monitor-official-categories.js';
import {ensureMonitor} from '../src/whatsapp-link-monitor.js';
import {renderPage,CLIENT_JS} from '../src/ui.js';
import worker from '../src/index.js';

function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){
  let args=[];
  return {bind(...values){args=values;return this;},
   first(){return db.prepare(sql).get(...args)||null;},
   all(){return {results:db.prepare(sql).all(...args)};},
   run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}}
 },async batch(ops){db.exec('BEGIN');try{const out=ops.map(x=>x.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
 return {env:{DB,SESSION_SECRET:'test-secret-with-more-than-32-characters',ADMIN_PASSWORD:'test-admin-password'},db};
}
async function seed(env,amount=1,{category='Geral',classification='needs_review'}={}){
 await ensureOfficialCategories(env);
 env.DB.prepare("INSERT INTO ml_monitor_groups(instance_name,group_jid,group_name,enabled,authorized,created_at) "+
  "VALUES('cr-jornada-afiliados','120363000111222333@g.us','Grupo autorizado',1,1,1000)").run();
 for(let i=0;i<amount;i++){
  const code='MLB'+(12345678+i);
  env.DB.prepare("INSERT INTO ml_monitor_links(group_id,product_id,source_url,title,category,classification,status,created_at) VALUES(1,?,?,?,?,?,'available',1000)")
   .bind(code,'https://www.mercadolivre.com.br/furadeira-de-impacto/p/'+code,
    'Furadeira de impacto profissional modelo '+i,category,classification).run();
 }
}
const fakeCategory=async()=>new Response(JSON.stringify([{
 category_id:'MLB189007',domain_name:'Furadeiras elétricas',
 domain_id:'MLB-ELECTRIC_DRILLS',category_name:'De Mão'
}]),{status:200,headers:{'content-type':'application/json'}});
test('click creates a durable nonblocking task; duplicate clicks do not reset its progress',async()=>{
 const {env,db}=setup();
 try{
  await seed(env,3);
  const first=await requestManualGroupCheck(env,'categories');
  assert.equal(first.status,'pending');
  assert.equal(first.remaining,8);
  assert.equal(first.already_queued,false);
  const repeat=await requestManualGroupCheck(env,'categories');
  assert.equal(repeat.already_queued,true);
  let calls=0;
  const result=await executeManualGroupCheck(env,'categories',{fetcher:async(...args)=>{calls++;return fakeCategory(...args);}});
  assert.equal(result.status,'pending');
  assert.equal(result.remaining,6);
  assert.equal(result.classified,2);
  assert.equal(calls,2,'per Cron máximo 2 anúncios, e não 8 chamadas dentro da requisição do painel');
  const again=await executeManualGroupCheck(env,'categories',{fetcher:fakeCategory});
  assert.equal(again.classified,3);
  assert.equal(again.remaining,5);
  const done=await executeManualGroupCheck(env,'categories',{fetcher:fakeCategory});
  assert.equal(done.status,'completed');
  assert.equal(done.classified,3);
  assert.equal((await readManualGroupCheck(env,'categories')).status,'completed');
  assert.equal(env.DB.prepare("SELECT COUNT(*) n FROM ml_monitor_links WHERE classification='mercadolivre'").first().n,3);
  const restarted=await requestManualGroupCheck(env,'categories');
  assert.equal(restarted.status,'pending');
  assert.equal(restarted.remaining,8);
  assert.equal(restarted.classified,0);
 }finally{db.close();}
});
test('manual price lookup proceeds in Cron with one item per pulse and reports confirmed price',async()=>{
 const {env,db}=setup();
 try{
  await seed(env,2,{category:'Ferramentas e Peças Automotivas',classification:'selected'});
  const first=await requestManualGroupCheck(env,'prices');
  assert.equal(first.remaining,2);
  const fetcher=async u=>{
   const s=String(u);
   if(s.startsWith('https://api.mercadolibre.com/items/')){
    const id=s.split('/').pop();
    return new Response(JSON.stringify({id,price:49.90,original_price:null,currency_id:'BRL'}),{
     status:200,headers:{'content-type':'application/json'}});
   }
   return new Response('Bloqueado',{status:403});
  };
  const a=await executeManualGroupCheck(env,'prices',{fetcher});
  assert.equal(a.status,'pending');
  assert.equal(a.checked,1);
  assert.equal(a.found,1);
  assert.equal(a.remaining,1);
  const b=await executeManualGroupCheck(env,'prices',{fetcher});
  assert.equal(b.status,'completed');
  assert.equal(b.checked,2);
  assert.equal(b.found,2);
  assert.equal(env.DB.prepare("SELECT COUNT(*) n FROM ml_monitor_site_prices WHERE status='ok'").first().n,2);
 }finally{db.close();}
});
test('failures are bounded and reattempted, invalid requests rejected',async()=>{
 const {env,db}=setup();
 try{
  await seed(env,1);
  await assert.rejects(()=>requestManualGroupCheck(env,'invalid'),/desconhecido/);
  await assert.rejects(()=>readManualGroupCheck(env,'invalid'),/desconhecido/);
  await requestManualGroupCheck(env,'categories');
  const job=await executeManualGroupCheck(env,'categories',{fetcher:async()=>new Response('bloqueado',{status:403})});
  assert.equal(job.status,'pending');
  assert.equal(job.failed,1);
  assert.equal(job.remaining,7);
  // Persisted status allows a browser to close and reopen without restarting.
  const current=await readManualGroupCheck(env,'categories');
  assert.equal(current.failed,1);
  assert.equal(current.remaining,7);
 }finally{db.close();}
});
test('UI starts asynchronously, polls short route, and no longer chains long refreshes to button responses',()=>{
 const html=renderPage();
 assert.match(html,/id="copy-groups-categories-job"/);
 assert.match(html,/id="copy-groups-prices-job"/);
 assert.match(CLIENT_JS,/copyGroupStartCheck/);
 assert.match(CLIENT_JS,/\/api\/copy-groups\/check-status/);
 assert.doesNotMatch(CLIENT_JS,/const data=await call\('\/api\/copy-groups\/categorize'.*30000/);
 assert.doesNotMatch(CLIENT_JS,/const result=await call\('\/api\/copy-groups\/prices'.*45000/);
});
test('only authenticated admins can create or inspect jobs',async()=>{
 const {env,db}=setup();
 try{
  for(const path of ['/api/copy-groups/prices','/api/copy-groups/categorize']){
   const res=await worker.fetch(new Request('https://bot.crjornada.com'+path,{
    method:'POST',headers:{origin:'https://bot.crjornada.com','content-type':'application/json'},body:'{}'
   }),env);
   assert.equal(res.status,401);
  }
  const get=await worker.fetch(new Request('https://bot.crjornada.com/api/copy-groups/check-status?kind=categories'),env);
  assert.equal(get.status,401);
 }finally{db.close();}
});
