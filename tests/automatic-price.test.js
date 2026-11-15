import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {prepareAutomaticOfferPrice,recordAutomaticPriceRetry,ensureAutomaticPrices,officialPriceOverlay} from '../src/automatic-price.js';
import {formatOfferMessage} from '../src/logic.js';
import {cachedProductImage} from '../src/offer-images.js';
const AFF='https://meli.la/KITLIMPEZA123';
const PRODUCT_URL='https://www.mercadolivre.com.br/kit-limpeza-automotiva-carro-moto/p/MLB12345678';
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
const product=(url=PRODUCT_URL,price='129.90',currency='BRL')=>
 '<html><script type="application/ld+json">'+JSON.stringify({
 '@context':'https://schema.org','@type':'Product',url,
 offers:{'@type':'Offer',price,priceCurrency:currency}})+
 '</script></html>';
test('busca valor real no anúncio original e monta legenda profissional Telegram + WhatsApp',async()=>{
 const {env,DB}=envDb();try{
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')").bind(PRODUCT_URL,AFF).run();
  let calls=0;
  const offer={title:'Kit para lavar carro, cera, pretinho e pano',affiliate_url:AFF,category:'Automotivo',
   created_at:Math.floor(Date.now()/1000),price_cents:null};
  const fetcher=async(url,opts)=>{calls++;assert.equal(url,PRODUCT_URL);assert.equal(opts.redirect,'manual');
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
  assert.match(result.reason,/página original do produto/);
  const retry=await recordAutomaticPriceRetry(env,'telegram',oldOffer.id,result.reason,1700000000);
  assert.equal(retry.status,'awaiting_price');
  assert.equal(DB.prepare('SELECT next_retry_at FROM affiliate_auto_price_retries WHERE offer_id=12').first().next_retry_at,1700000180);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM offers").first().total,0);
 }finally{DB.close();}
});
test('recusa preço de produto diferente, moeda USD e metadados conflitantes',async()=>{
 const {env,DB}=envDb();try{
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')").bind(PRODUCT_URL,AFF).run();
  const offer={id:22,title:'Produto',affiliate_url:AFF,created_at:Math.floor(Date.now()/1000)-90000};
  for(const html of [
   product('https://www.mercadolivre.com.br/outro/p/MLB99999999'),
   product(PRODUCT_URL,'129.90','USD'),
   '<html><script type="application/ld+json">'+JSON.stringify({
     '@type':'Product',url:PRODUCT_URL,offers:[{priceCurrency:'BRL',price:100},{priceCurrency:'BRL',price:129}]})+'</script></html>'
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
 assert.match(caption,/De: não informado no anúncio/);
 assert.doesNotMatch(caption,/OFF|desconto de \d/);
});

test('quando HTTP do anúncio retorna 403, Browser Run confirma preço na página original',async()=>{
 const {env,DB}=envDb();try{
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')")
    .bind(PRODUCT_URL,AFF).run();
  let called=0;
  env.BROWSER={async quickAction(action,opts){
   called++;
   assert.equal(action,'content');
   assert.equal(opts.url,PRODUCT_URL);
   return new Response(product(PRODUCT_URL,'149.90','BRL'),{
    status:200,headers:{'content-type':'text/html'}});
  }};
  const offer={id:11,title:'Kit de limpeza para carro',affiliate_url:AFF,
   created_at:Math.floor(Date.now()/1000),price_cents:null};
  const fetcher=async()=>new Response('Acesso temporariamente bloqueado',{status:403});
  const result=await prepareAutomaticOfferPrice(env,offer,{fetcher});
  assert.equal(result.ok,true);
  assert.equal(result.price_source,'mercadolivre');
  assert.equal(result.offer.price_cents,14990);
  assert.equal(called,1);
  assert.match(formatOfferMessage(result.offer,{network:'whatsapp'}),/Por R\$\s*149,90/);
  const cache=await prepareAutomaticOfferPrice(env,offer,{fetcher:async()=>{throw Error('cache');}});
  assert.equal(cache.offer.price_cents,14990);
  assert.equal(called,1);
 }finally{DB.close();}
});
test('navegador não aceita preço de outro produto, nem publicará preço inventado',async()=>{
 const {env,DB}=envDb();try{
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')")
    .bind(PRODUCT_URL,AFF).run();
  env.BROWSER={async quickAction(){
   return new Response(product('https://www.mercadolivre.com.br/kit-outro/p/MLB99999999','3.00'),{
    headers:{'content-type':'text/html'}});
  }};
  const offer={id:12,title:'Kit limpeza',affiliate_url:AFF,created_at:Math.floor(Date.now()/1000)-90000};
  const result=await prepareAutomaticOfferPrice(env,offer,{fetcher:async()=>new Response('Access denied',{status:403})});
  assert.equal(result.ok,false);
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM affiliate_verified_prices').first().n,0);
 }finally{DB.close();}
});

test('link meli.la direto resolve anúncio oficial e recebe texto fixo com preço antigo, atual e pagamento',async()=>{
 const {env,DB}=envDb();
 try{
  const offer={title:'Tapete antiderrapante',affiliate_url:AFF,category:'Geral',id:44,created_at:Math.floor(Date.now()/1000)};
  const fetcher=async(url)=>{
   if(url===AFF)return new Response(null,{status:302,headers:{location:PRODUCT_URL}});
   if(url===PRODUCT_URL)return new Response('<link rel="canonical" href="'+PRODUCT_URL+'">'+
     '<script type="application/ld+json">'+JSON.stringify({'@type':'Product',url:PRODUCT_URL,offers:{
     price:'34.82',priceCurrency:'BRL',originalPrice:'49.90',paymentMethod:'CreditCard',
     installments:{numberOfPayments:3,paymentAmount:'11.61',interestFree:true}
    }})+'</script>',{headers:{'content-type':'text/html'}});
   throw Error('Site externo não permitido: '+url);
  };
  const result=await prepareAutomaticOfferPrice(env,offer,{fetcher,requireSite:true});
  assert.equal(result.ok,true);
  assert.equal(result.offer.price_cents,3482);
  assert.equal(result.offer.old_price_cents,4990);
  assert.equal(await cachedProductImage(env,AFF),photoLarge,
   'a foto original confirmada na vitrine deve ficar pronta para Telegram e WhatsApp');
  const msg=formatOfferMessage(result.offer,{network:'whatsapp',includeLink:true});
  assert.match(msg,/✨ CONFIRA ESTA OFERTA!/);
  assert.match(msg,/De: ~R\$\s*49,90~/);
  assert.match(msg,/Por R\$\s*34,82/);
  assert.match(msg,/Pagamento: cartão/);
  assert.match(msg,/Parcelamento: 3x de R\$\s*11,61 sem juros/);
  assert.ok(msg.endsWith(AFF));
  assert.equal(DB.prepare('SELECT source_url FROM affiliate_verified_sources WHERE affiliate_url=?').bind(AFF).first().source_url,PRODUCT_URL);
 }finally{DB.close();}
});

test('automático publica preço da API pública oficial quando o HTML do anúncio é bloqueado',async()=>{
 const {env,DB}=envDb();
 try{
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')")
   .bind(PRODUCT_URL,AFF).run();
  const seen=[];
  const fetcher=async url=>{
   seen.push(String(url));
   if(url===PRODUCT_URL)return new Response('Access denied',{status:403});
   if(url==='https://api.mercadolibre.com/items/MLB12345678')
    return Response.json({id:'MLB12345678',currency_id:'BRL',price:34.82,original_price:49.90});
   throw Error('Endereço inesperado '+url);
  };
  const offer={id:72,title:'Kit de limpeza automotiva',affiliate_url:AFF,
   created_at:Math.floor(Date.now()/1000),price_cents:null};
  const result=await prepareAutomaticOfferPrice(env,offer,{fetcher,requireSite:true});
  assert.equal(result.ok,true);
  assert.equal(result.offer.price_cents,3482);
  assert.equal(result.offer.old_price_cents,4990);
  assert.equal(result.price_source,'mercadolivre');
  assert.deepEqual(seen,[PRODUCT_URL,'https://api.mercadolibre.com/items/MLB12345678']);
  assert.match(formatOfferMessage(result.offer,{network:'whatsapp',includeLink:true}),/Por R\$\s*34,82/);
  const again=await prepareAutomaticOfferPrice(env,offer,{fetcher:async()=>{throw Error('Não deveria reler preço válido');},requireSite:true});
  assert.equal(again.offer.price_cents,3482);
 }finally{DB.close();}
});
test('API pública nunca aceita preço de ID diferente, moeda externa ou sem preço',async()=>{
 const {env,DB}=envDb();
 try{
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')")
   .bind(PRODUCT_URL,AFF).run();
  const offer={id:73,title:'Produto verificado',affiliate_url:AFF,created_at:Math.floor(Date.now()/1000)};
  for(const response of [
   {id:'MLB99999999',currency_id:'BRL',price:1.00},
   {id:'MLB12345678',currency_id:'USD',price:1.00},
   {id:'MLB12345678',currency_id:'BRL',price:0}
  ]){
   const fetcher=async url=>{
    if(url===PRODUCT_URL)return new Response('Forbidden',{status:403});
    return Response.json(response);
   };
   const checked=await prepareAutomaticOfferPrice(env,offer,{fetcher,requireSite:true});
   assert.equal(checked.ok,false);
  }
 }finally{DB.close();}
});

test('preço da vitrine principal libera fila mesmo com anúncio e API bloqueados',async()=>{
 const {env,DB}=envDb();
 const SOCIAL='https://www.mercadolivre.com.br/social/gearofertas';
 const photoPreview='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-P.webp';
 const photoLarge='https://http2.mlstatic.com/D_NQ_NP_99811-MLB88899-F.jpg';
 const featured='<div class="rl-card-featured-wrapper">'+
  '<img class="poly-component__picture" src="'+photoPreview+'">'+
  '<a class="poly-component__title" href="'+PRODUCT_URL+'">Kit de limpeza automotiva</a>'+
  '<div class="poly-component__price">'+
  '<s class="poly-price__previous"><span class="andes-money-amount__currency-symbol">R$</span>'+
  '<span class="andes-money-amount__fraction">49</span><span class="andes-money-amount__cents">90</span></s>'+
  '<div class="poly-price__current"><span class="andes-money-amount poly-price__amount">'+
  '<span class="andes-money-amount__currency-symbol">R$</span>'+
  '<span class="andes-money-amount__fraction">34</span><span class="andes-money-amount__cents">82</span></span></div>'+
  '<span class="poly-price__installments">3x <span class="andes-money-amount polylabel-price">'+
  '<span class="andes-money-amount__currency-symbol">R$</span>'+
  '<span class="andes-money-amount__fraction">11</span><span class="andes-money-amount__cents">61</span></span> sem juros</span>'+
  '</div><a class="poly-action-links__action--link" href="'+PRODUCT_URL+'">Ir para produto</a></div>'+
  '<div class="rl-card-recommendations"><a href="https://www.mercadolivre.com.br/errado/p/MLB99999999">Outro produto</a></div>';
 try{
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')")
   .bind(PRODUCT_URL,AFF).run();
  const fetcher=async(url,options={})=>{
   if(url===photoLarge&&options.method==='HEAD')
    return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'300000'}});
   if(url===PRODUCT_URL||String(url).startsWith('https://api.mercadolibre.com/'))
    return new Response('Acesso negado',{status:403});
   if(url===AFF)return new Response(null,{status:302,headers:{location:SOCIAL}});
   if(url===SOCIAL)return new Response(featured,{headers:{'content-type':'text/html'}});
   throw Error('URL inesperada '+url);
  };
  const result=await prepareAutomaticOfferPrice(env,{id:91,title:'Kit limpeza automotiva',
   affiliate_url:AFF,created_at:Math.floor(Date.now()/1000)}, {fetcher,requireSite:true});
  assert.equal(result.ok,true);
  assert.equal(result.offer.price_cents,3482);
  assert.equal(result.offer.old_price_cents,4990);
  const msg=formatOfferMessage(result.offer,{network:'whatsapp',includeLink:true});
  assert.match(msg,/Por R\$\s*34,82/);
  assert.match(msg,/Parcelamento: 3x de R\$\s*11,61 sem juros/);
 }finally{DB.close();}
});
test('vitrine com HTML vazio usa navegador e nunca preço de recomendação',async()=>{
 const {env,DB}=envDb();
 const SOCIAL='https://www.mercadolivre.com.br/social/gearofertas';
 try{
  DB.prepare("INSERT INTO ml_link_batch_items(source_url,affiliate_url,status) VALUES(?,?,'queued')")
   .bind(PRODUCT_URL,AFF).run();
  const featured='<div class="rl-card-featured-wrapper">'+
   '<a class="poly-component__title" href="'+PRODUCT_URL+'">Kit</a>'+
   '<div class="poly-component__price"><div class="poly-price__current">'+
   '<span class="andes-money-amount poly-price__amount">'+
   '<span class="andes-money-amount__currency-symbol">R$</span>'+
   '<span class="andes-money-amount__fraction">75</span><span class="andes-money-amount__cents">90</span>'+
   '</span></div></div></div><div class="rl-card-recommendations">R$ 1,00</div>';
  let browserCalls=0;
  env.BROWSER={quickAction:async()=>{
   browserCalls++;return new Response(featured,{headers:{'content-type':'text/html'}});
  }};
  const fetcher=async url=>{
   if(url===PRODUCT_URL||String(url).startsWith('https://api.mercadolibre.com/'))
    return new Response('Acesso negado',{status:403});
   if(url===AFF)return new Response(null,{status:302,headers:{location:SOCIAL}});
   if(url===SOCIAL)return new Response('<html>Carregando...</html>',{headers:{'content-type':'text/html'}});
   throw Error('URL inesperada '+url);
  };
  const result=await prepareAutomaticOfferPrice(env,{id:92,title:'Kit limpeza automotiva',
   affiliate_url:AFF,created_at:Math.floor(Date.now()/1000)}, {fetcher,requireSite:true});
  assert.equal(result.ok,true);
  assert.equal(result.offer.price_cents,7590);
  assert.equal(browserCalls,1);
 }finally{DB.close();}
});
