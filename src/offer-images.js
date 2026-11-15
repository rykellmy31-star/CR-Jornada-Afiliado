import { trustedProductImage, trustedProductPage, extractProductImage, validatedProductPhoto } from './images.js';

// A URL é a chave porque a mesma oferta pode ser divulgada em canais diferentes.
// Só guarda a URL pública da foto, nunca dados do comprador ou credenciais.
const CREATE_CACHE = `CREATE TABLE IF NOT EXISTS affiliate_product_images (
  affiliate_url TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;
const CACHE_LIFETIME = 7 * 24 * 60 * 60;

// Registra a FOTO EFETIVAMENTE aceita pelo Telegram no sendPhoto.
// O WhatsApp consulta primeiro esse registro em D1; assim o link da imagem
// é compartilhado e não depende de recuperar uma prévia do link novamente.
const TELEGRAM_PHOTO_TABLE = "CREATE TABLE IF NOT EXISTS affiliate_telegram_sent_photos ("+
 "affiliate_url TEXT PRIMARY KEY,image_url TEXT NOT NULL,"+
 "message_id TEXT NOT NULL,sent_at INTEGER NOT NULL)";
export async function rememberTelegramSentPhoto(env,affiliateUrl,imageUrl,messageId){
 if(!env?.DB||!trustedProductPage(affiliateUrl)||!trustedProductImage(imageUrl)||
    !Number.isSafeInteger(Number(messageId))||Number(messageId)<=0)return false;
 await env.DB.prepare(TELEGRAM_PHOTO_TABLE).run();
 await env.DB.prepare(
  "INSERT INTO affiliate_telegram_sent_photos(affiliate_url,image_url,message_id,sent_at) "+
  "VALUES(?,?,?,?) ON CONFLICT(affiliate_url) DO UPDATE SET "+
  "image_url=excluded.image_url,message_id=excluded.message_id,sent_at=excluded.sent_at"
 ).bind(affiliateUrl,imageUrl,String(messageId),Math.floor(Date.now()/1000)).run();
 // Também abastece o cache que já é usado nos fluxos manual e automático.
 await rememberProductImage(env,affiliateUrl,imageUrl);
 return true;
}
export async function telegramSentPhoto(env,affiliateUrl){
 if(!env?.DB||!trustedProductPage(affiliateUrl))return null;
 await env.DB.prepare(TELEGRAM_PHOTO_TABLE).run();
 const data=await env.DB.prepare(
  "SELECT image_url FROM affiliate_telegram_sent_photos "+
  "WHERE affiliate_url=? AND sent_at>=?"
 ).bind(affiliateUrl,Math.floor(Date.now()/1000)-CACHE_LIFETIME).first();
 return trustedProductImage(data?.image_url)?data.image_url:null;
}
export async function sharedWhatsAppProductPhoto(env,affiliateUrl,lookup){
 // O mesmo produto enviado COM FOTO pelo Telegram deve ir COM A MESMA FOTO
 // no WhatsApp, sem nova consulta ao meli.la. Para ofertas somente WhatsApp,
 // continuam as fontes de foto do Mercado Livre e o cache original.
 try{
  const confirmed=await telegramSentPhoto(env,affiliateUrl);
  if(confirmed)return confirmed;
 }catch(error){
  console.warn('Foto enviada no Telegram indisponível:',String(error?.message||error).slice(0,95));
 }
 return await resolveProductImage(env,affiliateUrl,lookup);
}


export async function cachedProductImage(env, affiliateUrl) {
  if (!env?.DB || !trustedProductPage(affiliateUrl)) return null;
  await env.DB.prepare(CREATE_CACHE).run();
  const row = await env.DB.prepare(
    'SELECT image_url FROM affiliate_product_images WHERE affiliate_url=? AND updated_at>=?'
  ).bind(affiliateUrl, Math.floor(Date.now() / 1000) - CACHE_LIFETIME).first();
  return trustedProductImage(row?.image_url) ? row.image_url : null;
}

export async function rememberProductImage(env, affiliateUrl, imageUrl) {
  if (!env?.DB || !trustedProductPage(affiliateUrl) || !trustedProductImage(imageUrl)) return false;
  await env.DB.prepare(CREATE_CACHE).run();
  await env.DB.prepare(
    'INSERT INTO affiliate_product_images(affiliate_url,image_url,updated_at) VALUES(?,?,?) ' +
    'ON CONFLICT(affiliate_url) DO UPDATE SET image_url=excluded.image_url,updated_at=excluded.updated_at'
  ).bind(affiliateUrl, imageUrl, Math.floor(Date.now() / 1000)).run();
  return true;
}

// Quando o afiliado converte um lote, mantemos a associação confirmada
// entre o link com comissão e a URL normal daquele mesmo produto. A vitrine
// /social dos links meli.la pode bloquear metadados em chamadas do Worker.
// Buscar a imagem no anúncio original evita enviar somente texto por isso.
export async function sourcePageForAffiliateImage(env, affiliateUrl) {
 if (!env?.DB || !trustedProductPage(affiliateUrl)) return null;
 try {
  const row=await env.DB.prepare(
   "SELECT source_url FROM ml_link_batch_items "+
   "WHERE affiliate_url=? AND status='queued' ORDER BY id DESC LIMIT 1"
  ).bind(affiliateUrl).first();
  const source=row?.source_url;
  if(!trustedProductPage(source)||source===affiliateUrl)return null;
  const url=new URL(source);
  // A fonte precisa ser anúncio oficial, nunca outra vitrine ou encurtador.
  if(!/^(?:www\.|produto\.|m\.)?mercadolivre\.com\.br$/i.test(url.hostname))return null;
  if(!/\/(?:p|up)\/MLBU?\d{6,}|(?:^|\/)MLB-?\d{6,}/i.test(url.pathname))
   return null;
  return url.href;
 }catch{return null;} // Batches opcionais e bancos legados.
}

// Última alternativa: uma vitrine React pode ocultar og:image numa consulta HTTP.
// Browser Run executa o JavaScript, porém só é usado após as duas tentativas
// normais. A quota de D1 impede consumo excessivo do navegador.
export async function claimAffiliateImageBrowserBudget(env,now=Math.floor(Date.now()/1000)){
 if(!env?.DB||typeof env?.BROWSER?.quickAction!=='function')return false;
 const day=new Date(now*1000).toISOString().slice(0,10);
 await env.DB.prepare(
  "CREATE TABLE IF NOT EXISTS affiliate_image_browser_budget (id INTEGER PRIMARY KEY CHECK(id=1),day_key TEXT NOT NULL DEFAULT '',daily_count INTEGER NOT NULL DEFAULT 0,last_at INTEGER NOT NULL DEFAULT 0)"
 ).run();
 await env.DB.prepare("INSERT OR IGNORE INTO affiliate_image_browser_budget(id) VALUES(1)").run();
 const updated=await env.DB.prepare(
  "UPDATE affiliate_image_browser_budget SET "+
  "daily_count=CASE WHEN day_key=? THEN daily_count+1 ELSE 1 END,day_key=?,last_at=? "+
  "WHERE id=1 AND (day_key<>? OR daily_count<12) AND last_at<=?"
 ).bind(day,day,now,day,now-45).run();
 return updated.meta?.changes===1;
}
async function photoFromRenderedPage(env,url){
 if(!trustedProductPage(url)||!await claimAffiliateImageBrowserBudget(env))return null;
 try{
  const response=await env.BROWSER.quickAction('content',{
    url,
    gotoOptions:{waitUntil:'domcontentloaded',timeout:14000},
    rejectResourceTypes:['font','media']
  });
  if(!response?.ok||typeof response.text!=='function')return null;
  const html=(await response.text()).slice(0,3_000_000);
  const candidate=extractProductImage(html);
  if(!candidate)return null;
  return await validatedProductPhoto(candidate);
 }catch(error){
  console.warn('Browser Run não confirmou imagem:',String(error?.message||error).slice(0,100));
  return null;
 }
}

export async function resolveProductImage(env, affiliateUrl, lookup) {
  let cached = null;
  try { cached = await cachedProductImage(env, affiliateUrl); }
  catch (error) { console.warn('Cache da foto indisponível:', String(error?.message || error).slice(0, 100)); }
  if (cached) return cached;
  let image=null,source=null;
  try{image=await lookup(affiliateUrl);}
  catch(error){console.warn('Foto do encurtador indisponível:',String(error?.message||error).slice(0,100));}
  if(!trustedProductImage(image)){
    source=await sourcePageForAffiliateImage(env,affiliateUrl);
    if(source){
      // Reaproveita também o cache da página original, quando existir.
      try{image=await cachedProductImage(env,source);}
      catch{}
      if(!trustedProductImage(image)){
        try{image=await lookup(source);}
        catch(error){console.warn('Foto da página do produto indisponível:',String(error?.message||error).slice(0,100));}
      }
      if(trustedProductImage(image)){
        try{await rememberProductImage(env,source,image);}
        catch{}
      }
    }
  }
  if(!trustedProductImage(image)){
    // Preferir o anúncio original confirmado no lote; caso não exista, a
    // vitrine de afiliado pode conter a própria foto do produto nos metadados.
    image=await photoFromRenderedPage(env,source||affiliateUrl);
  }
  if (image && trustedProductImage(image)) {
    try { await rememberProductImage(env, affiliateUrl, image); }
    catch (error) { console.warn('Não foi possível memorizar a foto:', String(error?.message || error).slice(0, 100)); }
    return image;
  }
  return null;
}
