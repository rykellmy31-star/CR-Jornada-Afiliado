import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {renderPage,CLIENT_JS} from '../src/ui.js';
import {ensureMonitor,addMonitorGroup,saveMonitorSettings,ingestMonitorEvent} from '../src/whatsapp-link-monitor.js';
import {connectAffiliateStore} from '../src/affiliate-stores.js';
import {groupCopyState,saveGroupCopySettings,runGroupCopyScheduled} from '../src/group-copy.js';
import worker from '../src/index.js';

const TOKEN='test-monitor-webhook-token-1234567890';
const PRODUCT='https://www.mercadolivre.com.br/furadeira-impacto-profissional/p/MLB12345678';
const GROUP='120363000111222333@g.us';
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){
  let args=[];
  return {bind(...values){args=values;return this;},
   first(){return db.prepare(sql).get(...args)||null;},
   all(){return {results:db.prepare(sql).all(...args)};},
   run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}}
 },async batch(ops){
   db.exec('BEGIN');
   try{const result=ops.map(op=>op.run());db.exec('COMMIT');return result;}
   catch(error){db.exec('ROLLBACK');throw error;}
 }};
 const env={DB,MONITOR_WEBHOOK_TOKEN:TOKEN,ADMIN_PASSWORD:'local test admin',SESSION_SECRET:'local test secret for unit testing'};
 return {env,db};
}
async function seed(env){
 await ensureMonitor(env);
 await connectAffiliateStore(env,{official_url:'https://meli.la/2XzEMvr'},
  async()=>new Response(null,{status:302,headers:{location:'https://www.mercadolivre.com.br/social/rykellmy_007?matt_word=rykellmy_007&matt_tool=33321398&ref=real'}}));
 await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',group_jid:GROUP,group_name:'Ofertas públicas autorizadas',permission_confirmed:true});
 await saveMonitorSettings(env,{enabled:true});
 await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
  data:{key:{remoteJid:GROUP,fromMe:false,id:'msg-123'},message:{conversation:'Furadeira impacto profissional em oferta '+PRODUCT}}});
}
test('COPIAR DE GRUPOS usa monitor único, aparece no menu e conserva conversão em lote',()=>{
 const html=renderPage();
 assert.match(html,/data-panel="copygroups"/);
 assert.match(html,/id="copy-groups-page"/);
 assert.equal((html.match(/id="ml-whatsapp-monitor"/g)||[]).length,1);
 assert.match(html,/id="ml-link-batches"/);
 assert.match(CLIENT_JS,/selectedPage==='copygroups'/);
 assert.match(CLIENT_JS,/runCopyGroupsScheduled|refreshCopyGroups/);
});
test('importação experimental começa desligada e requer confirmação, loja e monitor',async()=>{
 const {env,db}=setup();
 try{
  const initial=await groupCopyState(env);
  assert.equal(initial.enabled,false);
  await assert.rejects(saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:false}),/Confirme/);
  await assert.rejects(saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true}),/Cadastre antes/);
  await seed(env);
  const active=await saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true});
  assert.equal(active.enabled,true);
  assert.equal(active.authorized_groups,1);
  assert.equal(active.store_configured,true);
  const off=await saveGroupCopySettings(env,{enabled:false,experimental_acknowledged:false});
  assert.equal(off.enabled,false);
 }finally{db.close();}
});
test('captura produto de terceiro, elimina rastreio antigo, exige preço oficial e importa uma vez na fila',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  await saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true});
  let result=await runGroupCopyScheduled(env);
  assert.equal(result.skipped,'awaiting_verified_price');
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
  const t=Math.floor(Date.now()/1000);
  const p=env.DB.prepare('SELECT product_id FROM ml_monitor_links').first();
  assert.ok(p?.product_id);
  env.DB.prepare("INSERT INTO ml_monitor_site_prices(product_id,price_cents,status,checked_at,tries,method) VALUES(?,4590,'ok',?,1,'html')").bind(p.product_id,t).run();
  result=await runGroupCopyScheduled(env);
  assert.equal(result.queued,1,JSON.stringify(result));
  assert.match(result.short_url,/^https:\/\/promoml\.app\/[A-Za-z0-9_-]{12}$/);
  assert.equal(result.commission_verified,false);
  const offer=env.DB.prepare('SELECT * FROM offers').first();
  assert.equal(offer.status,'ready');
  assert.equal(offer.price_cents,4590);
  assert.ok(offer.affiliate_url.includes('matt_word=rykellmy_007'));
  assert.ok(offer.affiliate_url.includes('matt_tool=33321398'));
  assert.ok(!offer.affiliate_url.includes('outro_afiliado'));
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_links WHERE status='batched'").first().total,1);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS total FROM ml_link_batches WHERE status=?').bind('imported').first().total,1);
  const retry=await runGroupCopyScheduled(env);
  assert.equal(retry.queued,undefined);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,1);
  const unauthorized=await worker.fetch(new Request('https://app.example.com/api/copy-groups'),env);
  assert.equal(unauthorized.status,401);
 }finally{db.close();}
});
test('sem grupo autorizado ativo ou sem preço recente não há publicação',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  await saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true});
  const p=env.DB.prepare('SELECT product_id FROM ml_monitor_links').first();
  env.DB.prepare("INSERT INTO ml_monitor_site_prices(product_id,price_cents,status,checked_at,tries,method) VALUES(?,4590,'ok',?,1,'html')").bind(p.product_id,Math.floor(Date.now()/1000)-8*3600).run();
  assert.equal((await runGroupCopyScheduled(env)).queued,undefined);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
  env.DB.prepare('UPDATE ml_monitor_groups SET enabled=0').run();
  env.DB.prepare("UPDATE ml_monitor_site_prices SET checked_at=?").bind(Math.floor(Date.now()/1000)).run();
  assert.equal((await runGroupCopyScheduled(env)).queued,undefined);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
 }finally{db.close();}
});
