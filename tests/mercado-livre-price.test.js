import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {extractMercadoLivrePagePrice,fetchMercadoLivrePrice,parseSiteMoney,extractFeaturedShowcasePrice} from '../src/mercado-livre-price.js';
import {addMonitorGroup,saveMonitorSettings,ingestMonitorEvent,monitorState,refreshMonitorSitePrices,prepareMonitorBatch} from '../src/whatsapp-link-monitor.js';
import {importLinkBatch} from '../src/link-batches.js';
import {composeOfferMessage} from '../src/logic.js';

const PRODUCT='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
const OTHER='https://www.mercadolivre.com.br/outra-coisa/p/MLB87654321';
const GROUP='120363000111222333@g.us';
const INSTANCE='cr-jornada-afiliados';

function html(productUrl=PRODUCT,price='110.00',currency='BRL'){
 return '<!doctype html><html><head>'+
  '<link rel="canonical" href="'+productUrl+'">'+
  '<script type="application/ld+json">'+JSON.stringify({
   '@context':'https://schema.org','@type':'Product',name:'Furadeira de impacto',
   url:productUrl,offers:{'@type':'Offer',price,priceCurrency:currency}
  })+'</script></head></html>';
}
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){let values=[];
  return {bind(...args){values=args;return this;},
   first(){return db.prepare(sql).get(...values)||null;},
   all(){return {results:db.prepare(sql).all(...values)};},
   run(){const r=db.prepare(sql).run(...values);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
  };
 },async batch(commands){
   db.exec('BEGIN');
   try{const out=commands.map(x=>x.run());db.exec('COMMIT');return out;}
   catch(err){db.exec('ROLLBACK');throw err;}
 },close(){db.close();}};
 return {DB,env:{DB,MONITOR_WEBHOOK_TOKEN:'test-webhook-secret-1234567890'}};
}
function event(content){
 return {event:'messages.upsert',instance:INSTANCE,data:{
  key:{remoteJid:GROUP,fromMe:false,id:'SITE-PRICE-001'},
  message:{extendedTextMessage:{text:content+' '+PRODUCT}}
 }};
}
async function ready(env){
 await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,
  group_name:'ACHADINHOS DA INTERNET',permission_confirmed:true});
 await saveMonitorSettings(env,{enabled:true});
}
const fetchHTML=async()=>new Response(html(),{
 status:200,headers:{'content-type':'text/html;charset=utf-8'}
});

test('extrai preço público BRL do Product JSON-LD do anúncio correto',()=>{
 assert.equal(extractMercadoLivrePagePrice(html(),PRODUCT).price_cents,11000);
 assert.equal(parseSiteMoney('R$ 1.499,90'),149990);
 assert.equal(parseSiteMoney('110.50'),11050);
 assert.equal(parseSiteMoney(''),null);
 assert.equal(parseSiteMoney('NaN'),null);
 assert.equal(parseSiteMoney(-1),null);
});
test('recusa metadados de outro produto, outra moeda e múltiplos preços conflitantes',()=>{
 assert.equal(extractMercadoLivrePagePrice(html(OTHER),PRODUCT),null);
 assert.equal(extractMercadoLivrePagePrice(html(PRODUCT,'110.00','USD'),PRODUCT),null);
 const conflict='<link rel="canonical" href="'+PRODUCT+'">'+
  '<script type="application/ld+json">'+JSON.stringify({
   '@type':'Product',url:PRODUCT,offers:[{price:110,priceCurrency:'BRL'},
    {price:120,priceCurrency:'BRL'}]})+'</script>';
 assert.equal(extractMercadoLivrePagePrice(conflict,PRODUCT),null);
 assert.equal(extractMercadoLivrePagePrice('<div>De R$ 150 por R$ 100</div>',PRODUCT),null);
});
test('aceita somente metadados globais ligados ao canonical do anúncio',()=>{
 const valid='<link rel="canonical" href="'+PRODUCT+'"><meta property="product:price:amount" content="91.10">'+
 '<meta property="product:price:currency" content="BRL">';
 assert.equal(extractMercadoLivrePagePrice(valid,PRODUCT)?.price_cents,9110);
 assert.equal(extractMercadoLivrePagePrice(valid.replace(PRODUCT,OTHER),PRODUCT),null);
});
test('limita redirects a hosts oficiais e evita ler sites terceiros',async()=>{
 let calls=0;
 const redirected=await fetchMercadoLivrePrice(PRODUCT,async(url)=>{
  calls++;
  if(calls===1)return new Response(null,{status:302,headers:{location:PRODUCT+'?ref=homepage'}});
  return new Response(html(),{headers:{'content-type':'text/html'}});
 });
 assert.equal(calls,2);
 assert.equal(redirected?.price_cents,11000);
 calls=0;
 assert.equal(await fetchMercadoLivrePrice(PRODUCT,async()=>{
  calls++;return new Response(null,{status:302,headers:{location:'https://evil.example/offer'}});
 }),null);
 assert.equal(calls,1);
});
test('duas fontes: registra site separado e usa site como fallback apenas se grupo nao deu preço',async()=>{
 const {env,DB}=fixture();
 try{
  await ready(env);
  await ingestMonitorEvent(env,event('Furadeira em oferta hoje!'));
  assert.equal((await refreshMonitorSitePrices(env,{fetcher:fetchHTML})).found,1);
  const state=await monitorState(env);
  assert.equal(state.links[0].last_seen_price_cents,null);
  assert.equal(state.links[0].site_price_cents,11000);
  assert.equal(state.links[0].site_status,'ok');
  assert.ok(state.links[0].site_checked_at>0);
  const batch=await prepareMonitorBatch(env,{automatic:true});
  await importLinkBatch(env,batch.batch.id,{owner_confirmation:true,pairing_confirmation:true,
   links:[{affiliate_url:'https://meli.la/PRICE12345',category:batch.items[0].category}]});
  const offer=DB.prepare('SELECT * FROM offers').first();
  assert.equal(offer.price_cents,11000);
  assert.equal(offer.old_price_cents,null);
  assert.match(composeOfferMessage(offer),/Preço público consultado no Mercado Livre: R\$ 110,00/);
  assert.doesNotMatch(composeOfferMessage(offer),/Preço anunciado no grupo/);
 }finally{DB.close();}
});
test('promoção anunciada no grupo prevalece; site é exibido como fonte distinta',async()=>{
 const {env,DB}=fixture();
 try{
  await ready(env);
  await ingestMonitorEvent(env,event('De: R$149,99 🔥 Por: R$91,10'));
  await refreshMonitorSitePrices(env,{fetcher:fetchHTML});
  const state=await monitorState(env);
  assert.equal(state.links[0].last_seen_price_cents,9110);
  assert.equal(state.links[0].site_price_cents,11000);
  const batch=await prepareMonitorBatch(env,{automatic:true});
  await importLinkBatch(env,batch.batch.id,{owner_confirmation:true,pairing_confirmation:true,
   links:[{affiliate_url:'https://meli.la/GROUP12345',category:batch.items[0].category}]});
  const offer=DB.prepare('SELECT * FROM offers').first();
  assert.equal(offer.price_cents,9110);
  assert.equal(offer.old_price_cents,14999);
  assert.match(composeOfferMessage(offer),/de R\$ 149,99 por R\$ 91,10/);
 }finally{DB.close();}
});
test('consulta negada nao apaga valor do grupo nem inventa preço do site',async()=>{
 const {env,DB}=fixture();
 try{
  await ready(env);
  await ingestMonitorEvent(env,event('De R$149,99 por R$91,10'));
  const result=await refreshMonitorSitePrices(env,{fetcher:async()=>new Response('proibido',{status:403})});
  assert.deepEqual(result,{checked:1,found:0});
  const state=await monitorState(env);
  assert.equal(state.links[0].site_price_cents,null);
  assert.equal(state.links[0].site_status,'unavailable');
  assert.equal(state.links[0].last_seen_price_cents,9110);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{DB.close();}
});

test('preço antigo e forma de pagamento são lidos somente no Product da página oficial',()=>{
 const body='<link rel="canonical" href="'+PRODUCT+'"><script type="application/ld+json">'+
 JSON.stringify({'@type':'Product',url:PRODUCT,offers:{
  '@type':'Offer',price:'34.82',priceCurrency:'BRL',
  priceSpecification:{'@type':'UnitPriceSpecification',
   priceType:'https://schema.org/StrikethroughPrice',price:'49.90',priceCurrency:'BRL'},
  paymentMethod:'https://schema.org/CreditCard',
  installmentPlan:{numberOfPayments:3,paymentAmount:'11.61',interestFree:true}
 }})+'</script>';
 const details=extractMercadoLivrePagePrice(body,PRODUCT);
 assert.equal(details.price_cents,3482);
 assert.equal(details.old_price_cents,4990);
 assert.equal(details.payment_mode,'card');
 assert.equal(details.installments,3);
 assert.equal(details.installment_cents,1161);
 assert.equal(details.installments_no_interest,true);
 assert.equal(extractMercadoLivrePagePrice(body,OTHER),null);
 const unsupported=body.replace('https://schema.org/StrikethroughPrice','https://schema.org/CurrentPrice');
 assert.equal(extractMercadoLivrePagePrice(unsupported,PRODUCT).old_price_cents,null);
});

export const FEATURED_SHOWCASE_HTML = '<div class="rl-card-featured-wrapper"><div class="poly-card">'+
 '<a class="poly-component__title" href="'+PRODUCT+'?c_id=/home/card-featured/element">Furadeira de impacto</a>'+
 '<div class="poly-component__price">'+
 '<s class="andes-money-amount poly-price__previous"><span class="andes-money-amount__currency-symbol">R$</span>'+
 '<span class="andes-money-amount__fraction">241</span><span class="andes-money-amount__cents">78</span></s>'+
 '<div class="poly-price__current"><span class="andes-money-amount poly-price__amount">'+
 '<span class="andes-money-amount__currency-symbol">R$</span>'+
 '<span class="andes-money-amount__fraction">211</span><span class="andes-money-amount__cents">07</span></span>'+
 '<span class="poly-price__disc-label">12% OFF no Pix</span></div>'+
 '<span class="poly-price__installments">ou <span class="andes-money-amount polylabel-price">'+
 '<span class="andes-money-amount__currency-symbol">R$</span><span class="andes-money-amount__fraction">234</span>'+
 '<span class="andes-money-amount__cents">52</span></span> em 6x '+
 '<span class="andes-money-amount polylabel-price"><span class="andes-money-amount__currency-symbol">R$</span>'+
 '<span class="andes-money-amount__fraction">39</span><span class="andes-money-amount__cents">09</span></span> sem juros</span></div>'+
 '<a class="poly-action-links__action--link" href="'+PRODUCT+'">Ir para produto</a></div></div>'+
 '<div class="rl-card-recommendations"><a class="poly-component__title" href="'+OTHER+'">Outro produto</a>'+
 '<div class="poly-component__price"><div class="poly-price__current"><span class="andes-money-amount poly-price__amount">'+
 '<span class="andes-money-amount__currency-symbol">R$</span><span class="andes-money-amount__fraction">1</span></span></div></div></div>';

test('preço da vitrine é apenas do produto principal confirmado e distingue Pix do cartão',()=>{
 const actual=extractFeaturedShowcasePrice(FEATURED_SHOWCASE_HTML,'MLB12345678');
 assert.equal(actual.price_cents,21107);
 assert.equal(actual.old_price_cents,24178);
 assert.equal(actual.card_price_cents,23452);
 assert.equal(actual.payment_mode,'pix_only');
 assert.equal(actual.installments,6);
 assert.equal(actual.installment_cents,3909);
 assert.equal(actual.installments_no_interest,true);
 assert.equal(extractFeaturedShowcasePrice(FEATURED_SHOWCASE_HTML,'MLB87654321'),null,
  'o preço de um recomendado jamais substitui o preço do produto principal');
});
