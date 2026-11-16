// Importação automática EXPERIMENTAL dos produtos de grupos WhatsApp AUTORIZADOS.
// Os parâmetros matt_word/matt_tool não representam geração oficial de ref ou garantia de comissão.
// Nunca reutiliza o link nem a etiqueta de quem compartilhou o anúncio.
import {ensureMonitor} from './whatsapp-link-monitor.js';
import {affiliateStoreState,previewAffiliateLink} from './affiliate-stores.js';
import {getPrimaryCategory,categoryMatches} from './multichannel.js';
import {ensureLinkBatches} from './link-batches.js';

const SETTINGS="CREATE TABLE IF NOT EXISTS ml_group_copy_auto_settings ("+
 "id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,"+
 "experimental_acknowledged INTEGER NOT NULL DEFAULT 0,"+
 "lease_until INTEGER NOT NULL DEFAULT 0,last_run_at INTEGER NOT NULL DEFAULT 0,"+
 "last_error TEXT NOT NULL DEFAULT '',queued_count INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)";
const HISTORY="CREATE TABLE IF NOT EXISTS ml_group_copy_auto_history ("+
 "product_id TEXT PRIMARY KEY,group_id INTEGER NOT NULL,offer_id INTEGER NOT NULL,"+
 "short_url TEXT NOT NULL,source_url TEXT NOT NULL,target_url TEXT NOT NULL,queued_at INTEGER NOT NULL)";
const epoch=()=>Math.floor(Date.now()/1000);
const fail=(text,status=400)=>Object.assign(new Error(text),{status});
export async function ensureGroupCopyAutomation(env){
 await env.DB.prepare(SETTINGS).run();
 await env.DB.prepare(HISTORY).run();
 await env.DB.prepare("INSERT OR IGNORE INTO ml_group_copy_auto_settings(id) VALUES(1)").run();
}
export async function groupCopyState(env){
 await ensureMonitor(env);await ensureGroupCopyAutomation(env);
 const at=epoch();
 const [row,monitor,groups,account,recent,waiting,readiness]=await Promise.all([
  env.DB.prepare('SELECT enabled,experimental_acknowledged,last_run_at,last_error,queued_count FROM ml_group_copy_auto_settings WHERE id=1').first(),
  env.DB.prepare('SELECT enabled FROM ml_monitor_settings WHERE id=1').first(),
  env.DB.prepare('SELECT COUNT(*) AS total FROM ml_monitor_groups WHERE enabled=1 AND authorized=1').first(),
  affiliateStoreState(env),
  env.DB.prepare('SELECT product_id,short_url,queued_at FROM ml_group_copy_auto_history ORDER BY queued_at DESC LIMIT 15').all(),
  env.DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id WHERE l.status='available' AND g.enabled=1 AND g.authorized=1").first(),
  env.DB.prepare("SELECT "+
   "COALESCE(SUM(CASE WHEN l.category='Geral' OR l.classification='needs_review' THEN 1 ELSE 0 END),0) AS needs_category,"+
   "COALESCE(SUM(CASE WHEN l.category<>'Geral' AND l.classification<>'needs_review' "+
   "AND (sp.product_id IS NULL OR sp.status<>'ok' OR sp.price_cents<=0 OR sp.checked_at<? OR sp.checked_at>?) "+
   "THEN 1 ELSE 0 END),0) AS needs_price,"+
   "COALESCE(SUM(CASE WHEN l.category<>'Geral' AND l.classification<>'needs_review' "+
   "AND sp.status='ok' AND sp.price_cents>0 AND sp.checked_at>=? AND sp.checked_at<=? "+
   "THEN 1 ELSE 0 END),0) AS with_price "+
   "FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id "+
   "LEFT JOIN ml_monitor_site_prices sp ON sp.product_id=l.product_id "+
   "WHERE l.status='available' AND g.enabled=1 AND g.authorized=1")
  .bind(at-6*3600,at,at-6*3600,at).first()
 ]);
 return {enabled:row?.enabled===1,experimental_acknowledged:row?.experimental_acknowledged===1,
  last_run_at:Number(row?.last_run_at||0),last_error:String(row?.last_error||''),
  queued_count:Number(row?.queued_count||0),monitor_enabled:monitor?.enabled===1,
  authorized_groups:Number(groups?.total||0),store_configured:account.mercadolivre.configured,
  label:account.mercadolivre.label||null,waiting:Number(waiting?.total||0),
  readiness:{needs_category:Number(readiness?.needs_category||0),
   needs_price:Number(readiness?.needs_price||0),with_price:Number(readiness?.with_price||0)},
  recent:(recent?.results||[]),commission_verified:false};
}
export async function saveGroupCopySettings(env,body){
 await ensureGroupCopyAutomation(env);
 if(typeof body?.enabled!=='boolean')throw fail('Informe se a importação automática está ligada ou desligada.');
 if(body.enabled){
  if(body.experimental_acknowledged!==true)
   throw fail('Confirme que a conversão por etiqueta é experimental e que o Mercado Livre ainda não confirmou as comissões.');
  const state=await groupCopyState(env);
  if(!state.store_configured)throw fail('Cadastre antes sua etiqueta em LOJAS.');
  if(!state.monitor_enabled)throw fail('Ative a captura de grupos na aba COPIAR DE GRUPOS.');
  if(!state.authorized_groups)throw fail('Selecione ao menos um grupo autorizado para copiar produtos.');
 }
 await env.DB.prepare('UPDATE ml_group_copy_auto_settings SET enabled=?,experimental_acknowledged=?,updated_at=?,last_error=? WHERE id=1')
  .bind(Number(body.enabled),Number(body.enabled&&body.experimental_acknowledged===true),epoch(),'').run();
 return {ok:true,...await groupCopyState(env)};
}
// Ação de teste explícita: importa no máximo uma oferta elegível para a fila,
// sem chamar APIs de envio nem alterar horários de publicação.
export async function testGroupCopyImport(env){
 const state=await groupCopyState(env);
 if(!state.enabled)throw fail('Ative e salve a importação automática experimental antes de testar.');
 if(!state.monitor_enabled)throw fail('Ative o monitor de grupos para continuar o teste.');
 if(!state.store_configured||!state.authorized_groups)
  throw fail('Cadastre sua loja e escolha pelo menos um grupo autorizado.');
 const result=await runGroupCopyScheduled(env);
 return {ok:!result.error,result,state:await groupCopyState(env)};
}
function shortCode(){
 const bytes=crypto.getRandomValues(new Uint8Array(9));
 return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
// Um produto por Cron. Somente ofertas classificadas com preço OFICIAL recente
// e canal compatível; o publicador existente impõe intervalo, horário e foto real.
export async function runGroupCopyScheduled(env,{now=null}={}){
 if(!env?.DB)return {skipped:'database'};
 await ensureGroupCopyAutomation(env);
 const at=Number.isSafeInteger(now)&&now>0?now:epoch();
 const lease=at+180;
 const claimed=await env.DB.prepare('UPDATE ml_group_copy_auto_settings SET lease_until=? WHERE id=1 AND enabled=1 AND experimental_acknowledged=1 AND lease_until<=?')
  .bind(lease,at).run();
 if(claimed.meta?.changes!==1)return {skipped:'disabled_or_busy'};
 try{
  await ensureMonitor(env);
  const monitor=await env.DB.prepare('SELECT enabled FROM ml_monitor_settings WHERE id=1').first();
  if(!monitor?.enabled)return {skipped:'monitor_off'};
  const account=await affiliateStoreState(env);
  if(!account.mercadolivre.configured)return {skipped:'missing_store'};
  await ensureLinkBatches(env);
  const permitted=await getPrimaryCategory(env);
  const rows=(await env.DB.prepare(
   "SELECT l.id,l.group_id,l.product_id,l.title,l.category,l.source_url,sp.price_cents,sp.checked_at,COALESCE(m.last_queued_at,0) AS last_queued_at "+
   "FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id "+
   "JOIN ml_monitor_site_prices sp ON sp.product_id=l.product_id "+
   "LEFT JOIN ml_monitor_product_meta m ON m.product_id=l.product_id "+
   "LEFT JOIN ml_group_copy_auto_history h ON h.product_id=l.product_id "+
   "WHERE l.status='available' AND l.category<>'Geral' AND l.classification<>'needs_review' "+
   "AND g.enabled=1 AND g.authorized=1 AND sp.status='ok' AND sp.price_cents>0 "+
   "AND sp.checked_at>=? AND sp.checked_at<=? AND h.product_id IS NULL "+
   "ORDER BY l.id LIMIT 12"
  ).bind(at-6*3600,at).all()).results;
  for(const item of rows){
   if(!categoryMatches(item.category,permitted))continue;
   if(item.last_queued_at&&at-item.last_queued_at<7*24*3600)continue;
   let preview;
   try{preview=await previewAffiliateLink(env,{product_url:item.source_url});}
   catch{continue;} // URLs não canônicas aguardam normalização/revisão, não inventamos IDs.
   if(item.title.length<5||item.title.length>180)continue;
   const price=Number(item.price_cents);
   if(!Number.isSafeInteger(price)||price<=0||price>100_000_000)continue;
   // Se o mesmo destino já entrou manualmente na fila, não republicar.
   const duplicate=await env.DB.prepare("SELECT id FROM offers WHERE affiliate_url=? LIMIT 1").bind(preview.target_url).first();
   if(duplicate)continue;
   const code=shortCode();
   const shortUrl='https://promoml.app/'+code;
   let offerId=null,batchId=null;
   try{
    // O log único bloqueia a mesma oferta no próximo ciclo.
    await env.DB.prepare("INSERT INTO ml_group_copy_auto_history(product_id,group_id,offer_id,short_url,source_url,target_url,queued_at) VALUES(?,?,0,?,?,?,?)")
     .bind(item.product_id,item.group_id,shortUrl,item.source_url,preview.target_url,at).run();
    const created=await env.DB.prepare("INSERT INTO offers(title,affiliate_url,category,price_cents,old_price_cents,promo_terms_json,promo_captured_at,created_at,status) VALUES(?,?,?,?,NULL,?,?,?,'ready')")
     .bind(item.title,preview.target_url,item.category,price,
      JSON.stringify({price_cents:price,old_price_cents:null,price_source:'mercadolivre',payment_mode:'unspecified',installments:null,installment_cents:null,installments_no_interest:false,card_price_cents:null,coupon_required:false,coupon_code:null}),Number(item.checked_at),at).run();
    offerId=Number(created.meta?.last_row_id);
    if(!Number.isSafeInteger(offerId)||offerId<1)throw fail('O banco não retornou a oferta criada.');
    const createdBatch=await env.DB.prepare("INSERT INTO ml_link_batches(status,created_at,updated_at,imported_at) VALUES('imported',?,?,?)").bind(at,at,at).run();
    batchId=Number(createdBatch.meta?.last_row_id);
    await env.DB.batch([
     env.DB.prepare("INSERT INTO ml_link_batch_items(batch_id,position,title,source_url,category,classification,affiliate_url,offer_id,status) VALUES(?,1,?,?,?,'selected',?,?,'queued')")
      .bind(batchId,item.title,item.source_url,item.category,preview.target_url,offerId),
     env.DB.prepare("UPDATE ml_monitor_links SET status='batched',batch_id=? WHERE id=? AND status='available'").bind(batchId,item.id),
     env.DB.prepare("INSERT INTO crj_affiliate_shortlinks(code,product_url,target_url,label,created_at) VALUES(?,?,?,?,?)")
      .bind(code,preview.product_url,preview.target_url,preview.label,at),
     env.DB.prepare('UPDATE ml_group_copy_auto_history SET offer_id=? WHERE product_id=?').bind(offerId,item.product_id),
     env.DB.prepare('UPDATE ml_monitor_product_meta SET last_queued_at=?,last_queued_price_cents=? WHERE product_id=?').bind(at,price,item.product_id),
     env.DB.prepare('UPDATE ml_group_copy_auto_settings SET queued_count=queued_count+1,last_run_at=?,last_error=? WHERE id=1').bind(at,'')
    ]);
    return {queued:1,product_id:item.product_id,offer_id:offerId,short_url:shortUrl,commission_verified:false};
   }catch(error){
    // Retira artefatos parciais; a fila NUNCA recebe um anúncio sem link validado.
    if(batchId)try{await env.DB.prepare('DELETE FROM ml_link_batches WHERE id=? AND status=?').bind(batchId,'imported').run();}catch{}
    if(offerId)try{await env.DB.prepare("DELETE FROM offers WHERE id=? AND status='ready'").bind(offerId).run();}catch{}
    try{await env.DB.prepare('DELETE FROM ml_group_copy_auto_history WHERE product_id=? AND offer_id=0').bind(item.product_id).run();}catch{}
    throw error;
   }
  }
  await env.DB.prepare('UPDATE ml_group_copy_auto_settings SET last_run_at=?,last_error=? WHERE id=1').bind(at,'').run();
  return {skipped:rows.length?'no_eligible_product':'awaiting_verified_price'};
 }catch(error){
  const message=String(error?.message||error).slice(0,160);
  await env.DB.prepare('UPDATE ml_group_copy_auto_settings SET last_run_at=?,last_error=? WHERE id=1').bind(at,message).run();
  return {error:message};
 }finally{
  await env.DB.prepare('UPDATE ml_group_copy_auto_settings SET lease_until=0 WHERE id=1 AND lease_until=?').bind(lease).run();
 }
}
