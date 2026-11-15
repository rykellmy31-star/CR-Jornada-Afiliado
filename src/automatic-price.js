// Pré-verificação de preço para ofertas automáticas do Mercado Livre.
// Uma falha temporária de preço nunca bloqueia os demais produtos.
import {fetchMercadoLivrePrice,extractMercadoLivrePagePrice} from './mercado-livre-price.js';
import {sourcePageForAffiliateImage} from './offer-images.js';
import {productId} from './link-batches.js';
import {safePromotionTerms,MAX_AGE_MS} from './promotion-terms.js';

const VERIFY_CACHE=15*60;
const LAST_CONFIRMED=60*60;
const PRICE_CHECKS="CREATE TABLE IF NOT EXISTS affiliate_verified_prices("+
 "affiliate_url TEXT PRIMARY KEY,source_url TEXT NOT NULL,price_cents INTEGER NOT NULL,"+
 "checked_at INTEGER NOT NULL)";
const RETRIES="CREATE TABLE IF NOT EXISTS affiliate_auto_price_retries("+
 "queue_type TEXT NOT NULL,offer_id INTEGER NOT NULL,"+
 "attempts INTEGER NOT NULL DEFAULT 0,next_retry_at INTEGER NOT NULL DEFAULT 0,"+
 "last_error TEXT NOT NULL DEFAULT '',PRIMARY KEY(queue_type,offer_id))";
const official=url=>{
 try{const u=new URL(url);return u.protocol==='https:'&&
  ['www.mercadolivre.com.br','mercadolivre.com.br','produto.mercadolivre.com.br'].includes(u.hostname.toLowerCase())&&
  !!productId(u.pathname);}catch{return false;}
};
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=99999999;
export async function ensureAutomaticPrices(env){
 await env.DB.prepare(PRICE_CHECKS).run();
 await env.DB.prepare(RETRIES).run();
}
// Se o HTML comum vier incompleto, só o navegador renderizado do anúncio
// original pode fornecer o preço. Nunca ler valor de páginas recomendadas.
async function renderedOfficialPrice(env,source,now){
 if(!official(source)||typeof env?.BROWSER?.quickAction!=='function')return null;
 const day=new Date(now*1000).toISOString().slice(0,10);
 try{
  await env.DB.prepare(
   "CREATE TABLE IF NOT EXISTS affiliate_price_browser_budget ("+
   "id INTEGER PRIMARY KEY CHECK(id=1),day_key TEXT NOT NULL DEFAULT '',"+
   "daily_count INTEGER NOT NULL DEFAULT 0,last_at INTEGER NOT NULL DEFAULT 0)"
  ).run();
  await env.DB.prepare("INSERT OR IGNORE INTO affiliate_price_browser_budget(id) VALUES(1)").run();
  const quota=await env.DB.prepare(
   "UPDATE affiliate_price_browser_budget SET "+
   "daily_count=CASE WHEN day_key=? THEN daily_count+1 ELSE 1 END,day_key=?,last_at=? "+
   "WHERE id=1 AND (day_key<>? OR daily_count<24) AND last_at<=?"
  ).bind(day,day,now,day,now-45).run();
  if(quota.meta?.changes!==1)return null;
  const response=await env.BROWSER.quickAction('content',{
   url:source,gotoOptions:{waitUntil:'domcontentloaded',timeout:14000},
   rejectResourceTypes:['image','font','media']
  });
  if(!response?.ok||typeof response.text!=='function')return null;
  const html=(await response.text()).slice(0,750000);
  const found=extractMercadoLivrePagePrice(html,source);
  return positive(found?.price_cents)?found.price_cents:null;
 }catch(error){
  console.warn('Preço renderizado indisponível:',String(error?.message||error).slice(0,110));
  return null;
 }
}

export function hasFreshOfferPrice(offer,now=Date.now()){
 const captured=Number(offer?.promo_captured_at),created=Number(offer?.created_at);
 const terms=safePromotionTerms(offer?.promo_terms_json);
 if(positive(terms?.price_cents)&&Number.isSafeInteger(captured)&&captured>0&&
   now>=captured*1000&&now-captured*1000<=MAX_AGE_MS)return true;
 if(!offer?.promo_terms_json&&positive(offer?.price_cents)&&Number.isSafeInteger(created)&&
  created>0&&now>=created*1000&&now-created*1000<=MAX_AGE_MS)return true;
 return false;
}
export function officialPriceOverlay(offer,price,now=Math.floor(Date.now()/1000)){
 const terms={price_cents:price,old_price_cents:null,price_source:'mercadolivre',
  coupon_required:false,coupon_code:null,payment_mode:'unspecified',
  installments:null,installment_cents:null,installments_no_interest:false,card_price_cents:null};
 return {...offer,price_cents:price,old_price_cents:null,promo_terms_json:JSON.stringify(terms),promo_captured_at:now};
}
export async function prepareAutomaticOfferPrice(env,offer,{fetcher=fetch,now=Math.floor(Date.now()/1000)}={}){
 await ensureAutomaticPrices(env);
 let source=null;
 try{source=await sourcePageForAffiliateImage(env,offer.affiliate_url);}catch{}
 if(!source&&official(offer.affiliate_url))source=offer.affiliate_url;
 let site=null;
 if(source){
  const cache=await env.DB.prepare(
    'SELECT source_url,price_cents,checked_at FROM affiliate_verified_prices WHERE affiliate_url=?'
  ).bind(offer.affiliate_url).first();
  if(cache?.source_url===source&&positive(cache.price_cents)&&
   now-cache.checked_at>=0&&now-cache.checked_at<=VERIFY_CACHE){
   site=Number(cache.price_cents);
  }else{
   try{
    const live=await fetchMercadoLivrePrice(source,fetcher);
    if(positive(live?.price_cents)){
     site=live.price_cents;
     await env.DB.prepare(
       'INSERT INTO affiliate_verified_prices(affiliate_url,source_url,price_cents,checked_at) VALUES(?,?,?,?) '+
       'ON CONFLICT(affiliate_url) DO UPDATE SET source_url=excluded.source_url,price_cents=excluded.price_cents,checked_at=excluded.checked_at'
     ).bind(offer.affiliate_url,source,site,now).run();
    }
   }catch(error){console.warn('Consulta de preço no anúncio:',String(error?.message||error).slice(0,100));}
   if(!site){
    // Última alternativa: leitura renderizada, limitada no D1. Somente se
    // preço e código do produto puderem ser confirmados na mesma página.
    const rendered=await renderedOfficialPrice(env,source,now);
    if(positive(rendered)){
     site=rendered;
     await env.DB.prepare(
      'INSERT INTO affiliate_verified_prices(affiliate_url,source_url,price_cents,checked_at) VALUES(?,?,?,?) '+
      'ON CONFLICT(affiliate_url) DO UPDATE SET source_url=excluded.source_url,price_cents=excluded.price_cents,checked_at=excluded.checked_at'
     ).bind(offer.affiliate_url,source,site,now).run();
    }
   }
   if(!site&&cache?.source_url===source&&positive(cache.price_cents)&&
     now-cache.checked_at>=0&&now-cache.checked_at<=LAST_CONFIRMED)site=Number(cache.price_cents);
  }
 }
 if(site)return {ok:true,offer:officialPriceOverlay(offer,site,now),price_source:'mercadolivre'};
 if(hasFreshOfferPrice(offer,now*1000))return {ok:true,offer,price_source:'anuncio'};
 return {ok:false,reason:source?'Preço não verificável no anúncio original':'Anúncio original não identificado e preço não informado'};
}
export async function recordAutomaticPriceRetry(env,queueType,offerId,reason,now=Math.floor(Date.now()/1000)){
 await ensureAutomaticPrices(env);
 if(!['telegram','channel','whatsapp','wa-direct','wa-group'].includes(queueType)||!Number.isSafeInteger(Number(offerId)))
  throw Error('Fila de preço inválida');
 await env.DB.prepare(
  'INSERT INTO affiliate_auto_price_retries(queue_type,offer_id,attempts,next_retry_at,last_error) VALUES(?,?,1,?,?) '+
  'ON CONFLICT(queue_type,offer_id) DO UPDATE SET attempts=attempts+1,next_retry_at=excluded.next_retry_at,last_error=excluded.last_error'
 ).bind(queueType,offerId,now+180,String(reason).slice(0,160)).run();
 return {status:'awaiting_price',offer_id:Number(offerId),reason:String(reason),next_retry_at:now+180};
}
export async function clearAutomaticPriceRetry(env,queueType,offerId){
 await ensureAutomaticPrices(env);
 await env.DB.prepare('DELETE FROM affiliate_auto_price_retries WHERE queue_type=? AND offer_id=?')
  .bind(queueType,Number(offerId)).run();
}
