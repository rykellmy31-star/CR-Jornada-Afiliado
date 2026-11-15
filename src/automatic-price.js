// Pré-verificação de preço para ofertas automáticas do Mercado Livre.
// Uma falha temporária de preço nunca bloqueia os demais produtos.
import {fetchMercadoLivrePrice,fetchMercadoLivrePublicPrice,extractMercadoLivrePagePrice,extractFeaturedShowcasePrice} from './mercado-livre-price.js';
import {sourcePageForAffiliateImage,rememberProductImage} from './offer-images.js';
import {validatedProductPhoto} from './images.js';
import {inspectMonitorShortlink,browserFeaturedProduct,claimSocialBrowserBudget} from './whatsapp-link-monitor.js';
import {productId} from './link-batches.js';
import {safePromotionTerms,MAX_AGE_MS} from './promotion-terms.js';

const VERIFY_CACHE=15*60;
const PRICE_BROWSER_DAILY_LIMIT=96;
const PRICE_BROWSER_COOLDOWN=8;
const SOURCES="CREATE TABLE IF NOT EXISTS affiliate_verified_sources ("+
 "affiliate_url TEXT PRIMARY KEY,source_url TEXT NOT NULL,checked_at INTEGER NOT NULL)";
const DETAILS="CREATE TABLE IF NOT EXISTS affiliate_verified_offer_details ("+
 "affiliate_url TEXT PRIMARY KEY,source_url TEXT NOT NULL,details_json TEXT NOT NULL,checked_at INTEGER NOT NULL)";
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
 await env.DB.prepare(SOURCES).run();
 await env.DB.prepare(DETAILS).run();
}
// Um orçamento único de Browser Run para preços oficiais, com limite diário.
async function claimPriceBrowserBudget(env,now){
 if(typeof env?.BROWSER?.quickAction!=='function')return false;
 const day=new Date(now*1000).toISOString().slice(0,10);
 await env.DB.prepare(
  "CREATE TABLE IF NOT EXISTS affiliate_price_browser_budget ("+
   "id INTEGER PRIMARY KEY CHECK(id=1),day_key TEXT NOT NULL DEFAULT '',"+
   "daily_count INTEGER NOT NULL DEFAULT 0,last_at INTEGER NOT NULL DEFAULT 0)"
 ).run();
 await env.DB.prepare("INSERT OR IGNORE INTO affiliate_price_browser_budget(id) VALUES(1)").run();
 const quota=await env.DB.prepare(
  "UPDATE affiliate_price_browser_budget SET "+
   "daily_count=CASE WHEN day_key=? THEN daily_count+1 ELSE 1 END,day_key=?,last_at=? "+
   "WHERE id=1 AND (day_key<>? OR daily_count<"+PRICE_BROWSER_DAILY_LIMIT+") AND last_at<=?"
 ).bind(day,day,now,day,now-PRICE_BROWSER_COOLDOWN).run();
 return quota.meta?.changes===1;
}
async function renderedOfficialPrice(env,source,now){
 if(!official(source)||typeof env?.BROWSER?.quickAction!=='function')return null;
 try{
  if(!await claimPriceBrowserBudget(env,now))return null;
  const response=await env.BROWSER.quickAction('content',{
   url:source,gotoOptions:{waitUntil:'networkidle2',timeout:20000},
   rejectResourceTypes:['image','font','media']
  });
  if(!response?.ok||typeof response.text!=='function')return null;
  const found=extractMercadoLivrePagePrice((await response.text()).slice(0,750000),source);
  return positive(found?.price_cents)?found:null;
 }catch(error){
  console.warn('Preço renderizado indisponível:',String(error?.message||error).slice(0,110));
  return null;
 }
}
// Só aceita o preço do cartão destacado se o MLB corresponder à origem
// confirmada. Recomendações e preços de terceiros são ignorados.
async function featuredShowcasePrice(env,affiliateUrl,source,fetcher,now){
 if(!/^https:\/\/(?:meli\.la|meli\.promo)\//i.test(affiliateUrl)||!official(source))return null;
 const expected=productId(new URL(source).pathname);
 let inspected;
 try{inspected=await inspectMonitorShortlink(affiliateUrl,{fetcher});}
 catch{return null;}
 if(inspected?.product&&inspected.product.product_id!==expected)return null;
 if(positive(inspected?.featured_price?.price_cents)&&inspected?.product?.product_id===expected)
  return inspected.featured_price;
 const social=inspected?.social_url;
 if(!social||typeof env?.BROWSER?.quickAction!=='function')return null;
 try{
  if(!await claimPriceBrowserBudget(env,now))return null;
  const response=await env.BROWSER.quickAction('content',{
   url:social,gotoOptions:{waitUntil:'networkidle2',timeout:20000},
   rejectResourceTypes:['image','font','media']
  });
  if(!response?.ok||typeof response.text!=='function')return null;
  const found=extractFeaturedShowcasePrice((await response.text()).slice(0,5500000),expected);
  return positive(found?.price_cents)?found:null;
 }catch(error){
  console.warn('Preço da vitrine principal:',String(error?.message||error).slice(0,110));
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
 const d=typeof price==='number'?{price_cents:price}:price;
 if(!positive(d?.price_cents))throw Error('Preço público inválido.');
 const old=positive(d?.old_price_cents)&&d.old_price_cents>d.price_cents?d.old_price_cents:null;
 const mode=['pix','pix_only','card'].includes(d.payment_mode)?d.payment_mode:'unspecified';
 const count=Number.isInteger(d.installments)&&d.installments>=2&&d.installments<=24?d.installments:null;
 const terms={price_cents:d.price_cents,old_price_cents:old,price_source:'mercadolivre',
  coupon_required:false,coupon_code:null,payment_mode:mode,
  installments:count,installment_cents:count&&positive(d.installment_cents)?d.installment_cents:null,
  installments_no_interest:!!(count&&d.installments_no_interest),
  card_price_cents:positive(d.card_price_cents)&&d.card_price_cents>d.price_cents?d.card_price_cents:null};
 return {...offer,price_cents:d.price_cents,old_price_cents:old,
  promo_terms_json:JSON.stringify(terms),promo_captured_at:now};
}
export async function resolveOfferSource(env,affiliateUrl,{fetcher=fetch}={}){
 await ensureAutomaticPrices(env);
 let source=null;
 try{source=await sourcePageForAffiliateImage(env,affiliateUrl);}catch{}
 if(!source&&official(affiliateUrl))source=affiliateUrl;
 if(!source){
  const cached=await env.DB.prepare('SELECT source_url FROM affiliate_verified_sources WHERE affiliate_url=?')
    .bind(affiliateUrl).first();
  if(official(cached?.source_url))source=cached.source_url;
 }
 if(!source){
  try{
   const result=await inspectMonitorShortlink(affiliateUrl,{fetcher});
   const identified=result?.product||(result?.social_url&&['showcase','auth'].includes(result.kind)&&
      await claimSocialBrowserBudget(env)
     ?await browserFeaturedProduct(env,result.social_url):null);
   if(official(identified?.url))source=identified.url;
  }catch(error){
   console.warn('Origem do anúncio do afiliado:',String(error?.message||error).slice(0,100));
  }
 }
 if(!official(source))return null;
 await env.DB.prepare("INSERT INTO affiliate_verified_sources(affiliate_url,source_url,checked_at) VALUES(?,?,?) "+
  "ON CONFLICT(affiliate_url) DO UPDATE SET source_url=excluded.source_url,checked_at=excluded.checked_at")
  .bind(affiliateUrl,source,Math.floor(Date.now()/1000)).run();
 return source;
}
export async function prepareAutomaticOfferPrice(env,offer,
 {fetcher=fetch,now=Math.floor(Date.now()/1000),requireSite=false}={}){
 await ensureAutomaticPrices(env);
 const source=await resolveOfferSource(env,offer.affiliate_url,{fetcher});
 let details=null;
 if(source){
  const cached=await env.DB.prepare(
   'SELECT source_url,details_json,checked_at FROM affiliate_verified_offer_details WHERE affiliate_url=?'
  ).bind(offer.affiliate_url).first();
  if(cached?.source_url===source&&now-cached.checked_at>=0&&now-cached.checked_at<=VERIFY_CACHE){
   try{details=JSON.parse(cached.details_json);}catch{}
  }
  if(!positive(details?.price_cents)){
   try{const live=await fetchMercadoLivrePrice(source,fetcher);
    if(positive(live?.price_cents))details=live;
   }catch(error){console.warn('Preço direto do Mercado Livre:',String(error?.message||error).slice(0,100));}
   if(!positive(details?.price_cents)){
    // Consulta pública oficial, sem credenciais. Nunca troca o ID do produto.
    try{
     const publicPrice=await fetchMercadoLivrePublicPrice(source,fetcher);
     if(positive(publicPrice?.price_cents))details=publicPrice;
    }catch(error){console.warn('Preço público do Mercado Livre:',String(error?.message||error).slice(0,100));}
   }
   if(!positive(details?.price_cents)){
    const featured=await featuredShowcasePrice(env,offer.affiliate_url,source,fetcher,now);
    if(positive(featured?.price_cents))details=featured;
   }
   if(!positive(details?.price_cents)){
    const rendered=await renderedOfficialPrice(env,source,now);
    if(positive(rendered?.price_cents))details=rendered;
   }
   if(positive(details?.price_cents)){
    // Foto do MESMO cartão principal, validada na CDN. A imagem é reutilizada
    // no envio manual/automático e no espelhamento para WhatsApp.
    if(details.image_url){
     try{
      const photo=await validatedProductPhoto(details.image_url,fetcher);
      if(photo){
       await rememberProductImage(env,offer.affiliate_url,photo);
       await rememberProductImage(env,source,photo);
      }
     }catch(error){console.warn('Foto da vitrine:',String(error?.message||error).slice(0,95));}
    }
    await env.DB.prepare(
      'INSERT INTO affiliate_verified_offer_details(affiliate_url,source_url,details_json,checked_at) VALUES(?,?,?,?) '+
      'ON CONFLICT(affiliate_url) DO UPDATE SET source_url=excluded.source_url,details_json=excluded.details_json,checked_at=excluded.checked_at'
    ).bind(offer.affiliate_url,source,JSON.stringify(details),now).run();
    await env.DB.prepare(
      'INSERT INTO affiliate_verified_prices(affiliate_url,source_url,price_cents,checked_at) VALUES(?,?,?,?) '+
      'ON CONFLICT(affiliate_url) DO UPDATE SET source_url=excluded.source_url,price_cents=excluded.price_cents,checked_at=excluded.checked_at'
    ).bind(offer.affiliate_url,source,details.price_cents,now).run();
   }
  }
 }
 if(positive(details?.price_cents))
  return {ok:true,offer:officialPriceOverlay(offer,details,now),price_source:'mercadolivre'};
 // Automatic strict mode never uses owner-entered or WhatsApp-group prices.
 if(!requireSite&&hasFreshOfferPrice(offer,now*1000))
  return {ok:true,offer,price_source:'anuncio'};
 return {ok:false,reason:source?'Preço atual indisponível no anúncio original':'Não foi possível confirmar a página original do produto'};
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
