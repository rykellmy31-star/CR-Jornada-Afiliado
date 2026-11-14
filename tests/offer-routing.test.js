import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {getWhatsAppState,runWhatsAppScheduled,updateWhatsAppSettings,ensureWhatsAppTables,publishDirectWhatsAppOffer} from '../src/whatsapp.js';
import {renderPage,CLIENT_JS} from '../src/ui.js';

const ORIGIN='https://afiliados.example.test';
const BASE='https://evo.example.com';
const INSTANCE='afiliados';
const GROUP='120363888999777@g.us';
const GROUP_OTHER='120363888999778@g.us';
const URL_A='https://meli.la/FAKE11';
const URL_B='https://meli.la/FAKE22';
const URL_C='https://meli.la/FAKE33';
const ORIGINAL_FETCH=globalThis.fetch;
function mockDB(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  return {
    prepare(sql){let vals=[];return {
      bind(...p){vals=p;return this;},
      first(){return sqlite.prepare(sql).get(...vals)||null;},
      all(){return {results:sqlite.prepare(sql).all(...vals)};},
      run(){const r=sqlite.prepare(sql).run(...vals);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
    };},
    close(){sqlite.close();}
  };
}
function envFor(DB){return {DB,ADMIN_PASSWORD:'password_for_whatsapp_routing',
  SESSION_SECRET:'session_secret_for_routing_test_2026',
  EVOLUTION_API_URL:BASE,EVOLUTION_API_KEY:'FAKE_KEY',TELEGRAM_BOT_TOKEN:'FAKE_TELEGRAM_TOKEN'};}
const req=(path,body,cookie,method='POST')=>new Request(ORIGIN+path,{method,headers:{
  ...(body!==undefined?{'content-type':'application/json',origin:ORIGIN}:{}),
  ...(cookie?{cookie}:{})
},body:body===undefined?undefined:JSON.stringify(body)});
async function cookieFor(env){
  const res=await worker.fetch(req('/api/login',{password:env.ADMIN_PASSWORD}),env);
  assert.equal(res.status,200);
  return res.headers.get('set-cookie').split(';')[0];
}
async function api(env,cookie,path,body){
  const response=await worker.fetch(req(path,body,cookie),env);
  const json=await response.json();
  return {code:response.status,data:json};
}
async function activateWhatsApp(env,category='Geral'){
  const config={instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,category,interval_minutes:7};
  await updateWhatsAppSettings(env,config);
  await updateWhatsAppSettings(env,{...config,public_registered:true,enabled:true});
}
function mockNetwork(sent){
  globalThis.fetch=async(url,opts={})=>{
    const u=String(url);
    if(u===BASE+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false')
      return Response.json([{id:GROUP,subject:'Grupo de Afiliados'},{id:GROUP_OTHER,subject:'Outro Grupo'}]);
    if(u.startsWith('https://meli.la/'))
      return new Response('<html></html>',{headers:{'content-type':'text/html'}});
    if(u.includes('api.telegram.org')&&u.includes('/getChat?'))
      return Response.json({ok:true,result:{type:'channel'}});
    if(u.includes('api.telegram.org')&&u.includes('/sendMessage')){
      const body=JSON.parse(opts.body);sent.push({destination:'telegram',body});
      return Response.json({ok:true,result:{message_id:sent.length+100}});
    }
    if(u===BASE+'/message/sendText/'+INSTANCE){
      const body=JSON.parse(opts.body);sent.push({destination:'whatsapp',body});
      return Response.json({key:{id:'WA_'+sent.length}});
    }
    throw Error('Unexpected fetch '+u);
  };
}
const offer=(url=URL_A,mode='both',category='Geral')=>({
  title:'Produto teste mercado livre',
  affiliate_url:url,category,delivery_mode:mode,owner_confirmation:true,price:'69.90',old_price:'79.90'
});

test('novos cadastros explícitos escolhem Telegram, WhatsApp ou ambos sem apagar tabelas',async()=>{
  const DB=mockDB(),env=envFor(DB),sent=[];
  try{
    mockNetwork(sent);await activateWhatsApp(env);
    const cookie=await cookieFor(env);
    let r=await api(env,cookie,'/api/offers',offer(URL_A,'telegram'));
    assert.equal(r.code,201);
    r=await api(env,cookie,'/api/whatsapp/offers',offer(URL_B,'whatsapp'));
    assert.equal(r.code,201);
    r=await api(env,cookie,'/api/offers',offer(URL_C,'both'));
    assert.equal(r.code,201);
    const telegram=DB.prepare('SELECT affiliate_url,status FROM offers ORDER BY id').all().results;
    assert.deepEqual(telegram.map(x=>x.affiliate_url),[URL_A,URL_C]);
    assert.equal(telegram.every(x=>x.status==='ready'),true);
    assert.deepEqual(DB.prepare('SELECT delivery_mode FROM offer_delivery_routing ORDER BY offer_id').all().results.map(x=>x.delivery_mode),['telegram','both']);
    assert.deepEqual((await getWhatsAppState(env)).direct_offers.map(x=>x.affiliate_url),[URL_B]);
    assert.equal(sent.length,0);
  }finally{globalThis.fetch=ORIGINAL_FETCH;DB.close();}
});

test('somente WhatsApp publica sem Telegram, usando intervalo do grupo e sem duplicar',async()=>{
  const DB=mockDB(),env=envFor(DB),sent=[];
  try{
    mockNetwork(sent);await activateWhatsApp(env);
    const cookie=await cookieFor(env);
    const add=await api(env,cookie,'/api/whatsapp/offers',offer(URL_A,'whatsapp'));
    assert.equal(add.code,201);
    delete env.TELEGRAM_BOT_TOKEN;
    const first=await runWhatsAppScheduled(env);
    assert.equal(first.status,'published');
    assert.equal(first.source,'direct');
    assert.equal(sent.length,1);
    assert.equal(sent[0].destination,'whatsapp');
    assert.equal(sent[0].body.number,GROUP);
    assert.match(sent[0].body.text,/https:\/\/meli\.la\/FAKE11/);
    const state=await getWhatsAppState(env);
    assert.equal(state.direct_offers[0].status,'published');
    assert.equal(state.deliveries.length,0);
    assert.equal(DB.prepare('SELECT COUNT(*) c FROM offers').first().c,0);
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
  }finally{globalThis.fetch=ORIGINAL_FETCH;DB.close();}
});

test('somente Telegram nunca é espelhado, mas "ambos" envia uma vez em cada',async()=>{
  const DB=mockDB(),env=envFor(DB),sent=[];
  try{
    mockNetwork(sent);await activateWhatsApp(env);
    const cookie=await cookieFor(env);
    const one=await api(env,cookie,'/api/offers',offer(URL_A,'telegram'));
    const two=await api(env,cookie,'/api/offers',offer(URL_B,'both'));
    assert.equal(one.code,201);assert.equal(two.code,201);
    DB.prepare('UPDATE settings SET telegram_enabled=1,channel_registered=1 WHERE id=1').run();
    for(const id of [one.data.offer_id,two.data.offer_id]){
      const pub=await api(env,cookie,'/api/offers/'+id+'/publish',{});
      assert.equal(pub.code,200);
    }
    assert.deepEqual(sent.map(x=>x.destination),['telegram','telegram']);
    const wa=await runWhatsAppScheduled(env);
    assert.equal(wa.status,'sent');
    assert.equal(wa.source,'mirrored');
    assert.equal(sent.length,3);
    assert.equal(sent[2].destination,'whatsapp');
    assert.match(sent[2].body.text,/https:\/\/meli\.la\/FAKE22/);
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
    assert.equal((await getWhatsAppState(env)).deliveries.length,1);
  }finally{globalThis.fetch=ORIGINAL_FETCH;DB.close();}
});

test('ofertas antigas permanecem espelháveis e modo antigo sem campo permanece compatível',async()=>{
  const DB=mockDB(),env=envFor(DB),sent=[];
  try{
    mockNetwork(sent);await activateWhatsApp(env);
    const cookie=await cookieFor(env);
    const body=offer(URL_A);
    delete body.delivery_mode;
    const response=await api(env,cookie,'/api/offers',body);
    assert.equal(response.code,201);
    assert.equal(DB.prepare('SELECT delivery_mode FROM offer_delivery_routing WHERE offer_id=?').bind(response.data.offer_id).first().delivery_mode,'both');
    const now=Math.floor(Date.now()/1000);
    DB.prepare("UPDATE offers SET status='published',published_at=? WHERE id=?").bind(now+1,response.data.offer_id).run();
    const mirror=await runWhatsAppScheduled(env);
    assert.equal(mirror.status,'sent');
    assert.equal(sent.length,1);
  }finally{globalThis.fetch=ORIGINAL_FETCH;DB.close();}
});

test('validação protege categorias, links duplicados, grupos e autorizações',async()=>{
  const DB=mockDB(),env=envFor(DB),sent=[];
  try{
    mockNetwork(sent);
    const cookie=await cookieFor(env);
    assert.equal((await api(env,cookie,'/api/whatsapp/offers',offer(URL_A,'whatsapp'))).code,400);
    await activateWhatsApp(env,'Motos');
    assert.equal((await api(env,cookie,'/api/whatsapp/offers',offer(URL_A,'whatsapp','Infantil'))).code,400);
    assert.equal((await api(env,cookie,'/api/whatsapp/offers',offer(URL_A,'whatsapp','Motos'))).code,201);
    assert.equal((await api(env,cookie,'/api/offers',offer(URL_A,'telegram','Motos'))).code,409);
    assert.equal((await api(env,cookie,'/api/whatsapp/offers',offer(URL_A,'whatsapp','Motos'))).code,409);
    assert.equal((await api(env,cookie,'/api/offers',offer(URL_B,'ambos','Motos'))).code,400);
    assert.equal(DB.prepare('SELECT COUNT(*) c FROM whatsapp_direct_offers').first().c,1);
  }finally{globalThis.fetch=ORIGINAL_FETCH;DB.close();}
});

test('oferta WhatsApp fica presa ao grupo original, nunca redirecionada a outro grupo',async()=>{
  const DB=mockDB(),env=envFor(DB),sent=[];
  try{
    mockNetwork(sent);await activateWhatsApp(env);
    const cookie=await cookieFor(env);
    assert.equal((await api(env,cookie,'/api/whatsapp/offers',offer(URL_A,'whatsapp'))).code,201);
    DB.prepare('UPDATE whatsapp_settings SET group_jid=? WHERE id=1').bind(GROUP_OTHER).run();
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
    assert.equal(sent.length,0);
    await assert.rejects(publishDirectWhatsAppOffer(env,1),/outro grupo/);
  }finally{globalThis.fetch=ORIGINAL_FETCH;DB.close();}
});

test('publicação manual WhatsApp respeita intervalo e falhas ambíguas vão para revisão',async()=>{
  const DB=mockDB(),env=envFor(DB),sent=[];
  try{
    mockNetwork(sent);await activateWhatsApp(env);
    const cookie=await cookieFor(env);
    assert.equal((await api(env,cookie,'/api/whatsapp/offers',offer(URL_A,'whatsapp'))).code,201);
    assert.equal((await api(env,cookie,'/api/whatsapp/offers',offer(URL_B,'whatsapp'))).code,201);
    let out=await api(env,cookie,'/api/whatsapp/offers/1/publish',{});
    assert.equal(out.code,200);
    out=await api(env,cookie,'/api/whatsapp/offers/2/publish',{});
    assert.equal(out.code,409);
    assert.equal(out.data.skipped,'interval');
    assert.equal(sent.length,1);
    DB.prepare('UPDATE whatsapp_schedule_custom SET last_attempt_at=? WHERE id=1').bind(Math.floor(Date.now()/1000)-500).run();
    DB.prepare('UPDATE whatsapp_instance_pacing SET last_attempt_at=?').bind(Math.floor(Date.now()/1000)-500).run();
    globalThis.fetch=async(url,opts={})=>{
      const s=String(url);
      if(s.startsWith('https://meli.la/'))return new Response('<html></html>',{headers:{'content-type':'text/html'}});
      if(s===BASE+'/message/sendText/'+INSTANCE)return Response.json({pending:true});
      throw Error('Unexpected fetch '+s);
    };
    out=await api(env,cookie,'/api/whatsapp/offers/2/publish',{});
    assert.equal(out.code,409);
    assert.equal(out.data.status,'needs_review');
    assert.equal(DB.prepare('SELECT status FROM whatsapp_direct_offers WHERE id=2').first().status,'needs_review');
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
    assert.equal((await api(env,cookie,'/api/whatsapp/offers/2/requeue',{})).code,200);
  }finally{globalThis.fetch=ORIGINAL_FETCH;DB.close();}
});

test('API de cadastro WhatsApp exige sessão administrativa e origem confiável',async()=>{
  const DB=mockDB(),env=envFor(DB);
  try{
    assert.equal((await worker.fetch(req('/api/whatsapp/offers',offer(URL_A,'whatsapp')),env)).status,401);
    const cookie=await cookieFor(env);
    const unsafe=await worker.fetch(new Request(ORIGIN+'/api/whatsapp/offers',{
      method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example.test',cookie},
      body:JSON.stringify(offer(URL_A,'whatsapp'))
    }),env);
    assert.equal(unsafe.status,403);
  }finally{DB.close();}
});

test('painel mostra seletor de destino e formulário WhatsApp com fila e ações',()=>{
  const html=renderPage();
  for(const id of ['offer-delivery-mode','wa-direct-offer-form','wa-direct-delivery-mode',
    'wa-direct-offers','wa-direct-category','wa-direct-feedback','offer-delivery-wrap'])
    assert.ok(html.includes('id="'+id+'"'),id+' não encontrado');
  assert.match(html,/<option value="telegram">Somente Telegram<\/option>/);
  assert.match(html,/<option value="whatsapp" selected>Somente WhatsApp<\/option>/);
  assert.match(html,/<option value="both" selected>Telegram e WhatsApp<\/option>/);
  assert.doesNotThrow(()=>new Function(CLIENT_JS));
  assert.match(CLIENT_JS,/\/api\/whatsapp\/offers/);
});
