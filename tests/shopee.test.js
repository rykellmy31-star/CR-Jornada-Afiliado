import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {
  ensureShopeeTables,validateShopeeAffiliateUrl,normalizeShopeeOffer,
  shopeeDestinations,shopeeState,saveShopeeTarget,addShopeeOffer,
  publishShopeeOffer,runShopeeScheduled
} from '../src/shopee.js';
import {
  createShopeeOwnDestination,saveShopeeOwnTelegram,saveShopeeOwnWhatsApp,
  listShopeeOwnDestinations,shopeeWhatsAppConnection,shopeeWhatsAppOptions
} from '../src/shopee-destinations.js';
import {CLIENT_JS,renderPage} from '../src/ui.js';

const ORIGIN='https://afiliados.example.test';
const WA_URL='https://evo.example.com';
const GROUP='120363888999778@g.us';
const MAIN_GROUP='120363888999777@g.us';
const TELEGRAM_TOKEN='12345678:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SHARED='cr-jornada-shopee',ML_INSTANCE='cr-jornada-afiliados';
const actualFetch=globalThis.fetch;
function makeDb(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 return {prepare(sql){
   let values=[];
   return {bind(...args){values=args;return this;},
     first(){return db.prepare(sql).get(...values)||null;},
     all(){return {results:db.prepare(sql).all(...values)};},
     run(){const x=db.prepare(sql).run(...values);return {meta:{changes:Number(x.changes),last_row_id:Number(x.lastInsertRowid)}};}};
 },close(){db.close();}};
}
const envFor=DB=>({DB,ADMIN_PASSWORD:'ADMIN_PASSWORD_FOR_SHOPEE_TESTS',
  SESSION_SECRET:'SESSION_SECRET_2026_FOR_SHOPEE_TESTING',
  TELEGRAM_BOT_TOKEN:'MERCADO_LIVRE_EXISTING_TOKEN',
  EVOLUTION_API_URL:WA_URL,EVOLUTION_API_KEY:'EVOLUTION_TEST_KEY'});
const url='https://s.shopee.com.br/8ADefghiJ',other='https://shp.ee/123456abc';
const offer=(target,link=url,category='Geral')=>({
  network:target.network,target_id:target.id,title:'Produto válido da Shopee',
  affiliate_url:link,category,owner_confirmation:true,price:'79.90',old_price:'89.90'
});
const config=(target,category='Geral')=>({
  network:target.network,target_id:target.id,category,permission_confirmed:true,enabled:true,
  interval_minutes:20,max_daily:12,start_hour:0,end_hour:24
});
const posted=[];
let instanceCreated=false;
function mockExternal(){
 posted.length=0;instanceCreated=false;
 globalThis.fetch=async(request,opts={})=>{
   const u=String(request);
   if(u.includes('api.telegram.org/bot')){
     assert.ok(u.includes(TELEGRAM_TOKEN),'A Shopee nunca deve usar o bot do Mercado Livre.');
     if(u.includes('/getMe'))return Response.json({ok:true,result:{id:12345678,is_bot:true}});
     if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
     if(u.includes('/getChatMember?'))return Response.json({ok:true,result:{status:'administrator',can_post_messages:true}});
     if(u.includes('/sendMessage')){
       const body=JSON.parse(opts.body);
       posted.push({network:'telegram',chat:body.chat_id,text:body.text});
       return Response.json({ok:true,result:{message_id:900+posted.length}});
     }
   }
   if(u===WA_URL+'/group/fetchAllGroups/'+SHARED+'?getParticipants=false')
     return Response.json([{id:GROUP,subject:'Ofertas Shopee'}]);
   if(u===WA_URL+'/message/sendText/'+SHARED){
     const body=JSON.parse(opts.body);
     posted.push({network:'whatsapp',chat:body.number,text:body.text});
     return Response.json({key:{id:'shopee_'+posted.length}});
   }
   if(u===WA_URL+'/instance/fetchInstances')
     return Response.json(instanceCreated?[{name:ML_INSTANCE},{name:SHARED}]:[{name:ML_INSTANCE}]);
   if(u===WA_URL+'/instance/create'){
     const body=JSON.parse(opts.body);
     assert.equal(body.instanceName,SHARED);
     instanceCreated=true;
     return Response.json({instance:{instanceName:SHARED},qrcode:{base64:'iVBORw0KGgoAAAANSUhEUg=='}});
   }
   if(u===WA_URL+'/instance/connectionState/'+SHARED)
     return Response.json({instance:{state:'connecting'}});
   if(u===WA_URL+'/instance/connect/'+SHARED)
     return Response.json({base64:'iVBORw0KGgoAAAANSUhEUg=='});
   throw Error('External URL unexpected '+u);
 };
}
async function createTele(env,name='Canal Infantil Shopee',category='Infantil',chat='@shopeeinfantil'){
 const r=await createShopeeOwnDestination(env,{network:'telegram',name,category,telegram_chat_id:chat});
 return {network:'telegram',id:r.id};
}
async function activateTele(env,dest,name='Canal Infantil Shopee',category='Infantil',chat='@shopeeinfantil'){
 const body={name,category,telegram_chat_id:chat,bot_token:TELEGRAM_TOKEN,channel_registered:true,enabled:true};
 const first=await saveShopeeOwnTelegram(env,dest.id,body);
 assert.equal(first.enabled,false);
 const second=await saveShopeeOwnTelegram(env,dest.id,{...body,bot_token:''});
 assert.equal(second.enabled,true);
}
async function createWA(env,name='Grupo Infantil Shopee',category='Infantil',mode='shared'){
 const r=await createShopeeOwnDestination(env,{network:'whatsapp',name,category,instance_mode:mode});
 return {network:'whatsapp',id:r.id};
}
async function activateWA(env,dest,name='Grupo Infantil Shopee',category='Infantil',jid=GROUP){
 const body={name,category,group_jid:jid,public_registered:true,enabled:true};
 const first=await saveShopeeOwnWhatsApp(env,dest.id,body);
 assert.equal(first.enabled,false);
 const second=await saveShopeeOwnWhatsApp(env,dest.id,body);
 assert.equal(second.enabled,true);
}
test('Shopee aceita somente links HTTPS autorizados manualmente',()=>{
 for(const link of [url,other,'https://www.shopee.com.br/product/123','https://br.shp.ee/ab123'])
   assert.equal(validateShopeeAffiliateUrl(link),new URL(link).href);
 for(const link of ['https://evil.example/x','https://shopee.com.br.evil.example/x',
    'https://user:pwd@shopee.com.br/x','http://shopee.com.br/a','https://shopee.com.br/'])
   assert.throws(()=>validateShopeeAffiliateUrl(link));
 assert.throws(()=>normalizeShopeeOffer({...offer({network:'telegram',id:1000}),owner_confirmation:false}),/Portal de Afiliados/);
});
test('Shopee inicia sem nenhum canal Mercado Livre e preserva o banco original',async()=>{
 const DB=makeDb(),env=envFor(DB);
 try{
   const destinations=await shopeeDestinations(env);
   assert.deepEqual(destinations.destinations,[]);
   assert.equal(DB.prepare('SELECT COUNT(*) total FROM shopee_targets').first().total,0);
   assert.equal(DB.prepare("SELECT COUNT(*) total FROM sqlite_master WHERE type='table' AND name='telegram_channels'").first().total,0);
   assert.equal(DB.prepare('SELECT interval_minutes FROM settings WHERE id=1').first().interval_minutes,30);
   const list=await listShopeeOwnDestinations(env);
   assert.deepEqual(list,[]);
 }finally{DB.close();}
});
test('destinos Shopee Telegram e WhatsApp têm IDs próprios e configuração independente',async()=>{
 const DB=makeDb(),env=envFor(DB);
 try{
   const t1=await createTele(env);
   const t2=await createTele(env,'Shopee Feminino','Feminino','@shopeefeminino');
   const wa=await createWA(env);
   assert.deepEqual([t1.id,t2.id,wa.id],[1000,1001,1000]);
   const dest=(await shopeeDestinations(env)).destinations;
   assert.equal(dest.length,3);
   assert.deepEqual(dest.map(x=>x.name),['Canal Infantil Shopee','Shopee Feminino','Grupo Infantil Shopee']);
   assert.equal(dest[0].base_enabled,false);
   assert.equal(dest[2].instance_name,SHARED);
   assert.equal(DB.prepare('SELECT COUNT(*) total FROM telegram_channels').first().total,0);
   assert.equal(DB.prepare("SELECT COUNT(*) total FROM sqlite_master WHERE type='table' AND name='whatsapp_groups'").first().total,0);
   assert.equal(DB.prepare("SELECT COUNT(*) total FROM sqlite_master WHERE type='table' AND name='whatsapp_settings'").first().total,0);
 }finally{DB.close();}
});
test('bot Telegram exclusivo Shopee é criptografado e nunca aparece no estado',async()=>{
 const DB=makeDb(),env=envFor(DB);
 try{
   mockExternal();
   const channel=await createTele(env);
   const first=await saveShopeeOwnTelegram(env,channel.id,{name:'Canal Infantil Shopee',category:'Infantil',
     telegram_chat_id:'@shopeeinfantil',bot_token:TELEGRAM_TOKEN,channel_registered:true,enabled:true});
   assert.equal(first.enabled,false);
   assert.equal(first.changed,true);
   const raw=DB.prepare('SELECT token_encrypted FROM shopee_telegram_channels WHERE id=?').bind(channel.id).first();
   assert.ok(raw.token_encrypted&&!raw.token_encrypted.includes(TELEGRAM_TOKEN));
   const view=await shopeeDestinations(env);
   assert.equal(JSON.stringify(view).includes(TELEGRAM_TOKEN),false);
   await activateTele(env,channel);
   assert.equal((await shopeeDestinations(env)).destinations[0].base_enabled,true);
   const state=await shopeeState(env,'telegram',channel.id);
   assert.equal(state.base.bot_configured,true);
 }finally{globalThis.fetch=actualFetch;DB.close();}
});
test('WhatsApp Shopee compartilha somente instância Shopee e não altera Evolution Mercado Livre',async()=>{
 const DB=makeDb(),env=envFor(DB);
 try{
   mockExternal();
   const group=await createWA(env);
   const initial=await shopeeWhatsAppConnection(env,group.id,false);
   assert.equal(initial.state,'not_created');
   const qr=await shopeeWhatsAppConnection(env,group.id,true);
   assert.equal(qr.instance_name,SHARED);
   assert.match(qr.qr_image,/^data:image\/png;base64,/);
   assert.equal((await shopeeWhatsAppOptions(env,group.id)).groups[0].id,GROUP);
   await activateWA(env,group);
   assert.equal((await shopeeDestinations(env)).destinations[0].base_registered,true);
   assert.equal(DB.prepare("SELECT COUNT(*) total FROM sqlite_master WHERE type='table' AND name='whatsapp_settings'").first().total,0);
 }finally{globalThis.fetch=actualFetch;DB.close();}
});
test('Shopee publica por bot próprio e grupo próprio, com categoria e intervalo independentes',async()=>{
 const DB=makeDb(),env=envFor(DB);
 try{
   mockExternal();
   const tele=await createTele(env),wa=await createWA(env);
   await activateTele(env,tele);
   await activateWA(env,wa);
   assert.equal((await saveShopeeTarget(env,config(tele,'Infantil'))).ok,true);
   assert.equal((await saveShopeeTarget(env,config(wa,'Infantil'))).ok,true);
   await addShopeeOffer(env,offer(tele,url,'Infantil'));
   await addShopeeOffer(env,offer(tele,other,'Infantil'));
   await addShopeeOffer(env,offer(wa,url,'Infantil'));
   await assert.rejects(addShopeeOffer(env,offer(wa,other,'Masculino')),/apenas a categoria/);
   const first=await runShopeeScheduled(env);
   assert.equal(first.results.length,2);
   assert.deepEqual(posted.map(p=>p.network),['telegram','whatsapp']);
   assert.deepEqual(posted.map(p=>p.chat),['@shopeeinfantil',GROUP]);
   assert.equal(posted[0].text.includes(url),true);
   assert.equal((await runShopeeScheduled(env)).results.length,0);
   DB.prepare('UPDATE shopee_targets SET last_attempt_at=? WHERE network=?').bind(Math.floor(Date.now()/1000)-21*60,'telegram').run();
   const second=await runShopeeScheduled(env);
   assert.equal(second.results.length,1);
   assert.equal(posted.length,3);
   assert.equal(DB.prepare('SELECT COUNT(*) total FROM offers').first().total,0);
   assert.equal(DB.prepare("SELECT COUNT(*) total FROM sqlite_master WHERE type='table' AND name='channel_offers'").first().total,0);
 }finally{globalThis.fetch=actualFetch;DB.close();}
});
test('destinos Shopee legados ligados a IDs do Mercado Livre ficam preservados, mas nunca recebem ofertas',async()=>{
 const DB=makeDb(),env=envFor(DB);
 try{
   mockExternal();
   await ensureShopeeTables(env);
   DB.prepare("INSERT INTO shopee_targets(network,target_id,category,enabled,permission_confirmed,created_at,updated_at) VALUES('telegram',1,'Geral',1,1,?,?)").bind(1000,1000).run();
   const existing=DB.prepare('SELECT * FROM shopee_targets WHERE target_id=1').first();
   const r=await runShopeeScheduled(env);
   assert.deepEqual(r.results,[]);
   assert.equal(DB.prepare('SELECT enabled FROM shopee_targets WHERE id=?').bind(existing.id).first().enabled,1);
   await assert.rejects(shopeeState(env,'telegram',1),/não encontrado/);
   assert.deepEqual((await shopeeDestinations(env)).destinations,[]);
 }finally{globalThis.fetch=actualFetch;DB.close();}
});
test('Shopee não permite ativar sem conexão exclusiva nem divulgar em canal de categoria diferente',async()=>{
 const DB=makeDb(),env=envFor(DB);
 try{
   const own=await createTele(env);
   await assert.rejects(saveShopeeTarget(env,config(own,'Infantil')),/Confirme a autorização/);
   await assert.rejects(saveShopeeTarget(env,config(own,'Masculino')),/restrito à categoria/);
   await saveShopeeTarget(env,{...config(own,'Infantil'),enabled:false,permission_confirmed:false});
   await assert.rejects(addShopeeOffer(env,offer(own,url,'Masculino')),/apenas a categoria/);
   await addShopeeOffer(env,offer(own,url,'Infantil'));
   await assert.rejects(saveShopeeTarget(env,{...config(own,'Geral'),enabled:false}),/restrito à categoria/);
 }finally{DB.close();}
});
test('API de criação e ajustes Shopee exige login e proteção de origem',async()=>{
 const DB=makeDb(),env=envFor(DB);
 const headers={'content-type':'application/json',origin:ORIGIN};
 try{
   assert.equal((await worker.fetch(new Request(ORIGIN+'/api/shopee/destinations'),env)).status,401);
   const login=await worker.fetch(new Request(ORIGIN+'/api/login',{method:'POST',headers,
     body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env);
   const cookie=login.headers.get('set-cookie').split(';')[0];
   const create=await worker.fetch(new Request(ORIGIN+'/api/shopee/destinations/create',{method:'POST',
     headers:{...headers,cookie},body:JSON.stringify({network:'telegram',name:'Ofertas Shopee',category:'Geral',telegram_chat_id:'@ofertasshopee'})}),env);
   assert.equal(create.status,201);
   const destination=(await create.json()).id;
   assert.ok(destination>=1000);
   const state=await worker.fetch(new Request(ORIGIN+'/api/shopee/state?network=telegram&target_id='+destination,{headers:{cookie}}),env);
   assert.equal(state.status,200);
   const blocked=await worker.fetch(new Request(ORIGIN+'/api/shopee/destinations/create',{method:'POST',
     headers:{...headers,origin:'https://attacker.example',cookie},body:JSON.stringify({network:'whatsapp',name:'Atacante'})}),env);
   assert.equal(blocked.status,403);
 }finally{DB.close();}
});
test('interface da Shopee tem criação separada para canais e grupos, além de bot/QR',()=>{
 const html=renderPage();
 for(const id of ['shopee-destination-create-form','shopee-create-toggle','shopee-create-wa-mode','shopee-create-telegram-handle',
   'shopee-telegram-destination-form','shopee-tele-token','shopee-whatsapp-destination-form',
   'shopee-wa-connect','shopee-wa-qr-image','shopee-wa-group','shopee-destination-manage'])
   assert.ok(html.includes('id="'+id+'"'),id+' ausente');
 assert.match(html,/data-platform="mercadolivre"/);
 assert.match(html,/data-platform="shopee"/);
 assert.doesNotThrow(()=>new Function(CLIENT_JS));
 assert.match(CLIENT_JS,/\/api\/shopee\/destinations\/create/);
 assert.match(CLIENT_JS,/shopeeTarget=\{telegram:null,whatsapp:null\}/);
});
