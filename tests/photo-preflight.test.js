import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {prewarmTelegramQueue} from '../src/photo-preflight.js';
import {cachedProductImage} from '../src/offer-images.js';
import {runScheduled} from '../src/index.js';
const SHORT='https://meli.la/2ESKGQw';
const PREVIEW='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-P.webp';
const LARGE='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-F.jpg';
const SOURCE='https://www.mercadolivre.com.br/oferta-verificada/p/MLB12345678';
function setup(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 sqlite.exec("CREATE TABLE ml_link_batch_items(id INTEGER PRIMARY KEY,source_url TEXT,affiliate_url TEXT,status TEXT)");
 sqlite.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')").run(SOURCE,SHORT);
 const DB={prepare(sql){let params=[];return{
  bind(...values){params=values;return this;},
  first(){return sqlite.prepare(sql).get(...params)||null;},
  all(){return {results:sqlite.prepare(sql).all(...params)};},
  run(){const r=sqlite.prepare(sql).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
 };}};
 const env={DB,TELEGRAM_BOT_TOKEN:'SIMULATED_TELEGRAM_TOKEN'};
 DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=1,max_daily=48,start_hour=0,end_hour=24").run();
 DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,price_cents,created_at) VALUES(?,?,?,'ready',3490,?)")
  .bind('Tapete antiderrapante para banheiro',SHORT,'Geral',Math.floor(Date.now()/1000)).run();
 return {DB,env,close:()=>sqlite.close()};
}
function mockImageFetch(counter){
 return async(url,options={})=>{
  const u=String(url);
  if(u===SOURCE)return new Response('<meta property="og:image" content="'+PREVIEW+'"><link rel="canonical" href="'+SOURCE+'"><script type="application/ld+json">'+JSON.stringify({'@type':'Product',url:SOURCE,offers:{'@type':'Offer',price:'79.90',priceCurrency:'BRL'}})+'</script>',{headers:{'content-type':'text/html'}});
  if(u===SHORT){counter.reads++;return new Response('<meta property="og:image" content="'+PREVIEW+'">',{headers:{'content-type':'text/html'}});}
  if(u===LARGE&&options.method==='HEAD')
   return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'260000'}});
  if(u.includes('api.telegram.org')&&u.includes('/getChat?'))
   return Response.json({ok:true,result:{type:'channel'}});
  if(u.endsWith('/sendPhoto')){counter.photos++;assert.equal(JSON.parse(options.body).photo,LARGE);return Response.json({ok:true,result:{message_id:6565}});}
  throw Error('URL inesperada: '+u);
 };
}
test('foto preparada antes do horário é reaproveitada no automático',async()=>{
 const {DB,env,close}=setup(),original=globalThis.fetch,counter={reads:0,photos:0};
 try{
  globalThis.fetch=mockImageFetch(counter);
  assert.equal((await prewarmTelegramQueue(env)).status,'photo_ready');
  assert.equal(await cachedProductImage(env,SHORT),LARGE);
  assert.equal((await runScheduled(env)).status,'published');
  assert.equal(DB.prepare('SELECT status FROM offers WHERE id=1').first().status,'published');
  assert.equal(counter.photos,1);
  assert.equal(counter.reads,0,'foto preparada a partir do anúncio original, sem usar o encurtador');
 }finally{globalThis.fetch=original;close();}
});
test('foto recuperada reabilita apenas falha explícita segura e limpa retries',async()=>{
 const {DB,env,close}=setup(),original=globalThis.fetch,counter={reads:0,photos:0};
 try{
  DB.prepare("UPDATE offers SET status='needs_review',last_error=? WHERE id=1")
   .bind('Foto real indisponível após seis tentativas automáticas. Nenhum texto foi enviado.').run();
  DB.prepare('CREATE TABLE telegram_photo_retries(offer_id INTEGER PRIMARY KEY,attempts INTEGER,next_retry_at INTEGER,reason TEXT,updated_at INTEGER)').run();
  DB.prepare("INSERT INTO telegram_photo_retries VALUES(1,6,9999999999,'Sem foto',1)").run();
  globalThis.fetch=mockImageFetch(counter);
  assert.equal((await prewarmTelegramQueue(env)).status,'photo_ready');
  assert.equal(DB.prepare('SELECT status FROM offers WHERE id=1').first().status,'ready');
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM telegram_photo_retries').first().n,0);
 }finally{globalThis.fetch=original;close();}
});
