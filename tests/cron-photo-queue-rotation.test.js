import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {runScheduled} from '../src/index.js';

const PHOTO='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-P.webp';
const LARGE='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-F.jpg';
const source=id=>'https://www.mercadolivre.com.br/produto-confirmado/p/MLB'+String(12345670+id);
const affiliate=id=>'https://meli.la/2TEST0'+String(id);

function setup(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 sqlite.exec('CREATE TABLE ml_link_batch_items(id INTEGER PRIMARY KEY,source_url TEXT,affiliate_url TEXT,status TEXT)');
 const DB={prepare(sql){
  let values=[];
  return {
   bind(...args){values=args;return this;},
   first(){return sqlite.prepare(sql).get(...values)||null;},
   all(){return {results:sqlite.prepare(sql).all(...values)};},
   run(){const r=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)}};}
  };
 }};
 DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr',telegram_enabled=1,channel_registered=1,automation_enabled=1,interval_minutes=77,max_daily=48,start_hour=0,end_hour=24").run();
 for(let id=1;id<=7;id++){
  DB.prepare("INSERT INTO offers(title,affiliate_url,category,status,created_at) VALUES(?,?,'Geral','ready',?)")
   .bind('Produto para testar a fila '+id,affiliate(id),Math.floor(Date.now()/1000)+id).run();
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')")
   .bind(source(id),affiliate(id)).run();
 }
 return {DB,env:{DB,TELEGRAM_BOT_TOKEN:'SIMULATED_TELEGRAM_TOKEN'},close:()=>sqlite.close()};
}

test('Cron percorre ofertas além das cinco primeiras sem foto, reutilizando publicador manual e intervalo',async()=>{
 const {DB,env,close}=setup(),previous=globalThis.fetch;
 let published=0;
 try{
  globalThis.fetch=async(url,opts={})=>{
   const u=String(url);
   if(u===source(7))return new Response('<meta property="og:image" content="'+PHOTO+'">',{headers:{'content-type':'text/html'}});
   if(Array.from({length:6},(_,i)=>source(i+1)).includes(u)||u.startsWith('https://meli.la/'))
    return new Response('<html>sem foto</html>',{headers:{'content-type':'text/html'}});
   if(u===LARGE&&opts.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'250000'}});
   if(u.includes('/getChat?'))return Response.json({ok:true,result:{type:'channel'}});
   if(u.endsWith('/sendPhoto')){
    assert.equal(JSON.parse(opts.body).photo,LARGE);
    published++;
    return Response.json({ok:true,result:{message_id:99887}});
   }
   throw Error('Requisição inesperada: '+u);
  };
  const first=await runScheduled(env);
  assert.equal(first.skipped,'awaiting_photo');
  assert.equal(DB.prepare('SELECT last_offer_id FROM affiliate_telegram_schedule_cursor WHERE id=1').first().last_offer_id,5);
  assert.equal(published,0);
  assert.equal(DB.prepare("SELECT COUNT(*) AS n FROM offers WHERE status='ready'").first().n,7);
  const second=await runScheduled(env);
  assert.equal(second.status,'published');
  assert.equal(second.format,'photo');
  assert.equal(published,1,'enviou apenas uma oferta pelo publicador compartilhado');
  assert.equal(DB.prepare('SELECT status FROM offers WHERE id=7').first().status,'published');
  assert.equal(DB.prepare('SELECT last_offer_id FROM affiliate_telegram_schedule_cursor WHERE id=1').first().last_offer_id,7);
  assert.equal(DB.prepare('SELECT interval_minutes FROM settings WHERE id=1').first().interval_minutes,77);
  assert.equal((await runScheduled(env)).skipped,'interval_or_schedule');
  assert.equal(published,1,'não duplicou após confirmar a publicação');
 }finally{globalThis.fetch=previous;close();}
});
