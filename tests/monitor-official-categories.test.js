import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureOfficialCategories,readOfficialPrediction,predictOfficialCategory,classifyMonitorMissingCategories,officialCategoryStats} from '../src/monitor-official-categories.js';
import {ensureAutomationCenter} from '../src/automation-center.js';
import {ensureMonitor} from '../src/whatsapp-link-monitor.js';
import {runGroupCopyScheduled,groupCopyState} from '../src/group-copy.js';
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
 },async batch(ops){db.exec('BEGIN');try{const out=ops.map(op=>op.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
 return {env:{DB,ADMIN_PASSWORD:'test password',SESSION_SECRET:'test session secret'},db};
}
async function seed(env){
 await ensureMonitor(env);
 await ensureAutomationCenter(env);
 env.DB.prepare("INSERT INTO ml_monitor_groups(instance_name,group_jid,group_name,enabled,authorized,created_at) VALUES('cr-jornada-afiliados','120363000111222333@g.us','Grupo autorizado',1,1,1000)").run();
}
function product(env,id,title,classification='needs_review',category='Geral'){
 env.DB.prepare("INSERT INTO ml_monitor_links(group_id,product_id,source_url,title,category,classification,status,created_at) VALUES(1,?,?,?,?,?,'available',1000)")
 .bind('MLB'+id,'https://www.mercadolivre.com.br/produto/p/MLB'+id,title,category,classification).run();
}
function response(category_id='MLB189007',domain_name='Furadeiras elétricas',domain_id='MLB-ELECTRIC_DRILLS',category_name='De Mão'){
 return new Response(JSON.stringify([{category_id,domain_name,domain_id,category_name}]),{status:200,headers:{'content-type':'application/json'}});
}
test('consulta o preditor oficial MLB com título e valida resposta, sem aceitar domínio externo',async()=>{
 let called='';
 const data=await predictOfficialCategory('Furadeira de impacto 750W',{fetcher:async(url)=>{
  called=url;return response();
 }});
 assert.equal(new URL(called).hostname,'api.mercadolibre.com');
 assert.equal(new URL(called).pathname,'/sites/MLB/domain_discovery/search');
 assert.equal(new URL(called).searchParams.get('q'),'Furadeira de impacto 750W');
 assert.equal(data.category_id,'MLB189007');
 assert.equal(data.official_label,'Furadeiras elétricas');
 assert.equal(readOfficialPrediction([{category_id:'MLB1234',domain_name:'<script>alert(1)</script>'}]),null);
 assert.equal(readOfficialPrediction([{category_id:'INVALID',domain_name:'Furadeiras'}]),null);
 assert.match((await predictOfficialCategory('Produto específico em oferta',{fetcher:async()=>new Response('',{status:429})})).error,/limitou/i);
});
test('categoria oficial cria apenas uma vez, reaproveita no segundo produto e preserva escolhas manuais',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  product(env,'12345678','Furadeira de impacto 750W');
  product(env,'12345679','Furadeira profissional 220 volts');
  product(env,'12345680','Furadeira manual categoria escolhida','selected','Casa e Utilidades');
  const old=(await env.DB.prepare('SELECT COUNT(*) AS total FROM affiliate_group_categories').first()).total;
  const fetcher=async()=>response();
  const first=await classifyMonitorMissingCategories(env,{fetcher,limit:8,at:1700000000});
  assert.equal(first.classified,2,JSON.stringify(first));
  assert.equal(first.created,1);
  assert.equal(first.reused,1);
  const after=(await env.DB.prepare('SELECT COUNT(*) AS total FROM affiliate_group_categories').first()).total;
  assert.equal(after,old+1);
  const assigned=(await env.DB.prepare('SELECT category,classification FROM ml_monitor_links WHERE product_id=?').bind('MLB12345678').first());
  assert.equal(assigned.category,'Furadeiras elétricas');
  assert.equal(assigned.classification,'mercadolivre');
  const manual=await env.DB.prepare("SELECT category,classification FROM ml_monitor_links WHERE product_id='MLB12345680'").first();
  assert.equal(manual.category,'Casa e Utilidades');
  assert.equal(manual.classification,'selected');
  assert.equal((await classifyMonitorMissingCategories(env,{fetcher,at:1700000060})).classified,0);
  assert.equal((await officialCategoryStats(env)).waiting,0);
 }finally{db.close();}
});
test('reutiliza categoria existente por nome oficial sem criar duplicada, incluindo acentos e maiúsculas',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  product(env,'23456789','Vestido feminino casual');
  const old=(await env.DB.prepare('SELECT COUNT(*) AS total FROM affiliate_group_categories').first()).total;
  const result=await classifyMonitorMissingCategories(env,{fetcher:async()=>response('MLB100022','Moda e acessorios','MLB-CLOTHING','Moda'),at:1700000000});
  assert.equal(result.classified,1);
  assert.equal(result.created,0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS total FROM affiliate_group_categories').first()).total,old);
  assert.equal((await env.DB.prepare("SELECT category FROM ml_monitor_links WHERE product_id='MLB23456789'").first()).category,'Moda e Acessórios');
 }finally{db.close();}
});
test('categoria existente desativada não cria duplicata nem classifica até o administrador reabilitar',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  product(env,'23555555','Vestido casual feminino');
  env.DB.prepare("UPDATE affiliate_group_categories SET enabled=0 WHERE name='Moda e Acessórios'").run();
  const fetcher=async()=>response('MLB100022','Moda e acessórios','MLB-CLOTHING','Moda');
  const a=await classifyMonitorMissingCategories(env,{fetcher,at:1700000000});
  assert.equal(a.classified,0);
  assert.equal(a.created,0);
  assert.equal((await env.DB.prepare("SELECT category FROM ml_monitor_links WHERE product_id='MLB23555555'").first()).category,'Geral');
  env.DB.prepare("UPDATE affiliate_group_categories SET enabled=1 WHERE name='Moda e Acessórios'").run();
  const b=await classifyMonitorMissingCategories(env,{fetcher,at:1700000610});
  assert.equal(b.classified,1);
  assert.equal(b.created,0);
  assert.equal((await env.DB.prepare("SELECT category FROM ml_monitor_links WHERE product_id='MLB23555555'").first()).category,'Moda e Acessórios');
 }finally{db.close();}
});

test('backfill automático classifica 22 produtos em lotes sem duplicar categorias e sem publicar nada',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  for(let i=0;i<22;i++)product(env,String(50000000+i),'Jogo de ferramentas '+i);
  let calls=0,classified=0,created=0;
  const fetcher=async()=>{calls++;return response('MLB189007','Furadeiras elétricas');};
  for(let minute=0;minute<6;minute++){
   const result=await classifyMonitorMissingCategories(env,{fetcher,at:1700000000+minute*60,limit:4});
   classified+=result.classified;created+=result.created;
  }
  assert.equal(calls,22);
  assert.equal(classified,22);
  assert.equal(created,1);
  assert.equal((await officialCategoryStats(env)).waiting,0);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_links WHERE classification='mercadolivre'").first()).total,22);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS total FROM offers').first()).total,0);
  assert.equal((await runGroupCopyScheduled(env)).skipped,'disabled_or_busy');
 }finally{db.close();}
});
test('resposta não disponível entra em retry com espera e não cria categorias arbitrárias',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  product(env,'34567890','Produto para teste da categorização');
  const first=await classifyMonitorMissingCategories(env,{fetcher:async()=>new Response('proibido',{status:403}),at:1700000000,limit:4});
  assert.equal(first.classified,0);
  assert.equal(first.failed,1);
  const retry=await env.DB.prepare("SELECT next_retry_at,attempts FROM ml_monitor_official_category_retry WHERE product_id='MLB34567890'").first();
  assert.equal(retry.attempts,1);
  assert.ok(retry.next_retry_at>1700000000);
  let calls=0;
  const next=await classifyMonitorMissingCategories(env,{fetcher:async()=>{calls++;return response()},at:1700000060,limit:4});
  assert.equal(next.classified,0);
  assert.equal(calls,0);
  assert.equal((await env.DB.prepare("SELECT category FROM ml_monitor_links WHERE product_id='MLB34567890'").first()).category,'Geral');
 }finally{db.close();}
});
test('título genérico usa o código do anúncio para consultar sua categoria real no Mercado Livre',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  product(env,'87654321','Produto Mercado Livre MLB87654321');
  const requests=[];
  const fetcher=async url=>{
   const u=String(url);requests.push(u);
   if(u.includes('/items/MLB87654321'))return new Response(JSON.stringify({
    id:'MLB87654321',category_id:'MLB189007',domain_id:'MLB-ELECTRIC_DRILLS'
   }),{status:200,headers:{'content-type':'application/json'}});
   if(u.endsWith('/categories/MLB189007'))return new Response(JSON.stringify({
    id:'MLB189007',name:'Furadeiras elétricas'
   }),{status:200,headers:{'content-type':'application/json'}});
   throw new Error('endpoint inesperado: '+u);
  };
  const job=await classifyMonitorMissingCategories(env,{fetcher,at:1700000000});
  assert.equal(job.classified,1);
  assert.equal(job.created,1);
  assert.equal(requests.length,2);
  assert.equal(env.DB.prepare("SELECT category FROM ml_monitor_links WHERE product_id='MLB87654321'").first().category,'Furadeiras elétricas');
 }finally{db.close();}
});
test('produto que volta a Geral recupera categoria oficial em cache sem nova consulta externa',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  product(env,'87654322','Furadeira de bancada 220V');
  const first=await classifyMonitorMissingCategories(env,{fetcher:async()=>response(),at:1700000000});
  assert.equal(first.classified,1);
  env.DB.prepare("UPDATE ml_monitor_links SET category='Geral',classification='needs_review' WHERE product_id='MLB87654322'").run();
  const second=await classifyMonitorMissingCategories(env,{fetcher:async()=>{throw Error('não deveria consultar a API');},at:1700000060});
  assert.equal(second.classified,1);
  assert.equal(second.created,0);
  assert.equal(env.DB.prepare("SELECT category FROM ml_monitor_links WHERE product_id='MLB87654322'").first().category,'Furadeiras elétricas');
 }finally{db.close();}
});
test('a tela remove a escolha de categoria única em massa e oferece classificação individual automática',()=>{
 const page=renderPage();
 assert.match(page,/Classificar automaticamente todos/);
 assert.doesNotMatch(page,/id="ml-monitor-bulk-category-select"/);
 assert.match(CLIENT_JS,/\/api\/copy-groups\/categorize/);
});
test('aba COPIAR DE GRUPOS expõe classificação automática e API requer login administrativo',async()=>{
 const page=renderPage();
 assert.match(page,/id="copy-groups-categorize"/);
 assert.match(page,/id="copy-groups-official-status"/);
 assert.match(CLIENT_JS,/\/api\/copy-groups\/categorize/);
 const {env,db}=setup();
 try{
  const res=await worker.fetch(new Request('https://bot.crjornada.com/api/copy-groups/categorize',{method:'POST',headers:{origin:'https://bot.crjornada.com','content-type':'application/json'},body:'{}'}),env);
  assert.equal(res.status,401);
 }finally{db.close();}
});
