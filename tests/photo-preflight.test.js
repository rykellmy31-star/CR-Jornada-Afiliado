import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {prewarmTelegramQueue} from '../src/photo-preflight.js';
import {cachedProductImage} from '../src/offer-images.js';
import worker,{runScheduled} from '../src/index.js';
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


test('Cron publica pela MESMA rotina do botão manual e reaproveita foto em cache',async()=>{
 const {DB,env,close}=setup(),original=globalThis.fetch;
 const counter={reads:0,photos:0,sourceReads:0};
 const mock=mockImageFetch(counter);
 try{
  globalThis.fetch=async(url,options)=>{
   if(String(url)===SOURCE){
    counter.sourceReads++;
    await new Promise(resolve=>setTimeout(resolve,25));
   }
   return mock(url,options);
  };
  const tasks=[];
  await worker.scheduled({},env,{waitUntil:p=>tasks.push(p)});
  await Promise.all(tasks);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'published');
  assert.equal(counter.photos,1,'Cron precisa enviar FOTO real do mesmo publicador manual');
  assert.equal(counter.sourceReads,1,
   'não deve duplicar consultas ao anúncio antes de publicar');
  assert.equal(counter.reads,0,'não consulta vitrine encurtada se a origem já foi confirmada');
 }finally{globalThis.fetch=original;close();}
});

test('sete falhas automáticas de foto NÃO colocam oferta em Revisar; após foto recuperar o Cron publica',async()=>{
 const {DB,env,close}=setup(),original=globalThis.fetch;
 const counter={reads:0,photos:0};
 let ready=false,channelChecks=0;
 const success=mockImageFetch(counter);
 try{
  globalThis.fetch=async(url,options={})=>{
   if(ready)return success(url,options);
   const u=String(url);
   if(u===SOURCE||u===SHORT)return new Response('<html><head></head></html>',{
    headers:{'content-type':'text/html'}});
   if(u.includes('/getChat?')){channelChecks++;return Response.json({ok:true,result:{type:'channel'}});}
   if(u.includes('/sendPhoto')||u.includes('/sendMessage'))
    throw Error('Tentou enviar sem foto confirmada');
   throw Error('Link inesperado durante preparação: '+u);
  };
  for(let i=1;i<=7;i++){
   const outcome=await runScheduled(env);
   assert.equal(outcome.skipped,'awaiting_photo','sem foto não deve publicar');
   assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'ready',
    'a oferta precisa permanecer na fila apesar de falhas de mídia');
   assert.equal(DB.prepare("SELECT attempts FROM telegram_photo_retries WHERE offer_id=1").first().attempts,i);
   DB.prepare('UPDATE telegram_photo_retries SET next_retry_at=0 WHERE offer_id=1').run();
  }
  assert.ok(channelChecks>=7,
   'Cada rodada deve chegar ao MESMO publicador manual, sem bloqueio de preflight');
  ready=true;
  const dispatched=await runScheduled(env);
  assert.equal(dispatched.status,'published');
  assert.equal(dispatched.format,'photo');
  assert.equal(counter.photos,1);
  assert.equal(DB.prepare('SELECT status FROM offers WHERE id=1').first().status,'published');
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM telegram_photo_retries').first().n,0);
  assert.equal((await runScheduled(env)).skipped,'interval_or_schedule',
   'não deve postar oferta publicada novamente no próximo Cron');
 }finally{globalThis.fetch=original;close();}
});


test('Cron lê foto REAL do cartão destacado da vitrine quando HTML do anúncio não fornece og:image',async()=>{
 const {DB,env,close}=setup(),original=globalThis.fetch;
 const SOCIAL='https://www.mercadolivre.com.br/social/perfil-oferta';
 let delivered=0,scraped=0;
 try{
  env.BROWSER={async quickAction(kind,options){
   if(kind==='content')return new Response('<html>vitrine hidratada sem meta tags</html>',{
    headers:{'content-type':'text/html'}});
   assert.equal(kind,'scrape');
   scraped++;
   assert.equal(options.url,SOCIAL);
   return Response.json({result:[
    {selector:'.rl-card-featured-wrapper a.poly-component__title[href]',
     results:{text:'Produto destacado verdadeiro',
      attributes:[{name:'href',value:SOURCE}]}},
    {selector:'.rl-card-featured-wrapper img.poly-component__picture',
     results:{attributes:[{name:'src',value:PREVIEW}]}},
    {selector:'.rl-card-recommendations a.poly-component__title[href]',
     results:{attributes:[{name:'href',
      value:'https://www.mercadolivre.com.br/produto-recomendado/p/MLB99999999'}]}}
   ]});
  }};
  globalThis.fetch=async(url,options={})=>{
   const u=String(url);
   if(u===SOURCE)return new Response('<html>anúncio sem metadados de foto nesta leitura</html>',{
    headers:{'content-type':'text/html'}});
   if(u===SHORT)return new Response(null,{status:302,headers:{location:SOCIAL}});
   if(u===SOCIAL)return new Response('<html>vitrine sem produto estático</html>',{
    headers:{'content-type':'text/html'}});
   if(u===LARGE&&options.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'250000'}});
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendPhoto')){
    assert.equal(JSON.parse(options.body).photo,LARGE);
    delivered++;
    return Response.json({ok:true,result:{message_id:45699}});
   }
   throw Error('URL inesperada: '+u);
  };
  const published=await runScheduled(env);
  assert.equal(published.status,'published','automático usa foto real, sem clique manual');
  assert.equal(published.format,'photo');
  assert.equal(delivered,1);
  assert.ok(scraped>0,'recuperou foto do destaque que está visível na vitrine');
  assert.equal(await cachedProductImage(env,SHORT),LARGE);
  assert.equal(DB.prepare('SELECT status FROM offers WHERE id=1').first().status,'published');
 }finally{globalThis.fetch=original;close();}
});

test('Cron NÃO copia a imagem de uma recomendação com MLB diferente do produto original',async()=>{
 const {DB,env,close}=setup(),original=globalThis.fetch;
 const SOCIAL='https://www.mercadolivre.com.br/social/perfil-oferta';
 let delivered=0;
 try{
  env.BROWSER={async quickAction(kind){
   if(kind==='content')return new Response('<html>sem imagem</html>',{
    headers:{'content-type':'text/html'}});
   return Response.json({result:[
    {selector:'.rl-card-featured-wrapper a.poly-component__title[href]',
     results:{attributes:[{name:'href',
      value:'https://www.mercadolivre.com.br/outro/p/MLB99999999'}]}},
    {selector:'.rl-card-featured-wrapper img.poly-component__picture',
     results:{attributes:[{name:'src',value:PREVIEW}]}}
   ]});
  }};
  globalThis.fetch=async(url,options={})=>{
   const u=String(url);
   if(u===SOURCE)return new Response('<html>foto indisponível</html>',{headers:{'content-type':'text/html'}});
   if(u===SHORT)return new Response(null,{status:302,headers:{location:SOCIAL}});
   if(u===SOCIAL)return new Response('<html>sem foto estática</html>',{
    headers:{'content-type':'text/html'}});
   if(u===LARGE&&options.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'250000'}});
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendPhoto')){delivered++;return Response.json({ok:true,result:{message_id:800}});}
   throw Error('URL inesperada: '+u);
  };
  const state=await runScheduled(env);
  assert.equal(state.skipped,'awaiting_photo');
  assert.equal(delivered,0);
  assert.equal(await cachedProductImage(env,SHORT),null);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'ready');
 }finally{globalThis.fetch=original;close();}
});


test('oferta Na fila com Aguardando foto prioriza vitrine e publica, sem repetir HTTP do produto',async()=>{
 const {DB,env,close}=setup(),previous=globalThis.fetch;
 const social='https://www.mercadolivre.com.br/social/vitrine-produto';
 let originalReads=0,photoPosts=0;
 try{
  DB.prepare("UPDATE offers SET last_error=? WHERE id=1")
   .bind('Aguardando foto real do produto. Nova tentativa automática agendada.').run();
  env.BROWSER={async quickAction(kind){
   if(kind==='content')return new Response('<html>sem foto em metadados</html>',{
    headers:{'content-type':'text/html'}});
   return Response.json({result:[
    {selector:'.rl-card-featured-wrapper a.poly-component__title[href]',
     results:{attributes:[{name:'href',value:SOURCE}]}},
    {selector:'.rl-card-featured-wrapper img.poly-component__picture',
     results:{attributes:[{name:'src',value:PREVIEW}]}}
   ]});
  }};
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===SOURCE){originalReads++;return new Response('<html>sem metadados</html>',{
    headers:{'content-type':'text/html'}});}
   if(u===SHORT)return new Response(null,{status:302,headers:{location:social}});
   if(u===social)return new Response('<html>vitrine</html>',{headers:{'content-type':'text/html'}});
   if(u===LARGE&&opts.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'250000'}});
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendPhoto')){
    photoPosts++;assert.equal(JSON.parse(opts.body).photo,LARGE);
    return Response.json({ok:true,result:{message_id:7733}});
   }
   throw Error('unexpected '+u);
  };
  const result=await runScheduled(env);
  assert.equal(result.status,'published');
  assert.equal(photoPosts,1);
  assert.ok(originalReads>=1,'Cron entra primeiro no resolvedor do publicador manual antes da recuperação da vitrine');
  assert.equal(DB.prepare('SELECT status FROM offers WHERE id=1').first().status,'published');
 }finally{globalThis.fetch=previous;close();}
});


test('agendador não possui barreira de foto extra antes do publicador manual',()=>{
 const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const start=source.indexOf('async function runScheduled(env){');
 const end=source.indexOf('\nexport ',start);
 const cron=source.slice(start,end);
 assert.ok(cron.includes('publishWithManualTools(env,offer,settings'),
  'Cron chama diretamente o MESMO publicador manual');
 assert.ok(!cron.includes('prepareScheduledPhoto(env,offer)'),'Cron não deve exigir segundo pré-validador');
 assert.ok(!cron.includes('deferScheduledPhoto(env,offer)'),'Cron nunca adia a foto antes de tentar o publicador');
});


test('Cron deixa o envio principal terminar antes de preparar fotos das outras filas',async()=>{
 const {DB,env,close}=setup(),original=globalThis.fetch;
 const counter={reads:0,photos:0};
 const mock=mockImageFetch(counter);
 const prepare=DB.prepare.bind(DB);
 let finished=false,prewarmTooEarly=false,unblockSend;
 const sendBlocked=new Promise(resolve=>{unblockSend=resolve;});
 let notifySending;
 const sending=new Promise(resolve=>{notifySending=resolve;});
 DB.prepare=(sql)=>{
  if(String(sql).includes('affiliate_photo_preflight')&&!finished)prewarmTooEarly=true;
  return prepare(sql);
 };
 try{
  globalThis.fetch=async(url,opts={})=>{
   if(String(url).endsWith('/sendPhoto')){
    notifySending();
    await sendBlocked;
    const response=await mock(url,opts);
    finished=true;
    return response;
   }
   return mock(url,opts);
  };
  const tasks=[];
  await worker.scheduled({},env,{waitUntil:p=>tasks.push(p)});
  await Promise.race([sending,new Promise((_,reject)=>setTimeout(
   ()=>reject(Error('O cron não chegou ao publicador de foto')),3000))]);
  assert.equal(prewarmTooEarly,false,
   'pré-carregamento não pode disputar rede/D1 com envio de foto automático');
  unblockSend();
  await Promise.all(tasks);
  assert.equal(counter.photos,1);
  assert.equal(prewarmTooEarly,false);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'published');
 }finally{
  unblockSend();
  globalThis.fetch=original;
  close();
 }
});


test('prewarm do Cron prepara foto principal da vitrine ANTES do disparo agendado',async()=>{
 const {DB,env,close}=setup(),previous=globalThis.fetch;
 const social='https://www.mercadolivre.com.br/social/vitrine-teste-prewarm';
 let sent=0,lookups=0;
 try{
  env.BROWSER={async quickAction(kind,options){
   if(kind==='content')return new Response('<html>vitrine sem meta de foto</html>',{
    headers:{'content-type':'text/html'}});
   assert.equal(kind,'scrape');
   lookups++;
   assert.equal(options.url,social);
   return Response.json({result:[
    {selector:'.rl-card-featured-wrapper a.poly-component__title[href]',
     results:{attributes:[{name:'href',value:SOURCE}]}},
    {selector:'[class*="card-featured"] img.poly-component__picture',
     results:{attributes:[{name:'src',value:PREVIEW}]}}
   ]});
  }};
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===SOURCE)return new Response('<html>sem foto nesta leitura</html>',{
    headers:{'content-type':'text/html'}});
   if(u===SHORT)return new Response(null,{status:302,headers:{location:social}});
   if(u===social)return new Response('<html>vitrine renderizada por JS</html>',{
    headers:{'content-type':'text/html'}});
   if(u===LARGE&&opts.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'260000'}});
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendPhoto')){
    sent++;
    assert.equal(JSON.parse(opts.body).photo,LARGE);
    return Response.json({ok:true,result:{message_id:90901}});
   }
   throw Error('URL inesperada: '+u);
  };
  const prepared=await prewarmTelegramQueue(env);
  assert.equal(prepared.status,'photo_ready');
  assert.ok(lookups>=1,'pré-carregamento deve consultar a foto real do destaque');
  assert.equal(await cachedProductImage(env,SHORT),LARGE);
  assert.equal((await runScheduled(env)).status,'published');
  assert.equal(sent,1);
 }finally{globalThis.fetch=previous;close();}
});

test('Cron procura foto outra vez IMEDIATAMENTE e publica como o botão manual sem duplicar',async()=>{
 const {DB,env,close}=setup(),previous=globalThis.fetch;
 let reads=0,photos=0;
 try{
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===SOURCE){
    reads++;
    return new Response(reads<=3?'<html>foto temporariamente ausente</html>':
     '<meta property="og:image" content="'+PREVIEW+'">',{
      headers:{'content-type':'text/html'}});
   }
   if(u===SHORT)return new Response('<html>sem metadados</html>',{
    headers:{'content-type':'text/html'}});
   if(u===LARGE&&opts.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'260000'}});
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendPhoto')){
    photos++;
    assert.equal(JSON.parse(opts.body).photo,LARGE);
    return Response.json({ok:true,result:{message_id:7812}});
   }
   throw Error('Unexpected photo retry request: '+u);
  };
  const outcome=await runScheduled(env);
  assert.equal(outcome.status,'published','segundo caminho manual deve enviar na mesma janela');
  assert.equal(photos,1,'não pode duplicar publicação após a foto ser encontrada');
  assert.ok(reads>=4,'fez uma busca de foto nova quando a primeira falhou');
  assert.equal(DB.prepare("SELECT COUNT(*) AS n FROM telegram_photo_retries").first().n,0);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'published');
 }finally{globalThis.fetch=previous;close();}
});

test('nova tentativa de FOTO não altera o intervalo entre PUBLICAÇÕES',async()=>{
 const {DB,env,close}=setup(),previous=globalThis.fetch;
 let photoPosts=0;
 try{
  DB.prepare('UPDATE settings SET interval_minutes=77').run();
  globalThis.fetch=async(url)=>{
   const u=String(url);
   if(u===SOURCE||u===SHORT)
    return new Response('<html>sem foto temporariamente</html>',{
     headers:{'content-type':'text/html'}});
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendPhoto')){photoPosts++;throw Error('Não deveria enviar sem foto');}
   throw Error('Unexpected fetch '+u);
  };
  const before=Math.floor(Date.now()/1000);
  const response=await runScheduled(env);
  assert.equal(response.skipped,'awaiting_photo');
  const row=DB.prepare('SELECT next_retry_at FROM telegram_photo_retries WHERE offer_id=1').first();
  assert.ok(row.next_retry_at>=before+60&&row.next_retry_at<=before+65,
   'a nova tentativa de foto deve ser independente do intervalo de 77 minutos');
  assert.equal(DB.prepare('SELECT interval_minutes FROM settings WHERE id=1').first().interval_minutes,77);
  assert.equal(DB.prepare('SELECT status FROM offers WHERE id=1').first().status,'ready');
  assert.equal(photoPosts,0);
 }finally{globalThis.fetch=previous;close();}
});


test('Cron aciona o publicador manual mesmo com retry de foto no futuro',async()=>{
 const {DB,env,close}=setup(),previous=globalThis.fetch;
 const counter={reads:0,photos:0};
 try{
  DB.prepare('CREATE TABLE telegram_photo_retries(offer_id INTEGER PRIMARY KEY,attempts INTEGER,next_retry_at INTEGER,reason TEXT,updated_at INTEGER)').run();
  DB.prepare('INSERT INTO telegram_photo_retries VALUES(1,5,2147483647,?,1)')
   .bind('Aguardando foto real na preparação automática').run();
  globalThis.fetch=mockImageFetch(counter);
  const published=await runScheduled(env);
  assert.equal(published.status,'published',
   'o relógio deve publicar como o botão manual, sem bloquear por next_retry_at');
  assert.equal(counter.photos,1);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'published');
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM telegram_photo_retries').first().n,0);
  assert.equal((await runScheduled(env)).skipped,'interval_or_schedule',
   'publicação já concluída nunca pode ser repetida');
 }finally{globalThis.fetch=previous;close();}
});

test('manual e cron acionam a mesma operação, sem modificar intervalo',()=>{
 const src=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const manual=src.slice(src.indexOf("const publish = u.pathname.match"),src.indexOf("\n  return fail('Rota inexistente.', 404)",src.indexOf("const publish = u.pathname.match")));
 const cron=src.slice(src.indexOf('async function runScheduled(env){'),
  src.indexOf('\nasync function router(',src.indexOf('async function runScheduled(env){')));
 assert.match(manual,/publishUsingManualButton\(env,Number\(publish\[1\]\)/);
 assert.match(cron,/publishUsingManualButton\(env,offer\.id/);
 assert.match(cron,/shouldSend\(settings,now,total,latest/);
 assert.doesNotMatch(cron,/tpr\.next_retry_at<=/);
 assert.doesNotMatch(cron,/UPDATE settings SET interval_minutes/);
});
