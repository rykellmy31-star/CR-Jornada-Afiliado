import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {resolveProductImageWithRetry,cachedProductImage} from '../src/offer-images.js';
import {resolveOfferSource} from '../src/automatic-price.js';
import {findProductImage} from '../src/images.js';
import {photoForWhatsApp} from '../src/whatsapp-photo.js';
import {sendTelegramProductPhoto} from '../src/telegram-photo.js';
import {runScheduled} from '../src/index.js';

const SHORT='https://meli.la/276cd5n';
const SOCIAL='https://www.mercadolivre.com.br/social/rykellmy_007';
const PRODUCT='https://www.mercadolivre.com.br/jogo-de-ferramentas-com-110-pecas-embalagem-fechada-vonder/p/MLB28575093';
const PHOTO='https://http2.mlstatic.com/D_Q_NP_2X_938176-MLA99494925644_112025-V.webp';
const WRONG='https://www.mercadolivre.com.br/soquete-nao-relacionado/p/MLB99999999';
const card='<html><section class="rl-card-featured-wrapper"><div class="poly-card">'+
 '<img class="poly-component__picture" src="'+PHOTO+'">'+
 '<a class="poly-component__title" href="'+PRODUCT+'?matt_tool=999#c_id=/home/card-featured/element">Jogo Vonder</a>'+
 '<div class="poly-component__price">'+
 '<s class="poly-price__previous"><span class="andes-money-amount__currency-symbol">R$</span>'+
 '<span class="andes-money-amount__fraction">639</span><span class="andes-money-amount__cents">99</span></s>'+
 '<div class="poly-price__current"><span class="andes-money-amount__currency-symbol">R$</span>'+
 '<span class="andes-money-amount__fraction">432</span><span class="andes-money-amount__cents">25</span></div></div>'+
 '<a class="poly-component__link poly-component__link--action-link" href="'+PRODUCT+'">Ir para produto</a>'+
 '</div></section><section class="rl-card-recommendations"><a href="'+WRONG+'">Ir para produto</a></section></html>';
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){let args=[];return{
  bind(...v){args=v;return this;},
  first(){return db.prepare(sql).get(...args)||null;},
  all(){return {results:db.prepare(sql).all(...args)};},
  run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
 };},close(){db.close();}};
 return {DB,env:{DB,TELEGRAM_BOT_TOKEN:'TEST_BOT_TOKEN'}};
}
function fakeFetch(track){
 return async(url,options={})=>{
  const u=String(url);track.push({url:u,options});
  if(u===SHORT)return new Response(null,{status:302,headers:{location:SOCIAL}});
  if(u===SOCIAL)return new Response(card,{headers:{'content-type':'text/html'}});
  if(u===PRODUCT)return new Response('Acesso ao anúncio limitado',{status:403});
  if(u===PHOTO){
   if(options.method==='HEAD')return new Response(null,{status:200,headers:{'content-type':'image/webp','content-length':'177000'}});
   if(options.cf?.image?.format==='jpeg')return new Response('JPG-convertido-da-foto-original',{headers:{'content-type':'image/jpeg','content-length':'32'}});
   return new Response('arquivo-webp-original',{headers:{'content-type':'image/webp'}});
  }
  if(/^https:\/\/http2\.mlstatic\.com\/D_/.test(u))return new Response(null,{status:404});
  if(u.includes('/sendPhoto')){
   if(options.body instanceof FormData){
    assert.equal(options.body.get('photo').type,'image/jpeg');
    assert.match(options.body.get('caption'),/276cd5n/);
    return Response.json({ok:true,result:{message_id:101}});
   }
   assert.equal(JSON.parse(options.body).photo,PHOTO);
   return Response.json({ok:false,description:'Bad Request: failed to get HTTP URL content'},{status:400});
  }
  if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
  if(u.includes('/sendMessage'))throw Error('Proibido enviar texto em lugar da foto');
  throw Error('URL inesperada: '+u);
 };
}
test('vitrine CR DIVULGA recupera foto VONDER apesar de MLB 403, sem pegar recomendações',async()=>{
 const {DB,env}=setup(),original=globalThis.fetch,track=[];
 try{
  globalThis.fetch=fakeFetch(track);
  const image=await resolveProductImageWithRetry(env,SHORT,findProductImage,{retryOnMiss:true,sourceLookup:resolveOfferSource});
  assert.equal(image,PHOTO);
  assert.equal(await cachedProductImage(env,SHORT),PHOTO);
  const source=DB.prepare('SELECT source_url FROM affiliate_verified_sources WHERE affiliate_url=?').bind(SHORT).first();
  assert.equal(source?.source_url,PRODUCT);
  assert.equal(track.some(x=>x.url===WRONG),false);
  const wa=await photoForWhatsApp(image);
  assert.equal(wa.mimetype,'image/jpeg');
  assert.equal(Buffer.from(wa.media.split(',')[1],'base64').toString(),'JPG-convertido-da-foto-original');
  const tg=await sendTelegramProductPhoto('TEST_BOT_TOKEN','@achadinhosmlcr',image,{text:'Jogo Vonder\n'+SHORT});
  assert.equal(tg.message_id,101);
 }finally{globalThis.fetch=original;DB.close();}
});
test('cron publica VONDER sozinho com imagem, sem botão manual',async()=>{
 const {DB,env}=setup(),original=globalThis.fetch,track=[];
 try{
  globalThis.fetch=fakeFetch(track);
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=1,start_hour=0,end_hour=24,max_daily=48 WHERE id=1").run();
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,price_cents) VALUES(?,?,?,?,'ready',43225)")
   .bind('Jogo de ferramentas com 110 peças Vonder',SHORT,'Geral',Math.floor(Date.now()/1000)).run();
  const outcome=await runScheduled(env);
  assert.equal(outcome.status,'published',JSON.stringify(outcome));
  assert.equal(outcome.format,'photo');
  assert.equal(DB.prepare('SELECT status FROM offers WHERE id=1').first().status,'published');
  assert.equal(track.some(x=>x.url.includes('/sendMessage')),false);
  assert.equal(track.filter(x=>x.url.includes('/sendPhoto')&&x.options.body instanceof FormData).length,1);
 }finally{globalThis.fetch=original;DB.close();}
});
