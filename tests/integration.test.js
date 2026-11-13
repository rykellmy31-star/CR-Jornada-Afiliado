import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

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
    if (String(url).startsWith('https://meli.la/')) return new Response('<html></html>',{headers:{'content-type':'text/html'}});
    calls++;
    assert.match(String(url),/^https:\/\/api\.telegram\.org\/botTOKEN_SIMULADO\/sendMessage$/);
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
    const settings={telegram_chat_id:'@achadinhosml1101',channel_registered:true,telegram_enabled:true,automation_enabled:false,interval_minutes:30,max_daily:12,start_hour:8,end_hour:21};
    assert.equal((await worker.fetch(req('/api/settings',{method:'POST',body:settings,cookie}),env)).status,200);
    const testMsg=await worker.fetch(req('/api/test-telegram',{method:'POST',body:{},cookie}),env);
    assert.equal(testMsg.status,200);
    const pub=await worker.fetch(req('/api/offers/1/publish',{method:'POST',body:{},cookie}),env);
    assert.equal(pub.status,200);
    assert.equal(lastPayload.chat_id,'@achadinhosml1101');
    assert.ok(lastPayload.text.includes(offer.affiliate_url));
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
  try{await worker.scheduled({}, {DB}, {waitUntil:p=>p});}finally{DB.close();}
});
test('agendador envia somente uma oferta e respeita limite diário',async()=>{
  const DB=dbMock();
  const nativeFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async(url)=>{if(String(url).includes('/getChat?'))return new Response(JSON.stringify({ok:true,result:{type:'channel'}}),{status:200}); if(String(url).startsWith('https://meli.la/')) return new Response('<html></html>',{status:200,headers:{'content-type':'text/html'}}); calls++;return new Response(JSON.stringify({ok:true,result:{message_id:900+calls}}),{status:200});};
  try{
    DB.prepare("UPDATE settings SET automation_enabled=1, telegram_enabled=1, channel_registered=1, max_daily=1, interval_minutes=15, start_hour=0, end_hour=24 WHERE id=1").run();
    for(let i=0;i<2;i++) DB.prepare("INSERT INTO offers (title, affiliate_url, category,created_at) VALUES(?,?,?,?)")
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
  globalThis.fetch=async(url)=>{if(String(url).includes('/getChat?'))return new Response(JSON.stringify({ok:true,result:{type:'channel'}}),{status:200}); throw new Error('simulação de rede interrompida');};
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
    if(address==='https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.jpg') return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'10000'}});
    if(address.endsWith('/sendPhoto')){
      const body=JSON.parse(init.body);
      assert.equal(body.photo,'https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.jpg');
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

test('foto recusada explicitamente pelo Telegram: envia texto uma única vez',async()=>{
  const DB=dbMock(); const nativeFetch=globalThis.fetch; const methods=[];
  globalThis.fetch=async (url,init={})=>{
    const address=String(url);
    if(address.includes('/getChat?'))return new Response(JSON.stringify({ok:true,result:{type:'channel'}}),{status:200});
    if(address==='https://meli.la/2bsHW5y') return new Response('<meta name="twitter:image" content="https://http2.mlstatic.com/D_NQ_NP_99999-MLB-P.jpg">',{headers:{'content-type':'text/html'}});
    if(address.startsWith('https://http2.mlstatic.com/')) return new Response(null,{status:200,headers:{'content-type':'image/jpeg'}});
    if(address.includes('/sendPhoto')){
      methods.push('sendPhoto');
      return new Response(JSON.stringify({ok:false,description:'Bad Request: failed to get HTTP URL content'}),{status:400});
    }
    if(address.includes('/sendMessage')){
      methods.push('sendMessage');
      return new Response(JSON.stringify({ok:true,result:{message_id:7}}),{status:200});
    }
    throw new Error('Unexpected');
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
    assert.equal((await pub.json()).format,'text_photo_rejected');
    assert.deepEqual(methods,['sendPhoto','sendMessage']);
  }finally{globalThis.fetch=nativeFetch;DB.close();}
});

test('cupom cadastrado entra automaticamente na oferta e deixa de aparecer depois de vencer',async()=>{
  const DB=dbMock();const native=globalThis.fetch;const messages=[];
  globalThis.fetch=async(url,init={})=>{
    if(String(url).includes('/getChat?'))return new Response(JSON.stringify({ok:true,result:{type:'channel'}}),{status:200});
    if(String(url).startsWith('https://meli.la/')) return new Response('<html></html>',{headers:{'content-type':'text/html'}});
    if(String(url).includes('/sendMessage')){
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
    assert.match(messages[0].text,/MELI10/);
    assert.equal(messages[0].reply_markup.inline_keyboard[0][0].url,'https://meli.la/COUPON01');
    const after=await worker.fetch(req('/api/coupons',{method:'POST',body:c,cookie}),env);
    assert.equal(after.status,409);
    DB.prepare('INSERT INTO offers (title,affiliate_url,category,created_at) VALUES(?,?,?,?)')
      .bind('Produto sem cupom vigente','https://meli.la/COUPON02','Geral',Math.floor(Date.now()/1000)).run();
    assert.equal((await worker.fetch(req('/api/coupons',{method:'POST',body:{...c,offer_id:2,start_day:'2025-01-01',end_day:'2025-01-31'},cookie}),env)).status,201);
    assert.equal((await worker.fetch(req('/api/offers/2/publish',{method:'POST',body:{},cookie}),env)).status,200);
    assert.doesNotMatch(messages[1].text,/MELI10/);
  }finally{globalThis.fetch=native;DB.close();}
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
    assert.equal(DB.prepare('SELECT telegram_chat_id AS destination FROM settings WHERE id=1').first().destination,'@achadinhosml1101');
  }finally{globalThis.fetch=native;DB.close();}
});
