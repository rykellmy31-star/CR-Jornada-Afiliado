import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {renderPage,CLIENT_JS} from '../src/ui.js';
import {ensureMonitor,addMonitorGroup,saveMonitorSettings,ingestMonitorEvent} from '../src/whatsapp-link-monitor.js';
import {connectAffiliateStore} from '../src/affiliate-stores.js';
import {groupCopyState,saveGroupCopySettings,runGroupCopyScheduled,testGroupCopyImport,selectGroupCopyPrice} from '../src/group-copy.js';
import {extractPromotionTerms,safePromotionTerms} from '../src/promotion-terms.js';
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
  await assert.rejects(testGroupCopyImport(env),/Ative e salve a importação/);
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
  const dry=await testGroupCopyImport(env);
  assert.equal(dry.result.skipped,'awaiting_verified_price');
  assert.equal(dry.state.readiness.with_price,0);
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


test('mensagem do grupo extrai De/Por com R$ riscado sem confundir parcelas',()=>{
 const terms=extractPromotionTerms('OFERTA! De: R$ ~363,18~ 🔥 Por: R$ 214,27 \n 5x no cartão');
 assert.equal(terms.price_cents,21427);
 assert.equal(terms.old_price_cents,36318);
 assert.equal(terms.installments,5);
 assert.equal(terms.installment_cents,null);
 const other=extractPromotionTerms('Tênis original de ~R$ 49~ por R$ 22 • Frete grátis');
 assert.equal(other.price_cents,2200);
 assert.equal(other.old_price_cents,4900);
 assert.equal(extractPromotionTerms('Só parcelamento em 8x sem juros').price_cents,null);
});
test('preço do grupo é usado apenas com origem, valor consistente e prazo de seis horas',()=>{
 const at=1794800000;
 const terms=extractPromotionTerms('De: R$ ~199,90~ Por: R$ 79,90');
 const item={product_id:'MLB12345678',message_id:'msg-price',site_status:'unavailable',
  group_deal_json:JSON.stringify(terms),group_price_cents:7990,group_checked_at:at-300};
 const result=selectGroupCopyPrice(item,at);
 assert.equal(result.price,7990);
 assert.equal(result.source,'grupo');
 assert.equal(result.terms.price_source,'grupo');
 assert.equal(safePromotionTerms(result.terms).old_price_cents,19990);
 assert.equal(selectGroupCopyPrice({...item,group_price_cents:2990},at),null,'preço não corresponde à mensagem');
 assert.equal(selectGroupCopyPrice({...item,group_checked_at:at-7*3600},at),null,'preço antigo não pode virar promoção nova');
 assert.equal(selectGroupCopyPrice({...item,message_id:''},at),null,'sem mensagem original não usar preço');
 assert.equal(selectGroupCopyPrice({...item,group_price_cents:300,group_deal_json:JSON.stringify({...terms,price_cents:300})},at),null,'valor suspeito requer revisão');
 const site=selectGroupCopyPrice({...item,price_cents:8490,checked_at:at-120,site_status:'ok'},at);
 assert.equal(site.price,8490);
 assert.equal(site.source,'mercadolivre','preço oficial recente tem prioridade');
});
test('COPIAR DE GRUPOS importa preço recuperado da própria mensagem sem consulta pública',async()=>{
 const {env,db}=setup();
 try{
  await seed(env);
  // Nova mensagem do MESMO produto, captada com preço explícito no grupo.
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
   data:{key:{remoteJid:GROUP,fromMe:false,id:'msg-oferta-preco'},message:{
    conversation:'Furadeira em oferta De: R$ ~129,90~ 🔥 Por: R$ 45,90 '+PRODUCT
   }}});
  const id=env.DB.prepare('SELECT product_id FROM ml_monitor_links LIMIT 1').first().product_id;
  const meta=env.DB.prepare('SELECT last_seen_price_cents,last_seen_deal_json FROM ml_monitor_product_meta WHERE product_id=?').bind(id).first();
  assert.equal(meta.last_seen_price_cents,4590,'preço do grupo capturado no webhook');
  assert.equal(JSON.parse(meta.last_seen_deal_json).old_price_cents,12990);
  await saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true});
  const state=await groupCopyState(env);
  assert.equal(state.readiness.with_group_price,1);
  assert.equal(state.readiness.with_price,1);
  assert.equal(state.readiness.needs_price,0);
  const result=await runGroupCopyScheduled(env);
  assert.equal(result.queued,1,JSON.stringify(result));
  const offer=env.DB.prepare('SELECT * FROM offers').first();
  assert.equal(offer.status,'ready');
  assert.equal(offer.price_cents,4590);
  assert.equal(offer.old_price_cents,12990);
  assert.equal(JSON.parse(offer.promo_terms_json).price_source,'grupo');
  assert.equal(JSON.parse(offer.promo_terms_json).price_cents,4590);
  assert.equal((await runGroupCopyScheduled(env)).queued,undefined,'não duplicar oferta');
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,1);
 }finally{db.close();}
});
