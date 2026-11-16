// Mesmo resolvedor de fotos do botão manual, antes do disparo do Cron.
import {findProductImage} from './images.js';
import {resolveOfferSource} from './automatic-price.js';
import {getPrimaryCategory} from './multichannel.js';
import {cachedProductImage,resolveProductImageWithRetry,sourcePageForAffiliateImage,rememberProductImage} from './offer-images.js';
import {inspectMonitorShortlink,browserFeaturedProduct} from './whatsapp-link-monitor.js';
import {productId} from './link-batches.js';
import {trustedProductImage,validatedProductPhoto} from './images.js';
const TABLE="CREATE TABLE IF NOT EXISTS affiliate_photo_preflight (affiliate_url TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0)";
const REVIEW='Foto real indisponível após seis tentativas automáticas. Nenhum texto foi enviado.';
export async function prewarmTelegramQueue(env){
 if(!env?.DB||env.MASTER_SCHEDULE_ENABLED===false)return {skipped:'disabled'};
 const cfg=await env.DB.prepare('SELECT automation_enabled,telegram_enabled,channel_registered FROM settings WHERE id=1').first();
 if(!cfg?.automation_enabled||!cfg.telegram_enabled||!cfg.channel_registered)return {skipped:'disabled'};
 await env.DB.prepare(TABLE).run();
 const category=await getPrimaryCategory(env);
 // O Cron seguinte não deve ficar ocupado lendo 12 fotos lentas, nem
 // reconsiderar ofertas cujo próprio preflight marcou para tentar depois.
 // Preaquecer só as 2 próximas ofertas vencidas, de forma rotativa.
 const due=Math.floor(Date.now()/1000);
 const rows=await env.DB.prepare(
  "SELECT o.id,o.affiliate_url,o.status FROM offers o "+
  "LEFT JOIN affiliate_photo_preflight p ON p.affiliate_url=o.affiliate_url "+
  "WHERE (o.status='ready' OR (o.status='needs_review' AND o.last_error=?)) "+
  "AND (lower(?)='geral' OR lower(o.category)=lower(?)) "+
  "AND COALESCE(p.next_attempt_at,0)<=? "+
  "ORDER BY o.created_at,o.id LIMIT 2"
 ).bind(REVIEW,category,category,due).all();
 for(const item of rows.results||[]){
  try{
   // Impede buscas repetitivas de preço e imagem no mesmo anúncio a cada minuto.
   const now=Math.floor(Date.now()/1000);
   await env.DB.prepare('INSERT OR IGNORE INTO affiliate_photo_preflight(affiliate_url) VALUES(?)')
     .bind(item.affiliate_url).run();
   const slot=await env.DB.prepare(
    'UPDATE affiliate_photo_preflight SET attempts=attempts+1,next_attempt_at=? WHERE affiliate_url=? AND next_attempt_at<=?'
   ).bind(now+120,item.affiliate_url,now).run();
   if(slot.meta?.changes!==1)continue;
   // O agendador verifica preços com retry próprio. A rotina de fotos não
   // deve consumir o orçamento de navegador em consultas duplicadas.
   const cached=await cachedProductImage(env,item.affiliate_url);
   // O botão manual continua usando o resolvedor original. Se a vitrine
   // React esconder a foto nos metadados, o pré-carregamento AGENDADO usa
   // também a foto do cartão principal (nunca a de recomendações).
   let image=cached||await resolveProductImageWithRetry(
     env,item.affiliate_url,findProductImage,{retryOnMiss:true,sourceLookup:resolveOfferSource});
   if(!image)image=await resolveScheduledShowcasePhoto(env,item.affiliate_url);
   if(!image)continue;
   await env.DB.prepare('DELETE FROM affiliate_photo_preflight WHERE affiliate_url=?')
     .bind(item.affiliate_url).run();
   try{await env.DB.prepare('DELETE FROM telegram_photo_retries WHERE offer_id=?').bind(item.id).run();}catch{}
   if(item.status==='ready'){
    const changed=await env.DB.prepare(
     "UPDATE offers SET last_error=NULL WHERE id=? AND status='ready' AND last_error LIKE 'Aguardando foto%'"
    ).bind(item.id).run();
    if(!cached||changed.meta?.changes)return {status:'photo_ready',offer_id:item.id};
   }else{
    const changed=await env.DB.prepare(
     "UPDATE offers SET status='ready',last_error=NULL WHERE id=? AND status='needs_review' AND last_error=?"
    ).bind(item.id,REVIEW).run();
    if(changed.meta?.changes)return {status:'photo_ready',offer_id:item.id};
   }
  }catch(error){console.warn('Pré-carregamento de foto:',String(error?.message||error).slice(0,120));}
 }
 return {skipped:'cached_or_waiting'};
}


// Este último recurso pertence EXCLUSIVAMENTE ao Cron, não ao botão Publicar.
// O Mercado Livre às vezes oculta og:image da vitrine /social no HTTP público,
// mesmo exibindo a foto REAL em img.poly-component__picture após renderização.
// Nunca usar imagem de recomendações: o título e a foto devem estar dentro do
// MESMO cartão de destaque e a identidade MLB/MLBU precisa ser única.
const SHOWCASE_BUDGET='CREATE TABLE IF NOT EXISTS affiliate_scheduled_showcase_budget ('+
 'id INTEGER PRIMARY KEY CHECK(id=1),day_key TEXT NOT NULL DEFAULT \'\','+
 'daily_count INTEGER NOT NULL DEFAULT 0,last_at INTEGER NOT NULL DEFAULT 0)';
function officialProduct(value){
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||
   !['www.mercadolivre.com.br','mercadolivre.com.br',
     'produto.mercadolivre.com.br'].includes(url.hostname.toLowerCase()))return null;
  const id=productId(url.pathname);
  return id?{id,url:url.href}:null;
 }catch{return null;}
}
function elementAttribute(element,name){
 const attributes=element?.attributes;
 if(Array.isArray(attributes)){
  const item=attributes.find(a=>String(a?.name).toLowerCase()===name);
  if(typeof item?.value==='string')return item.value.replace(/&amp;/gi,'&');
 }else if(attributes&&typeof attributes==='object'&&typeof attributes[name]==='string'){
  return attributes[name].replace(/&amp;/gi,'&');
 }
 const html=String(element?.html||'').slice(0,6000);
 const match=(name==='href'?/\bhref\s*=\s*["']([^"']+)["']/i:
  name==='data-src'?/\bdata-src\s*=\s*["']([^"']+)["']/i:
   /\bsrc\s*=\s*["']([^"']+)["']/i).exec(html);
 return match?match[1].replace(/&amp;/gi,'&'):null;
}
async function claimShowcasePhotoBrowser(env,now=Math.floor(Date.now()/1000)){
 if(typeof env?.BROWSER?.quickAction!=='function')return false;
 await env.DB.prepare(SHOWCASE_BUDGET).run();
 await env.DB.prepare('INSERT OR IGNORE INTO affiliate_scheduled_showcase_budget(id) VALUES(1)').run();
 const day=new Date(now*1000).toISOString().slice(0,10);
 const claim=await env.DB.prepare(
  'UPDATE affiliate_scheduled_showcase_budget SET '+
  'day_key=?,daily_count=CASE WHEN day_key=? THEN daily_count+1 ELSE 1 END,last_at=? '+
  'WHERE id=1 AND (day_key<>? OR daily_count<240) AND last_at<=?'
 ).bind(day,day,now,day,now-15).run();
 return claim.meta?.changes===1;
}
async function saveVerifiedShowcasePhoto(env,affiliateUrl,source,imageUrl){
 if(!trustedProductImage(imageUrl))return null;
 const valid=await validatedProductPhoto(imageUrl);
 if(!valid)return null;
 await rememberProductImage(env,affiliateUrl,valid);
 if(source)await rememberProductImage(env,source,valid);
 return valid;
}
export async function resolveScheduledShowcasePhoto(env,affiliateUrl){
 if(!env?.DB||!env?.BROWSER?.quickAction)return null;
 if(!/^https:\/\/(?:meli\.la|meli\.promo|melila\.me)\//i.test(String(affiliateUrl)))return null;
 let source=null;
 try{source=officialProduct(await sourcePageForAffiliateImage(env,affiliateUrl));}catch{}
 let inspected;
 try{inspected=await inspectMonitorShortlink(affiliateUrl);}catch{return null;}
 if(inspected?.kind==='external'||inspected?.kind==='loop')return null;
 const publicProduct=officialProduct(inspected?.product?.url);
 if(source&&publicProduct&&source.id!==publicProduct.id)return null;
 source=source||publicProduct;
 if(source&&inspected?.product?.product_id&&source.id!==inspected.product.product_id)return null;
 const social=inspected?.social_url;
 if(!social||!/^https:\/\/(?:www\.)?mercadolivre\.com\.br\/social(?:\/|$)/i.test(social))
  return null;
 // HTML já renderizado pelo Worker: a identidade do cartão precisa ser
 // conhecida antes de aproveitar qualquer foto.
 if(source&&trustedProductImage(inspected?.featured_price?.image_url)){
  const photo=await saveVerifiedShowcasePhoto(
   env,affiliateUrl,source.url,inspected.featured_price.image_url);
  if(photo)return photo;
 }
 if(!await claimShowcasePhotoBrowser(env))return null;
 const titleSelector='.rl-card-featured-wrapper a.poly-component__title[href]';
 const actionSelector='.rl-card-featured-wrapper a.poly-component__link--action-link[href]';
 const photoSelector='.rl-card-featured-wrapper img.poly-component__picture';
 const alternatePhotoSelector='[class*="card-featured"] img.poly-component__picture';
 const alternateTitleSelector='[class*="card-featured"] a.poly-component__title[href]';
 const photoSelectors=[photoSelector,alternatePhotoSelector];
 const linkSelectors=[titleSelector,actionSelector,alternateTitleSelector];
 try{
  const scraped=await env.BROWSER.quickAction('scrape',{
   url:social,gotoOptions:{waitUntil:'domcontentloaded',timeout:18000},
   rejectResourceTypes:['font','media'],
   elements:[
    ...linkSelectors.map(selector=>({selector})),
    ...photoSelectors.map(selector=>({selector}))
   ]
  });
  if(!scraped?.ok||typeof scraped.json!=='function')return null;
  const payload=await scraped.json();
  const sections=Array.isArray(payload)?payload:
   Array.isArray(payload?.result)?payload.result:
   Array.isArray(payload?.results)?payload.results:[];
  const matched=new Map(),photos=[];
  for(const section of sections){
   if(![...linkSelectors,...photoSelectors].includes(section?.selector))continue;
   const items=Array.isArray(section?.results)?section.results:
    (section?.results&&typeof section.results==='object'?[section.results]:[]);
   for(const element of items.slice(0,6)){
    if(photoSelectors.includes(section.selector)){
     for(const key of ['src','data-src']){
      const url=elementAttribute(element,key);
      if(trustedProductImage(url)&&!photos.includes(url))photos.push(url);
     }
     continue;
    }
    const href=elementAttribute(element,'href');
    const candidate=officialProduct(href);
    if(candidate)matched.set(candidate.id,candidate);
   }
  }
  // As vitrines às vezes usam links /sec/ no destaque: o scraper de imagem
  // encontra a foto, mas o href sozinho não revela o MLB. Reutilizar o
  // resolvedor de destino do cartão principal, que segue somente /sec/
  // oficiais, antes de desistir da imagem válida.
  let featured=matched.size===1?[...matched.values()][0]:null;
  if(matched.size>1)return null;
  if(!featured&&photos.length){
   try{
    const resolved=await browserFeaturedProduct(env,social,{includeDetails:true});
    const official=officialProduct(resolved?.url);
    if(official&&(!source||source.id===official.id)){
     featured=official;
     if(trustedProductImage(resolved?.featured_price?.image_url)&&
        !photos.includes(resolved.featured_price.image_url))
      photos.unshift(resolved.featured_price.image_url);
    }
   }catch(error){
    console.warn('Identidade do destaque renderizado:',String(error?.message||error).slice(0,100));
   }
  }
  if(!featured||!photos.length)return null;
  if(source&&source.id!==featured.id)return null;
  // Só a foto do cartão destacado do MESMO MLB; nunca recomendações.
  for(const imageUrl of photos.slice(0,3)){
   const photo=await saveVerifiedShowcasePhoto(env,affiliateUrl,featured.url,imageUrl);
   if(photo)return photo;
  }
 }catch(error){
  console.warn('Foto destacada automática indisponível:',String(error?.message||error).slice(0,120));
 }
 return null;
}
