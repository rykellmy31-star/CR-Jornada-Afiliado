import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import {
  ensureShopeeTables,validateShopeeAffiliateUrl,normalizeShopeeOffer,
  shopeeDestinations,shopeeState,saveShopeeTarget,addShopeeOffer,
  publishShopeeOffer,requeueShopeeOffer,runShopeeScheduled
} from '../src/shopee.js';
import { createTelegramChannel,updateTelegramChannel,getPrimaryCategory } from '../src/multichannel.js';
import {createManagedWhatsAppGroup,saveManagedWhatsAppGroup} from '../src/whatsapp-groups.js';
import {CLIENT_JS,renderPage} from '../src/ui.js';

const ORIGIN='https://afiliados.example.test';
const WA_URL='https://evo.example.com',GROUP='120363888999778@g.us';
const TOKEN='TELEGRAM_TEST_BOT_TOKEN',KEY='EVOLUTION_TEST_KEY';
const actualFetch=globalThis.fetch;
function makeDb(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  return {prepare(sql){
    let vals=[];
    return {bind(...args){vals=args;return this;},first(){return db.prepare(sql).get(...vals)||null;},
      all(){return {results:db.prepare(sql).all(...vals)};},
      run(){const data=db.prepare(sql).run(...vals);return {meta:{changes:Number(data.changes),last_row_id:Number(data.lastInsertRowid)}};}};
  },close(){db.close();}};
}
const makeEnv=DB=>({DB,ADMIN_PASSWORD:'ADMIN_PASSWORD_FOR_SHOPEE_TESTS',SESSION_SECRET:'SESSION_SECRET_2026_FOR_SHOPEE_TESTING',
  TELEGRAM_BOT_TOKEN:TOKEN,EVOLUTION_API_URL:WA_URL,EVOLUTION_API_KEY:KEY});
const official='https://s.shopee.com.br/8ADefghiJ';
const other='https://shp.ee/123456abc';
const defaultConfig={network:'telegram',target_id:1,category:'Geral',permission_confirmed:true,enabled:true,
  interval_minutes:20,max_daily:12,start_hour:0,end_hour:24};
const sample=(url=official,category='Geral')=>({network:'telegram',target_id:1,title:'Produto válido da Shopee',
  affiliate_url:url,category,owner_confirmation:true,price:'79.90',old_price:'89.90'});
const sent=[];
function mockServices(){
  sent.length=0;
  globalThis.fetch=async(url,opts={})=>{
    const address=String(url);
    if(address.includes('api.telegram.org/bot')&&address.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
    if(address.includes('api.telegram.org/bot')&&address.includes('/getMe'))return Response.json({ok:true,result:{id:7654321,is_bot:true}});
    if(address.includes('api.telegram.org/bot')&&address.includes('/getChatMember?'))return Response.json({ok:true,result:{status:'administrator',can_post_messages:true}});
    if(address.includes('api.telegram.org/bot')&&address.includes('/sendMessage')){
      const p=JSON.parse(opts.body);sent.push({network:'telegram',chat:p.chat_id,text:p.text});
      return Response.json({ok:true,result:{message_id:300+sent.length}});
    }
    if(address===WA_URL+'/group/fetchAllGroups/cr-jornada-afiliados?getParticipants=false')
      return Response.json([{id:GROUP,subject:'Grupo da Shopee'}]);
    if(address===WA_URL+'/message/sendText/cr-jornada-afiliados'){
      const body=JSON.parse(opts.body);sent.push({network:'whatsapp',chat:body.number,text:body.text});
      return Response.json({key:{id:'SHP'+sent.length}});
    }
    throw Error('Unexpected URL: '+address);
  };
}
function activateMainTelegram(DB){
  DB.prepare('UPDATE settings SET telegram_enabled=1,channel_registered=1,automation_enabled=0 WHERE id=1').run();
}
async function setupWhatsAppGroup(env){
  const {id}=await createManagedWhatsAppGroup(env,{name:'Infantil Shopee',category:'Infantil',instance_mode:'shared'});
  const c={name:'Infantil Shopee',category:'Infantil',group_jid:GROUP,
    enabled:false,public_registered:false,interval_minutes:10,max_daily:12,start_hour:0,end_hour:24};
  await saveManagedWhatsAppGroup(env,id,c);
  await saveManagedWhatsAppGroup(env,id,{...c,enabled:true,public_registered:true});
  return id;
}
test('Shopee aceita apenas links oficiais HTTPS gerados pelo usuário',()=>{
  for(const link of [official,other,'https://www.shopee.com.br/product/123','https://br.shp.ee/ab123'])
    assert.equal(validateShopeeAffiliateUrl(link),new URL(link).href);
  for(const url of ['https://evil.example/x','https://shopee.com.br.evil.example/x',
    'https://user:pwd@shopee.com.br/x','http://shopee.com.br/a','https://shopee.com.br/'])
    assert.throws(()=>validateShopeeAffiliateUrl(url));
  assert.throws(()=>normalizeShopeeOffer({...sample(),owner_confirmation:false}),/Portal de Afiliados/);
  assert.throws(()=>normalizeShopeeOffer({...sample(),old_price:'50.00'}),/preço anterior/);
});
test('Shopee tem catálogo de destinos Telegram e WhatsApp sem alterar dados originais',async()=>{
  const DB=makeDb(),env=makeEnv(DB);
  try{
    await ensureShopeeTables(env);
    const options=await shopeeDestinations(env);
    assert.deepEqual(options.destinations.map(x=>x.network),['telegram','whatsapp']);
    assert.deepEqual(options.destinations.map(x=>x.target_id),[1,1]);
    assert.equal(options.destinations[0].name,'Canal principal');
    assert.equal(options.destinations[1].name,'WhatsApp principal');
    assert.equal(DB.prepare('SELECT COUNT(*) total FROM shopee_targets').first().total,0);
    assert.equal(DB.prepare('SELECT interval_minutes FROM settings WHERE id=1').first().interval_minutes,30);
    assert.equal(await getPrimaryCategory(env),'Geral');
  }finally{DB.close();}
});
test('Shopee não ativa destino sem permissão nem sem ativar o Telegram/WhatsApp original',async()=>{
  const DB=makeDb(),env=makeEnv(DB);
  try{
    await assert.rejects(saveShopeeTarget(env,defaultConfig),/Ative e autorize/);
    activateMainTelegram(DB);
    await assert.rejects(saveShopeeTarget(env,{...defaultConfig,permission_confirmed:false}),/Confirme a autorização/);
    assert.equal((await saveShopeeTarget(env,defaultConfig)).ok,true);
    const state=await shopeeState(env,'telegram',1);
    assert.equal(state.config.enabled,1);
    assert.equal(state.config.interval_minutes,20);
    assert.equal(DB.prepare('SELECT automation_enabled FROM settings WHERE id=1').first().automation_enabled,0);
  }finally{DB.close();}
});
test('Shopee entrega duas ofertas diferentes em Telegram, respeitando o intervalo próprio',async()=>{
  const DB=makeDb(),env=makeEnv(DB);
  try{
    mockServices();activateMainTelegram(DB);
    await saveShopeeTarget(env,defaultConfig);
    await addShopeeOffer(env,sample());
    await addShopeeOffer(env,sample(other));
    const first=await runShopeeScheduled(env);
    assert.equal(first.results[0].status,'published');
    assert.equal(sent.length,1);
    assert.equal(sent[0].network,'telegram');
    assert.match(sent[0].text,/Publicidade • Oferta Shopee/);
    assert.match(sent[0].text,/s\.shopee\.com\.br/);
    assert.deepEqual((await runShopeeScheduled(env)).results,[]);
    const earlier=Math.floor(Date.now()/1000)-22*60;
    DB.prepare('UPDATE shopee_targets SET last_attempt_at=?').bind(earlier).run();
    assert.equal((await runShopeeScheduled(env)).results[0].status,'published');
    assert.equal(sent.length,2);
    assert.equal(DB.prepare('SELECT COUNT(*) total FROM offers').first().total,0);
    assert.equal(DB.prepare('SELECT COUNT(*) total FROM shopee_offers WHERE status=?').bind('published').first().total,2);
  }finally{globalThis.fetch=actualFetch;DB.close();}
});
test('Shopee permite configurar grupos WhatsApp e canais extras com categorias isoladas',async()=>{
  const DB=makeDb(),env=makeEnv(DB);
  try{
    mockServices();activateMainTelegram(DB);
    const waId=await setupWhatsAppGroup(env);
    const channel=await createTelegramChannel(env,{name:'Achadinhos Moda',category:'Moda',telegram_chat_id:'@shopeemodacr',bot_mode:'shared'});
    await updateTelegramChannel(env,channel.id,{name:'Achadinhos Moda',category:'Moda',telegram_chat_id:'@shopeemodacr',
      bot_mode:'shared',channel_registered:true,telegram_enabled:true,automation_enabled:false,
      interval_minutes:7,max_daily:10,start_hour:0,end_hour:24});
    const options=await shopeeDestinations(env);
    assert.equal(options.destinations.filter(x=>x.network==='telegram').length,2);
    assert.equal(options.destinations.filter(x=>x.network==='whatsapp').length,2);
    await assert.rejects(saveShopeeTarget(env,{...defaultConfig,network:'whatsapp',target_id:waId,category:'Masculino'}),/restrito à categoria Infantil/);
    await saveShopeeTarget(env,{...defaultConfig,network:'whatsapp',target_id:waId,category:'Infantil'});
    await saveShopeeTarget(env,{...defaultConfig,target_id:channel.id,category:'Moda'});
    await addShopeeOffer(env,{...sample(other,'Infantil'),network:'whatsapp',target_id:waId});
    await addShopeeOffer(env,{...sample(official,'Moda'),target_id:channel.id});
    assert.equal((await shopeeState(env,'whatsapp',waId)).offers[0].category,'Infantil');
    assert.equal((await shopeeState(env,'telegram',channel.id)).offers[0].category,'Moda');
    const result=await runShopeeScheduled(env);
    assert.equal(result.results.length,2);
    assert.deepEqual(sent.map(x=>x.network),['telegram','whatsapp']);
    assert.deepEqual(sent.map(x=>x.chat),['@shopeemodacr',GROUP]);
  }finally{globalThis.fetch=actualFetch;DB.close();}
});
test('Shopee rejeita categoria errada, duplicata e preserva suas ofertas de canal separado',async()=>{
  const DB=makeDb(),env=makeEnv(DB);
  try{
    activateMainTelegram(DB);
    await saveShopeeTarget(env,{...defaultConfig,category:'Motos'});
    await addShopeeOffer(env,sample(official,'Motos'));
    await assert.rejects(addShopeeOffer(env,sample(other,'Feminino')),/apenas a categoria/);
    await assert.rejects(addShopeeOffer(env,sample(official,'Motos')),/já foi cadastrado/);
    await assert.rejects(saveShopeeTarget(env,{...defaultConfig,category:'Masculino'}),/fila Shopee/);
    assert.equal((await shopeeState(env,'telegram',1)).offers[0].category,'Motos');
  }finally{DB.close();}
});
test('publicação manual de Shopee exige destino ativo, sem vazar links para Mercado Livre',async()=>{
  const DB=makeDb(),env=makeEnv(DB);
  try{
    mockServices();activateMainTelegram(DB);
    await saveShopeeTarget(env,defaultConfig);
    await addShopeeOffer(env,sample());
    const id=(await shopeeState(env,'telegram',1)).offers[0].id;
    assert.equal((await publishShopeeOffer(env,'telegram',1,id)).status,'published');
    await assert.rejects(publishShopeeOffer(env,'telegram',1,id),/já publicada/);
    assert.equal(sent[0].chat,'@achadinhosmlcr');
    assert.equal(DB.prepare('SELECT COUNT(*) total FROM logs').first().total,0);
  }finally{globalThis.fetch=actualFetch;DB.close();}
});
test('API Shopee exige login administrativo, mesma origem e oferece canais configuráveis',async()=>{
  const DB=makeDb(),env=makeEnv(DB);
  const headers={'content-type':'application/json',origin:ORIGIN};
  try{
    assert.equal((await worker.fetch(new Request(ORIGIN+'/api/shopee/destinations'),env)).status,401);
    const login=await worker.fetch(new Request(ORIGIN+'/api/login',{method:'POST',headers,body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const destinations=await worker.fetch(new Request(ORIGIN+'/api/shopee/destinations',{headers:{cookie}}),env);
    assert.equal(destinations.status,200);
    assert.equal((await destinations.json()).destinations.length,2);
    const unsafe=await worker.fetch(new Request(ORIGIN+'/api/shopee/settings',{
      method:'POST',headers:{...headers,origin:'https://host-evil.example',cookie},
      body:JSON.stringify({...defaultConfig,enabled:false})}),env);
    assert.equal(unsafe.status,403);
    const safe=await worker.fetch(new Request(ORIGIN+'/api/shopee/settings',{
      method:'POST',headers:{...headers,cookie},
      body:JSON.stringify({...defaultConfig,enabled:false})}),env);
    assert.equal(safe.status,200);
    const state=await worker.fetch(new Request(ORIGIN+'/api/shopee/state?network=telegram&target_id=1',{headers:{cookie}}),env);
    assert.equal(state.status,200);
    assert.equal((await state.json()).config.enabled,0);
  }finally{DB.close();}
});
test('menu lateral da Shopee e seletores de Telegram/WhatsApp existem e compilam',()=>{
  const html=renderPage();
  for(const name of ['platform-sidebar','platform-target-select','shopee-panel','shopee-category',
    'shopee-settings-form','shopee-offer-form','shopee-offers-rows'])
    assert.match(html,new RegExp('id="'+name+'"'));
  assert.match(html,/data-platform="mercadolivre"/);
  assert.match(html,/data-platform="shopee"/);
  assert.match(html,/data-network="telegram"/);
  assert.match(html,/data-network="whatsapp"/);
  assert.doesNotThrow(()=>new Function(CLIENT_JS));
  assert.match(CLIENT_JS,/\/api\/shopee\/state/);
  assert.match(CLIENT_JS,/selectedPlatform/);
});
