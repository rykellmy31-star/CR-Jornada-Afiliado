import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {fetchOfficialProductPhoto} from '../src/official-product-photo.js';
import {resolveProductImage,cachedProductImage} from '../src/offer-images.js';

const SOURCE='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
const AFFILIATE='https://meli.la/PHOTO0001';
const PHOTO='https://http2.mlstatic.com/D_NQ_NP_751234-MLB99999-P.webp';
const LARGE='https://http2.mlstatic.com/D_NQ_NP_751234-MLB99999-F.jpg';

function fakeAPI({wrongId=false,blockedItems=false,foreign=false}={}){
 const visited=[];
 const fetcher=async(url,opts={})=>{
  visited.push({url:String(url),method:opts.method});
  if(String(url)==='https://api.mercadolibre.com/items/MLB12345678'){
   if(blockedItems)return new Response('denied',{status:403});
   return Response.json({id:wrongId?'MLB99999999':'MLB12345678',
     pictures:[{secure_url:foreign?'https://evil.example/D_NQ_NP_bad-F.jpg':
       PHOTO.replace('https:','http:')}]});
  }
  if(String(url)==='https://api.mercadolibre.com/products/MLB12345678')
   return new Response('not found',{status:404});
  if(String(url)===LARGE&&opts.method==='HEAD')
   return new Response(null,{status:200,
     headers:{'content-type':'image/jpeg','content-length':'250000'}});
  return new Response('not found',{status:404});
 };
 return {visited,fetcher};
}
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 db.exec('CREATE TABLE ml_link_batch_items(id INTEGER PRIMARY KEY,source_url TEXT,affiliate_url TEXT,status TEXT)');
 const DB={prepare(sql){let args=[];return {
  bind(...values){args=values;return this;},
  first(){return db.prepare(sql).get(...args)||null;},
  all(){return {results:db.prepare(sql).all(...args)};},
  run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}
 };}};
 DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')")
   .bind(SOURCE,AFFILIATE).run();
 return {env:{DB},close:()=>db.close()};
}

test('API oficial fornece foto com ID correto, CDN segura e JPEG confirmado',async()=>{
 const {fetcher,visited}=fakeAPI();
 assert.equal(await fetchOfficialProductPhoto(SOURCE,{fetcher}),LARGE);
 assert.ok(visited.some(x=>x.url.endsWith('/items/MLB12345678')));
 assert.ok(visited.some(x=>x.method==='HEAD'&&x.url===LARGE));
});
test('recusa item divergente, imagem externa e fonte não oficial',async()=>{
 for(const option of [{wrongId:true},{foreign:true}]){
  const {fetcher}=fakeAPI(option);
  assert.equal(await fetchOfficialProductPhoto(SOURCE,{fetcher}),null);
 }
 const {fetcher,visited}=fakeAPI();
 assert.equal(await fetchOfficialProductPhoto('https://evil.example/p/MLB12345678',{fetcher}),null);
 assert.equal(visited.length,0);
});
test('falha pública da API não inventa foto',async()=>{
 const {fetcher}=fakeAPI({blockedItems:true});
 assert.equal(await fetchOfficialProductPhoto(SOURCE,{fetcher}),null);
});
test('publicador manual e agendado reutilizam foto da API quando página está vazia',async()=>{
 const {env,close}=setup(),old=globalThis.fetch;
 try{
  const {fetcher}=fakeAPI();
  globalThis.fetch=fetcher;
  const image=await resolveProductImage(env,AFFILIATE,async()=>null);
  assert.equal(image,LARGE);
  assert.equal(await cachedProductImage(env,AFFILIATE),LARGE);
 }finally{globalThis.fetch=old;close();}
});
test('Cron importa ofertas prontas sem esperar o envio de imagem do Telegram',async()=>{
 const code=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const block=code.slice(code.indexOf('// Não altera os publicadores nem seus intervalos.'));
 assert.ok(block.indexOf('await runGroupCopyBatch(env,{limit:3})')>=0);
 assert.ok(block.indexOf('await runGroupCopyBatch(env,{limit:3})')<
   block.indexOf('await telegramPublished'));
});
