import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {prepareAutomaticOfferPrice,recordAutomaticPriceRetry,ensureAutomaticPrices,officialPriceOverlay} from '../src/automatic-price.js';
import {formatOfferMessage} from '../src/logic.js';
const AFF='https://meli.la/KITLIMPEZA123';
const URL='https://www.mercadolivre.com.br/kit-limpeza-automotiva-carro-moto/p/MLB12345678';
function envDb(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 db.exec("CREATE TABLE ml_link_batch_items(id INTEGER PRIMARY KEY,source_url TEXT,affiliate_url TEXT,status TEXT)");
 const DB={prepare(sql){let args=[];return {
  bind(...v){args=v;return this;},
  first(){return db.prepare(sql).get(...args)||null;},
  all(){return {results:db.prepare(sql).all(...args)};},
  run(){let r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}
 };},close(){db.close();}};
 return {env:{DB},DB};
}
const product=(url=URL,price='129.90',currency='BRL')=>
 '<html><script type="application/ld+json">'+JSON.stringify({
 '@context':'https://schema.org','@type':'Product',url,
 offers:{'@type':'Offer',price,priceCurrency:currency}})+
 '</script></html>';
test('busca valor real no anúncio original e monta legenda profissional Telegram + WhatsApp',async()=>{
 const {env,DB}=envDb();try{
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')").bind(URL,AFF).run();
  let calls=0;
  const offer={title:'Kit para lavar carro, cera, pretinho e pano',affiliate_url:AFF,category:'Automotivo',
   created_at:Math.floor(Date.now()/1000),price_cents:null};
  const fetcher=async(url,opts)=>{calls++;assert.equal(url,URL);assert.equal(opts.redirect,'manual');
   return new Response(product(),{headers:{'content-type':'text/html'}});};
  const result=await prepareAutomaticOfferPrice(env,offer,{fetcher});
  assert.equal(result.ok,true);
  assert.equal(result.price_source,'mercadolivre');
  assert.equal(result.offer.price_cents,12990);
  const telegram=formatOfferMessage(result.offer,{network:'telegram'});
  const whatsapp=formatOfferMessage(result.offer,{network:'whatsapp',includeLink:true});
  assert.match(telegram,/🔥.*<b>Por R\$\s*129,90<\/b>/);
  assert.match(whatsapp,/🔥.*\*Por R\$\s*129,90\*/);
  assert.match(telegram,/Publicidade • link de afiliado/);
  assert.match(whatsapp,/https:\/\/meli.la\/KITLIMPEZA123/);
  assert.doesNotMatch(telegram,/Consulte o preço atualizado na loja/);
  assert.doesNotMatch(whatsapp,/Consulte o preço atualizado na loja/);
  assert.equal(calls,1);
  const repeated=await prepareAutomaticOfferPrice(env,offer,{fetcher:async()=>{throw Error('cache não foi usado');}});
  assert.equal(repeated.offer.price_cents,12990);
 }finally{DB.close();}
});
test('preço não verificado não inventa números, agenda retry e não ocupa a fila',async()=>{
 const {env,DB}=envDb();try{
  await ensureAutomaticPrices(env);
  const oldOffer={id:12,title:'Produto sem valor',affiliate_url:AFF,category:'Geral',
   created_at:Math.floor(Date.now()/1000)-86400,price_cents:8990};
  const result=await prepareAutomaticOfferPrice(env,oldOffer);
  assert.equal(result.ok,false);
  assert.match(result.reason,/preço não informado/);
  const retry=await recordAutomaticPriceRetry(env,'telegram',oldOffer.id,result.reason,1700000000);
  assert.equal(retry.status,'awaiting_price');
  assert.equal(DB.prepare('SELECT next_retry_at FROM affiliate_auto_price_retries WHERE offer_id=12').first().next_retry_at,1700000180);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM offers").first().total,0);
 }finally{DB.close();}
});
test('recusa preço de produto diferente, moeda USD e metadados conflitantes',async()=>{
 const {env,DB}=envDb();try{
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')").bind(URL,AFF).run();
  const offer={id:22,title:'Produto',affiliate_url:AFF,created_at:Math.floor(Date.now()/1000)-90000};
  for(const html of [
   product('https://www.mercadolivre.com.br/outro/p/MLB99999999'),
   product(URL,'129.90','USD'),
   '<html><script type="application/ld+json">'+JSON.stringify({
     '@type':'Product',url:URL,offers:[{priceCurrency:'BRL',price:100},{priceCurrency:'BRL',price:129}]})+'</script></html>'
  ]){
   const outcome=await prepareAutomaticOfferPrice(env,offer,{fetcher:async()=>new Response(html,{headers:{'content-type':'text/html'}})});
   assert.equal(outcome.ok,false);
  }
 }finally{DB.close();}
});
test('a legenda nunca inventa preço anterior nem desconto ao consultar preço público',()=>{
 const offer=officialPriceOverlay({title:'Kit Caraíva',affiliate_url:AFF,category:'Automotivo'},13490);
 const caption=formatOfferMessage(offer,{network:'telegram'});
 assert.match(caption,/R\$\s*134,90/);
 assert.doesNotMatch(caption,/De:|OFF|desconto de \d/);
});
