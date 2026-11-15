// Mesmo resolvedor de fotos do botão manual, antes do disparo do Cron.
import {findProductImage} from './images.js';
import {getPrimaryCategory} from './multichannel.js';
import {cachedProductImage,resolveProductImageWithRetry} from './offer-images.js';
const TABLE="CREATE TABLE IF NOT EXISTS affiliate_photo_preflight (affiliate_url TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0)";
const REVIEW='Foto real indisponível após seis tentativas automáticas. Nenhum texto foi enviado.';
export async function prewarmTelegramQueue(env){
 if(!env?.DB||env.MASTER_SCHEDULE_ENABLED===false)return {skipped:'disabled'};
 const cfg=await env.DB.prepare('SELECT automation_enabled,telegram_enabled,channel_registered FROM settings WHERE id=1').first();
 if(!cfg?.automation_enabled||!cfg.telegram_enabled||!cfg.channel_registered)return {skipped:'disabled'};
 await env.DB.prepare(TABLE).run();
 const category=await getPrimaryCategory(env);
 const rows=await env.DB.prepare("SELECT id,affiliate_url,status FROM offers WHERE (status='ready' OR (status='needs_review' AND last_error=?)) AND (lower(?)='geral' OR lower(category)=lower(?)) ORDER BY created_at,id LIMIT 12")
  .bind(REVIEW,category,category).all();
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
   const image=cached||await resolveProductImageWithRetry(
     env,item.affiliate_url,findProductImage,{retryOnMiss:true});
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
