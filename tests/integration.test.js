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
    const settings={channel_registered:true,telegram_enabled:true,automation_enabled:false,interval_minutes:30,max_daily:12,start_hour:8,end_hour:21};
    assert.equal((await worker.fetch(req('/api/settings',{method:'POST',body:settings,cookie}),env)).status,200);
    const testMsg=await worker.fetch(req('/api/test-telegram',{method:'POST',body:{},cookie}),env);
    assert.equal(testMsg.status,200);
    const pub=await worker.fetch(req('/api/offers/1/publish',{method:'POST',body:{},cookie}),env);
    assert.equal(pub.status,200);
    assert.equal(lastPayload.chat_id,'@achadinhosml1101');
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
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({ok:true,result:{message_id:900+calls}}),{status:200});};
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
  globalThis.fetch=async()=>{throw new Error('simulação de rede interrompida');};
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
