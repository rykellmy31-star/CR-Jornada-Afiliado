import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker,{runScheduled} from '../src/index.js';
import {runWhatsAppScheduled,updateWhatsAppSettings} from '../src/whatsapp.js';
import {telegramSentPhoto,rememberTelegramSentPhoto,cachedProductImage} from '../src/offer-images.js';

const SHORT='https://meli.la/2ESKGQw';
const PHOTO_PREVIEW='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-P.webp';
const PHOTO_LARGE='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-F.jpg';
const ORIGIN='https://afiliados.example.test',EVOLUTION='https://evo.example.com';
const INSTANCE='afiliados',GROUP='120363888999777@g.us';
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){let params=[];return{
  bind(...v){params=v;return this;},
  first(){return db.prepare(sql).get(...params)||null;},
  all(){return{results:db.prepare(sql).all(...params)};},
  run(){const r=db.prepare(sql).run(...params);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
 };},close(){db.close();}};
 return {DB,env:{DB,ADMIN_PASSWORD:'sample_test_admin_pw',SESSION_SECRET:'sample_test_session_key_123456789',
  TELEGRAM_BOT_TOKEN:'SIMULATED_TELEGRAM_TOKEN',EVOLUTION_API_URL:EVOLUTION,EVOLUTION_API_KEY:'SIMULATED_KEY'}};
}
function req(path,{cookie,method='GET',body}={}){
 const headers={};if(cookie)headers.cookie=cookie;
 if(body!==undefined){headers['content-type']='application/json';headers.origin=ORIGIN;}
 return new Request(ORIGIN+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}
async function setupWhatsApp(env){
 await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,interval_minutes:1});
 await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:true,enabled:true,interval_minutes:1});
}

for(const delivery of ['manual','automatic']){
 test('Telegram '+delivery+' envia foto REAL e WhatsApp automático usa exatamente a mesma mídia sem nova consulta do link',async()=>{
  const {DB,env}=setup(),old=globalThis.fetch;
  let tgPhoto=0,waMedia=0,waText=0,shortReads=0,postTelegram=false,verifiedPhoto=null;
  try{
   globalThis.fetch=async(url,opts={})=>{
    const u=String(url);
    if(u===EVOLUTION+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false')
     return Response.json([{id:GROUP,subject:'Achadinhos'}]);
    if(u.includes('api.telegram.org')&&u.includes('/getChat?'))
     return Response.json({ok:true,result:{type:'channel'}});
    if(u===SHORT){
     if(postTelegram)throw Error('WhatsApp não deveria voltar a consultar o link, a foto foi enviada no Telegram');
     shortReads++;
     return new Response('<html><meta property="og:image" content="'+PHOTO_PREVIEW+'"></html>',{
      headers:{'content-type':'text/html'}});
    }
    if(u===PHOTO_LARGE&&opts.method==='HEAD')
     return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'250000'}});
    if(u==='https://api.telegram.org/botSIMULATED_TELEGRAM_TOKEN/sendPhoto'){
     const payload=JSON.parse(opts.body);
     tgPhoto++;
     verifiedPhoto=payload.photo;
     assert.equal(verifiedPhoto,PHOTO_LARGE);
     assert.match(payload.caption,/Cebolinha/);
     return Response.json({ok:true,result:{message_id:7171}});
    }
    if(u===EVOLUTION+'/message/sendMedia/'+INSTANCE){
     waMedia++;
     const payload=JSON.parse(opts.body);
     assert.equal(payload.media,verifiedPhoto,'WhatsApp deve usar a foto realmente confirmada no Telegram');
     assert.equal(payload.number,GROUP);
     assert.match(payload.caption,/https:\/\/meli\.la\/2ESKGQw/);
     return Response.json({key:{id:'EVOLUTION_MEDIA_CONFIRMED'}});
    }
    if(u===EVOLUTION+'/message/sendText/'+INSTANCE){waText++;throw Error('Não pode usar sendText');}
    throw Error('Requisição inesperada '+u);
   };
   await setupWhatsApp(env);
   DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=1,max_daily=48,start_hour=0,end_hour=24 WHERE id=1").run();
   const now=Math.floor(Date.now()/1000);
   DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at) VALUES(?,?,?,'ready',?)")
    .bind('Kit 3 Perfumes Cebolinha Jequiti',SHORT,'Geral',now).run();
   if(delivery==='manual'){
    const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const published=await worker.fetch(req('/api/offers/1/publish',{method:'POST',cookie,body:{}}),env);
    assert.equal(published.status,200);
    assert.equal((await published.json()).format,'photo');
   }else{
    const published=await runScheduled(env);
    assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'published');
   }
   assert.equal(tgPhoto,1);
   assert.equal(await telegramSentPhoto(env,SHORT),PHOTO_LARGE);
   assert.equal(await cachedProductImage(env,SHORT),PHOTO_LARGE);
   assert.equal(DB.prepare('SELECT message_id FROM affiliate_telegram_sent_photos WHERE affiliate_url=?').bind(SHORT).first().message_id,'7171');
   postTelegram=true;
   const result=await runWhatsAppScheduled(env);
   assert.equal(result.status,'sent');
   assert.equal(result.format,'photo');
   assert.equal(waMedia,1);
   assert.equal(waText,0);
   assert.equal(shortReads,1,'somente Telegram consultou o link; WhatsApp reaproveitou a foto gravada');
   assert.equal(DB.prepare('SELECT status FROM whatsapp_deliveries').first().status,'sent');
   assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
  }finally{globalThis.fetch=old;DB.close();}
 });
}
test('não compartilhar mídia sem confirmação real de sendPhoto ou com URL externa',async()=>{
 const {env,DB}=setup();
 try{
  assert.equal(await rememberTelegramSentPhoto(env,SHORT,'https://outro-site.com/foto.jpg',1001),false);
  assert.equal(await rememberTelegramSentPhoto(env,SHORT,PHOTO_LARGE,0),false);
  assert.equal(await telegramSentPhoto(env,SHORT),null);
  assert.equal(await rememberTelegramSentPhoto(env,SHORT,PHOTO_LARGE,1001),true);
  assert.equal(await telegramSentPhoto(env,SHORT),PHOTO_LARGE);
  assert.equal(await telegramSentPhoto(env,'https://meli.la/OUTROLINK'),null);
  assert.equal(await telegramSentPhoto(env,'https://shopee.com.br/produto'),null);
 }finally{DB.close();}
});


test('falha de foto no automático NÃO publica preview; quando imagem volta, Telegram envia foto e WhatsApp reutiliza exatamente a mesma',async()=>{
 const {DB,env}=setup(),native=globalThis.fetch;
 let ready=false,tgMedia=0,tgText=0,waMedia=0,waText=0,photoUsed=null;
 try{
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=1,max_daily=48,start_hour=0,end_hour=24 WHERE id=1").run();
  const now=Math.floor(Date.now()/1000);
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at) VALUES(?,?,?,'ready',?)")
   .bind('Kit 3 Perfumes Cebolinha Jequiti',SHORT,'Geral',now).run();
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u.includes('api.telegram.org')&&u.includes('/getChat?'))
    return Response.json({ok:true,result:{type:'channel'}});
   if(u===SHORT)return new Response(ready?
    '<meta property="og:image" content="'+PHOTO_PREVIEW+'">':'<html><title>Vitrine JS sem produto no HTML</title></html>',
    {headers:{'content-type':'text/html'}});
   if(u===PHOTO_LARGE&&opts.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'240000'}});
   if(u.includes('api.telegram.org')&&u.includes('/sendPhoto')){
    tgMedia++;
    photoUsed=JSON.parse(opts.body).photo;
    assert.equal(photoUsed,PHOTO_LARGE);
    return Response.json({ok:true,result:{message_id:7373}});
   }
   if(u.includes('api.telegram.org')&&u.includes('/sendMessage')){tgText++;throw Error('automático não pode enviar mensagem com prévia');}
   if(u===EVOLUTION+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false')
    return Response.json([{id:GROUP,subject:'Achadinhos'}]);
   if(u===EVOLUTION+'/message/sendMedia/'+INSTANCE){
    waMedia++;
    assert.equal(JSON.parse(opts.body).media,photoUsed);
    return Response.json({key:{id:'EVOLUTION_PHOTO'}});
   }
   if(u===EVOLUTION+'/message/sendText/'+INSTANCE){waText++;throw Error('WhatsApp não pode enviar só texto');}
   throw Error('Requisição inesperada: '+u);
  };
  await setupWhatsApp(env);
  const first=await runScheduled(env);
  assert.equal(first.status,'awaiting_photo');
  assert.equal(tgMedia,0);
  assert.equal(tgText,0);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'ready');
  assert.equal(DB.prepare("SELECT attempts FROM telegram_photo_retries WHERE offer_id=1").first().attempts,1);
  assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
  ready=true;
  DB.prepare('UPDATE telegram_photo_retries SET next_retry_at=0').run();
  const second=await runScheduled(env);
  assert.equal(second.status,'published');
  assert.equal(second.format,'photo');
  const wa=await runWhatsAppScheduled(env);
  assert.equal(wa.status,'sent');
  assert.equal(wa.format,'photo');
  assert.equal(waMedia,1);
  assert.equal(waText,0);
  assert.equal(tgMedia,1);
  assert.equal(tgText,0);
  assert.equal(await telegramSentPhoto(env,SHORT),PHOTO_LARGE);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM telegram_photo_retries').first().n,0);
 }finally{globalThis.fetch=native;DB.close();}
});

test('link sem foto não bloqueia outro produto pronto na fila Telegram',async()=>{
 const {DB,env}=setup(),native=globalThis.fetch;
 let sent=0,previews=0;
 try{
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=1,max_daily=48,start_hour=0,end_hour=24 WHERE id=1").run();
  const t=Math.floor(Date.now()/1000);
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at) VALUES(?,?,?,'ready',?)")
    .bind('Vitrine temporária sem foto','https://meli.la/SERPROBLEMA','Geral',t-20).run();
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at) VALUES(?,?,?,'ready',?)")
    .bind('Produto com foto real',SHORT,'Geral',t-10).run();
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u.includes('api.telegram.org')&&u.includes('/getChat?'))
    return Response.json({ok:true,result:{type:'channel'}});
   if(u==='https://meli.la/SERPROBLEMA')
    return new Response('<html>Vitrine sem foto</html>',{headers:{'content-type':'text/html'}});
   if(u===SHORT)
    return new Response('<meta property="og:image" content="'+PHOTO_PREVIEW+'">',{headers:{'content-type':'text/html'}});
   if(u===PHOTO_LARGE&&opts.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'240000'}});
   if(u.endsWith('/sendPhoto')){sent++;return Response.json({ok:true,result:{message_id:8888}});}
   if(u.endsWith('/sendMessage')){previews++;throw Error('Envio de link em texto é proibido no automático');}
   throw Error('Unexpected URL '+u);
  };
  assert.equal((await runScheduled(env)).status,'awaiting_photo');
  assert.equal((await runScheduled(env)).status,'published');
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'ready');
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=2").first().status,'published');
  assert.equal(previews,0);
  assert.equal(sent,1);
 }finally{globalThis.fetch=native;DB.close();}
});


test('foto Telegram liberada automaticamente reativa entrega WhatsApp antiga somente se o erro era falta de imagem',async()=>{
 const {env,DB}=setup();
 try{
  DB.prepare("CREATE TABLE whatsapp_media_retries(affiliate_url TEXT PRIMARY KEY,attempts INTEGER,next_attempt_at INTEGER,last_reason TEXT,updated_at INTEGER)").run();
  DB.prepare("CREATE TABLE whatsapp_deliveries(offer_id INTEGER,group_jid TEXT,status TEXT,last_error TEXT,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(offer_id,group_jid))").run();
  DB.prepare("INSERT INTO offers(id,title,affiliate_url,category,created_at,status) VALUES(1,'Kit Cebolinha',?,'Geral',1,'published')").bind(SHORT).run();
  DB.prepare("INSERT INTO whatsapp_media_retries VALUES(?,6,123,'Sem foto',123)").bind(SHORT).run();
  DB.prepare("INSERT INTO whatsapp_deliveries VALUES(1,?,'needs_review','Foto indisponível após 6 tentativas. Nenhuma mensagem sem foto foi enviada.',1,1)").bind(GROUP).run();
  DB.prepare("INSERT INTO whatsapp_deliveries VALUES(1,'OUTRO_GRUPO','needs_review','A Evolution não confirmou o envio.',1,1)").run();
  DB.prepare("INSERT INTO whatsapp_deliveries VALUES(1,'TERCEIRO_GRUPO','sent',NULL,1,1)").run();
  assert.equal(await rememberTelegramSentPhoto(env,SHORT,PHOTO_LARGE,900),true);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM whatsapp_media_retries').first().n,0);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM whatsapp_deliveries WHERE group_jid=?').bind(GROUP).first().n,0);
  assert.equal(DB.prepare("SELECT status FROM whatsapp_deliveries WHERE group_jid='OUTRO_GRUPO'").first().status,'needs_review');
  assert.equal(DB.prepare("SELECT status FROM whatsapp_deliveries WHERE group_jid='TERCEIRO_GRUPO'").first().status,'sent');
 }finally{DB.close();}
});
