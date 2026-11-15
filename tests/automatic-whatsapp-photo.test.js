import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {sourcePageForAffiliateImage,resolveProductImage,cachedProductImage,claimAffiliateImageBrowserBudget} from '../src/offer-images.js';
import {updateWhatsAppSettings,runWhatsAppScheduled} from '../src/whatsapp.js';

const SHORT='https://meli.la/1ZbJKkU';
const ORIGINAL='https://www.mercadolivre.com.br/perfume-masculino-eau-de-parfum-azzaro-the-most-wanted-intense-100ml/p/MLB12345678';
const PHOTO_SOURCE='https://http2.mlstatic.com/D_NQ_NP_763110-MLA115947651793_082026-P.webp';
const PHOTO_LARGE='https://http2.mlstatic.com/D_NQ_NP_763110-MLA115947651793_082026-F.jpg';
const EVO='https://evo.example.com';
const INSTANCE='cr-jornada-afiliados',GROUP='120363888999777@g.us';
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 db.exec("CREATE TABLE ml_link_batch_items(id INTEGER PRIMARY KEY, source_url TEXT NOT NULL,affiliate_url TEXT,status TEXT NOT NULL DEFAULT 'awaiting_links')");
 const DB={
  prepare(sql){let params=[];return {
   bind(...values){params=values;return this;},
   first(){return db.prepare(sql).get(...params)||null;},
   all(){return {results:db.prepare(sql).all(...params)};},
   run(){const res=db.prepare(sql).run(...params);return {meta:{changes:Number(res.changes),last_row_id:Number(res.lastInsertRowid)}};}
  };},
  close(){db.close();}
 };
 return {DB,db,env:{DB,EVOLUTION_API_URL:EVO,EVOLUTION_API_KEY:'fake_testing_key',ADMIN_PASSWORD:'test',SESSION_SECRET:'testtesttesttesttesttesttest'}};
}
const save=(DB,source=ORIGINAL,short=SHORT)=>
 DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')").bind(source,short).run();

test('foto da oferta é recuperada no anúncio normal do lote quando o meli.la retorna vitrine vazia',async()=>{
 const {DB,env}=setup();try{
  save(DB);
  const seen=[];
  const lookup=async url=>{seen.push(url);return url===ORIGINAL?PHOTO_LARGE:null;};
  const photo=await resolveProductImage(env,SHORT,lookup);
  assert.equal(photo,PHOTO_LARGE);
  assert.deepEqual(seen,[ORIGINAL]);
  assert.equal(await cachedProductImage(env,SHORT),PHOTO_LARGE);
  assert.equal(await cachedProductImage(env,ORIGINAL),PHOTO_LARGE);
  assert.equal(await resolveProductImage(env,SHORT,async()=>{throw Error('cache não usado');}),PHOTO_LARGE);
 }finally{DB.close();}
});

test('fonte de foto recusa redirecionadores, produto de loja externa e associação não confirmada',async()=>{
 const {DB,env}=setup();try{
  save(DB,'https://shopee.com.br/produto','https://meli.la/BAD1BAD');
  save(DB,'https://www.mercadolivre.com.br/social/alguem','https://meli.la/BAD2BAD');
  save(DB,'https://www.mercadolivre.com.br/pagina-generica','https://meli.la/BAD3BAD');
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,?)")
    .bind(ORIGINAL,'https://meli.la/NOTQUEUED','awaiting_links').run();
  for(const id of ['BAD1BAD','BAD2BAD','BAD3BAD','NOTQUEUED']){
   assert.equal(await sourcePageForAffiliateImage(env,'https://meli.la/'+id),null);
  }
 }finally{DB.close();}
});

test('publicação AUTOMÁTICA realista do WhatsApp usa sendMedia quando meli.la leva a vitrine sem imagem',async()=>{
 const {DB,env}=setup();const nativeFetch=globalThis.fetch;
 let media=0,text=0,shortReads=0,sourceReads=0;
 try{
  save(DB);
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===EVO+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false')
     return Response.json([{id:GROUP,subject:'Achadinhos'}]);
   if(u===SHORT){shortReads++;return new Response('<html>Vitrine carregando...</html>',{headers:{'content-type':'text/html'}});}
   if(u===ORIGINAL){
    sourceReads++;return new Response('<html><head><meta property="og:image" content="'+PHOTO_SOURCE+'"></head></html>',
      {headers:{'content-type':'text/html'}});
   }
   if(u===PHOTO_LARGE&&opts.method==='HEAD')
     return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'520000'}});
   if(u===EVO+'/message/sendMedia/'+INSTANCE){
    const payload=JSON.parse(opts.body);
    assert.equal(payload.number,GROUP);
    assert.equal(payload.mediatype,'image');
    assert.equal(payload.media,PHOTO_LARGE);
    assert.match(payload.caption,/Azzaro/);
    assert.match(payload.caption,/https:\/\/meli\.la\/1ZbJKkU/);
    media++;
    return Response.json({key:{id:'PHOTO_ID_001'}});
   }
   if(u===EVO+'/message/sendText/'+INSTANCE){text++;return Response.json({key:{id:'TEXT_ID_001'}});}
   throw Error('URL inesperada: '+u);
  };
  await updateWhatsAppSettings(env,{
   instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,interval_minutes:1
  });
  await updateWhatsAppSettings(env,{
   instance_name:INSTANCE,group_jid:GROUP,public_registered:true,enabled:true,interval_minutes:1
  });
  const now=Math.floor(Date.now()/1000);
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,published_at,published_day,price_cents) VALUES(?,?,?,?,'published',?,?,7990)")
   .bind('Perfume masculino eau de parfum Azzaro the most wanted intense 100 ml',SHORT,'Geral',now-100,now,
   new Date().toISOString().slice(0,10)).run();
  const result=await runWhatsAppScheduled(env);
  assert.equal(result.status,'sent');
  assert.equal(result.format,'photo');
  assert.equal(media,1);
  assert.equal(text,0);
  assert.equal(shortReads,0,'foto buscada diretamente no anúncio original verificado');
  assert.equal(sourceReads,1,'WhatsApp reutiliza preço já confirmado e consulta somente a foto original');
  assert.equal(await cachedProductImage(env,SHORT),PHOTO_LARGE);
 }finally{globalThis.fetch=nativeFetch;DB.close();}
});

test('não usa imagem de vitrine de outro vendedor como substituta da foto do item',async()=>{
 const {DB,env}=setup();try{
  save(DB);
  const sources=[];
  const bad='https://outro.exemplo.com/imagem.jpg';
  const actual=await resolveProductImage(env,SHORT,async url=>{
   sources.push(url);return url===ORIGINAL?bad:null;
  });
  assert.equal(actual,null);
  assert.deepEqual(sources,[ORIGINAL]);
 }finally{DB.close();}
});


test('automático sem imagem não envia texto, não consome intervalo e tenta novamente',async()=>{
 const {DB,env}=setup(),old=globalThis.fetch;
 let text=0,media=0;
 try{
  save(DB);
  let pictureIsAvailable=false;
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===EVO+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false')
    return Response.json([{id:GROUP,subject:'Achadinhos'}]);
   if(u===SHORT)return new Response('<html>Não há foto legível aqui</html>',{headers:{'content-type':'text/html'}});
   if(u===ORIGINAL)return new Response(pictureIsAvailable?
    '<meta property="og:image" content="'+PHOTO_SOURCE+'">':'<html>Consulta indisponível</html>',
    {headers:{'content-type':'text/html'}});
   if(u===PHOTO_LARGE&&opts.method==='HEAD')return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'500000'}});
   if(u===EVO+'/message/sendText/'+INSTANCE){text++;return Response.json({key:{id:'TEXT'}});}
   if(u===EVO+'/message/sendMedia/'+INSTANCE){media++;return Response.json({key:{id:'MEDIA'}});}
   throw Error('Unexpected '+u);
  };
  await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,interval_minutes:7});
  await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:true,enabled:true,interval_minutes:7});
  const now=Math.floor(Date.now()/1000);
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,published_at,published_day,price_cents) VALUES(?,?,?,?,'published',?,?,7990)")
   .bind('Azzaro The Most Wanted Intense',SHORT,'Geral',now-1,now,new Date().toISOString().slice(0,10)).run();
  const first=await runWhatsAppScheduled(env);
  assert.equal(first.skipped,'awaiting_photo');
  assert.equal(first.attempts,1);
  assert.equal(text,0);
  assert.equal(media,0);
  assert.equal(DB.prepare('SELECT last_attempt_at FROM whatsapp_schedule_custom').first().last_attempt_at,0);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM whatsapp_deliveries').first().n,0);
  assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
  pictureIsAvailable=true;
  DB.prepare('UPDATE whatsapp_media_retries SET next_attempt_at=0').run();
  const result=await runWhatsAppScheduled(env);
  assert.equal(result.status,'sent');
  assert.equal(result.format,'photo');
  assert.equal(media,1);
  assert.equal(text,0);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM whatsapp_media_retries').first().n,0);
  assert.equal(DB.prepare("SELECT status FROM whatsapp_deliveries").first().status,'sent');
 }finally{globalThis.fetch=old;DB.close();}
});
test('oferta automática sem foto é revista após seis falhas sem enviar mensagens',async()=>{
 const {DB,env}=setup(),old=globalThis.fetch;
 let sent=0;
 try{
  globalThis.fetch=async(url)=>{
   if(String(url)===EVO+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false')
    return Response.json([{id:GROUP,subject:'Achadinhos'}]);
   if(String(url)===SHORT)return new Response('<html></html>',{headers:{'content-type':'text/html'}});
   if(String(url).includes('/message/send')){sent++;throw Error('Não deveria publicar');}
   throw Error('Unexpected '+url);
  };
  await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,interval_minutes:1});
  await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:true,enabled:true,interval_minutes:1});
  const now=Math.floor(Date.now()/1000);
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,published_at,price_cents) VALUES(?,?,?,?,'published',?,7990)")
   .bind('Cebolinha kit três perfumes',SHORT,'Geral',now-1,now).run();
  for(let i=1;i<=6;i++){
   if(i>1)DB.prepare("UPDATE whatsapp_media_retries SET next_attempt_at=0").run();
   const result=await runWhatsAppScheduled(env);
   assert.equal(result.offer_id,1);
   if(i<6)assert.equal(result.skipped,'awaiting_photo');
   else assert.equal(result.status,'needs_review');
  }
  assert.equal(sent,0);
  assert.match(DB.prepare('SELECT last_error FROM whatsapp_deliveries').first().last_error,/Nenhuma mensagem sem foto foi enviada/);
  assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
 }finally{globalThis.fetch=old;DB.close();}
});
test('Browser Run recupera metadados da vitrine quando HTTP só retorna carregamento',async()=>{
 const {DB,env}=setup(),old=globalThis.fetch;
 try{
  let rendered=0,photoValidated=0;
  env.BROWSER={async quickAction(action,{url}){rendered++;assert.equal(action,'content');assert.equal(url,SHORT);
   return new Response('<html><head><meta property="og:image" content="'+PHOTO_SOURCE+'"></head></html>',
    {headers:{'content-type':'text/html'}});}};
  globalThis.fetch=async(url,opts={})=>{
   if(String(url)===PHOTO_LARGE&&opts.method==='HEAD'){
    photoValidated++;
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'500000'}});
   }
   throw Error('unexpected '+url);
  };
  const recovered=await resolveProductImage(env,SHORT,async()=>null);
  assert.equal(recovered,PHOTO_LARGE);
  assert.equal(rendered,1);
  assert.equal(photoValidated,1);
  assert.equal(await cachedProductImage(env,SHORT),PHOTO_LARGE);
 }finally{globalThis.fetch=old;DB.close();}
});
test('Browser Run tem limite diário, imagens externas e links inseguros não são aceitos',async()=>{
 const {DB,env}=setup();
 try{
  let requests=0;
  env.BROWSER={async quickAction(){requests++;return new Response('<meta property="og:image" content="https://another.website/image.jpg">');}};
  assert.equal(await resolveProductImage(env,'https://shopee.com.br/xx',async()=>null),null);
  assert.equal(requests,0);
  const begin=1700000000;
  assert.equal(await claimAffiliateImageBrowserBudget(env,begin),true);
  assert.equal(await claimAffiliateImageBrowserBudget(env,begin+30),false);
  for(let i=1;i<12;i++)assert.equal(await claimAffiliateImageBrowserBudget(env,begin+i*46),true);
  assert.equal(await claimAffiliateImageBrowserBudget(env,begin+12*46),false);
  assert.equal(await claimAffiliateImageBrowserBudget(env,begin+86400),true);
 }finally{DB.close();}
});
