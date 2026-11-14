import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { cachedProductImage, rememberProductImage } from '../src/offer-images.js';
import { updateWhatsAppSettings, runWhatsAppScheduled } from '../src/whatsapp.js';

const EVO='https://evo.example.com';
const GROUP='120363888999777@g.us';
const INSTANCE='afiliados';
const LINK='https://meli.la/PHOTO123';
const IMAGE='https://http2.mlstatic.com/D_NQ_NP_778-MLB123-F.jpg';
const originalFetch=globalThis.fetch;

function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  const DB={
    prepare(sql){let args=[];return {
      bind(...values){args=values;return this;},
      first(){return db.prepare(sql).get(...args)||null;},
      all(){return {results:db.prepare(sql).all(...args)};},
      run(){const result=db.prepare(sql).run(...args);return {meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}
    };},
    close(){db.close();}
  };
  const env={
    DB,ADMIN_PASSWORD:'test_password_for_affiliate_app',
    SESSION_SECRET:'test_secret_for_affiliate_app_12345',
    EVOLUTION_API_URL:EVO,EVOLUTION_API_KEY:'TEST_API_KEY_NOT_REAL',
    TELEGRAM_BOT_TOKEN:'TEST_TELEGRAM_TOKEN'
  };
  return {db,DB,env};
}

test('imagem publicada no Telegram é reutilizada no WhatsApp sem visitar meli.la outra vez',async()=>{
  const {db,DB,env}=setup();
  let pageReads=0, headReads=0, mediaSent=0, textsSent=0, telegramPhotos=0;
  try{
    globalThis.fetch=async(url,options={})=>{
      const u=String(url);
      if(u===EVO+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false')
        return Response.json([{id:GROUP,subject:'Promoções'}]);
      if(u==='https://meli.la/PHOTO123'){
        pageReads++;
        if(pageReads!==1)throw new Error('WhatsApp fez busca repetida de produto!');
        return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_778-MLB123-P.jpg">',{
          headers:{'content-type':'text/html'}
        });
      }
      if(u===IMAGE && options.method==='HEAD'){
        headReads++;
        return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'350000'}});
      }
      if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
      if(u.endsWith('/sendPhoto')){
        const payload=JSON.parse(options.body);
        assert.equal(payload.photo,IMAGE);
        telegramPhotos++;
        return Response.json({ok:true,result:{message_id:101}});
      }
      if(u===EVO+'/message/sendMedia/'+INSTANCE){
        const payload=JSON.parse(options.body);
        assert.equal(payload.number,GROUP);
        assert.equal(payload.mediatype,'image');
        assert.equal(payload.media,IMAGE);
        assert.match(payload.caption,/https:\/\/meli\.la\/PHOTO123/);
        mediaSent++;
        return Response.json({key:{id:'WA_PHOTO_101'}});
      }
      if(u===EVO+'/message/sendText/'+INSTANCE){textsSent++;return Response.json({key:{id:'WA_TEXT'}});}
      throw new Error('URL inesperada: '+u);
    };
    await updateWhatsAppSettings(env,{
      instance_name:INSTANCE,group_jid:GROUP,public_registered:false,
      enabled:false,interval_minutes:1
    });
    await updateWhatsAppSettings(env,{
      instance_name:INSTANCE,group_jid:GROUP,public_registered:true,
      enabled:true,interval_minutes:1
    });
    DB.prepare('UPDATE settings SET telegram_enabled=1,channel_registered=1 WHERE id=1').run();
    DB.prepare('INSERT INTO offers(title,affiliate_url,category,created_at) VALUES(?,?,?,?)')
      .bind('Lavadora de alta pressão',LINK,'Geral',Math.floor(Date.now()/1000)).run();
    const origin='https://afiliados.example.test';
    const login=await worker.fetch(new Request(origin+'/api/login',{method:'POST',
      headers:{origin,'content-type':'application/json'},
      body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env);
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const publish=await worker.fetch(new Request(origin+'/api/offers/1/publish',{
      method:'POST',headers:{origin,'content-type':'application/json',cookie},body:'{}'
    }),env);
    assert.equal(publish.status,200);
    assert.equal(telegramPhotos,1);
    assert.equal(await cachedProductImage(env,LINK),IMAGE);
    const sent=await runWhatsAppScheduled(env);
    assert.equal(sent.status,'sent');
    assert.equal(sent.format,'photo');
    assert.equal(pageReads,1);
    assert.equal(headReads,1);
    assert.equal(mediaSent,1);
    assert.equal(textsSent,0);
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
  }finally{globalThis.fetch=originalFetch;DB.close();}
});

test('não persiste foto não oficial, cache usa o link exato e não tem imagens entre produtos distintos',async()=>{
  const {DB,env}=setup();
  try{
    assert.equal(await rememberProductImage(env,LINK,'https://site-externo.example.com/foto.jpg'),false);
    assert.equal(await cachedProductImage(env,LINK),null);
    assert.equal(await rememberProductImage(env,LINK,IMAGE),true);
    assert.equal(await cachedProductImage(env,LINK),IMAGE);
    assert.equal(await cachedProductImage(env,'https://meli.la/DIFFERENT'),null);
  }finally{DB.close();}
});
