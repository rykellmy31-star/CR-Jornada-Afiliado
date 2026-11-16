import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {parseMercadoLivreProduct,previewAffiliateLink,followAffiliateShortlink,connectAffiliateStore} from '../src/affiliate-stores.js';
import {ensureMonitor,addMonitorGroup,saveMonitorSettings,ingestMonitorEvent} from '../src/whatsapp-link-monitor.js';
import {groupCopyEligibility,runGroupCopyScheduled,saveGroupCopySettings} from '../src/group-copy.js';

const LISTING='https://produto.mercadolivre.com.br/MLB-5185081240-tenis-feminino-vili-fusion-masculino-_JM';
const ITEM='https://www.mercadolivre.com.br/furadeira-impacto/p/MLB12345678';
const CATALOG='https://www.mercadolivre.com.br/kit-4-pisca-led-seta-sequencial-cb250-twister-titan-160/up/MLBU1978369947';
const GROUP='120363000111222333@g.us';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){
  let args=[];
  return {bind(...values){args=values;return this;},
   first(){return db.prepare(sql).get(...args)||null;},
   all(){return {results:db.prepare(sql).all(...args)};},
   run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}}
 },async batch(ops){db.exec('BEGIN');try{const results=ops.map(op=>op.run());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}};
 return {env:{DB,MONITOR_WEBHOOK_TOKEN:'unit-test-hook-token-1234567890',
  SESSION_SECRET:'unit-test-secret-long-enough'},db};
}
async function configure(env){
 await ensureMonitor(env);
 await connectAffiliateStore(env,{official_url:'https://meli.la/2XzEMvr'},async()=>new Response(null,{
  status:302,headers:{location:'https://www.mercadolivre.com.br/social/rykellmy_007?matt_word=rykellmy_007&matt_tool=33321398&ref=OFFICIAL'}
 }));
 await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',group_jid:GROUP,group_name:'Grupo autorizado',permission_confirmed:true});
 await saveMonitorSettings(env,{enabled:true});
}
test('conversor aceita /MLB-...-_JM do domínio produto e remove completamente a afiliação anterior',async()=>{
 const normal=parseMercadoLivreProduct(LISTING+'?matt_word=outro&matt_tool=999999&ref=ref_fake#recommendations');
 assert.equal(normal,LISTING);
 assert.equal(parseMercadoLivreProduct(ITEM+'?matt_word=outro'),ITEM);
 assert.equal(parseMercadoLivreProduct(CATALOG+'#polycard_client=any'),CATALOG);
 const {env,db}=fixture();
 try{
  await configure(env);
  const preview=await previewAffiliateLink(env,{product_url:LISTING+'?matt_word=outro&matt_tool=999999'});
  assert.equal(preview.product_url,LISTING);
  assert.equal(new URL(preview.target_url).hostname,'produto.mercadolivre.com.br');
  assert.equal(new URL(preview.target_url).pathname,new URL(LISTING).pathname);
  assert.equal(new URL(preview.target_url).searchParams.get('matt_word'),'rykellmy_007');
  assert.equal(new URL(preview.target_url).searchParams.get('matt_tool'),'33321398');
  assert.ok(!preview.target_url.includes('outro'));
  assert.equal(preview.commission_verified,false);
 }finally{db.close();}
});
test('recusa hosts parecidos, URL com credenciais e páginas que não sejam produtos',()=>{
 for(const link of [
  'https://produto.mercadolivre.com.br.evil.test/MLB-5185081240-tenis-_JM',
  'https://produto.mercadolivre.com.br@evil.test/MLB-5185081240-tenis-_JM',
  'https://produto.mercadolivre.com.br/social/rykellmy_007?ref=falso',
  'https://produto.mercadolivre.com.br/search?q=MLB-5185081240',
  'https://produto.mercadolivre.com.br/MLB-5185081240-tenis-_JM/redirect',
  'https://meli.promo/s/4MfRbJ',
  'http://produto.mercadolivre.com.br/MLB-5185081240-tenis-_JM'
 ])assert.throws(()=>parseMercadoLivreProduct(link));
});
test('monitor detecta item em www/MLB e host produto e consegue enfileirar anúncio real pelo próprio ID',async()=>{
 const {env,db}=fixture();
 try{
  await configure(env);
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
   data:{key:{remoteJid:GROUP,fromMe:false,id:'captura-produto-1'},
    message:{conversation:'Tênis feminino em oferta '+LISTING+'?matt_word=outra_etiqueta&matt_tool=999999'}}});
  const found=env.DB.prepare('SELECT product_id,source_url FROM ml_monitor_links LIMIT 1').first();
  assert.equal(found.product_id,'MLB5185081240');
  assert.equal(found.source_url,LISTING);
  env.DB.prepare("UPDATE ml_monitor_links SET category='Moda e Acessórios',classification='selected' WHERE product_id=?").bind(found.product_id).run();
  env.DB.prepare("INSERT INTO ml_monitor_site_prices(product_id,price_cents,status,checked_at,tries,method) VALUES(?,5990,'ok',?,1,'public')")
   .bind(found.product_id,Math.floor(Date.now()/1000)).run();
  assert.equal((await groupCopyEligibility(env)).ready,1);
  await saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true});
  const result=await runGroupCopyScheduled(env);
  assert.equal(result.queued,1,JSON.stringify(result));
  assert.equal(result.product_id,found.product_id);
  const offer=env.DB.prepare('SELECT affiliate_url,price_cents,status FROM offers LIMIT 1').first();
  const u=new URL(offer.affiliate_url);
  assert.equal(u.hostname,'produto.mercadolivre.com.br');
  assert.equal(u.pathname,new URL(LISTING).pathname);
  assert.equal(u.searchParams.get('matt_word'),'rykellmy_007');
  assert.equal(u.searchParams.get('matt_tool'),'33321398');
  assert.ok(!offer.affiliate_url.includes('outra_etiqueta'));
  assert.equal(offer.price_cents,5990);
  assert.equal(offer.status,'ready');
  const code=new URL(result.short_url).pathname.slice(1);
  const redir=await followAffiliateShortlink(env,code);
  assert.equal(redir.status,302);
  assert.equal(redir.headers.get('location'),offer.affiliate_url);
  assert.equal((await runGroupCopyScheduled(env)).queued,undefined);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,1);
 }finally{db.close();}
});
test('ID do link diferente do produto capturado bloqueia a publicação mesmo com preço confirmado',async()=>{
 const {env,db}=fixture();
 try{
  await configure(env);
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
   data:{key:{remoteJid:GROUP,fromMe:false,id:'captura-2'},message:{conversation:'Furadeira profissional '+ITEM}}});
  const found=env.DB.prepare('SELECT product_id FROM ml_monitor_links LIMIT 1').first();
  env.DB.prepare('UPDATE ml_monitor_links SET source_url=?,category=?,classification=? WHERE product_id=?')
   .bind(LISTING,'Moda e Acessórios','selected',found.product_id).run();
  env.DB.prepare("INSERT INTO ml_monitor_site_prices(product_id,price_cents,status,checked_at,tries,method) VALUES(?,5990,'ok',?,1,'public')")
   .bind(found.product_id,Math.floor(Date.now()/1000)).run();
  const e=await groupCopyEligibility(env);
  assert.equal(e.ready,0);
  assert.equal(e.blocked.link_incompativel,1);
  await saveGroupCopySettings(env,{enabled:true,experimental_acknowledged:true});
  const result=await runGroupCopyScheduled(env);
  assert.equal(result.queued,undefined);
  assert.equal(env.DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{db.close();}
});
test('PromoML nunca redireciona para host não autorizado nem página de busca',async()=>{
 const {env,db}=fixture();
 try{
  await configure(env);
  const code='AbCdEf123_-X';
  env.DB.prepare("INSERT INTO crj_affiliate_shortlinks(code,product_url,target_url,label,created_at) VALUES(?,?,?,?,?)")
   .bind(code,LISTING,'https://produto.mercadolivre.com.br.evil.test/MLB-5185081240-tenis-_JM','rykellmy_007',0).run();
  assert.equal((await followAffiliateShortlink(env,code)).status,410);
  env.DB.prepare('UPDATE crj_affiliate_shortlinks SET target_url=? WHERE code=?')
   .bind('https://produto.mercadolivre.com.br/search?q=MLB-5185081240',code).run();
  assert.equal((await followAffiliateShortlink(env,code)).status,410);
 }finally{db.close();}
});
