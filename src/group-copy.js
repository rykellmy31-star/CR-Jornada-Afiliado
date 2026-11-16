// Importação automática dos produtos de grupos WhatsApp AUTORIZADOS.
// Os parâmetros matt_word/matt_tool não representam geração oficial de ref ou garantia de comissão.
// Nunca reutiliza o link nem a etiqueta de quem compartilhou o anúncio.
import {ensureMonitor,monitorPriceDeepScanStats} from './whatsapp-link-monitor.js';
import {affiliateStoreState,previewAffiliateLink,parseMercadoLivreProduct} from './affiliate-stores.js';
import {getPrimaryCategory,categoryMatches} from './multichannel.js';
import {ensureLinkBatches,productId} from './link-batches.js';
import {officialCategoryStats} from './monitor-official-categories.js';
import {safePromotionTerms} from './promotion-terms.js';

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
// O anúncio já foi reconhecido pela captura do grupo. Mesmo assim,
// exigir que o ID no link original seja idêntico ao ID persistido no banco.
function checkedProductUrl(item){
 let source;
 try{source=new URL(item.source_url);}catch{throw fail('Link original inválido.');}
 if(productId(source.pathname)!==item.product_id)
   throw fail('O identificador do anúncio não corresponde ao produto reconhecido.');
 return source.href;
}
const SIX_HOURS=6*3600;
// Preços de grupos são anúncios de terceiros, nunca verificação do Mercado Livre.
// Abaixo de R$ 10,00 exigir revisão: evita importar parcelas, fretes ou cupons
// de baixo valor como se fossem preço do produto.
const MIN_GROUP_PRICE_CENTS=1000;
function positive(value){const n=Number(value);return Number.isSafeInteger(n)&&n>0&&n<=100_000_000;}
export function selectGroupCopyPrice(item,at){
 const siteAt=Number(item?.checked_at||0),site=Number(item?.price_cents);
 if(item?.site_status==='ok'&&positive(site)&&siteAt>=at-SIX_HOURS&&siteAt<=at)
  return {price:site,capturedAt:siteAt,source:'mercadolivre',
   terms:{price_cents:site,old_price_cents:null,price_source:'mercadolivre',
    payment_mode:'unspecified',installments:null,installment_cents:null,
    installments_no_interest:false,card_price_cents:null,
    coupon_required:false,coupon_code:null}};
 const groupAt=Number(item?.group_checked_at||0),price=Number(item?.group_price_cents);
 if(groupAt<at-SIX_HOURS||groupAt>at||!positive(price)||
  price<MIN_GROUP_PRICE_CENTS||!item?.message_id)return null;
 const original=safePromotionTerms(item.group_deal_json);
 // A cifra tem de vir da mesma oferta do grupo, nunca de um preço
 // inferido ou preço de parcela de outro produto.
 if(!original||Number(original.price_cents)!==price)return null;
 const old=positive(original.old_price_cents)&&original.old_price_cents>price?
  original.old_price_cents:null;
 return {price,capturedAt:groupAt,source:'grupo',
  terms:{...original,old_price_cents:old,price_source:'grupo'}};
}

export async function ensureGroupCopyAutomation(env){
 await env.DB.prepare(SETTINGS).run();
 await env.DB.prepare(HISTORY).run();
 await env.DB.prepare("INSERT OR IGNORE INTO ml_group_copy_auto_settings(id) VALUES(1)").run();
}
// Inspeção sem efeitos: explica POR QUE um anúncio com preço recente
// ainda não foi para a fila. Reutiliza os mesmos filtros do agendador.
export async function groupCopyEligibility(env,{now=null}={}){
 const at=Number.isSafeInteger(now)&&now>0?now:epoch();
 await ensureMonitor(env);await ensureLinkBatches(env);await ensureGroupCopyAutomation(env);
 const permitted=await getPrimaryCategory(env);
 // Um único acesso às credenciais do afiliado para todo o diagnóstico.
 // O importador real continua usando previewAffiliateLink com todas as regras.
 const account=await env.DB.prepare('SELECT label,tool_id FROM crj_affiliate_store_ml WHERE id=1').first();
 const items=(await env.DB.prepare(
  "SELECT l.product_id,l.message_id,l.title,l.source_url,l.category,l.status, "+
  "l.batch_id,i.id AS original_batch_item_id, "+
  "sp.price_cents,sp.checked_at,sp.status AS site_status, "+
  "m.last_seen_price_cents AS group_price_cents,m.last_seen_deal_json AS group_deal_json, "+
  "m.last_seen_at AS group_checked_at,COALESCE(m.last_queued_at,0) AS last_queued_at "+
  "FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id "+
  "LEFT JOIN ml_monitor_site_prices sp ON sp.product_id=l.product_id "+
  "LEFT JOIN ml_monitor_product_meta m ON m.product_id=l.product_id "+
  "LEFT JOIN ml_group_copy_auto_history h ON h.product_id=l.product_id "+
  "LEFT JOIN ml_link_batches b ON b.id=l.batch_id "+
  "LEFT JOIN ml_link_batch_items i ON i.batch_id=b.id AND i.source_url=l.source_url "+
  "WHERE l.category<>'Geral' AND l.classification<>'needs_review' "+
  "AND g.authorized=1 AND (g.enabled=1 OR EXISTS(SELECT 1 FROM ml_monitor_shortlinks already WHERE already.group_id=l.group_id AND already.message_id=l.message_id AND already.status='resolved')) AND h.product_id IS NULL "+
  "AND (l.status='available' OR (l.status='batched' AND b.status='awaiting_links' "+
  "AND i.status='awaiting_links' AND i.affiliate_url IS NULL AND i.offer_id IS NULL)) "+
  "ORDER BY l.id ASC LIMIT 120"
 ).all()).results.filter(item=>!!selectGroupCopyPrice(item,at));
 const blocked={};const examples=[];let ready=0;
 for(const item of items){
  let reason=null,description='';
  item.copyPrice=selectGroupCopyPrice(item,at);
  if(!categoryMatches(item.category,permitted)){
   reason='categoria_canal';description='O canal principal está restrito a "'+permitted+'"; o produto pertence à categoria "'+item.category+'".';
  }else if(item.last_queued_at&&at-item.last_queued_at<7*24*3600){
   reason='repetido_7_dias';description='Produto já utilizado nos últimos 7 dias.';
  }else if(item.title.length<5||item.title.length>180){
   reason='titulo_invalido';description='Título do produto fora do tamanho permitido.';
  }else if(!item.copyPrice){
   reason='preco_invalido';description='Preço público fora do intervalo permitido.';
  }else if(item.status==='batched'&&(!Number.isSafeInteger(Number(item.batch_id))||!Number.isSafeInteger(Number(item.original_batch_item_id)))){
   reason='lote_incompleto';description='O lote antigo não possui um item correspondente.';
  }else{
   try{
    if(!account)throw fail('Cadastre sua etiqueta em LOJAS.');
    const url=new URL(parseMercadoLivreProduct(checkedProductUrl(item)));
    url.searchParams.set('forceInApp','true');
    url.searchParams.set('matt_tool',account.tool_id);
    url.searchParams.set('matt_word',account.label);
    const duplicate=await env.DB.prepare('SELECT id FROM offers WHERE affiliate_url=? LIMIT 1').bind(url.toString()).first();
    if(duplicate){reason='duplicado';description='Este anúncio já consta da fila ou do histórico de ofertas.';}
   }catch(error){
    reason='link_incompativel';description='O link de origem não passou na validação: '+String(error?.message||error).slice(0,110);
   }
  }
  if(reason){
   blocked[reason]=(blocked[reason]||0)+1;
   if(examples.length<4)examples.push({product_id:item.product_id,title:String(item.title).slice(0,90),reason,description});
  }else ready++;
 }
 return {checked_with_price:items.length,with_group_price:items.filter(item=>
   selectGroupCopyPrice(item,at)?.source==='grupo').length,ready,blocked,examples,
   primary_category:permitted,sampled:items.length===120};
}
export async function groupCopyState(env){
 await ensureMonitor(env);await ensureGroupCopyAutomation(env);await ensureLinkBatches(env);
 const at=epoch();
 // Contar preços conhecidos do grupo, não apenas os retornados pelo site.
 // A interface antiga subtraía apenas os primeiros 120 itens avaliados e
 // mostrava dezenas de produtos como "sem preço" de forma enganosa.
 const siteRecent="(COALESCE(sp.status,'')='ok' AND COALESCE(sp.price_cents,0)>0 "+
  "AND COALESCE(sp.checked_at,0) BETWEEN unixepoch()-21600 AND unixepoch())";
 const groupRecent="(COALESCE(m.last_seen_price_cents,0)>=1000 "+
  "AND COALESCE(m.last_seen_at,0) BETWEEN unixepoch()-21600 AND unixepoch() "+
  "AND l.message_id<>'' AND json_valid(COALESCE(m.last_seen_deal_json,'')) "+
  "AND CAST(json_extract(CASE WHEN json_valid(COALESCE(m.last_seen_deal_json,'')) "+
  "THEN m.last_seen_deal_json ELSE '{}' END,'$.price_cents') AS INTEGER)=m.last_seen_price_cents)";
 const [row,monitor,groups,account,recent,waiting,readiness,official_categories,allCaptured,manualPending]=await Promise.all([
  env.DB.prepare('SELECT enabled,experimental_acknowledged,last_run_at,last_error,queued_count FROM ml_group_copy_auto_settings WHERE id=1').first(),
  env.DB.prepare('SELECT enabled FROM ml_monitor_settings WHERE id=1').first(),
  env.DB.prepare('SELECT COUNT(*) AS total FROM ml_monitor_groups WHERE enabled=1 AND authorized=1').first(),
  affiliateStoreState(env),
  env.DB.prepare('SELECT product_id,short_url,queued_at FROM ml_group_copy_auto_history ORDER BY queued_at DESC LIMIT 15').all(),
  env.DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id "+
    "LEFT JOIN ml_link_batches b ON b.id=l.batch_id "+
    "LEFT JOIN ml_link_batch_items i ON i.batch_id=b.id AND i.source_url=l.source_url "+
    "WHERE g.authorized=1 AND (g.enabled=1 OR EXISTS(SELECT 1 FROM ml_monitor_shortlinks already WHERE already.group_id=l.group_id AND already.message_id=l.message_id AND already.status='resolved')) AND (l.status='available' OR "+
    "(l.status='batched' AND b.status='awaiting_links' AND i.status='awaiting_links' AND i.affiliate_url IS NULL AND i.offer_id IS NULL))").first(),
  env.DB.prepare("SELECT "+
   "COALESCE(SUM(CASE WHEN l.category='Geral' OR l.classification='needs_review' THEN 1 ELSE 0 END),0) AS needs_category,"+
   "COALESCE(SUM(CASE WHEN l.category<>'Geral' AND l.classification<>'needs_review' "+
   "AND NOT ("+siteRecent+" OR "+groupRecent+") THEN 1 ELSE 0 END),0) AS needs_price,"+
   "COALESCE(SUM(CASE WHEN l.category<>'Geral' AND l.classification<>'needs_review' "+
   "AND sp.product_id IS NULL AND NOT "+groupRecent+" THEN 1 ELSE 0 END),0) AS price_never_checked,"+
   "COALESCE(SUM(CASE WHEN l.category<>'Geral' AND l.classification<>'needs_review' "+
   "AND sp.status='unavailable' AND NOT "+groupRecent+" THEN 1 ELSE 0 END),0) AS price_lookup_failed,"+
   "COALESCE(SUM(CASE WHEN l.category<>'Geral' AND l.classification<>'needs_review' "+
   "AND (("+siteRecent+") OR ("+groupRecent+")) THEN 1 ELSE 0 END),0) AS with_price,"+
   "COALESCE(SUM(CASE WHEN l.category<>'Geral' AND l.classification<>'needs_review' "+
   "AND NOT "+siteRecent+" AND "+groupRecent+" THEN 1 ELSE 0 END),0) AS with_group_price "+
   "FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id "+
   "LEFT JOIN ml_monitor_site_prices sp ON sp.product_id=l.product_id "+
   "LEFT JOIN ml_monitor_product_meta m ON m.product_id=l.product_id "+
   "LEFT JOIN ml_link_batches b ON b.id=l.batch_id "+
   "LEFT JOIN ml_link_batch_items i ON i.batch_id=b.id AND i.source_url=l.source_url "+
   "WHERE g.authorized=1 AND (g.enabled=1 OR EXISTS(SELECT 1 FROM ml_monitor_shortlinks already WHERE already.group_id=l.group_id AND already.message_id=l.message_id AND already.status='resolved')) AND (l.status='available' OR "+
   "(l.status='batched' AND b.status='awaiting_links' AND i.status='awaiting_links' AND i.affiliate_url IS NULL AND i.offer_id IS NULL))")
  .first(),
  officialCategoryStats(env),
  env.DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id WHERE g.authorized=1 AND (g.enabled=1 OR EXISTS(SELECT 1 FROM ml_monitor_shortlinks already WHERE already.group_id=l.group_id AND already.message_id=l.message_id AND already.status='resolved'))").first(),
  env.DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id "+
    "JOIN ml_link_batches b ON b.id=l.batch_id "+
    "JOIN ml_link_batch_items i ON i.batch_id=b.id AND i.source_url=l.source_url "+
    "WHERE g.authorized=1 AND (g.enabled=1 OR EXISTS(SELECT 1 FROM ml_monitor_shortlinks already WHERE already.group_id=l.group_id AND already.message_id=l.message_id AND already.status='resolved')) AND l.status='batched' AND b.status='awaiting_links' "+
    "AND i.status='awaiting_links' AND i.affiliate_url IS NULL AND i.offer_id IS NULL").first()
 ]);
 const eligibility=await groupCopyEligibility(env,{now:at});
 const price_search=await monitorPriceDeepScanStats(env);

 return {enabled:row?.enabled===1,experimental_acknowledged:row?.experimental_acknowledged===1,
  last_run_at:Number(row?.last_run_at||0),last_error:String(row?.last_error||''),
  queued_count:Number(row?.queued_count||0),monitor_enabled:monitor?.enabled===1,
  authorized_groups:Number(groups?.total||0),store_configured:account.mercadolivre.configured,
  label:account.mercadolivre.label||null,waiting:Number(waiting?.total||0),
  total_identified:Number(allCaptured?.total||0),
  awaiting_manual_batch:Number(manualPending?.total||0),
  readiness:{needs_category:Number(readiness?.needs_category||0),
   needs_price:Number(readiness?.needs_price||0),
   price_never_checked:Number(readiness?.price_never_checked||0),
   price_lookup_failed:Number(readiness?.price_lookup_failed||0),
   with_price:Number(readiness?.with_price||0),
   with_group_price:Number(readiness?.with_group_price||0)},
  official_categories:{...official_categories,waiting:Number(readiness?.needs_category||0)},
  eligibility,price_search,
  recent:(recent?.results||[]),commission_verified:false};
}
export async function saveGroupCopySettings(env,body){
 await ensureGroupCopyAutomation(env);
 if(typeof body?.enabled!=='boolean')throw fail('Informe se a importação automática está ligada ou desligada.');
 if(body.enabled){
  const state=await groupCopyState(env);
  if(!state.store_configured)throw fail('Cadastre antes sua etiqueta em LOJAS.');
  if(!state.monitor_enabled)throw fail('Ative a captura de grupos na aba COPIAR DE GRUPOS.');
  if(!state.authorized_groups)throw fail('Selecione ao menos um grupo autorizado para copiar produtos.');
 }
 await env.DB.prepare('UPDATE ml_group_copy_auto_settings SET enabled=?,experimental_acknowledged=?,updated_at=?,last_error=? WHERE id=1')
  .bind(Number(body.enabled),Number(body.enabled),epoch(),'').run();
 return {ok:true,...await groupCopyState(env)};
}
// Ação de teste explícita: importa no máximo uma oferta elegível para a fila,
// sem chamar APIs de envio nem alterar horários de publicação.
export async function testGroupCopyImport(env){
 const state=await groupCopyState(env);
 if(!state.enabled)throw fail('Ative e salve a importação automática antes de testar.');
 if(!state.monitor_enabled)throw fail('Ative o monitor de grupos para continuar o teste.');
 if(!state.store_configured||!state.authorized_groups)
  throw fail('Cadastre sua loja e escolha pelo menos um grupo autorizado.');
 const result=await runGroupCopyScheduled(env);
 const stateAfter=await groupCopyState(env);
 return {ok:!result.error,result,state:stateAfter,eligibility:stateAfter.eligibility};
}
function shortCode(){
 const bytes=crypto.getRandomValues(new Uint8Array(9));
 return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
// Um produto por reivindicação D1. O lote reaproveita esta operação, com a mesma
// proteção contra duplicação e sem tocar nos horários ou publicadores.
export async function runGroupCopyScheduled(env,{now=null,preferRecent=false}={}){
 if(!env?.DB)return {skipped:'database'};
 await ensureGroupCopyAutomation(env);
 const at=Number.isSafeInteger(now)&&now>0?now:epoch();
 const lease=at+180;
 const claimed=await env.DB.prepare('UPDATE ml_group_copy_auto_settings SET lease_until=? WHERE id=1 AND enabled=1 AND lease_until<=?')
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
   "SELECT l.id,l.group_id,l.message_id,l.product_id,l.title,l.category,l.source_url, "+
   "l.status AS source_status,l.batch_id AS source_batch_id,i.id AS original_batch_item_id, "+
   "sp.price_cents,sp.checked_at,sp.status AS site_status, "+
   "m.last_seen_price_cents AS group_price_cents,m.last_seen_deal_json AS group_deal_json, "+
   "m.last_seen_at AS group_checked_at,COALESCE(m.last_queued_at,0) AS last_queued_at "+
   "FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id "+
   "LEFT JOIN ml_monitor_site_prices sp ON sp.product_id=l.product_id "+
   "LEFT JOIN ml_monitor_product_meta m ON m.product_id=l.product_id "+
   "LEFT JOIN ml_group_copy_auto_history h ON h.product_id=l.product_id "+
   "LEFT JOIN ml_link_batches b ON b.id=l.batch_id "+
   "LEFT JOIN ml_link_batch_items i ON i.batch_id=b.id AND i.source_url=l.source_url "+
   "WHERE l.category<>'Geral' AND l.classification<>'needs_review' "+
   "AND g.authorized=1 AND (g.enabled=1 OR EXISTS(SELECT 1 FROM ml_monitor_shortlinks already WHERE already.group_id=l.group_id AND already.message_id=l.message_id AND already.status='resolved')) AND h.product_id IS NULL "+
   "AND (l.status='available' OR (l.status='batched' AND b.status='awaiting_links' "+
   "AND i.status='awaiting_links' AND i.affiliate_url IS NULL AND i.offer_id IS NULL)) "+
   "ORDER BY l.id "+(preferRecent?"DESC":"ASC")+" LIMIT 120"
  ).all()).results;
  let sawValidPrice=false;
  for(const item of rows){
   if(!categoryMatches(item.category,permitted))continue;
   if(item.last_queued_at&&at-item.last_queued_at<7*24*3600)continue;
   const priceInfo=selectGroupCopyPrice(item,at);
   if(!priceInfo)continue;
   sawValidPrice=true;
   const price=priceInfo.price;
   let preview;
   try{preview=await previewAffiliateLink(env,{product_url:checkedProductUrl(item)});}
   catch{continue;} // URLs não canônicas aguardam normalização/revisão, não inventamos IDs.
   if(item.title.length<5||item.title.length>180)continue;
   // Se o mesmo destino já entrou manualmente na fila, não republicar.
   const duplicate=await env.DB.prepare("SELECT id FROM offers WHERE affiliate_url=? LIMIT 1").bind(preview.target_url).first();
   if(duplicate)continue;
   const code=shortCode();
   const shortUrl='https://promoml.app/'+code;
   const fromManualBatch=item.source_status==='batched';
   const priorBatch=fromManualBatch?Number(item.source_batch_id):null;
   const priorItem=fromManualBatch?Number(item.original_batch_item_id):null;
   if(fromManualBatch&&(!Number.isSafeInteger(priorBatch)||!Number.isSafeInteger(priorItem)))continue;
   let offerId=null,batchId=null,createdBatchId=null;
   try{
    // O log único bloqueia a mesma oferta no próximo ciclo.
    await env.DB.prepare("INSERT INTO ml_group_copy_auto_history(product_id,group_id,offer_id,short_url,source_url,target_url,queued_at) VALUES(?,?,0,?,?,?,?)")
     .bind(item.product_id,item.group_id,shortUrl,item.source_url,preview.target_url,at).run();
    const created=await env.DB.prepare("INSERT INTO offers(title,affiliate_url,category,price_cents,old_price_cents,promo_terms_json,promo_captured_at,created_at,status) VALUES(?,?,?,?,?,?,?,?,'ready')")
     .bind(item.title,preview.target_url,item.category,price,priceInfo.terms.old_price_cents,
      JSON.stringify(priceInfo.terms),priceInfo.capturedAt,at).run();
    offerId=Number(created.meta?.last_row_id);
    if(!Number.isSafeInteger(offerId)||offerId<1)throw fail('O banco não retornou a oferta criada.');
    if(fromManualBatch){
      batchId=priorBatch; // Reutiliza o lote antigo. Não perde os itens ainda pendentes.
    }else{
      const createdBatch=await env.DB.prepare("INSERT INTO ml_link_batches(status,created_at,updated_at,imported_at) VALUES('imported',?,?,?)").bind(at,at,at).run();
      batchId=Number(createdBatch.meta?.last_row_id);
      createdBatchId=batchId;
    }
    const queueOperations=fromManualBatch?[
      // O lote gerado pela rotina antiga é convertido item a item; outros itens
      // aguardam preço sem serem apagados, devolvidos ou duplicados.
      env.DB.prepare("UPDATE ml_link_batch_items SET affiliate_url=?,offer_id=?,category=?,status='queued' "+
        "WHERE id=? AND batch_id=? AND status='awaiting_links' AND affiliate_url IS NULL AND offer_id IS NULL")
       .bind(preview.target_url,offerId,item.category,priorItem,priorBatch)
    ]:[
      env.DB.prepare("INSERT INTO ml_link_batch_items(batch_id,position,title,source_url,category,classification,affiliate_url,offer_id,status) VALUES(?,1,?,?,?,'selected',?,?,'queued')")
       .bind(batchId,item.title,item.source_url,item.category,preview.target_url,offerId),
      env.DB.prepare("UPDATE ml_monitor_links SET status='batched',batch_id=? WHERE id=? AND status='available'").bind(batchId,item.id)
    ];
    await env.DB.batch([
      ...queueOperations,
      env.DB.prepare("INSERT INTO crj_affiliate_shortlinks(code,product_url,target_url,label,created_at) VALUES(?,?,?,?,?)")
       .bind(code,preview.product_url,preview.target_url,preview.label,at),
      env.DB.prepare('UPDATE ml_group_copy_auto_history SET offer_id=? WHERE product_id=?').bind(offerId,item.product_id),
      env.DB.prepare('INSERT OR IGNORE INTO ml_monitor_product_meta(product_id,last_seen_at) VALUES(?,0)').bind(item.product_id),
      env.DB.prepare('UPDATE ml_monitor_product_meta SET last_queued_at=?,last_queued_price_cents=?,'+
         'pending_batch_id=NULL,pending_price_cents=NULL,pending_deal_json=NULL,pending_captured_at=NULL WHERE product_id=?')
       .bind(at,price,item.product_id),
      env.DB.prepare('UPDATE ml_group_copy_auto_settings SET queued_count=queued_count+1,last_run_at=?,last_error=? WHERE id=1').bind(at,'')
    ]);
    if(fromManualBatch){
      // Fecha apenas lotes cujos itens foram todos processados.
      await env.DB.prepare("UPDATE ml_link_batches SET status='imported',imported_at=?,updated_at=? "+
       "WHERE id=? AND status='awaiting_links' AND NOT EXISTS("+
       "SELECT 1 FROM ml_link_batch_items WHERE batch_id=? AND status='awaiting_links')")
       .bind(at,at,priorBatch,priorBatch).run();
    }
    return {queued:1,product_id:item.product_id,offer_id:offerId,short_url:shortUrl,commission_verified:false};
   }catch(error){
    // Retira artefatos parciais; a fila NUNCA recebe um anúncio sem link validado.
    if(createdBatchId)try{await env.DB.prepare('DELETE FROM ml_link_batches WHERE id=? AND status=?').bind(createdBatchId,'imported').run();}catch{}
    if(offerId)try{await env.DB.prepare("DELETE FROM offers WHERE id=? AND status='ready'").bind(offerId).run();}catch{}
    try{await env.DB.prepare('DELETE FROM ml_group_copy_auto_history WHERE product_id=? AND offer_id=0').bind(item.product_id).run();}catch{}
    throw error;
   }
  }
  await env.DB.prepare('UPDATE ml_group_copy_auto_settings SET last_run_at=?,last_error=? WHERE id=1').bind(at,'').run();
  return {skipped:sawValidPrice?'no_eligible_product':'awaiting_verified_price'};
 }catch(error){
  const message=String(error?.message||error).slice(0,160);
  await env.DB.prepare('UPDATE ml_group_copy_auto_settings SET last_run_at=?,last_error=? WHERE id=1').bind(at,message).run();
  return {error:message};
 }finally{
  await env.DB.prepare('UPDATE ml_group_copy_auto_settings SET lease_until=0 WHERE id=1 AND lease_until=?').bind(lease).run();
 }
}


/**
 * Processa itens prontos sem aguardar o próximo minuto do Cron.
 * Usa a reivindicação exclusiva já existente em runGroupCopyScheduled,
 * logo webhook e Cron simultâneos não produzem dois envios da mesma oferta.
 */
export async function runGroupCopyBatch(env,{limit=4,now=null,preferRecent=false}={}){
 const cap=Math.min(6,Math.max(1,Number.isInteger(limit)?limit:4));
 const results=[],at=Number.isSafeInteger(now)&&now>0?now:epoch();
 for(let i=0;i<cap;i++){
  const outcome=await runGroupCopyScheduled(env,{now:at,preferRecent});
  results.push(outcome);
  if(outcome?.queued!==1)break;
 }
 return {queued:results.filter(x=>x?.queued===1).length,
   products:results.filter(x=>x?.queued===1).map(x=>x.product_id),
   last:results[results.length-1],commission_verified:false};
}
/** Leitura leve para o painel ao vivo; NÃO faz consultas externas,
 * classificações, conversões ou alterações de status. */
export async function groupCopyLiveState(env){
 await ensureGroupCopyAutomation(env);
 const [settings,diagnostics,counts]=await Promise.all([
  env.DB.prepare('SELECT enabled,queued_count,last_run_at,last_error FROM ml_group_copy_auto_settings WHERE id=1').first(),
  env.DB.prepare('SELECT last_event_at FROM ml_monitor_diagnostics WHERE id=1').first(),
  env.DB.prepare("SELECT COUNT(*) AS total,"+
   "COALESCE(SUM(CASE WHEN l.status='available' OR (l.status='batched' AND b.status='awaiting_links') THEN 1 ELSE 0 END),0) AS waiting,"+
   "COALESCE(SUM(CASE WHEN l.status='batched' AND b.status='imported' THEN 1 ELSE 0 END),0) AS imported "+
   "FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id "+
   "LEFT JOIN ml_link_batches b ON b.id=l.batch_id WHERE g.authorized=1 AND (g.enabled=1 OR EXISTS(SELECT 1 FROM ml_monitor_shortlinks already WHERE already.group_id=l.group_id AND already.message_id=l.message_id AND already.status='resolved'))").first()
 ]);
 return {enabled:!!settings?.enabled,total_identified:Number(counts?.total||0),
  waiting:Number(counts?.waiting||0),imported:Number(counts?.imported||0),
  queued_count:Number(settings?.queued_count||0),last_run_at:Number(settings?.last_run_at||0),
  last_event_at:Number(diagnostics?.last_event_at||0),
  last_error:String(settings?.last_error||'')};
}
