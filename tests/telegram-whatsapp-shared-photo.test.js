import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker,{runScheduled} from '../src/index.js';
import {runWhatsAppScheduled,updateWhatsAppSettings} from '../src/whatsapp.js';
import {telegramSentPhoto,rememberTelegramSentPhoto,rememberProductImage,cachedProductImage} from '../src/offer-images.js';

const SHORT='https://meli.la/2ESKGQw';
const PHOTO_PREVIEW='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-P.webp';
const PHOTO_LARGE='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-F.jpg';
const SOURCE='https://www.mercadolivre.com.br/oferta-verificada/p/MLB12345678';
const ORIGIN='https://afiliados.example.test',EVOLUTION='https://evo.example.com';
const INSTANCE='afiliados',GROUP='120363888999777@g.us';
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 db.exec("CREATE TABLE ml_link_batch_items(id INTEGER PRIMARY KEY,source_url TEXT,affiliate_url TEXT,status TEXT)");
 db.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')").run(SOURCE,SHORT);
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
    if(u===SOURCE)return new Response('<meta property="og:image" content="'+PHOTO_PREVIEW+'"><link rel="canonical" href="'+SOURCE+'"><script type="application/ld+json">'+JSON.stringify({'@type':'Product',url:SOURCE,offers:{'@type':'Offer',price:'79.90',priceCurrency:'BRL'}})+'</script>',{headers:{'content-type':'text/html'}});
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
   DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at,price_cents) VALUES(?,?,?,'ready',?,7990)")
    .bind('Kit 3 Perfumes Cebolinha Jequiti',SHORT,'Geral',now).run();
   if(delivery==='manual'){
    const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const background=[];
    const published=await worker.fetch(
      req('/api/offers/1/publish',{method:'POST',cookie,body:{}}),env,
      {waitUntil:p=>background.push(p)}
    );
    assert.equal(published.status,200);
    assert.equal((await published.json()).format,'photo');
    assert.equal(background.length,1,'Cloudflare recebe o espelhamento pelo waitUntil');
    await Promise.all(background);
    assert.equal(waMedia,1,'WhatsApp recebe mídia após publicação manual, sem aguardar próximo Cron');
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
   assert.deepEqual(result,{skipped:'empty'},
    'publicação manual e automática devem espelhar no WhatsApp sem esperar outro Cron');
   assert.equal(waMedia,1);
   assert.equal(waText,0);
   assert.equal(shortReads,0,'foto oficial enviada no Telegram e reutilizada no WhatsApp sem buscar o link curto');
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


test('agendador usa exatamente o fallback de texto do modo manual e não duplica oferta',async()=>{
 const {DB,env}=setup(),old=globalThis.fetch;
 let tgText=0,tgMedia=0,waText=0;
 try{
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=1,max_daily=48,start_hour=0,end_hour=24 WHERE id=1").run();
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at,price_cents) VALUES(?,?,?,'ready',?,7990)")
   .bind('Kit 3 Perfumes Cebolinha Jequiti',SHORT,'Geral',Math.floor(Date.now()/1000)).run();
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===EVOLUTION+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false')
    return Response.json([{id:GROUP,subject:'Achadinhos'}]);
   if(u.includes('api.telegram.org')&&u.includes('/getChat?'))
    return Response.json({ok:true,result:{type:'channel'}});
   if(u===SOURCE||u===SHORT)
    return new Response('<html>Sem foto oficial disponível</html>',{headers:{'content-type':'text/html'}});
   if(u.endsWith('/sendMessage')){
    const body=JSON.parse(opts.body);
    assert.match(body.text,/Por R\$\s*79,90/);
    assert.match(body.text,/https:\/\/meli\.la\/2ESKGQw/);
    tgText++;
    return Response.json({ok:true,result:{message_id:7373}});
   }
   if(u.endsWith('/sendPhoto')){tgMedia++;throw Error('Foto não disponível');}
   if(u===EVOLUTION+'/message/sendText/'+INSTANCE){
    const body=JSON.parse(opts.body);
    assert.match(body.text,/https:\/\/meli\.la\/2ESKGQw/);
    waText++;
    return Response.json({key:{id:'EVOLUTION_TEXT'}});
   }
   throw Error('Unexpected URL: '+u);
  };
  await setupWhatsApp(env);
  const first=await runScheduled(env);
  assert.equal(first.status,'published');
  assert.equal(first.format,'text_no_image');
  assert.equal(first.whatsapp.status,'sent');
  assert.equal(tgText,1);
  assert.equal(tgMedia,0);
  assert.equal(waText,1);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'published');
  assert.equal((await runScheduled(env)).skipped,'interval_or_schedule');
  assert.equal(tgText,1,'não reenviar a mesma oferta');
 }finally{globalThis.fetch=old;DB.close();}
});

test('fila não fica presa na antiga verificação de preço e respeita o intervalo entre duas ofertas',async()=>{
 const {DB,env}=setup(),old=globalThis.fetch;
 let media=0,text=0;
 try{
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=1,max_daily=48,start_hour=0,end_hour=24 WHERE id=1").run();
  const now=Math.floor(Date.now()/1000);
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at,price_cents,last_error) VALUES(?,?,?,'ready',?,7990,?)")
   .bind('Produto sem foto disponível','https://meli.la/SERPROBLEMA','Geral',now-20,'Aguardando preço atualizado no Mercado Livre').run();
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at,price_cents) VALUES(?,?,?,'ready',?,7990)")
   .bind('Produto com foto disponível',SHORT,'Geral',now-10).run();
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===SOURCE||u===SHORT)return new Response('<meta property="og:image" content="'+PHOTO_PREVIEW+'">',{headers:{'content-type':'text/html'}});
   if(u==='https://meli.la/SERPROBLEMA')return new Response('<html>Sem foto</html>',{headers:{'content-type':'text/html'}});
   if(u===PHOTO_LARGE&&opts.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'240000'}});
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendMessage')){text++;return Response.json({ok:true,result:{message_id:8111}});}
   if(u.endsWith('/sendPhoto')){media++;return Response.json({ok:true,result:{message_id:8222}});}
   throw Error('Unexpected URL '+u);
  };
  const first=await runScheduled(env);
  assert.equal(first.status,'published');
  assert.equal(first.format,'text_no_image');
  assert.equal(DB.prepare("SELECT last_error FROM offers WHERE id=1").first().last_error,null);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=2").first().status,'ready');
  assert.equal((await runScheduled(env)).skipped,'interval_or_schedule');
  // Simula a passagem do intervalo sem aguardar um minuto real.
  DB.prepare('UPDATE offers SET published_at=? WHERE id=1').bind(now-120).run();
  const second=await runScheduled(env);
  assert.equal(second.status,'published');
  assert.equal(second.format,'photo');
  assert.equal(text,1);
  assert.equal(media,1);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=2").first().status,'published');
 }finally{globalThis.fetch=old;DB.close();}
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


test('automático usa exatamente o resolvedor de foto e o fallback do botão manual',async()=>{
 const {DB,env}=setup(),old=globalThis.fetch;
 let imageReads=0,mediaSent=0,plainText=0;
 try{
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=1,max_daily=48,start_hour=0,end_hour=24 WHERE id=1").run();
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at,price_cents) VALUES(?,?,?,'ready',?,7990)")
   .bind('Kit body splash e hidratante',SHORT,'Geral',Math.floor(Date.now()/1000)).run();
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===SOURCE){
    imageReads++;
    return new Response((imageReads===1?'':'<meta property="og:image" content="'+PHOTO_PREVIEW+'">')+
     '<html>Dados do anúncio</html>',{headers:{'content-type':'text/html'}});
   }
   if(u===SHORT)return new Response('<html>Vitrine sem imagem</html>',{headers:{'content-type':'text/html'}});
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendMessage')){plainText++;return Response.json({ok:true,result:{message_id:9911}});}
   if(u.endsWith('/sendPhoto')){mediaSent++;throw Error('Não havia foto confirmada');}
   throw Error('Unexpected '+u);
  };
  const result=await runScheduled(env);
  assert.equal(result.status,'published');
  assert.equal(result.format,'text_no_image');
  assert.equal(imageReads,1,'mesmo resolvedor de imagem do botão manual');
  assert.equal(mediaSent,0);
  assert.equal(plainText,1);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'published');
 }finally{globalThis.fetch=old;DB.close();}
});

test('Crons simultâneos publicam somente uma oferta e respeitam o intervalo configurado',async()=>{
 const {DB,env}=setup(),old=globalThis.fetch;
 let sends=0;
 try{
  const other='https://meli.la/SEGUNDAOFERTA1';
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')")
   .bind(SOURCE,other).run();
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=15,max_daily=48,start_hour=0,end_hour=24 WHERE id=1").run();
  const now=Math.floor(Date.now()/1000);
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at,price_cents) VALUES(?,?,?,'ready',?,7990)")
   .bind('Primeiro produto',SHORT,'Geral',now-30).run();
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at,price_cents) VALUES(?,?,?,'ready',?,7990)")
   .bind('Segundo produto',other,'Geral',now-20).run();
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===SOURCE)return new Response('<meta property="og:image" content="'+PHOTO_PREVIEW+'"><link rel="canonical" href="'+SOURCE+'"><script type="application/ld+json">'+JSON.stringify({
    '@type':'Product',url:SOURCE,offers:{price:'79.90',priceCurrency:'BRL'}
   })+'</script>',{headers:{'content-type':'text/html'}});
   if(u.includes('api.telegram.org')&&u.includes('/getChat?'))
    return Response.json({ok:true,result:{type:'channel'}});
   if(u===PHOTO_LARGE&&opts.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'250000'}});
   if(u.endsWith('/sendPhoto')){
    sends++;
    await new Promise(resolve=>setTimeout(resolve,60));
    return Response.json({ok:true,result:{message_id:4000+sends}});
   }
   throw Error('Unexpected URL '+u);
  };
  const [first,second]=await Promise.all([runScheduled(env),runScheduled(env)]);
  assert.equal([first?.status,second?.status].filter(x=>x==='published').length,1);
  assert.equal(sends,1);
  assert.equal(DB.prepare("SELECT COUNT(*) AS n FROM offers WHERE status='published'").first().n,1);
  const after=await runScheduled(env);
  assert.equal(after.skipped,'interval_or_schedule');
  assert.equal(sends,1,'nenhum segundo disparo antes dos 15 minutos');
 }finally{globalThis.fetch=old;DB.close();}
});

test('agendador reutiliza o preço e a foto do botão manual mesmo com site bloqueado',async()=>{
 const {DB,env}=setup(),native=globalThis.fetch;
 const SOCIAL='https://www.mercadolivre.com.br/social/vitrine-principal';
 let telegramPhotos=0,whatsappPhotos=0;
 try{
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=5,max_daily=48,start_hour=0,end_hour=24 WHERE id=1").run();
  const now=Math.floor(Date.now()/1000);
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at,price_cents,old_price_cents) VALUES(?,?,?,'ready',?,3482,4990)")
   .bind('Kit automotivo do anúncio principal',SHORT,'Geral',now).run();
  const featured='<div class="rl-card-featured-wrapper">'+
   '<img class="poly-component__picture" src="'+PHOTO_PREVIEW+'">'+
   '<a class="poly-component__title" href="'+SOURCE+'">Kit automotivo</a>'+
   '<div class="poly-component__price">'+
   '<s class="poly-price__previous"><span class="andes-money-amount__currency-symbol">R$</span>'+
   '<span class="andes-money-amount__fraction">49</span><span class="andes-money-amount__cents">90</span></s>'+
   '<div class="poly-price__current"><span class="andes-money-amount poly-price__amount">'+
   '<span class="andes-money-amount__currency-symbol">R$</span>'+
   '<span class="andes-money-amount__fraction">34</span><span class="andes-money-amount__cents">82</span></span></div>'+
   '</div><a class="poly-action-links__action--link" href="'+SOURCE+'">Ir para produto</a></div>'+
   '<div class="rl-card-recommendations"><a href="https://www.mercadolivre.com.br/errado/p/MLB99999999">Outro produto</a></div>';
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===SOURCE||u.startsWith('https://api.mercadolibre.com/'))
    return new Response('Acesso temporariamente negado',{status:403});
   if(u===SHORT)return new Response(null,{status:302,headers:{location:SOCIAL}});
   if(u===SOCIAL)return new Response(featured,{headers:{'content-type':'text/html'}});
   if(u===PHOTO_LARGE&&opts.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'300000'}});
   if(u.includes('api.telegram.org')&&u.includes('/getChat?'))
    return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendPhoto')){
    const payload=JSON.parse(opts.body);
    assert.equal(payload.photo,PHOTO_LARGE);
    assert.match(payload.caption,/Por R\$\s*34,82/);
    assert.match(payload.caption,/https:\/\/meli\.la\/2ESKGQw/);
    telegramPhotos++;
    return Response.json({ok:true,result:{message_id:4545}});
   }
   if(u===EVOLUTION+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false')
    return Response.json([{id:GROUP,subject:'Achadinhos'}]);
   if(u===EVOLUTION+'/message/sendMedia/'+INSTANCE){
    const payload=JSON.parse(opts.body);
    assert.equal(payload.media,PHOTO_LARGE);
    assert.match(payload.caption,/Por R\$\s*34,82/);
    whatsappPhotos++;
    return Response.json({key:{id:'WA_4545'}});
   }
   if(u===EVOLUTION+'/message/sendText/'+INSTANCE)throw Error('Não enviar sem foto');
   throw Error('Requisição inesperada '+u);
  };
  await setupWhatsApp(env);
  await rememberProductImage(env,SHORT,PHOTO_LARGE);
  const result=await runScheduled(env);
  assert.equal(result.status,'published');
  assert.equal(result.format,'photo');
  assert.equal(result.whatsapp.status,'sent');
  assert.equal(telegramPhotos,1);
  assert.equal(whatsappPhotos,1);
  assert.equal(DB.prepare('SELECT price_cents FROM offers WHERE id=1').first().price_cents,3482);
  assert.equal(DB.prepare('SELECT status FROM whatsapp_deliveries').first().status,'sent');
 }finally{globalThis.fetch=native;DB.close();}
});
