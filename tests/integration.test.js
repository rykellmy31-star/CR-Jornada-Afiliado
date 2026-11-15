import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker,{runScheduled} from '../src/index.js';

function dbMock(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url),'utf8'));
  return {
    prepare(sql){
      let params=[];
      return {
        bind(...p){params=p;return this;},
        first(){return db.prepare(sql).get(...params)||null;},
        all(){return {results:db.prepare(sql).all(...params)};},
        run(){const r=db.prepare(sql).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
      };
    },
    close(){db.close();}
  };
}
const ORIGIN='https://afiliados.example.test';
function req(path, {body, cookie, method='GET'}={}) {
  const headers={};
  if(body!==undefined) {headers['content-type']='application/json';headers.origin=ORIGIN;}
  if(cookie) headers.cookie=cookie;
  return new Request(ORIGIN+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}
test('fluxo completo: login → cadastro → habilitação → simulação Telegram → sem duplicatas',async()=>{
  const DB=dbMock();
  const env={DB,ADMIN_PASSWORD:'senha_super_forte_123',SESSION_SECRET:'segredo_de_32_caracteres_para_teste',TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
  let calls=0;let lastPayload;
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=async (url,init)=>{
    if (String(url).includes('/getChat?')) return new Response(JSON.stringify({ok:true,result:{type:'channel'}}),{status:200});
    if(String(url).startsWith('https://meli.la/'))return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.webp">',{headers:{'content-type':'text/html'}});
    if(String(url)==='https://http2.mlstatic.com/D_NQ_NP_99999-MLB-F.jpg')return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'120000'}});
    calls++;
    assert.match(String(url),/^https:\/\/api\.telegram\.org\/botTOKEN_SIMULADO\/(sendPhoto|sendMessage)$/);
    lastPayload=JSON.parse(init.body);
    return new Response(JSON.stringify({ok:true,result:{message_id:100+calls}}),{status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const denied=await worker.fetch(req('/api/state'),env);
    assert.equal(denied.status,401);
    const bad=await worker.fetch(req('/api/login',{method:'POST',body:{password:'errada'}}),env);
    assert.equal(bad.status,401);
    const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.ok(cookie.startsWith('crj_auth='));
    const offer={title:'Base Bauleto Gow 33 Litros',affiliate_url:'https://meli.la/2bsHW5y',category:'Automotivo',price:'54.90',old_price:'79.90',owner_confirmation:true};
    const add=await worker.fetch(req('/api/offers',{method:'POST',body:offer,cookie}),env);
    assert.equal(add.status,201);
    const dupe=await worker.fetch(req('/api/offers',{method:'POST',body:offer,cookie}),env);
    assert.equal(dupe.status,409);
    const missingConsent=await worker.fetch(req('/api/offers',{method:'POST',body:{...offer,affiliate_url:'https://meli.la/ABCDE12',owner_confirmation:false},cookie}),env);
    assert.equal(missingConsent.status,400);
    const state=await (await worker.fetch(req('/api/state',{cookie}),env)).json();
    assert.equal(state.offers.length,1);
    assert.equal(state.settings.automation_enabled,0);
    const settings={telegram_chat_id:'@achadinhosmlcr',channel_registered:true,telegram_enabled:true,automation_enabled:false,interval_minutes:30,max_daily:12,start_hour:8,end_hour:21};
    assert.equal((await worker.fetch(req('/api/settings',{method:'POST',body:settings,cookie}),env)).status,200);
    const testMsg=await worker.fetch(req('/api/test-telegram',{method:'POST',body:{},cookie}),env);
    assert.equal(testMsg.status,200);
    const pub=await worker.fetch(req('/api/offers/1/publish',{method:'POST',body:{},cookie}),env);
    assert.equal(pub.status,200);
    assert.equal(lastPayload.chat_id,'@achadinhosmlcr');
    assert.ok(lastPayload.caption.includes(offer.affiliate_url));
    assert.equal(lastPayload.reply_markup.inline_keyboard[0][0].url,offer.affiliate_url);
    assert.equal(calls,2); // um teste + uma oferta
    assert.equal((await worker.fetch(req('/api/offers/1/publish',{method:'POST',body:{},cookie}),env)).status,409);
    assert.equal(calls,2);
    const current=await (await worker.fetch(req('/api/state',{cookie}),env)).json();
    assert.equal(current.offers[0].status,'published');
    assert.equal(current.counts.find(c=>c.status==='published').total,1);
  }finally {globalThis.fetch=nativeFetch;DB.close();}
});
test('agendador não envia nada quando desligado',async()=>{
  const DB=dbMock();
  try{const tasks=[];await worker.scheduled({}, {DB}, {waitUntil:p=>tasks.push(p)});await Promise.all(tasks);}finally{DB.close();}
});
test('agendador envia somente uma oferta e respeita limite diário',async()=>{
  const DB=dbMock();
  const nativeFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async(url,options={})=>{
    const u=String(url);
    if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
    if(u==='https://www.mercadolivre.com.br/oferta-verificada/p/MLB12345678')
      return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.webp"><link rel="canonical" href="https://www.mercadolivre.com.br/oferta-verificada/p/MLB12345678"><script type="application/ld+json">'+
       JSON.stringify({'@type':'Product',url:'https://www.mercadolivre.com.br/oferta-verificada/p/MLB12345678',offers:{price:'79.90',priceCurrency:'BRL'}})+
       '</script>',{headers:{'content-type':'text/html'}});
    if(u.startsWith('https://meli.la/'))
      return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.webp">',{status:200,headers:{'content-type':'text/html'}});
    if(u==='https://http2.mlstatic.com/D_NQ_NP_99999-MLB-F.jpg'&&options.method==='HEAD')
      return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'700000'}});
    assert.match(u,/\/sendPhoto$/,'automático não deve enviar uma prévia textual');
    calls++;return Response.json({ok:true,result:{message_id:900+calls}});
  };
  try{
    DB.prepare("UPDATE settings SET automation_enabled=1, telegram_enabled=1, channel_registered=1, max_daily=1, interval_minutes=15, start_hour=0, end_hour=24 WHERE id=1").run();
    DB.prepare("CREATE TABLE ml_link_batch_items(id INTEGER PRIMARY KEY,source_url TEXT,affiliate_url TEXT,status TEXT)").run();
    for(let i=0;i<2;i++)DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')")
      .bind('https://www.mercadolivre.com.br/oferta-verificada/p/MLB12345678','https://meli.la/TESTE'+i).run();
    for(let i=0;i<2;i++) DB.prepare("INSERT INTO offers (title, affiliate_url, category,created_at,price_cents) VALUES(?,?,?,?,7990)")
      .bind('Oferta simulada '+i,'https://meli.la/TESTE'+i,'Geral',Math.floor(Date.now()/1000)).run();
    const env={DB,TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
    let pending=[];
    const ctx={waitUntil:p=>pending.push(p)};
    await worker.scheduled({},env,ctx);
    await Promise.all(pending); pending=[];
    await worker.scheduled({},env,ctx);
    await Promise.all(pending);
    assert.equal(calls,1);
    assert.equal(DB.prepare("SELECT COUNT(*) AS c FROM offers WHERE status='published'").first().c,1);
    assert.equal(DB.prepare("SELECT COUNT(*) AS c FROM offers WHERE status='ready'").first().c,1);
  }finally{globalThis.fetch=nativeFetch;DB.close();}
});
test('em erro da API, não repete oferta incerta sem revisão humana',async()=>{
  const DB=dbMock();const nativeFetch=globalThis.fetch;
  globalThis.fetch=async(url)=>{
   const u=String(url);
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.startsWith('https://meli.la/'))return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.webp">',{headers:{'content-type':'text/html'}});
   if(u==='https://http2.mlstatic.com/D_NQ_NP_99999-MLB-F.jpg')return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'120000'}});
   throw new Error('simulação de rede interrompida');
  };
  try{
    DB.prepare("UPDATE settings SET telegram_enabled=1, channel_registered=1 WHERE id=1").run();
    DB.prepare("INSERT INTO offers (title,affiliate_url,category,created_at) VALUES(?,?,?,?)")
      .bind('Produto teste','https://meli.la/TESTE01','Geral',Math.floor(Date.now()/1000)).run();
    const env={DB,ADMIN_PASSWORD:'senha_teste',SESSION_SECRET:'chave_segura_para_os_testes_123',TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
    const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const sent=await worker.fetch(req('/api/offers/1/publish',{method:'POST',body:{},cookie}),env);
    assert.equal(sent.status,409);
    const state=await (await worker.fetch(req('/api/state',{cookie}),env)).json();
    assert.equal(state.offers[0].status,'needs_review');
  }finally{globalThis.fetch=nativeFetch;DB.close();}
});

test('oferta com foto: resolve metadados, envia sendPhoto e mantém botão do afiliado',async()=>{
  const DB=dbMock();
  const nativeFetch=globalThis.fetch;
  const observed=[];
  globalThis.fetch=async (url,init={})=>{
    const address=String(url);observed.push({url:address,method:init.method||'GET'});
    if(address.includes('/getChat?'))return new Response(JSON.stringify({ok:true,result:{type:'channel'}}),{status:200});
    if(address==='https://meli.la/2bsHW5y') return new Response('',{status:302,headers:{location:'https://www.mercadolivre.com.br/p/MLB123'}});
    if(address==='https://www.mercadolivre.com.br/p/MLB123') return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.webp">',{headers:{'content-type':'text/html'}});
    if(address==='https://http2.mlstatic.com/D_NQ_NP_99999-MLB-F.jpg') return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'850000'}});
    if(address.endsWith('/sendPhoto')){
      const body=JSON.parse(init.body);
      assert.equal(body.photo,'https://http2.mlstatic.com/D_NQ_NP_99999-MLB-F.jpg');
      assert.match(body.caption,/Publicidade/);
      assert.equal(body.reply_markup.inline_keyboard[0][0].url,'https://meli.la/2bsHW5y');
      return new Response(JSON.stringify({ok:true,result:{message_id:42}}),{status:200});
    }
    throw new Error('URL inesperada: '+address);
  };
  try{
    DB.prepare('UPDATE settings SET telegram_enabled=1,channel_registered=1 WHERE id=1').run();
    DB.prepare('INSERT INTO offers (title,affiliate_url,category,created_at) VALUES(?,?,?,?)')
      .bind('Produto com foto','https://meli.la/2bsHW5y','Geral',Math.floor(Date.now()/1000)).run();
    const env={DB,ADMIN_PASSWORD:'senha_teste',SESSION_SECRET:'chave_segura_para_os_testes_123',TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
    const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const pub=await worker.fetch(req('/api/offers/1/publish',{method:'POST',body:{},cookie}),env);
    assert.equal(pub.status,200);
    assert.equal((await pub.json()).format,'photo');
    assert.equal(DB.prepare('SELECT telegram_message_id AS m FROM offers WHERE id=1').first().m,42);
    assert.ok(!observed.some(x=>x.url.endsWith('/sendMessage')));
  }finally{globalThis.fetch=nativeFetch;DB.close();}
});

test('Telegram recebe arquivo real quando recusa a URL da CDN, sem enviar texto',async()=>{
 const DB=dbMock(),native=globalThis.fetch,methods=[];
 globalThis.fetch=async(url,init={})=>{
  const address=String(url);
  if(address.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
  if(address==='https://meli.la/2bsHW5y')
   return new Response('<meta name="twitter:image" content="https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.webp">',{headers:{'content-type':'text/html'}});
  if(address==='https://http2.mlstatic.com/D_NQ_NP_99999-MLB-F.jpg'&&init.method==='HEAD')
   return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'64000'}});
  if(address==='https://http2.mlstatic.com/D_NQ_NP_99999-MLB-F.jpg'&&init.method==='GET')
   return new Response('fake-image-bytes',{status:200,headers:{'content-type':'image/jpeg'}});
  if(address.includes('/sendPhoto')){
   if(init.body instanceof FormData){
    methods.push('upload');
    assert.equal(init.body.get('photo').type,'image/jpeg');
    assert.match(init.body.get('caption'),/https:\/\/meli.la\/2bsHW5y/);
    return Response.json({ok:true,result:{message_id:7}});
   }
   methods.push('url');
   return Response.json({ok:false,description:'Bad Request: failed to get HTTP URL content'},{status:400});
  }
  if(address.includes('/sendMessage'))throw Error('Não publicar texto como fallback');
  throw Error('Unexpected '+address);
 };
 try{
  DB.prepare('UPDATE settings SET telegram_enabled=1,channel_registered=1 WHERE id=1').run();
  DB.prepare('INSERT INTO offers (title,affiliate_url,category,created_at) VALUES(?,?,?,?)')
   .bind('Produto com foto','https://meli.la/2bsHW5y','Geral',Math.floor(Date.now()/1000)).run();
  const env={DB,ADMIN_PASSWORD:'senha_teste',SESSION_SECRET:'chave_segura_para_os_testes_123',TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
  const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const pub=await worker.fetch(req('/api/offers/1/publish',{method:'POST',body:{},cookie}),env);
  assert.equal(pub.status,200);
  assert.equal((await pub.json()).format,'photo');
  assert.deepEqual(methods,['url','upload']);
 }finally{globalThis.fetch=native;DB.close();}
});

test('cupom cadastrado entra automaticamente na oferta e deixa de aparecer depois de vencer',async()=>{
  const DB=dbMock();const native=globalThis.fetch;const messages=[];
  globalThis.fetch=async(url,init={})=>{
    if(String(url).includes('/getChat?'))return new Response(JSON.stringify({ok:true,result:{type:'channel'}}),{status:200});
    if(String(url).startsWith('https://meli.la/')) return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.webp">',{headers:{'content-type':'text/html'}});
    if(String(url)==='https://http2.mlstatic.com/D_NQ_NP_99999-MLB-F.jpg')return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'120000'}});
    if(String(url).includes('/sendPhoto')){
      const data=JSON.parse(init.body);messages.push(data);
      return new Response(JSON.stringify({ok:true,result:{message_id:200+messages.length}}),{status:200});
    }
    throw new Error('URL inesperada: '+url);
  };
  try{
    const env={DB,ADMIN_PASSWORD:'senha_teste',SESSION_SECRET:'chave_segura_para_os_testes_123',TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
    const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    DB.prepare('UPDATE settings SET telegram_enabled=1,channel_registered=1 WHERE id=1').run();
    DB.prepare('INSERT INTO offers (title,affiliate_url,category,created_at) VALUES(?,?,?,?)')
      .bind('Produto teste','https://meli.la/COUPON01','Geral',Math.floor(Date.now()/1000)).run();
    const yesterday=new Date(Date.now()-3*86400000).toISOString().slice(0,10);
    const tomorrow=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
    const c={offer_id:1,kind:'code',code:'MELI10',discount_type:'percent',discount_value:'10',min_cart:'10.00',max_discount:'20.00',start_day:yesterday,end_day:tomorrow,source_url:'https://www.mercadolivre.com.br/ofertas/cupons',owner_confirmation:true};
    const saved=await worker.fetch(req('/api/coupons',{method:'POST',body:c,cookie}),env);
    assert.equal(saved.status,201);
    const state=await(await worker.fetch(req('/api/state',{cookie}),env)).json();
    assert.equal(state.offers[0].coupon_code,'MELI10');
    const pub=await worker.fetch(req('/api/offers/1/publish',{method:'POST',body:{},cookie}),env);
    assert.equal(pub.status,200);
    assert.match(messages[0].caption,/MELI10/);
    assert.equal(messages[0].reply_markup.inline_keyboard[0][0].url,'https://meli.la/COUPON01');
    const after=await worker.fetch(req('/api/coupons',{method:'POST',body:c,cookie}),env);
    assert.equal(after.status,409);
    DB.prepare('INSERT INTO offers (title,affiliate_url,category,created_at) VALUES(?,?,?,?)')
      .bind('Produto sem cupom vigente','https://meli.la/COUPON02','Geral',Math.floor(Date.now()/1000)).run();
    assert.equal((await worker.fetch(req('/api/coupons',{method:'POST',body:{...c,offer_id:2,start_day:'2025-01-01',end_day:'2025-01-31'},cookie}),env)).status,201);
    assert.equal((await worker.fetch(req('/api/offers/2/publish',{method:'POST',body:{},cookie}),env)).status,200);
    assert.doesNotMatch(messages[1].caption,/MELI10/);
  }finally{globalThis.fetch=native;DB.close();}
});

test('migra grupo antigo para novo canal preservando ofertas e desliga envios',async()=>{
  const DB=dbMock();
  try{
    DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosml1101',automation_enabled=1,telegram_enabled=1,channel_registered=1 WHERE id=1").run();
    DB.prepare("INSERT INTO offers (title,affiliate_url,category,created_at) VALUES (?,?,?,?)")
      .bind('Oferta antiga preservada','https://meli.la/OLDTEST001','Geral',Math.floor(Date.now()/1000)).run();
    const env={DB,ADMIN_PASSWORD:'senha_super_forte_123',SESSION_SECRET:'segredo_de_32_caracteres_para_teste',TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
    const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const response=await worker.fetch(req('/api/state',{cookie}),env);
    assert.equal(response.status,200);
    const state=await response.json();
    assert.equal(state.settings.telegram_chat_id,'@achadinhosmlcr');
    assert.equal(state.settings.automation_enabled,0);
    assert.equal(state.settings.telegram_enabled,0);
    assert.equal(state.settings.channel_registered,0);
    assert.equal(state.offers.length,1);
    assert.equal(state.offers[0].title,'Oferta antiga preservada');
    const before=DB.prepare("SELECT COUNT(*) AS total FROM logs WHERE event='channel_migrated'").first().total;
    assert.equal(before,1);
    await worker.fetch(req('/api/state',{cookie}),env);
    assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM logs WHERE event='channel_migrated'").first().total,1);
  }finally{DB.close();}
});

test('troca de canal público pausa a automação, limpa confirmação anterior e valida o destino', async()=>{
  const DB=dbMock();const native=globalThis.fetch;
  let checkedChat='';
  globalThis.fetch=async url=>{
    const str=String(url);
    if(str.includes('/getChat?')){
      checkedChat=new URL(str).searchParams.get('chat_id');
      return new Response(JSON.stringify({ok:true,result:{type:'channel'}}),{status:200});
    }
    throw new Error('API não esperada');
  };
  try {
    DB.prepare('UPDATE settings SET channel_registered=1, telegram_enabled=1, automation_enabled=1 WHERE id=1').run();
    const env={DB,ADMIN_PASSWORD:'admin forte para teste',SESSION_SECRET:'segredo-super-forte-para-teste-123',TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
    const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const body={telegram_chat_id:'https://t.me/achados_canal_novo',channel_registered:true,telegram_enabled:true,automation_enabled:true,interval_minutes:30,max_daily:12,start_hour:8,end_hour:21};
    const saved=await worker.fetch(req('/api/settings',{method:'POST',body,cookie}),env);
    assert.equal(saved.status,200);
    assert.equal((await saved.json()).channel_changed,true);
    assert.equal(checkedChat,'@achados_canal_novo');
    const next=await(await worker.fetch(req('/api/state',{cookie}),env)).json();
    assert.equal(next.settings.telegram_chat_id,'@achados_canal_novo');
    assert.equal(next.settings.automation_enabled,0);
    assert.equal(next.settings.telegram_enabled,0);
    assert.equal(next.settings.channel_registered,0);
    assert.equal((await worker.fetch(req('/api/settings',{method:'POST',body:{...body,telegram_chat_id:'@achados_canal_novo'},cookie}),env)).status,200);
    const active=await(await worker.fetch(req('/api/state',{cookie}),env)).json();
    assert.equal(active.settings.channel_registered,1);
    assert.equal(active.settings.telegram_enabled,1);
  } finally {globalThis.fetch=native;DB.close();}
});

test('rejeita grupo do Telegram ao tentar configurar novo canal', async()=>{
  const DB=dbMock();const native=globalThis.fetch;
  globalThis.fetch=async url=>{
    if(String(url).includes('/getChat?'))return new Response(JSON.stringify({ok:true,result:{type:'supergroup'}}),{status:200});
    throw new Error('API inesperada');
  };
  try {
    const env={DB,ADMIN_PASSWORD:'admin forte para teste',SESSION_SECRET:'segredo-super-forte-para-teste-123',TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
    const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const body={telegram_chat_id:'@grupo_existente',channel_registered:true,telegram_enabled:true,automation_enabled:true,interval_minutes:30,max_daily:12,start_hour:8,end_hour:21};
    const response=await worker.fetch(req('/api/settings',{method:'POST',body,cookie}),env);
    assert.equal(response.status,400);
    assert.match((await response.json()).error,/não um canal/);
    assert.equal(DB.prepare('SELECT telegram_chat_id AS destination FROM settings WHERE id=1').first().destination,'@achadinhosmlcr');
  }finally{globalThis.fetch=native;DB.close();}
});


test('reenfileirar após 8 tentativas libera Cron e publica FOTO automática novamente',async()=>{
 const DB=dbMock(),env={DB,ADMIN_PASSWORD:'senha_teste',SESSION_SECRET:'chave_segura_para_os_testes_123',TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
 const originalFetch=globalThis.fetch;
 const url='https://meli.la/276cd5n';
 const image='https://http2.mlstatic.com/D_NQ_NP_99999-MLB-F.jpg';
 let sentPhotos=0;
 try{
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=1,start_hour=0,end_hour=24,max_daily=48 WHERE id=1").run();
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status) VALUES(?,?,?,?,'needs_review')")
   .bind('jogo de ferramentas com 110 pecas embalagem fechada vonder',url,'Geral',Math.floor(Date.now()/1000)).run();
  DB.prepare("CREATE TABLE telegram_photo_retries(offer_id INTEGER PRIMARY KEY,attempts INTEGER NOT NULL,next_retry_at INTEGER NOT NULL,reason TEXT NOT NULL,updated_at INTEGER NOT NULL)").run();
  DB.prepare("INSERT INTO telegram_photo_retries VALUES(1,8,?,'Foto indisponível',?)")
   .bind(Math.floor(Date.now()/1000)+3600,Math.floor(Date.now()/1000)).run();
  const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const requeued=await worker.fetch(req('/api/offers/1/requeue',{method:'POST',body:{},cookie}),env);
  assert.equal(requeued.status,200);
  assert.equal(DB.prepare('SELECT status FROM offers WHERE id=1').first().status,'ready');
  assert.equal(DB.prepare('SELECT * FROM telegram_photo_retries WHERE offer_id=1').first(),null,
   'reenfileirar deve liberar oferta que ficou excluída da seleção do Cron');
  globalThis.fetch=async(request,opts={})=>{
   const u=String(request);
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u===url)return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.webp">',{headers:{'content-type':'text/html'}});
   if(u===image&&opts.method==='HEAD')return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'85000'}});
   if(u.includes('/sendPhoto')){
    const payload=JSON.parse(opts.body);
    assert.equal(payload.photo,image);
    assert.match(payload.caption,/276cd5n/);
    sentPhotos++;
    return Response.json({ok:true,result:{message_id:927}});
   }
   if(u.includes('/sendMessage'))throw new Error('Proibido fallback de texto');
   throw new Error('URL inesperada: '+u);
  };
  const dispatched=await runScheduled(env);
  assert.equal(dispatched.status,'published');
  assert.equal(dispatched.format,'photo');
  assert.equal(sentPhotos,1);
  assert.equal(DB.prepare("SELECT status FROM offers WHERE id=1").first().status,'published');
 }finally{globalThis.fetch=originalFetch;DB.close();}
});


test('revisão de foto é recuperada no cron sem clicar em reenfileirar ou publicar',async()=>{
 const DB=dbMock(),oldFetch=globalThis.fetch;
 const env={DB,ADMIN_PASSWORD:'senha_teste',SESSION_SECRET:'chave_segura_para_os_testes_123',TELEGRAM_BOT_TOKEN:'TOKEN_SIMULADO'};
 let sent=0;
 try{
  DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=1,start_hour=0,end_hour=24,max_daily=48 WHERE id=1").run();
  const now=Math.floor(Date.now()/1000);
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,last_error,price_cents) VALUES(?,?,?,?,'needs_review','Foto real indisponível após seis tentativas automáticas. Nenhum texto foi enviado.',43225)")
   .bind('Jogo ferramentas Vonder 110 peças','https://meli.la/276cd5n','Geral',now).run();
  DB.prepare("CREATE TABLE telegram_photo_retries(offer_id INTEGER PRIMARY KEY,attempts INTEGER,next_retry_at INTEGER,reason TEXT,updated_at INTEGER)").run();
  DB.prepare("INSERT INTO telegram_photo_retries VALUES(1,8,?,'Foto indisponível',?)").bind(now-10,now-2000).run();
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u==='https://meli.la/276cd5n')
    return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_938176-MLB999-P.webp">',{headers:{'content-type':'text/html'}});
   if(u==='https://http2.mlstatic.com/D_NQ_NP_938176-MLB999-F.jpg'&&opts.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'330000'}});
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.includes('/sendPhoto')){
    sent++;const json=JSON.parse(opts.body);
    assert.equal(json.photo,'https://http2.mlstatic.com/D_NQ_NP_938176-MLB999-F.jpg');
    return Response.json({ok:true,result:{message_id:888}});
   }
   if(u.includes('/sendMessage'))throw Error('Nunca enviar texto');
   throw Error('Unexpected URL: '+u);
  };
  const result=await runScheduled(env);
  assert.equal(result.status,'published',JSON.stringify(result));
  assert.equal(result.format,'photo');
  assert.equal(sent,1);
  assert.equal(DB.prepare('SELECT status FROM offers WHERE id=1').first().status,'published');
  assert.equal(DB.prepare('SELECT attempts FROM telegram_photo_retries WHERE offer_id=1').first(),null);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});
