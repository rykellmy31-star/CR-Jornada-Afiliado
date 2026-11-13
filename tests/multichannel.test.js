import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import {
  ensureMultiChannelTables,listTelegramChannels,createTelegramChannel,channelState,
  updateTelegramChannel,addChannelOffer,saveChannelCoupon,runMultiChannelScheduled,
  publishChannelOffer,normalizeTelegramHandle
} from '../src/multichannel.js';

const ORIGIN='https://afiliados.example.test';
const MAIN_TOKEN='MAIN_BOT_TOKEN';
const BOT_TOKEN='12345678:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
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
const envFor=DB=>({DB,SESSION_SECRET:'test_session_secret_of_sufficient_length_2026',ADMIN_PASSWORD:'admin-secret-for-testing',TELEGRAM_BOT_TOKEN:MAIN_TOKEN});
const config={telegram_chat_id:'@eletronicoscr',name:'Achados Tech',category:'Eletrônicos',
  bot_mode:'shared',channel_registered:true,telegram_enabled:true,automation_enabled:true,
  interval_minutes:20,max_daily:10,start_hour:0,end_hour:24};
const newOffer=(url,category='Eletrônicos')=>({title:'Fone Bluetooth Promoção',affiliate_url:url,category,owner_confirmation:true,price:'69.90'});
const realFetch=globalThis.fetch;
function fakeTelegram(sent){
  globalThis.fetch=async(url,init={})=>{
    const u=String(url);
    if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
    if(u.includes('/getMe'))return Response.json({ok:true,result:{id:987654321,is_bot:true,username:'testbot'}});
    if(u.includes('/getChatMember?'))return Response.json({ok:true,result:{status:'administrator',can_post_messages:true}});
    if(u.startsWith('https://meli.la/'))return new Response('<html></html>',{headers:{'content-type':'text/html'}});
    if(u.includes('/sendMessage')){
      sent.push({url:u,body:JSON.parse(init.body)});
      return Response.json({ok:true,result:{message_id:200+sent.length}});
    }
    throw Error('Unexpected external URL '+u);
  };
}
async function channels(env){
  const first=await createTelegramChannel(env,{name:'Achados Tech',category:'Eletrônicos',telegram_chat_id:'@eletronicoscr',bot_mode:'shared'});
  const second=await createTelegramChannel(env,{name:'Achados Moda',category:'Moda',telegram_chat_id:'@modacr',bot_mode:'shared'});
  return [first.id,second.id];
}
test('multicanal migra de forma aditiva: canal original e ofertas intactos',async()=>{
  const DB=dbMock(),env=envFor(DB);
  try{
    DB.prepare('INSERT INTO offers(title,affiliate_url,category,created_at) VALUES(?,?,?,?)')
      .bind('Oferta original','https://meli.la/AbCde1','Geral',1700000000).run();
    const first=await listTelegramChannels(env);
    assert.deepEqual(first.map(c=>c.id),[1]);
    assert.equal(first[0].telegram_chat_id,'@achadinhosmlcr');
    const ids=await channels(env);
    assert.deepEqual(ids,[2,3]);
    assert.deepEqual((await listTelegramChannels(env)).map(c=>c.id),[1,2,3]);
    assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,1);
    assert.equal(DB.prepare('SELECT interval_minutes FROM settings WHERE id=1').first().interval_minutes,30);
    await ensureMultiChannelTables(env);
    assert.equal((await listTelegramChannels(env)).length,3);
  }finally{DB.close();}
});

test('categorias e filas isoladas; links duplicados de outros canais são rejeitados',async()=>{
  const DB=dbMock(),env=envFor(DB);
  try{
    const [tech,moda]=await channels(env);
    await addChannelOffer(env,tech,newOffer('https://meli.la/AbCde1'));
    await addChannelOffer(env,moda,newOffer('https://meli.la/AbCde2','Moda'));
    assert.deepEqual((await channelState(env,tech)).offers.map(x=>x.affiliate_url),['https://meli.la/AbCde1']);
    assert.deepEqual((await channelState(env,moda)).offers.map(x=>x.affiliate_url),['https://meli.la/AbCde2']);
    assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
    await assert.rejects(addChannelOffer(env,tech,newOffer('https://meli.la/AbCde2')),/outro canal/);
    await assert.rejects(addChannelOffer(env,moda,newOffer('https://meli.la/AbCde3','Eletrônicos')),/somente ofertas da categoria/);
    const wrong=await worker.fetch(new Request(ORIGIN+'/api/channels/'+tech+'/state'),env);
    assert.equal(wrong.status,401);
  }finally{DB.close();}
});

test('token exclusivo é validado, criptografado no D1 e nunca exposto no estado',async()=>{
  const DB=dbMock(),env=envFor(DB),sent=[];
  try{
    fakeTelegram(sent);
    const res=await createTelegramChannel(env,{name:'Tecnologia exclusiva',category:'Geral',telegram_chat_id:'@botexclusivocr',bot_mode:'dedicated',bot_token:BOT_TOKEN});
    const dbChannel=DB.prepare('SELECT token_encrypted FROM telegram_channels WHERE id=?').bind(res.id).first();
    assert.ok(dbChannel.token_encrypted);
    assert.ok(!dbChannel.token_encrypted.includes(BOT_TOKEN));
    const state=await channelState(env,res.id);
    assert.equal(state.telegram_token_configured,true);
    assert.equal(state.settings.bot_configured,true);
    assert.equal(JSON.stringify(state).includes(BOT_TOKEN),false);
    assert.equal(JSON.stringify(await listTelegramChannels(env)).includes(BOT_TOKEN),false);
    const changed=await updateTelegramChannel(env,res.id,{...config,name:'Tecnologia exclusiva',category:'Geral',telegram_chat_id:'@botexclusivocr',bot_mode:'dedicated',bot_token:''});
    assert.equal(changed.channel_changed,false);
    assert.equal((await channelState(env,res.id)).settings.automation_enabled,1);
    assert.equal(sent.length,0);
  }finally{globalThis.fetch=realFetch;DB.close();}
});

test('scheduler publica ofertas distintas em canais distintos com bots e intervalos independentes',async()=>{
  const DB=dbMock(),env=envFor(DB),sent=[];
  try{
    fakeTelegram(sent);
    const [tech,moda]=await channels(env);
    await updateTelegramChannel(env,tech,config);
    await updateTelegramChannel(env,moda,{...config,name:'Achados Moda',category:'Moda',telegram_chat_id:'@modacr',interval_minutes:45});
    await addChannelOffer(env,tech,newOffer('https://meli.la/AbCde1'));
    await addChannelOffer(env,tech,newOffer('https://meli.la/AbCde3'));
    await addChannelOffer(env,moda,newOffer('https://meli.la/AbCde2','Moda'));
    const first=await runMultiChannelScheduled(env);
    assert.deepEqual(first.results.map(x=>x.status),['published','published']);
    assert.deepEqual(sent.map(x=>x.body.chat_id),['@eletronicoscr','@modacr']);
    assert.equal((await channelState(env,tech)).counts.find(x=>x.status==='published').total,1);
    assert.equal((await channelState(env,moda)).counts.find(x=>x.status==='published').total,1);
    const second=await runMultiChannelScheduled(env);
    assert.equal(second.results.length,0);
    assert.equal(sent.length,2);
    assert.equal(DB.prepare('SELECT automation_enabled FROM settings WHERE id=1').first().automation_enabled,0);
  }finally{globalThis.fetch=realFetch;DB.close();}
});

test('trocar destino ou bot pausa canal novo e não afeta canal principal',async()=>{
  const DB=dbMock(),env=envFor(DB),sent=[];
  try{
    fakeTelegram(sent);
    const [tech]=await channels(env);
    await updateTelegramChannel(env,tech,config);
    const changed=await updateTelegramChannel(env,tech,{...config,telegram_chat_id:'@eletronicosnovo'});
    assert.equal(changed.channel_changed,true);
    const after=(await channelState(env,tech)).settings;
    assert.equal(after.automation_enabled,0);
    assert.equal(after.channel_registered,0);
    assert.equal(after.telegram_enabled,0);
    assert.equal(DB.prepare('SELECT telegram_chat_id FROM settings WHERE id=1').first().telegram_chat_id,'@achadinhosmlcr');
  }finally{globalThis.fetch=realFetch;DB.close();}
});

test('cupom oficial funciona na fila do canal secundário sem misturar IDs',async()=>{
  const DB=dbMock(),env=envFor(DB);
  try{
    const [tech,moda]=await channels(env);
    await addChannelOffer(env,tech,newOffer('https://meli.la/AbCde1'));
    const id=(await channelState(env,tech)).offers[0].id;
    await assert.rejects(saveChannelCoupon(env,moda,{offer_id:id,owner_confirmation:true,kind:'code',code:'PROMO10',
      discount_type:'percent',discount_value:10,start_day:'2026-11-01',end_day:'2026-11-30',source_url:'https://www.mercadolivre.com.br/promocoes'}),/não encontrada neste canal/);
    await saveChannelCoupon(env,tech,{offer_id:id,owner_confirmation:true,kind:'code',code:'PROMO10',
      discount_type:'percent',discount_value:10,start_day:'2026-11-01',end_day:'2026-11-30',source_url:'https://www.mercadolivre.com.br/promocoes'});
    const state=await channelState(env,tech);
    assert.equal(state.offers[0].coupon_code,'PROMO10');
  }finally{DB.close();}
});

test('API autenticada permite criar, alternar e listar canais sem vazar tokens',async()=>{
  const DB=dbMock(),env=envFor(DB),sent=[];
  function req(path,opts={}){return new Request(ORIGIN+path,{method:opts.method||'GET',headers:{
    ...(opts.cookie?{cookie:opts.cookie}:{}),
    ...(opts.body?{origin:ORIGIN,'content-type':'application/json'}:{})
  },body:opts.body?JSON.stringify(opts.body):undefined});}
  try{
    fakeTelegram(sent);
    assert.equal((await worker.fetch(req('/api/channels'),env)).status,401);
    const login=await worker.fetch(req('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const created=await worker.fetch(req('/api/channels',{method:'POST',cookie,body:{name:'Canal de Moda',category:'Moda',telegram_chat_id:'@modacr',bot_mode:'shared'}}),env);
    assert.equal(created.status,201);
    const id=(await created.json()).id;
    const list=await worker.fetch(req('/api/channels',{cookie}),env);
    assert.equal(list.status,200);
    assert.deepEqual((await list.json()).channels.map(c=>c.id),[1,id]);
    const state=await worker.fetch(req('/api/channels/'+id+'/state',{cookie}),env);
    assert.equal(state.status,200);
    assert.equal((await state.json()).settings.name,'Canal de Moda');
    const nonAuthorized=await worker.fetch(new Request(ORIGIN+'/api/channels/'+id+'/offers',{method:'POST',headers:{
      origin:'https://bad.example.test','content-type':'application/json',cookie
    },body:JSON.stringify(newOffer('https://meli.la/AbCde9','Moda'))}),env);
    assert.equal(nonAuthorized.status,403);
    const added=await worker.fetch(req('/api/channels/'+id+'/offers',{method:'POST',cookie,body:newOffer('https://meli.la/AbCde9','Moda')}),env);
    assert.equal(added.status,201);
    assert.equal((await channelState(env,id)).offers.length,1);
  }finally{globalThis.fetch=realFetch;DB.close();}
});

test('validação de @canal impede usar grupos privados, urls erradas ou canais duplicados',async()=>{
  assert.equal(normalizeTelegramHandle('https://t.me/CanalTechCR'),'@canaltechcr');
  for(const wrong of ['https://t.me/+invite','@a','https://t.me/a?x=1','http://t.me/canaltechcr'])
    assert.throws(()=>normalizeTelegramHandle(wrong));
  const DB=dbMock(),env=envFor(DB);
  try{
    await createTelegramChannel(env,{name:'Moda',category:'Moda',telegram_chat_id:'@modacr',bot_mode:'shared'});
    await assert.rejects(createTelegramChannel(env,{name:'Moda 2',category:'Moda',telegram_chat_id:'@modacr',bot_mode:'shared'}),/já está cadastrado/);
    await assert.rejects(createTelegramChannel(env,{name:'Principal',telegram_chat_id:'@achadinhosmlcr'}),/principal/);
  }finally{DB.close();}
});
