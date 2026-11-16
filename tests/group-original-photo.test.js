import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {captureGroupOriginalPhotos,groupOriginalPhotoForOffer,sendTelegramOriginalPhoto,restoreGroupPhotosForQueue}
 from '../src/group-original-photo.js';
import {runScheduled} from '../src/index.js';
import {runWhatsAppScheduled,updateWhatsAppSettings} from '../src/whatsapp.js';
import {photoForWhatsApp} from '../src/whatsapp-photo.js';
import {readFileSync} from 'node:fs';

const INST='grupo-captura';
const GROUP='120363123456789@g.us';
const ORIGINAL='https://www.mercadolivre.com.br/perfume-123/p/MLB12345678';
const AFF='https://meli.la/ATEST987654';
const fakeImage=btoa(String.fromCharCode(255,216,255,...Array(155).fill(2)));
const entry=(caption='Veja https://meli.la/ATEST987654',jid=GROUP,fromMe=false)=>({
 key:{remoteJid:jid,id:'MSG_IMAGE_2026_01',fromMe},
 messageType:'imageMessage',
 message:{imageMessage:{caption,mimetype:'image/jpeg',fileLength:12000}}
});
function setup({full=false}={}){
 const db=new DatabaseSync(':memory:');
 if(full)db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 db.exec("CREATE TABLE ml_monitor_settings(id INTEGER PRIMARY KEY,enabled INTEGER)");
 db.exec("INSERT INTO ml_monitor_settings(id,enabled) VALUES(1,1)");
 db.exec("CREATE TABLE ml_monitor_groups(id INTEGER PRIMARY KEY,instance_name TEXT,group_jid TEXT,enabled INTEGER,authorized INTEGER)");
 db.exec("INSERT INTO ml_monitor_groups VALUES(1,'"+INST+"','"+GROUP+"',1,1)");
 db.exec("CREATE TABLE ml_monitor_links(group_id INTEGER,message_id TEXT,source_url TEXT)");
 db.exec("INSERT INTO ml_monitor_links VALUES(1,'MSG_IMAGE_2026_01','"+ORIGINAL+"')");
 db.exec("CREATE TABLE ml_link_batch_items(source_url TEXT,affiliate_url TEXT)");
 db.exec("INSERT INTO ml_link_batch_items VALUES('"+ORIGINAL+"','"+AFF+"')");
 const DB={prepare(sql){let args=[];return{
  bind(...v){args=v;return this;},
  first(){return db.prepare(sql).get(...args)||null;},
  all(){return {results:db.prepare(sql).all(...args)};},
  run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}
 };}};
 const env={DB,EVOLUTION_API_URL:'https://evo.example.com',EVOLUTION_API_KEY:'TEST_KEY'};
 return {env,DB,close:()=>db.close()};
}
const event=(e)=>({event:'messages.upsert',instance:INST,data:{...e}});
test('captura mídia Evolution apenas do grupo autorizado e associa à oferta exata',async()=>{
 const {env,close}=setup();let calls=0;
 try{
  const found=await captureGroupOriginalPhotos(env,event(entry()),{fetcher:async(u,opts)=>{
   calls++;
   assert.match(String(u),/getBase64FromMediaMessage\/grupo-captura$/);
   const payload=JSON.parse(opts.body);
   assert.equal(payload.message.messageType,'imageMessage');
   assert.equal(payload.message.key.remoteJid,GROUP);
   return Response.json({base64:fakeImage,mimetype:'image/jpeg'});
  }});
  assert.equal(found.captured,1);
  assert.equal(calls,1);
  assert.equal((await groupOriginalPhotoForOffer(env,AFF)).image_b64,fakeImage);
  assert.equal(await groupOriginalPhotoForOffer(env,'https://meli.la/OUTRA123'),null);
 }finally{close();}
});
test('imagem de grupo não autorizado, sem link ou enviada pelo próprio número é rejeitada',async()=>{
 const {env,close}=setup();let called=0;
 try{
  const fetcher=()=>{called++;throw Error('Não consultar mídia não autorizada');};
  for(const e of [entry('https://meli.la/ATEST987654','120363888888888@g.us'),
   entry('Somente uma foto'),entry('https://meli.la/ATEST987654',GROUP,true)]){
   assert.equal((await captureGroupOriginalPhotos(env,event(e),{fetcher})).captured,0);
  }
  assert.equal(called,0);
 }finally{close();}
});
test('foto de outra URL externa e dados não JPEG são recusados',async()=>{
 const {env,close}=setup();
 try{
  const b=await captureGroupOriginalPhotos(env,event(entry('https://evil.example/img')),{fetcher:async()=>Response.json({base64:fakeImage,mimetype:'image/jpeg'})});
  assert.equal(b.captured,0);
  const wrong=await captureGroupOriginalPhotos(env,event(entry()),{fetcher:async()=>Response.json({base64:fakeImage,mimetype:'image/png'})});
  assert.equal(wrong.captured,0);
  assert.equal(await groupOriginalPhotoForOffer(env,AFF),null);
 }finally{close();}
});
test('Telegram transmite foto original como arquivo com legenda e botões',async()=>{
 const {env,close}=setup();
 try{
  const response=await sendTelegramOriginalPhoto('TEST_TOKEN','@example',
   {mime:'image/jpeg',image_b64:fakeImage},
   {text:'📣 Publicidade • teste',parse_mode:'HTML',reply_markup:{inline_keyboard:[]}},
   {fetcher:async(url,opts)=>{
    assert.match(url,/sendPhoto$/);
    assert.equal(opts.body.get('chat_id'),'@example');
    assert.equal(opts.body.get('caption'),'📣 Publicidade • teste');
    assert.equal(opts.body.get('photo').type,'image/jpeg');
    return Response.json({ok:true,result:{message_id:7733}});
   }});
  assert.equal(response.message_id,7733);
 }finally{close();}
});
test('Cron publica oferta com foto do grupo, sem baixar mídia do Mercado Livre e sem duplicar',async()=>{
 const {env,DB,close}=setup({full:true}),old=globalThis.fetch;let photos=0;
 try{
  env.TELEGRAM_BOT_TOKEN='TEST_TOKEN';
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=2,max_daily=48,start_hour=0,end_hour=24").run();
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,price_cents,created_at) VALUES(? ,?,'Geral','ready',7990,?)")
   .bind('Perfume promocional original',AFF,Math.floor(Date.now()/1000)).run();
  const capture=await captureGroupOriginalPhotos(env,event(entry()),{fetcher:async()=>Response.json({base64:fakeImage,mimetype:'image/jpeg'})});
  assert.equal(capture.captured,1);
  globalThis.fetch=async(url,options={})=>{
   const u=String(url);
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendPhoto')){
    photos++;
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('photo').type,'image/jpeg');
    return Response.json({ok:true,result:{message_id:9977}});
   }
   throw Error('Não consultar foto da loja: '+u);
  };
  const result=await runScheduled(env);
  assert.equal(result.status,'published');
  assert.equal(photos,1);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'published');
  assert.equal((await runScheduled(env)).skipped,'interval_or_schedule');
 }finally{globalThis.fetch=old;close();}
});


test('recupera foto histórica de oferta na fila usando somente mensagem do grupo autorizado',async()=>{
 const {env,DB,close}=setup({full:true});
 let searches=0,images=0;
 try{
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,price_cents,created_at) VALUES(?,?,'Geral','ready',7990,?)")
   .bind('Perfume sem foto na fila',AFF,Math.floor(Date.now()/1000)).run();
  const fetcher=async(url,options)=>{
   const u=String(url);
   if(u.endsWith('/chat/findMessages/'+INST)){
    searches++;
    assert.equal(JSON.parse(options.body).where.key.id,'MSG_IMAGE_2026_01');
    return Response.json({messages:{records:[entry()]}});
   }
   if(u.endsWith('/chat/getBase64FromMediaMessage/'+INST)){
    images++;
    return Response.json({base64:fakeImage,mimetype:'image/jpeg'});
   }
   throw Error('URL não prevista '+u);
  };
  const restored=await restoreGroupPhotosForQueue(env,{fetcher});
  assert.equal(restored.restored,1);
  assert.equal(searches,1);
  assert.equal(images,1);
  assert.equal((await groupOriginalPhotoForOffer(env,AFF)).image_b64,fakeImage);
  assert.equal((await restoreGroupPhotosForQueue(env,{fetcher})).skipped,'no_pending_images');
  assert.equal(searches,1,'nenhuma tentativa duplicada da mesma mensagem');
 }finally{close();}
});


test('Evolution envia imagem copiada do grupo como Base64 puro, sem prefixo data URI',async()=>{
 const {env,DB,close}=setup({full:true}),previous=globalThis.fetch;
 const GROUP_TARGET='120363888777555@g.us';
 let media=0,txt=0;
 try{
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u.includes('/group/fetchAllGroups/'))
    return Response.json([{id:GROUP_TARGET,subject:'Grupo teste'}]);
   if(u.endsWith('/message/sendMedia/'+INST)){
    const payload=JSON.parse(opts.body);
    media++;
    assert.equal(payload.mediatype,'image');
    assert.equal(payload.mimetype,'image/jpeg');
    assert.equal(payload.media,fakeImage,'Evolution deve receber a string Base64 sem prefixo HTML');
    assert.ok(!payload.media.startsWith('data:'),'data: URI provocou HTTP 400 em produção');
    assert.equal(payload.number,GROUP_TARGET);
    assert.match(payload.caption,/Publicidade/);
    assert.match(payload.caption,/meli\.la/);
    return Response.json({key:{id:'EVOLUTION_CONFIRMED'}});
   }
   if(u.includes('/message/sendText/')){txt++;throw Error('Não usar texto');}
   throw Error('fetch inesperado '+u);
  };
  const cfg={instance_name:INST,group_jid:GROUP_TARGET,public_registered:false,enabled:false,interval_minutes:2};
  await updateWhatsAppSettings(env,cfg);
  await updateWhatsAppSettings(env,{...cfg,public_registered:true,enabled:true});
  const time=Math.floor(Date.now()/1000);
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,price_cents,created_at,published_at,published_day) VALUES(?,?,'Geral','published',7990,?,?,?)")
   .bind('Perfume original com foto',AFF,time,time,new Date().toISOString().slice(0,10)).run();
  const captured=await captureGroupOriginalPhotos(env,event(entry()),{fetcher:async()=>Response.json({base64:fakeImage,mimetype:'image/jpeg'})});
  assert.equal(captured.captured,1);
  const result=await runWhatsAppScheduled(env);
  assert.equal(result.status,'sent');
  assert.equal(media,1);
  assert.equal(txt,0);
  assert.equal(DB.prepare("SELECT status FROM whatsapp_deliveries WHERE offer_id=1").first().status,'sent');
 }finally{globalThis.fetch=previous;close();}
});
test('WebP convertido usa Base64 cru no sendMedia, preserva JPG oficial sem alteração',async()=>{
 const imageUrl='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-P.webp';
 const image=Uint8Array.from(atob(fakeImage),x=>x.charCodeAt(0));
 const result=await photoForWhatsApp(imageUrl,{fetcher:async(url,options)=>{
  assert.equal(url,imageUrl);
  assert.equal(options.cf.image.format,'jpeg');
  return new Response(image,{headers:{'content-type':'image/jpeg'}});
 }});
 assert.equal(result.media,fakeImage);
 assert.equal(result.mimetype,'image/jpeg');
 assert.equal(result.filename,'produto.jpg');
});
