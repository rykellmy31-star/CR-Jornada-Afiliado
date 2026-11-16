import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {groupCopyEligibility,groupCopyState,saveGroupCopySettings,testGroupCopyImport} from '../src/group-copy.js';
import {ensureMonitor,addMonitorGroup,saveMonitorSettings,ingestMonitorEvent} from '../src/whatsapp-link-monitor.js';
import {connectAffiliateStore,previewAffiliateLink} from '../src/affiliate-stores.js';
import {getPrimaryCategory} from '../src/multichannel.js';
import {CLIENT_JS,renderPage} from '../src/ui.js';

const PRODUCT='https://www.mercadolivre.com.br/furadeira-impacto/p/MLB12345678';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){let args=[];return {bind(...values){args=values;return this;},
  first(){return db.prepare(sql).get(...args)||null;},
  all(){return {results:db.prepare(sql).all(...args)};},
  run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}}
 },async batch(ops){db.exec('BEGIN');try{const out=ops.map(x=>x.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const env={DB,MONITOR_WEBHOOK_TOKEN:'unit-test-webhook-secret-1234567890',SESSION_SECRET:'unit-test-session-secret-long-enough'};
 return {env,db};
}
async function seed(env){
 await ensureMonitor(env);
 await connectAffiliateStore(env,{official_url:'https://meli.la/2XzEMvr'},async()=>
  new Response(null,{status:302,headers:{location:'https://www.mercadolivre.com.br/social/rykellmy_007?matt_word=rykellmy_007&matt_tool=33321398&ref=TEST'}}));
 await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',group_jid:'120363000111222333@g.us',group_name:'Grupo autorizado',permission_confirmed:true});
 await saveMonitorSettings(env,{enabled:true});
 await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
  data:{key:{remoteJid:'120363000111222333@g.us',fromMe:false,id:'msg-1'},
   message:{conversation:'Furadeira impacto profissional em oferta '+PRODUCT}}});
 const t=Math.floor(Date.now()/1000);
 const row=env.DB.prepare('SELECT product_id FROM ml_monitor_links').first();
 env.DB.prepare("UPDATE ml_monitor_links SET category='Ferramentas e Peças Automotivas',classification='selected'").run();
 env.DB.prepare("INSERT INTO ml_monitor_site_prices(product_id,price_cents,status,checked_at,tries,method) VALUES(?,4990,'ok',?,0,'html')").bind(row.product_id,t).run();
}
test('produto com preço confirmado mas categoria bloqueada mostra motivo específico, sem publicar',async()=>{
 const {env,db}=fixture();
 try{
  await seed(env);
  await getPrimaryCategory(env);
  env.DB.prepare("UPDATE primary_channel_category SET category='Moda e Acessórios' WHERE id=1").run();
  const report=await groupCopyEligibility(env);
  assert.equal(report.ready,0);
  assert.equal(report.checked_with_price,1);
  assert.equal(report.blocked.categoria_canal,1);
  assert.match(report.examples[0].description,/canal principal está restrito/i);
  const state=await groupCopyState(env);
  assert.equal(state.readiness.with_price,1);
  assert.equal(state.eligibility.ready,0);
  assert.equal(state.eligibility.blocked.categoria_canal,1);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{db.close();}
});
test('reconhece links incompatíveis e ofertas duplicadas sem fingir que preço falta',async()=>{
 const {env,db}=fixture();
 try{
  await seed(env);
  env.DB.prepare("UPDATE ml_monitor_links SET source_url=?").bind('https://www.mercadolivre.com.br/pagina-sem-codigo').run();
  let report=await groupCopyEligibility(env);
  assert.equal(report.blocked.link_incompativel,1);
  env.DB.prepare("UPDATE ml_monitor_links SET source_url=?").bind(PRODUCT).run();
  const preview=await previewAffiliateLink(env,{product_url:PRODUCT});
  env.DB.prepare("INSERT INTO offers(title,affiliate_url,category,price_cents,created_at,status) VALUES(?,?,?,?,?,'ready')")
   .bind('Produto já na fila',preview.target_url,'Ferramentas e Peças Automotivas',4990,Math.floor(Date.now()/1000)).run();
  report=await groupCopyEligibility(env);
  assert.equal(report.blocked.duplicado,1);
  assert.equal(report.ready,0);
 }finally{db.close();}
});
test('teste importa produto realmente apto e informa diagnóstico posterior sem afetar destinos',async()=>{
 const {env,db}=fixture();
 try{
  await seed(env);
  assert.equal((await groupCopyEligibility(env)).ready,1);
  await saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true});
  const result=await testGroupCopyImport(env);
  assert.equal(result.result.queued,1,JSON.stringify(result));
  assert.equal(result.state.queued_count,1);
  assert.equal(result.eligibility.ready,0);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,1);
 }finally{db.close();}
});
test('painel sempre explica restrições e exibe resultado antes da atualização secundária',()=>{
 const html=renderPage();
 assert.match(html,/id="copy-groups-eligibility"/);
 assert.match(CLIENT_JS,/categoria diferente da permitida no canal principal/);
 assert.match(CLIENT_JS,/Motivo encontrado:/);
 const posResult=CLIENT_JS.indexOf("const result=data.result||{}");
 const posRefresh=CLIENT_JS.indexOf("try{await refreshCopyGroups();}",posResult);
 assert.ok(posResult>=0&&posRefresh>posResult);
});
