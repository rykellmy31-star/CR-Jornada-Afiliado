import {classifyProduct,ensureAutomationCenter} from './automation-center.js';
import {createLinkBatch,productId,validateSourceUrl,ensureLinkBatches} from './link-batches.js';
import {listWhatsAppGroups,evolutionOrigin} from './whatsapp.js';
import {canRequeueProduct} from './monitor-repeat-policy.js';
import {extractPromotionTerms,promotionDescription} from './promotion-terms.js';
import {fetchMercadoLivrePrice,fetchMercadoLivrePublicPrice,extractFeaturedShowcasePrice} from './mercado-livre-price.js';
import {monitorWebhookReady} from './monitor-webhook-setup.js';

const SCHEMA=[
 "CREATE TABLE IF NOT EXISTS ml_monitor_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)",
 "INSERT OR IGNORE INTO ml_monitor_settings(id,enabled,updated_at) VALUES(1,0,0)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_groups(id INTEGER PRIMARY KEY AUTOINCREMENT,instance_name TEXT NOT NULL,group_jid TEXT NOT NULL,group_name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,authorized INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,UNIQUE(instance_name,group_jid))",
 "CREATE TABLE IF NOT EXISTS ml_monitor_links(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL REFERENCES ml_monitor_groups(id),message_id TEXT NOT NULL DEFAULT '',product_id TEXT NOT NULL UNIQUE,source_url TEXT NOT NULL,title TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'Geral',classification TEXT NOT NULL DEFAULT 'needs_review',status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','batched')),batch_id INTEGER,created_at INTEGER NOT NULL)",
 "CREATE INDEX IF NOT EXISTS idx_ml_monitor_links_queue ON ml_monitor_links(status,category,id)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_shortlinks(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL REFERENCES ml_monitor_groups(id),message_id TEXT NOT NULL DEFAULT '',short_url TEXT NOT NULL UNIQUE,message_hint TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','review','resolved')),tries INTEGER NOT NULL DEFAULT 0,reason TEXT,created_at INTEGER NOT NULL)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_diagnostics(id INTEGER PRIMARY KEY CHECK(id=1),events_received INTEGER NOT NULL DEFAULT 0,events_while_off INTEGER NOT NULL DEFAULT 0,messages_with_links INTEGER NOT NULL DEFAULT 0,authorized_messages INTEGER NOT NULL DEFAULT 0,links_recognized INTEGER NOT NULL DEFAULT 0,last_event_at INTEGER,last_authorized_at INTEGER,last_link_at INTEGER)",
 "INSERT OR IGNORE INTO ml_monitor_diagnostics(id) VALUES(1)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_url_observations(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL REFERENCES ml_monitor_groups(id),domain TEXT NOT NULL,reason TEXT NOT NULL,message_format TEXT NOT NULL,created_at INTEGER NOT NULL)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_group_delivery(group_id INTEGER PRIMARY KEY REFERENCES ml_monitor_groups(id),received_messages INTEGER NOT NULL DEFAULT 0,with_urls INTEGER NOT NULL DEFAULT 0,last_received_at INTEGER,last_format TEXT NOT NULL DEFAULT 'desconhecido')",
 "CREATE TABLE IF NOT EXISTS ml_monitor_discard_reasons(reason TEXT PRIMARY KEY,occurrences INTEGER NOT NULL DEFAULT 0,last_at INTEGER)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_price_recovery(product_id TEXT PRIMARY KEY,last_attempt_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_site_prices(product_id TEXT PRIMARY KEY,price_cents INTEGER,status TEXT NOT NULL DEFAULT 'unavailable' CHECK(status IN ('ok','unavailable')),checked_at INTEGER NOT NULL DEFAULT 0,tries INTEGER NOT NULL DEFAULT 0,method TEXT NOT NULL DEFAULT '')",
 "CREATE TABLE IF NOT EXISTS ml_monitor_retry_schedule(shortlink_id INTEGER PRIMARY KEY REFERENCES ml_monitor_shortlinks(id),next_retry_at INTEGER NOT NULL DEFAULT 0,last_attempt_at INTEGER NOT NULL DEFAULT 0,auto_attempts INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0)",
 "CREATE INDEX IF NOT EXISTS idx_ml_monitor_retry_due ON ml_monitor_retry_schedule(next_retry_at,lease_until)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_browser_budget(id INTEGER PRIMARY KEY CHECK(id=1),day_key TEXT NOT NULL DEFAULT '',daily_count INTEGER NOT NULL DEFAULT 0,last_at INTEGER NOT NULL DEFAULT 0)",
 "INSERT OR IGNORE INTO ml_monitor_browser_budget(id) VALUES(1)",
 // Cupons comprovados ficam fora da fila de produtos, mas preservamos o motivo
 // e a origem para auditoria, sem reprocessar o mesmo encurtador indefinidamente.
 "CREATE TABLE IF NOT EXISTS ml_monitor_ignored_links(short_url TEXT PRIMARY KEY,group_id INTEGER NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_worker_heartbeat(id INTEGER PRIMARY KEY CHECK(id=1),last_run_at INTEGER NOT NULL DEFAULT 0,last_reviewed INTEGER NOT NULL DEFAULT 0,last_resolved INTEGER NOT NULL DEFAULT 0,last_ignored INTEGER NOT NULL DEFAULT 0)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_browser_attempts(shortlink_id INTEGER PRIMARY KEY REFERENCES ml_monitor_shortlinks(id),last_attempt_at INTEGER NOT NULL DEFAULT 0)",
 "INSERT OR IGNORE INTO ml_monitor_worker_heartbeat(id) VALUES(1)"

];
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const epoch=()=>Math.floor(Date.now()/1000);
const GROUP=/^\d{6,30}(?:-\d{6,20})?@g\.us$/;
const INSTANCE=/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/;
const HOSTS=new Set(['www.mercadolivre.com.br','mercadolivre.com.br','produto.mercadolivre.com.br']);
const SHORT_HOSTS=new Set(['meli.la','melila.me','meli.promo']); // Domínios apenas de entrada; nunca reutilizar comissão alheia.
// Domínios usados como passagem em redirecionamentos do próprio Mercado Livre.
// Apenas as URLs brasileiras oficiais com MLB/MLBU viram produto captado.
const REDIRECT_HOSTS=new Set([...HOSTS,'m.mercadolivre.com.br','mercadolivre.com','www.mercadolivre.com']);

function couponLandingUrl(value){
 let u;try{u=new URL(value);}catch{return false;}
 const host=u.hostname.toLowerCase(),path=decodeURIComponent(u.pathname).toLowerCase();
 // Só páginas oficiais do Mercado Livre. Promoção de UM produto com cupom
 // não é um catálogo de cupons e deve continuar na fila de produtos.
 if(!REDIRECT_HOSTS.has(host))return false;
 return /(?:^|\/)(?:cupons?|coupons?|coupon-center|central-de-cupons|cupons-de-desconto)(?:\/|$)/i.test(path);
}
function couponOnlyAnnouncement(message){
 const value=String(message||'').replace(/[\u{1F300}-\u{1FAFF}]/gu,' ')
  .replace(/\s+/g,' ').trim().toLocaleLowerCase('pt-BR');
 if(value.length<8||value.length>220)return false;
 // Não descartar uma oferta de produto apenas porque oferece cupom de desconto.
 if(/(?:produto|kit |conjunto|perfume|celular|ferramenta|tênis|tenis|frete grátis|frete gratis|por r\$|de r\$|com cupom)/i.test(value))return false;
 return /^(?:(?:atenção|atencao|urgente|imperdível|imperdivel)\s*[:! -]\s*)?(?:cup(?:om|ons)\s+(?:liberad[oa]s?|dispon[ií]ve(?:l|is)|de desconto|exclusiv[oa]s?|para compras)|resgate(?:m)?\s+(?:o\s+)?cupom|aproveite\s+(?:o\s+)?cupom|cupom\s+[a-z0-9]{4,}\s+(?:liberado|disponível))\b/i.test(value);
}
export function monitorCouponOnly(hint,destination){
 return couponLandingUrl(destination)||couponOnlyAnnouncement(hint);
}
async function ignoreMonitorCoupon(env,item,at,reason='Link de cupom, não é produto individual'){
 // A tabela existente mantém CHECK sem status ignored; não a alteramos.
 // Registra o descarte e retira a pendência sem apagar ofertas ou grupos.
 await env.DB.prepare('INSERT OR IGNORE INTO ml_monitor_ignored_links(short_url,group_id,reason,created_at) VALUES(?,?,?,?)')
  .bind(item.short_url,item.group_id,reason,at).run();
 await env.DB.prepare('DELETE FROM ml_monitor_retry_schedule WHERE shortlink_id=?').bind(item.id).run();
 await env.DB.prepare('DELETE FROM ml_monitor_browser_attempts WHERE shortlink_id=?').bind(item.id).run();
 await env.DB.prepare("DELETE FROM ml_monitor_shortlinks WHERE id=? AND status IN ('pending','review')").bind(item.id).run();
}

export async function ensureMonitor(env){for(const query of SCHEMA)await env.DB.prepare(query).run();await ensureLinkBatches(env);}
export function extractUrls(text){
 if(typeof text!=='string')return [];
 // Normaliza artefatos de encaminhamento sem alterar o destino do link.
 const normalized=text.slice(0,16000)
  .replace(/[\u200b-\u200d\u2060\ufeff]/g,'')
  .replace(/(https?:\/\/(?:melila\.me|meli\.la|meli\.promo\/s)\/)[\t \r\n]+(?=[A-Za-z0-9_-]{5,50}(?:\b|\/|[?#]|$))/gi,'$1')
  .replace(/(https?:\/\/(?:www\.|produto\.)?mercadolivre\.com\.br\/)[\t \r\n]+(?=[A-Za-z0-9_-]{5,})/gi,'$1');
 // Aceita URL absoluta ou domínio conhecido sem protocolo. A validação do
 // candidato continua restrita ao Mercado Livre e a encurtadores configurados.
 const pattern=/(?:https?:\/\/|www\.|(?:meli\.la|melila\.me|meli\.promo\/s|(?:produto\.)?mercadolivre\.com\.br)\/)[^\s<>"'()[\]{}]+/gi;
 const urls=[];
 for(const match of normalized.matchAll(pattern)){
  let url=match[0].replace(/[.,;!?]+$/g,'');
  if(!/^https?:\/\//i.test(url))url='https://'+url;
  if(!urls.includes(url))urls.push(url);
  if(urls.length>=30)break;
 }
 return urls;
}
// Lê apenas texto da mensagem recebida, sem procurar em contatos, citações,
// previews com URL de terceiros ou dados de mídia (imagem, thumb, base64).
function extractMessageText(message,entry=null){
 const values=[],seen=new Set(),visited=new Set();
 const nested=['message','ephemeralMessage','viewOnceMessage','viewOnceMessageV2',
  'viewOnceMessageV2Extension','documentWithCaptionMessage','editedMessage','imageMessage',
  'videoMessage','documentMessage','extendedTextMessage','buttonsResponseMessage',
  'interactiveMessage','textMessage','mediaMessage','content','body','messageContent',
  'captionMessage','templateMessage','hydratedTemplate','hydratedFourRowTemplate',
  'listMessage','buttonsMessage','highlyStructuredMessage','productMessage','messageContextInfo'];
 const fields=['conversation','text','caption','body','selectedDisplayText','messageText',
  'contentText','description','title','footerText','hydratedContentText','hydratedFooterText'];
 let format='outro',nodeCount=0;
 function collect(value,label){
  if(typeof value!=='string'||!value.trim()||seen.has(value))return;
  seen.add(value);values.push(value.slice(0,16000));
  if(format==='outro')format=label;
 }
 function walk(node,label,depth){
  if(depth>9||nodeCount++>120||!node||typeof node!=='object'||Array.isArray(node)||visited.has(node))return;
  visited.add(node);
  for(const field of fields){
   const value=node[field];
   if(typeof value==='string')collect(value,label==='outro'?field:label);
   // Ex.: interactiveMessage.body.text.
   if(field==='body'&&value&&typeof value==='object'&&!Array.isArray(value))
    walk(value,label==='outro'?'body':label,depth+1);
  }
  for(const field of nested){
   const child=node[field];
   if((field==='content'||field==='message')&&typeof child==='string')collect(child,label==='outro'?field:label);
   else if(child&&typeof child==='object')walk(child,['message','content','messageContent'].includes(field)?label:field,depth+1);
  }
 }
 walk(message,'outro',0);
 if(entry&&entry!==message){
  // Campos textuais superiores retornados por alguns adaptadores da Evolution.
  for(const key of ['text','caption','body','messageText'])collect(entry[key],'outro'===format?key:format);
  // Não varrer metadata inteira nem mensagens citadas.
 }
 return {text:values.join('\n').slice(0,16000),format};
}
export function parseMonitorEvent(event,{includeNoLinks=false}={}){
 if(!event||typeof event!=='object'||!['messages.upsert','MESSAGES_UPSERT','messages-upsert'].includes(event.event))return [];
 const instance=typeof event.instance==='string'?event.instance:'';
 if(!INSTANCE.test(instance))return [];
 const input=Array.isArray(event.data)?event.data:Array.isArray(event.data?.messages)?event.data.messages:[event.data];
 const result=[];
 for(const entry of input.slice(0,25)){
  if(!entry||entry.key?.fromMe!==false||typeof entry.key.remoteJid!=='string'||!GROUP.test(entry.key.remoteJid))continue;
  const {text,format}=extractMessageText(entry.message||{},entry);
  const urls=extractUrls(text);
  if(!urls.length&&!includeNoLinks)continue;
  const hint=text.replace(/https?:\/\/[^\s<>"'()[\]{}]+/gi,'').replace(/\s+/g,' ').trim().slice(0,800);
  result.push({instance,group_jid:entry.key.remoteJid,message_id:String(entry.key.id||'').slice(0,150),hint,urls,format});
 }
 return result;
}
function urlCandidate(input){
 let u;try{u=new URL(input);}catch{return null;}
 if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
 if(SHORT_HOSTS.has(u.hostname.toLowerCase())&&
     (u.hostname.toLowerCase()==='meli.promo'
       ? /^\/s\/[A-Za-z0-9_-]{5,50}\/?$/.test(u.pathname)
       : /^\/[A-Za-z0-9_-]{5,50}\/?$/.test(u.pathname))){
   u.search='';u.hash='';return {kind:'short',url:u.href};
 }
 // A vitrine social oficial enviada diretamente por outra pessoa também é fonte.
 // O ref de terceiro NÃO é reaproveitado: somente identificamos o produto destacado.
 if(HOSTS.has(u.hostname.toLowerCase()) && /^\/social\/[A-Za-z0-9_-]{3,80}\/?$/.test(u.pathname) && u.searchParams.has('ref')){
   u.hash='';return {kind:'short',url:u.href};
 }
 if(!HOSTS.has(u.hostname.toLowerCase()))return null;
 try{
   const source_url=validateSourceUrl(u.href);
   const id=productId(u.pathname);
   u=new URL(source_url);
   // Remova parâmetros de rastreamento/afiliação de terceiros; copie apenas o endereço normal.
   const original_url=u.origin+u.pathname;
   return {kind:'product',url:original_url,product_id:id};
 }catch{return null;}
}
function productTitle(url,hint,id){
 const path=new URL(url).pathname;
 let slug=path.split('/').filter(Boolean).find(x=>x.includes('-')&&!/^MLBU?[-_]?\d/i.test(x))||'';
 slug=slug.replace(/-?p-?MLBU?[-_]?\d+.*/i,'').replace(/MLBU?[-_]?\d+/gi,'').replace(/-?JM$/i,'').replace(/[-_]+/g,' ').trim();
 if(slug.length>=5)return slug.slice(0,180);
 const clean=hint.replace(/https:\/\/[^\s]+/gi,'').replace(/[|]/g,' ').replace(/\s+/g,' ').trim();
 return clean.length>=5?clean.slice(0,130):'Produto Mercado Livre '+id;
}
// Recupera somente preços ausentes de produtos ainda disponíveis.
// Usa primeiro a legenda já guardada, e depois (em agendamento) consulta
// apenas a mensagem original na instância e grupo autorizados. Não publica nada.
export async function recoverMissingMonitorPrices(env,{allowEvolution=false}={}){
 await ensureMonitor(env);
 const now=epoch();
 const query=`SELECT l.product_id,l.message_id,l.group_id,l.created_at,g.instance_name,g.group_jid,
   m.last_seen_at,
   (SELECT s.message_hint FROM ml_monitor_shortlinks s
    WHERE s.group_id=l.group_id AND s.message_id=l.message_id AND s.status='resolved'
    ORDER BY s.created_at DESC LIMIT 1) AS saved_hint
   FROM ml_monitor_links l
   JOIN ml_monitor_groups g ON g.id=l.group_id
   JOIN ml_monitor_product_meta m ON m.product_id=l.product_id
   LEFT JOIN ml_monitor_price_recovery r ON r.product_id=l.product_id
   WHERE l.status='available' AND l.created_at>=?
     AND g.enabled=1 AND g.authorized=1 AND m.last_seen_price_cents IS NULL
     AND m.last_seen_at<=l.created_at+5
     AND (r.product_id IS NULL OR (r.attempts<3 AND r.last_attempt_at<=?))
   ORDER BY l.created_at DESC LIMIT ?`;
 const records=(await env.DB.prepare(query).bind(now-2*86400,now-900,allowEvolution?3:10).all()).results;
 let recovered=0,attempted=0;
 for(const row of records){
  let terms=extractPromotionTerms(row.saved_hint||'');
  if(!(Number.isSafeInteger(terms?.price_cents)&&terms.price_cents>0)&&allowEvolution){
   attempted++;
   const msg=await recoverCaptionFromEvolution(env,{instance:row.instance_name,
    group_jid:row.group_jid,message_id:row.message_id,urls:[],hint:''});
   if(msg)terms=extractPromotionTerms(msg.hint);
  }
  if(Number.isSafeInteger(terms?.price_cents)&&terms.price_cents>0){
   const result=await env.DB.prepare(
    "UPDATE ml_monitor_product_meta SET last_seen_price_cents=?,last_seen_deal_json=? WHERE product_id=? AND last_seen_price_cents IS NULL AND last_seen_at<=?"
   ).bind(terms.price_cents,JSON.stringify(terms),row.product_id,row.created_at+5).run();
   if(result.meta?.changes===1)recovered++;
  }else if(allowEvolution){
   await env.DB.prepare("INSERT INTO ml_monitor_price_recovery(product_id,last_attempt_at,attempts) VALUES(?,?,1) ON CONFLICT(product_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,attempts=attempts+1").bind(row.product_id,now).run();
  }
 }
 return {recovered,attempted};
}
// Consulta o preço público do anúncio validado sem modificar a condição do grupo.
// Executado após a confirmação dos links, via agendador, também para URLs diretas.
// Preço observado no cartão principal de uma vitrine oficial, somente se a
// extração tiver confirmado produto único e ID exato. Não altera comissão.
async function persistFeaturedMonitorPrice(env,productId,featured,at=epoch()){
 if(!/^MLBU?\d{6,}$/.test(String(productId||''))||
  !Number.isSafeInteger(featured?.price_cents)||featured.price_cents<=0||
  featured.price_cents>100_000_000)return false;
 await env.DB.prepare(
  "INSERT INTO ml_monitor_site_prices(product_id,price_cents,status,checked_at,tries,method) VALUES(?,?,'ok',?,0,?) "+
  "ON CONFLICT(product_id) DO UPDATE SET price_cents=excluded.price_cents,status='ok',checked_at=excluded.checked_at,tries=0,method=excluded.method "+
  "WHERE ml_monitor_site_prices.checked_at<=excluded.checked_at"
 ).bind(productId,featured.price_cents,at,'vitrine oficial do produto principal').run();
 return true;
}
export async function refreshMonitorSitePrices(env,{fetcher=fetch,limit=3,forceRetry=false}={}){
 await ensureMonitor(env);
 const now=epoch();
 const cap=Math.max(1,Math.min(5,Number.isSafeInteger(limit)?limit:3));
 const rows=(await env.DB.prepare(
  "SELECT l.product_id,l.source_url,"+
  "(SELECT s.short_url FROM ml_monitor_shortlinks s "+
  "WHERE s.group_id=l.group_id AND s.message_id=l.message_id "+
  "AND s.status='resolved' ORDER BY s.id DESC LIMIT 1) AS source_short_url "+
  "FROM ml_monitor_links l "+
  "JOIN ml_monitor_groups g ON g.id=l.group_id "+
  "LEFT JOIN ml_monitor_site_prices sp ON sp.product_id=l.product_id "+
  "LEFT JOIN ml_link_batches b ON b.id=l.batch_id "+
  "LEFT JOIN ml_link_batch_items i ON i.batch_id=b.id AND i.source_url=l.source_url "+
  "WHERE g.enabled=1 AND g.authorized=1 AND "+
  "(l.status='available' OR (l.status='batched' AND b.status='awaiting_links' "+
  "AND i.status='awaiting_links' AND i.affiliate_url IS NULL AND i.offer_id IS NULL)) "+
  "AND (sp.product_id IS NULL "+
  "OR (sp.status='ok' AND sp.checked_at<=?) "+
  "OR (sp.status='unavailable' AND (sp.checked_at<=?-(CASE WHEN sp.tries<=1 THEN 900 WHEN sp.tries=2 THEN 3600 ELSE 21600 END) "+
  "OR (?=1 AND sp.checked_at<=?-90)))) "+
  "ORDER BY (sp.product_id IS NULL) DESC,COALESCE(sp.checked_at,0) ASC,l.created_at DESC LIMIT ?"
 ).bind(now-21600,now,Number(forceRetry===true),now,cap).all()).results;
 let checked=0,found=0;
 for(const item of rows){
  let site=null;
  try{site=await fetchMercadoLivrePrice(item.source_url,fetcher);}
  catch{/* Página bloqueada ou indisponível: tente a API pública oficial. */}
  if(!(Number.isSafeInteger(site?.price_cents)&&site.price_cents>0)){
    try{site=await fetchMercadoLivrePublicPrice(item.source_url,fetcher);}
    catch{/* O ML pode exigir autenticação para alguns anúncios. Nunca inventar preço. */}
  }
  // Fallback: alguns links copiados vêm de vitrines /social oficiais que
  // mostram o valor atualizado no cartão destacado, ainda que a página do
  // anúncio e a API pública estejam bloqueadas.
  // A extração exige o MESMO produto_id da oferta, jamais o primeiro
  // recomendado e jamais um preço oriundo de outro encurtador.
  if(!(Number.isSafeInteger(site?.price_cents)&&site.price_cents>0)&&item.source_short_url){
    try{
      const inspected=await inspectMonitorShortlink(item.source_short_url,{fetcher});
      const featured=inspected?.featured_price;
      if(inspected?.kind==='featured_product'&&
       inspected.product?.product_id===item.product_id&&
       Number.isSafeInteger(featured?.price_cents)&&featured.price_cents>0){
        site={...featured,source:'vitrine oficial do produto principal confirmado'};
      }
    }catch{/* Vitrine pública indisponível: manter oferta pendente. */}
  }
  const valid=Number.isSafeInteger(site?.price_cents)&&site.price_cents>0;
  await env.DB.prepare(
   "INSERT INTO ml_monitor_site_prices(product_id,price_cents,status,checked_at,tries,method) VALUES(?,?,?,?,?,?) "+
   "ON CONFLICT(product_id) DO UPDATE SET "+
   "price_cents=CASE WHEN excluded.status='ok' THEN excluded.price_cents ELSE ml_monitor_site_prices.price_cents END,"+
   "status=excluded.status,checked_at=excluded.checked_at,"+
   "tries=CASE WHEN excluded.status='ok' THEN 0 ELSE MIN(ml_monitor_site_prices.tries+1,3) END,method=excluded.method"
  ).bind(item.product_id,valid?site.price_cents:null,valid?'ok':'unavailable',epoch(),valid?0:1,valid?site.source:'').run();
  checked++;if(valid)found++;
 }
 return {checked,found};
}
export async function monitorState(env){
 await ensureMonitor(env);
 await recoverMissingMonitorPrices(env);
 const [settings,groups,links,pending,categories,counts,perGroup,diagnostics,latestShortlinks,observations,delivery,rejected,retryProgress,ignoredCoupons,workerHeartbeat,browserUsage]=await Promise.all([
  env.DB.prepare('SELECT enabled,updated_at FROM ml_monitor_settings WHERE id=1').first(),
  env.DB.prepare('SELECT id,instance_name,group_jid,group_name,enabled,created_at FROM ml_monitor_groups ORDER BY id DESC LIMIT 100').all(),
  env.DB.prepare("SELECT l.id,l.product_id,l.title,l.source_url,l.category,l.classification,l.status,l.created_at,g.group_name,m.last_seen_price_cents,m.last_seen_deal_json,m.last_queued_at,sp.price_cents AS site_price_cents,sp.status AS site_status,sp.checked_at AS site_checked_at FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id LEFT JOIN ml_monitor_product_meta m ON m.product_id=l.product_id LEFT JOIN ml_monitor_site_prices sp ON sp.product_id=l.product_id ORDER BY l.id DESC LIMIT 200").all(),
  env.DB.prepare("SELECT status,COUNT(*) AS total FROM ml_monitor_shortlinks GROUP BY status").all(),
  (async()=>{await ensureAutomationCenter(env);return env.DB.prepare('SELECT name FROM affiliate_group_categories WHERE enabled=1 ORDER BY name').all()})(),
  env.DB.prepare("SELECT COUNT(l.id) AS captured,COALESCE(SUM(CASE WHEN l.status='available' THEN 1 ELSE 0 END),0) AS available,COALESCE(SUM(CASE WHEN l.status='batched' AND b.status='awaiting_links' THEN 1 ELSE 0 END),0) AS in_conversion,COALESCE(SUM(CASE WHEN l.status='batched' AND b.status='imported' THEN 1 ELSE 0 END),0) AS queued FROM ml_monitor_links l LEFT JOIN ml_link_batches b ON b.id=l.batch_id").first(),
  env.DB.prepare("SELECT l.group_id,COUNT(*) AS captured,COALESCE(SUM(CASE WHEN l.status='available' THEN 1 ELSE 0 END),0) AS available,COALESCE(SUM(CASE WHEN l.status='batched' AND b.status='awaiting_links' THEN 1 ELSE 0 END),0) AS in_conversion,COALESCE(SUM(CASE WHEN l.status='batched' AND b.status='imported' THEN 1 ELSE 0 END),0) AS queued FROM ml_monitor_links l LEFT JOIN ml_link_batches b ON b.id=l.batch_id GROUP BY l.group_id").all(),
  env.DB.prepare("SELECT events_received,events_while_off,messages_with_links,authorized_messages,links_recognized,last_event_at,last_authorized_at,last_link_at FROM ml_monitor_diagnostics WHERE id=1").first(),
  env.DB.prepare("SELECT s.id,s.short_url,s.status,s.reason,s.tries,s.created_at,g.group_name,rs.next_retry_at,rs.auto_attempts FROM ml_monitor_shortlinks s JOIN ml_monitor_groups g ON g.id=s.group_id LEFT JOIN ml_monitor_retry_schedule rs ON rs.shortlink_id=s.id WHERE s.status IN ('pending','review') ORDER BY CASE WHEN s.status='review' THEN 0 ELSE 1 END, s.id DESC LIMIT 200").all(),
  env.DB.prepare("SELECT o.domain,o.reason,o.message_format,o.created_at,g.group_name FROM ml_monitor_url_observations o JOIN ml_monitor_groups g ON g.id=o.group_id ORDER BY o.id DESC LIMIT 12").all(),
  env.DB.prepare("SELECT group_id,received_messages,with_urls,last_received_at,last_format FROM ml_monitor_group_delivery").all(),
  env.DB.prepare("SELECT reason,occurrences,last_at FROM ml_monitor_discard_reasons ORDER BY occurrences DESC LIMIT 8").all(),
  // O status 'review' reúne causas diferentes. Separa pendências automáticas
  // de destinos externos e mostra a última tentativa, inclusive com grupo pausado.
  env.DB.prepare(
   "SELECT COUNT(*) AS total, "+
   "SUM(CASE WHEN "+ 
   "(s.reason IS NULL OR s.reason='Destino fora dos domínios permitidos do Mercado Livre' OR "+
   "(s.reason NOT LIKE 'Redirecionamento para domínio não verificado%' AND "+
   "s.reason NOT LIKE 'Redirecionamento circular%' AND "+
   "s.reason NOT LIKE 'Produto associado por confirmação manual%')) "+
   "AND g.authorized=1 THEN 1 ELSE 0 END) AS automatic, "+
   "SUM(CASE WHEN (s.reason LIKE 'Redirecionamento para domínio não verificado%' OR "+
   "s.reason LIKE 'Redirecionamento circular%') THEN 1 ELSE 0 END) AS manual, "+
   "MAX(COALESCE(rs.last_attempt_at,0)) AS last_attempt_at, "+
   "MIN(CASE WHEN g.authorized=1 AND rs.next_retry_at>unixepoch() AND "+
   "(s.reason IS NULL OR s.reason='Destino fora dos domínios permitidos do Mercado Livre' OR "+
   "(s.reason NOT LIKE 'Redirecionamento para domínio não verificado%' AND "+
   "s.reason NOT LIKE 'Redirecionamento circular%' AND "+
   "s.reason NOT LIKE 'Produto associado por confirmação manual%')) "+
   "THEN rs.next_retry_at ELSE NULL END) AS next_retry_at, "+
   "SUM(CASE WHEN g.enabled=0 AND g.authorized=1 THEN 1 ELSE 0 END) AS from_paused_groups "+
   "FROM ml_monitor_shortlinks s JOIN ml_monitor_groups g ON g.id=s.group_id "+
   "LEFT JOIN ml_monitor_retry_schedule rs ON rs.shortlink_id=s.id "+
   "WHERE s.status='review'"
  ).first(),
  env.DB.prepare('SELECT COUNT(*) AS total FROM ml_monitor_ignored_links').first(),
  env.DB.prepare('SELECT last_run_at,last_reviewed,last_resolved,last_ignored FROM ml_monitor_worker_heartbeat WHERE id=1').first(),
  env.DB.prepare('SELECT day_key,daily_count,last_at FROM ml_monitor_browser_budget WHERE id=1').first()
 ]);
 const normalizedCounts=x=>({
  captured:Number(x?.captured||0),
  available:Number(x?.available||0),
  in_conversion:Number(x?.in_conversion||0),
  queued:Number(x?.queued||0)
 });
 const perGroupMap=new Map(perGroup.results.map(x=>[x.group_id,normalizedCounts(x)]));
 const deliveryMap=new Map(delivery.results.map(x=>[x.group_id,x]));
 return {enabled:!!settings?.enabled,webhook_secret_configured:await monitorWebhookReady(env),
   counts:normalizedCounts(counts),
   diagnostics:diagnostics||{},
   ignored_coupon_links:Number(ignoredCoupons?.total||0),
   browser_binding_available:typeof env?.BROWSER?.quickAction==='function',
   worker_heartbeat:workerHeartbeat||{},
   browser_usage:{used:browserUsage?.day_key===new Date().toISOString().slice(0,10)
     ?Number(browserUsage.daily_count||0):0,
     daily_limit:null,last_attempt_at:Number(browserUsage?.last_at||0)},
   retry_progress:{
     total:Number(retryProgress?.total||0),automatic:Number(retryProgress?.automatic||0),
     manual:Number(retryProgress?.manual||0),
     last_attempt_at:Number(retryProgress?.last_attempt_at||0),
     next_retry_at:Number(retryProgress?.next_retry_at||0),
     from_paused_groups:Number(retryProgress?.from_paused_groups||0)
   },
   recent_shortlinks:latestShortlinks.results,
   recent_domains:observations.results,
   rejected_events:rejected.results,
   groups:groups.results.map(x=>({...x,counts:perGroupMap.get(x.id)||normalizedCounts(null),
     delivery:deliveryMap.get(x.id)||{received_messages:0,with_urls:0,last_received_at:null,last_format:'—'}})),
   links:links.results.map(x=>({...x,promotion:promotionDescription(x.last_seen_deal_json)})),
   shortlinks:pending.results,categories:categories.results.map(x=>x.name)};
}
export async function saveMonitorSettings(env,body){
 await ensureMonitor(env);
 if(typeof body?.enabled!=='boolean')throw fail('Informe se o monitoramento deve ficar ativo ou desativado.');
 if(body.enabled){
   if(!await monitorWebhookReady(env))
     throw fail('Antes de ativar, clique em Configurar recepção automaticamente e confirme o webhook da Evolution.');
   const count=await env.DB.prepare('SELECT COUNT(*) AS total FROM ml_monitor_groups WHERE enabled=1 AND authorized=1').first();
   if(!count?.total)throw fail('Cadastre ao menos um grupo autorizado antes de ativar.');
 }
 await env.DB.prepare('UPDATE ml_monitor_settings SET enabled=?,updated_at=? WHERE id=1').bind(Number(body.enabled),epoch()).run();
 return {enabled:body.enabled,ok:true};
}
export async function monitorEvolutionGroups(env,instance){
 if(typeof instance!=='string'||!INSTANCE.test(instance))throw fail('Nome de instância inválido.');
 return {groups:await listWhatsAppGroups(env,instance)};
}
export async function addMonitorGroup(env,body){
 await ensureMonitor(env);
 const instance_name=String(body?.instance_name||'').trim();
 const group_jid=String(body?.group_jid||'').trim();
 const group_name=String(body?.group_name||'').trim().slice(0,100);
 if(!INSTANCE.test(instance_name)||!GROUP.test(group_jid))throw fail('Informe uma instância e grupo válidos da Evolution.');
 if(group_name.length<3||body?.permission_confirmed!==true)
   throw fail('Informe o nome do grupo e confirme sua autorização para monitorar os links.');
 const t=epoch();
 await env.DB.prepare('INSERT INTO ml_monitor_groups(instance_name,group_jid,group_name,enabled,authorized,created_at) VALUES(?,?,?,1,1,?) ON CONFLICT(instance_name,group_jid) DO UPDATE SET group_name=excluded.group_name,enabled=1,authorized=1')
   .bind(instance_name,group_jid,group_name,t).run();
 return {ok:true};
}
export async function updateMonitorGroup(env,id,body){
 await ensureMonitor(env);
 const n=Number(id);
 if(!Number.isSafeInteger(n)||n<1||typeof body?.enabled!=='boolean')throw fail('Grupo ou opção inválida.');
 const r=await env.DB.prepare('UPDATE ml_monitor_groups SET enabled=? WHERE id=?').bind(Number(body.enabled),n).run();
 if(r.meta?.changes!==1)throw fail('Grupo não encontrado.',404);
 return {ok:true};
}
async function saveProduct(env,entry,source){
 const time=epoch(),deal=extractPromotionTerms(entry.hint),price=deal?.price_cents??null;
 const title=productTitle(source.url,entry.hint,source.product_id);
 await ensureAutomationCenter(env);
 const cats=(await env.DB.prepare('SELECT * FROM affiliate_group_categories WHERE enabled=1').all()).results;
 const classification=classifyProduct(title+' '+entry.hint,'',cats);
 const category=classification.category?.name||'Geral';
 // Registre o último preço mencionado com precisão, inclusive NULL para mensagens sem preço.
 const prior=await env.DB.prepare("SELECT l.id,l.status,l.batch_id,b.status AS batch_status,b.imported_at,m.last_queued_at,m.last_queued_price_cents FROM ml_monitor_links l LEFT JOIN ml_link_batches b ON b.id=l.batch_id LEFT JOIN ml_monitor_product_meta m ON m.product_id=l.product_id WHERE l.product_id=?").bind(source.product_id).first();
 await env.DB.prepare("INSERT INTO ml_monitor_product_meta(product_id,last_seen_price_cents,last_seen_deal_json,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET last_seen_price_cents=excluded.last_seen_price_cents,last_seen_deal_json=excluded.last_seen_deal_json,last_seen_at=excluded.last_seen_at")
   .bind(source.product_id,price,deal?JSON.stringify(deal):null,time).run();
 if(!prior){
   const inserted=await env.DB.prepare("INSERT OR IGNORE INTO ml_monitor_links(group_id,message_id,product_id,source_url,title,category,classification,status,created_at) VALUES(?,?,?,?,?,?,?,'available',?)")
     .bind(entry.group_id,entry.message_id,source.product_id,source.url,title,category,classification.classification,time).run();
   return inserted.meta?.changes===1;
 }
 if(prior.status==='available')return false; // Já está na etapa 1; não repita.
 if(prior.batch_status!=='imported')return false; // Lote ainda está aguardando conversão.
 const lastQueued=prior.last_queued_at||prior.imported_at||0;
 if(!canRequeueProduct(lastQueued,prior.last_queued_price_cents,price,time))return false;
 const updated=await env.DB.prepare("UPDATE ml_monitor_links SET group_id=?,message_id=?,source_url=?,title=?,category=?,classification=?,status='available',batch_id=NULL,created_at=? WHERE id=? AND status='batched' AND EXISTS(SELECT 1 FROM ml_link_batches WHERE id=ml_monitor_links.batch_id AND status='imported')")
   .bind(entry.group_id,entry.message_id,source.url,title,category,classification.classification,time,prior.id).run();
 return updated.meta?.changes===1;
}
// Quando a legenda não vem no webhook, consulta apenas essa mensagem do grupo permitido.
async function recoverCaptionFromEvolution(env,msg){
 if(!env.EVOLUTION_API_URL||!env.EVOLUTION_API_KEY||!INSTANCE.test(msg.instance)||
  !GROUP.test(msg.group_jid)||!/^[A-Za-z0-9._:-]{4,150}$/.test(msg.message_id))return null;
 try{
  const url=evolutionOrigin(env.EVOLUTION_API_URL)+'/chat/findMessages/'+encodeURIComponent(msg.instance);
  const res=await fetch(url,{method:'POST',redirect:'manual',
   headers:{apikey:String(env.EVOLUTION_API_KEY).trim(),accept:'application/json','content-type':'application/json'},
   body:JSON.stringify({where:{key:{remoteJid:msg.group_jid,id:msg.message_id}},limit:5}),
   signal:AbortSignal.timeout(7000)});
  if(!res.ok||Number(res.headers.get('content-length')||0)>1048576)return null;
  const reader=res.body?.getReader();if(!reader)return null;const chunks=[];let bytes=0;
  try{
   for(;;){const {value,done}=await reader.read();if(done)break;
    bytes+=value.byteLength;if(bytes>1048576){await reader.cancel();return null;}chunks.push(value);
   }
  }finally{reader.releaseLock();}
  const payload=new Uint8Array(bytes);let offset=0;
  for(const chunk of chunks){payload.set(chunk,offset);offset+=chunk.byteLength;}
  const data=JSON.parse(new TextDecoder().decode(payload));
  const records=Array.isArray(data)?data:Array.isArray(data?.messages?.records)?data.messages.records:
   Array.isArray(data?.records)?data.records:Array.isArray(data?.messages)?data.messages:[];
  const record=records.find(x=>x?.key?.remoteJid===msg.group_jid&&
   x.key.id===msg.message_id&&x.key.fromMe===false);
  if(!record)return null;
  const recovered=extractMessageText(record.message||{},record),urls=extractUrls(recovered.text);
  if(!urls.length)return null;
  return {...msg,urls,format:'evolution:'+recovered.format,
   hint:recovered.text.replace(/https:\/\/[^\s<>"'()[\]{}]+/gi,'').replace(/\s+/g,' ').trim().slice(0,800)};
 }catch{return null;}
}
export async function ingestMonitorEvent(env,payload){
 await ensureMonitor(env);
 const receivedAt=epoch();
 await env.DB.prepare("UPDATE ml_monitor_diagnostics SET events_received=events_received+1,last_event_at=? WHERE id=1").bind(receivedAt).run();
 const state=await env.DB.prepare('SELECT enabled FROM ml_monitor_settings WHERE id=1').first();
 if(!state?.enabled){
   await env.DB.prepare("UPDATE ml_monitor_diagnostics SET events_while_off=events_while_off+1 WHERE id=1").run();
   return {ok:true,ignored:'monitor_off'};
 }
 const groupList=(await env.DB.prepare('SELECT id,instance_name,group_jid FROM ml_monitor_groups WHERE enabled=1 AND authorized=1').all()).results;
 const messages=parseMonitorEvent(payload,{includeNoLinks:true});
 // Diagnóstico agregado de descartes antes da classificação; não guarda
 // JIDs desconhecidos, números, conteúdo de mensagens nem URLs privadas.
 if(payload?.event==='messages.upsert'||payload?.event==='MESSAGES_UPSERT'||payload?.event==='messages-upsert'){
   const source=Array.isArray(payload.data)?payload.data:Array.isArray(payload.data?.messages)?payload.data.messages:[payload.data];
   const reasons=new Map();
   for(const raw of source.slice(0,25)){
     const jid=raw?.key?.remoteJid;
     if(typeof jid!=='string'||!GROUP.test(jid))continue; // Ignora conversas privadas e canais.
     let reason;
     if(!groupList.some(g=>g.instance_name===payload.instance&&g.group_jid===jid)){
       reason=groupList.some(g=>g.group_jid===jid)?'instancia_diferente':'grupo_nao_corresponde_aos_cadastrados';
     }else if(raw.key?.fromMe!==false)reason='fromMe_nao_foi_false';
     if(reason)reasons.set(reason,(reasons.get(reason)||0)+1);
   }
   if(reasons.size){
     const ops=[...reasons].map(([reason,count])=>env.DB.prepare(
       "INSERT INTO ml_monitor_discard_reasons(reason,occurrences,last_at) VALUES(?,?,?) ON CONFLICT(reason) DO UPDATE SET occurrences=occurrences+excluded.occurrences,last_at=excluded.last_at"
     ).bind(reason,count,receivedAt));
     await env.DB.batch(ops);
   }
 }
 if(!messages.length)return {ok:true,accepted:0};
 let captured=0,pending=0,authorized=0,recognized=0;
 const observations=[];
 const delivery=[];
 let recoveryBudget=2;
 for(const original of messages){
   const group=groupList.find(x=>x.instance_name===original.instance&&x.group_jid===original.group_jid);
   if(!group)continue;
   let msg=original;
   if(!msg.urls.length&&recoveryBudget>0){
    recoveryBudget--;
    msg=await recoverCaptionFromEvolution(env,msg)||msg;
   }
   authorized++;
   delivery.push([group.id,Number(msg.urls.length>0),receivedAt,msg.format]);
   if(!msg.urls.length)observations.push([group.id,'—','nenhum_link_na_legenda',msg.format,receivedAt]);
   const entry={...msg,group_id:group.id};
   for(const raw of msg.urls){
     const candidate=urlCandidate(raw);
     let domain='inválido';
     try{domain=new URL(raw).hostname.toLowerCase().slice(0,85);}catch{}
     const reason=candidate?(candidate.kind==='short'?'encurtador_aceito':'produto_direto'):
      SHORT_HOSTS.has(domain)?'encurtador_formato_invalido':
      HOSTS.has(domain)?'produto_sem_codigo_valido':'dominio_nao_permitido';
     observations.push([group.id,domain,reason,msg.format,receivedAt]);
     if(!candidate)continue;
     recognized++;
     if(candidate.kind==='short'){
       const previouslyIgnored=await env.DB.prepare('SELECT 1 AS ignored FROM ml_monitor_ignored_links WHERE short_url=?')
         .bind(candidate.url).first();
       if(previouslyIgnored)continue;
       // O mesmo link encurtado pode voltar a ser publicado; reverifique após um intervalo.
       const inserted=await env.DB.prepare("INSERT OR IGNORE INTO ml_monitor_shortlinks(group_id,message_id,short_url,message_hint,status,tries,created_at) VALUES(?,?,?,?,'pending',0,?)")
         .bind(group.id,msg.message_id,candidate.url,msg.hint,epoch()).run();
       if(inserted.meta?.changes===1){pending++;continue;}
       const retried=await env.DB.prepare("UPDATE ml_monitor_shortlinks SET group_id=?,message_id=?,message_hint=?,status='pending',tries=0,reason=NULL,created_at=? WHERE short_url=? AND status IN ('resolved','review') AND message_id<>? AND created_at<=?")
         .bind(group.id,msg.message_id,msg.hint,epoch(),candidate.url,msg.message_id,epoch()-300).run();
       if(retried.meta?.changes===1)pending++;
     }else{if(await saveProduct(env,entry,candidate))captured++;}
   }
 }
 await env.DB.prepare("UPDATE ml_monitor_diagnostics SET messages_with_links=messages_with_links+?,authorized_messages=authorized_messages+?,links_recognized=links_recognized+?,last_authorized_at=CASE WHEN ?>0 THEN ? ELSE last_authorized_at END,last_link_at=CASE WHEN ?>0 THEN ? ELSE last_link_at END WHERE id=1")
   .bind(messages.filter(m=>m.urls.length>0).length,authorized,recognized,authorized,receivedAt,recognized,receivedAt).run();
 if(delivery.length){
   await env.DB.batch(delivery.slice(0,25).map(([groupId,hasUrls,stamp,format])=>env.DB.prepare(
     "INSERT INTO ml_monitor_group_delivery(group_id,received_messages,with_urls,last_received_at,last_format) VALUES(?,1,?,?,?) ON CONFLICT(group_id) DO UPDATE SET received_messages=received_messages+1,with_urls=with_urls+excluded.with_urls,last_received_at=excluded.last_received_at,last_format=excluded.last_format"
   ).bind(groupId,hasUrls,stamp,format)));
 }
 if(observations.length){
   const inserts=observations.slice(0,40).map(row=>env.DB.prepare("INSERT INTO ml_monitor_url_observations(group_id,domain,reason,message_format,created_at) VALUES(?,?,?,?,?)").bind(...row));
   await env.DB.batch(inserts);
   // Telemetria pequena e temporária: nenhum texto de mensagem, URL ou contato armazenado.
   await env.DB.prepare("DELETE FROM ml_monitor_url_observations WHERE id NOT IN (SELECT id FROM ml_monitor_url_observations ORDER BY id DESC LIMIT 120)").run();
 }
 return {ok:true,captured,pending};
}
// Não permite aprovar arbitrariamente um encurtador: exige um produto
// específico no domínio oficial e confirmação explícita da correspondência.
// Mesmo aprovado, salva SOMENTE a URL comum para posterior conversão própria.
export async function reviewMonitorShortlink(env,id,body){
 await ensureMonitor(env);
 const n=Number(id),action=body?.action;
 if(!Number.isSafeInteger(n)||n<1)throw fail('Link de revisão inválido.');
 if(!['retry','approve'].includes(action))throw fail('Escolha revalidar ou aprovar produto.');
 const short=await env.DB.prepare(
  "SELECT s.*,g.enabled,g.authorized FROM ml_monitor_shortlinks s JOIN ml_monitor_groups g ON g.id=s.group_id WHERE s.id=?"
 ).bind(n).first();
 if(!short)throw fail('Link não encontrado.',404);
 if(short.status!=='review')throw fail('Este link não está mais em revisão. Atualize a lista.',409);
 if(!short.authorized)throw fail('Grupo sem autorização para revisar o link.',403);
 let candidate,inspected=null;
 if(action==='retry'){
  inspected=await inspectMonitorShortlink(short.short_url);
  candidate=inspected.product;
  // O botão em massa e o Cron exigem o produto principal identificado;
  // nunca aprovar o primeiro anúncio recomendado na vitrine.
  if(!candidate&&inspected.social_url&&['showcase','auth'].includes(inspected.kind)){
   if(await claimSocialBrowserBudget(env)){
    const featured=await browserFeaturedProduct(env,inspected.social_url);
    if(featured){candidate=featured;inspected.featured_price=featured.featured_price||null;inspected.kind='featured_product';}
   }else{
    inspected={...inspected,reason:'Vitrine exige navegador; limite ou intervalo de segurança atingido. Nova tentativa necessária.'};
   }
  }
  if(!candidate){
   await env.DB.prepare(
    "UPDATE ml_monitor_shortlinks SET tries=tries+1,reason=? WHERE id=? AND status='review'"
   ).bind(inspected.reason,n).run();
   return {ok:true,resolved:false,reason:inspected.reason};
  }
 }else{
  if(body?.confirm_same_product!==true)
   throw fail('Confirme que abriu o link encurtado e verificou que ele leva ao mesmo produto.');
  const raw=typeof body?.source_url==='string'?body.source_url.trim():'';
  if(raw.length>2048)throw fail('Endereço de produto muito longo.');
  candidate=urlCandidate(raw);
  if(!candidate||candidate.kind!=='product')
   throw fail('Cole o endereço HTTPS do produto no Mercado Livre com código MLB/MLBU. Outros sites e encurtadores não podem ser aprovados.');
  // Se o destino encurtado puder ser verificado, nunca aceite outra mercadoria.
  let verified=null;
  try{verified=await redirectSource(short.short_url);}catch{}
  if(verified?.product_id&&verified.product_id!==candidate.product_id)
   throw fail('O endereço informado não corresponde ao produto identificado no link encurtado.',409);
 }
 await saveProduct(env,{group_id:short.group_id,message_id:short.message_id,hint:short.message_hint},candidate);
 if(action==='retry'){
  try{await persistFeaturedMonitorPrice(env,candidate.product_id,inspected.featured_price||candidate.featured_price);}
  catch{/* O erro no preço não invalida a identificação do anúncio. */}
 }
 const result=await env.DB.prepare(
  "UPDATE ml_monitor_shortlinks SET status='resolved',tries=tries+1,reason=? WHERE id=? AND status='review'"
 ).bind(action==='approve'?'Produto associado por confirmação manual':null,n).run();
 if(result.meta?.changes!==1)throw fail('O link foi alterado durante a revisão. Atualize a lista.',409);
 await env.DB.prepare('DELETE FROM ml_monitor_retry_schedule WHERE shortlink_id=?').bind(n).run();
 await env.DB.prepare('DELETE FROM ml_monitor_browser_attempts WHERE shortlink_id=?').bind(n).run();
 return {ok:true,resolved:true,manual:action==='approve',product_id:candidate.product_id};
}
// Processa a revisão inteira em páginas pequenas, preservando limites do Worker.
// Nunca converte link de terceiros em um link de afiliado nem publica a oferta.
export async function bulkValidateMonitorShortlinks(env,{after_id=0,limit=3,now=null}={}){
 await ensureMonitor(env);
 const after=Number(after_id),batchSize=Number(limit);
 if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>3)
  throw fail('Lote de revisão inválido.');
 const t=Number.isSafeInteger(now)&&now>0?now:epoch();
 const candidates=(await env.DB.prepare(
  "SELECT s.id,s.reason,g.authorized,COALESCE(rs.auto_attempts,0) AS auto_attempts "+
  "FROM ml_monitor_shortlinks s JOIN ml_monitor_groups g ON g.id=s.group_id "+
  "LEFT JOIN ml_monitor_retry_schedule rs ON rs.shortlink_id=s.id "+
  "WHERE s.status='review' AND s.id>? "+
  "AND COALESCE(rs.next_retry_at,0)<=? AND COALESCE(rs.lease_until,0)<=? "+
  "ORDER BY s.id LIMIT ?"
 ).bind(after,t,t,batchSize).all()).results;
 const outcome={ok:true,processed:0,resolved:0,not_confirmed:0,requires_manual:0,
  busy:0,results:[],next_cursor:after,has_more:false};
 for(const item of candidates){
  outcome.next_cursor=Number(item.id);
  if(!item.authorized){
   outcome.requires_manual++;
   outcome.results.push({id:item.id,status:'requires_manual',reason:'Grupo sem autorização'});
   continue;
  }
  if(/^(Redirecionamento para domínio não verificado|Redirecionamento circular|Produto associado por confirmação manual)/.test(item.reason||'')){
   outcome.requires_manual++;
   outcome.results.push({id:item.id,status:'requires_manual',reason:item.reason});
   continue;
  }
  // Lease usado também pelo Cron: impede processar o mesmo link simultaneamente.
  const inserted=await env.DB.prepare(
   "INSERT OR IGNORE INTO ml_monitor_retry_schedule(shortlink_id,next_retry_at,last_attempt_at,auto_attempts,lease_until) VALUES(?,0,0,0,?)"
  ).bind(item.id,t+120).run();
  let claimed=inserted.meta?.changes===1;
  if(!claimed){
   const lease=await env.DB.prepare(
    'UPDATE ml_monitor_retry_schedule SET lease_until=? WHERE shortlink_id=? AND lease_until<=?'
   ).bind(t+120,item.id,t).run();
   claimed=lease.meta?.changes===1;
  }
  if(!claimed){
   outcome.busy++;
   outcome.results.push({id:item.id,status:'busy'});
   continue;
  }
  outcome.processed++;
  try{
   const result=await reviewMonitorShortlink(env,item.id,{action:'retry'});
   if(result.resolved){
    outcome.resolved++;
    outcome.results.push({id:item.id,status:'resolved'});
   }else{
    outcome.not_confirmed++;
    const reason=String(result.reason||'Produto não confirmado').slice(0,220);
    await env.DB.prepare(
     'UPDATE ml_monitor_retry_schedule SET last_attempt_at=?,next_retry_at=?,auto_attempts=auto_attempts+1,lease_until=0 WHERE shortlink_id=?'
    ).bind(t,t+monitorRetryDelaySeconds(Number(item.auto_attempts||0)+1),item.id).run();
    outcome.results.push({id:item.id,status:'not_confirmed',reason});
   }
  }catch(error){
   outcome.not_confirmed++;
   await env.DB.prepare('UPDATE ml_monitor_retry_schedule SET lease_until=0,next_retry_at=?,last_attempt_at=? WHERE shortlink_id=?')
    .bind(t+120,t,item.id).run();
   outcome.results.push({id:item.id,status:'not_confirmed',reason:String(error?.message||error).slice(0,220)});
  }
 }
 const next=await env.DB.prepare(
  "SELECT 1 AS available FROM ml_monitor_shortlinks s "+
  "LEFT JOIN ml_monitor_retry_schedule rs ON rs.shortlink_id=s.id "+
  "WHERE s.status='review' AND s.id>? "+
  "AND COALESCE(rs.next_retry_at,0)<=? AND COALESCE(rs.lease_until,0)<=? LIMIT 1"
 ).bind(outcome.next_cursor,t,t).first();
 outcome.has_more=!!next;
 return outcome;
}
export async function updateMonitorLinkCategory(env,id,body){
 await ensureMonitor(env);await ensureAutomationCenter(env);
 const n=Number(id),category=String(body?.category||'').trim();
 if(!Number.isSafeInteger(n)||n<1)throw fail('Produto inválido.');
 const found=await env.DB.prepare('SELECT id FROM affiliate_group_categories WHERE name=? AND enabled=1').bind(category).first();
 if(!found)throw fail('Selecione uma categoria ativa já cadastrada.');
 const row=await env.DB.prepare("UPDATE ml_monitor_links SET category=?,classification='selected' WHERE id=? AND status='available'")
   .bind(category,n).run();
 if(row.meta?.changes!==1)throw fail('Produto não disponível para editar.',409);
 return {ok:true};
}
// A categoria "Geral" bloqueia o lote. Permita classificar TODOS os
// produtos ainda não classificados explicitamente, mas SOMENTE após o dono
// escolher uma categoria ativa. Não modifica itens de lotes anteriores.
export async function bulkCategorizeMonitorLinks(env,body){
 await ensureMonitor(env);
 await ensureAutomationCenter(env);
 const category=String(body?.category||'').trim();
 if(body?.confirm_all_unclassified!==true)
  throw fail('Confirme a classificação dos produtos disponíveis.');
 if(!category||category==='Geral')
  throw fail('Selecione uma categoria específica antes de continuar.');
 const active=await env.DB.prepare(
  'SELECT name FROM affiliate_group_categories WHERE enabled=1 AND name=?'
 ).bind(category).first();
 if(!active)throw fail('Categoria inválida ou desativada.');
 const items=(await env.DB.prepare(
  "SELECT id FROM ml_monitor_links WHERE status='available' "+
  "AND (category='Geral' OR trim(category)='') ORDER BY id LIMIT 100"
 ).all()).results;
 if(!items.length)return {ok:true,classified:0,remaining:0,category};
 const operations=items.map(x=>env.DB.prepare(
  "UPDATE ml_monitor_links SET category=?,classification='selected' "+
  "WHERE id=? AND status='available' AND (category='Geral' OR trim(category)='')"
 ).bind(active.name,x.id));
 if(typeof env.DB.batch!=='function')throw fail('Banco transacional indisponível.',503);
 await env.DB.batch(operations);
 const remaining=await env.DB.prepare(
  "SELECT count(*) AS total FROM ml_monitor_links WHERE status='available' "+
  "AND (category='Geral' OR trim(category)='')"
 ).first();
 // Na etapa seguinte, a validação em segundo plano já prepara até 50
 // desses produtos. Não cria nem publica nada aqui, sem uma conferência.
 return {ok:true,classified:items.length,remaining:Number(remaining?.total||0),category:active.name};
}
export async function prepareMonitorBatch(env,body){
 await ensureMonitor(env);
 const ids=body?.automatic===true
   ?(await env.DB.prepare("SELECT id FROM ml_monitor_links WHERE status='available' AND category<>'Geral' ORDER BY category,id LIMIT 50").all()).results.map(x=>x.id)
   :body?.ids;
 if(!Array.isArray(ids)||!ids.length||ids.length>50||!ids.every(x=>Number.isSafeInteger(x)&&x>0)||new Set(ids).size!==ids.length)
   throw fail('Selecione de 1 a 50 produtos diferentes.');
 const sql='SELECT id,title,source_url,category FROM ml_monitor_links WHERE status=\'available\' AND id IN ('+ids.map(()=>'?').join(',')+') ORDER BY category,id';
 const rows=(await env.DB.prepare(sql).bind(...ids).all()).results;
 if(rows.length!==ids.length)throw fail('Um produto já foi utilizado em lote. Atualize a lista.',409);
 if(rows.some(x=>x.category==='Geral'))throw fail('Defina a categoria dos produtos não reconhecidos antes de montar o lote.');
 const text=rows.map(x=>x.title.replace(/\|/g,' ')+' | '+x.source_url+' | '+x.category).join('\n');
 // Migra registros antigos sem metadados; um item disponível sem esta
 // linha causava rollback de TODO lote na criação automática.
 await env.DB.prepare(
  'INSERT OR IGNORE INTO ml_monitor_product_meta(product_id,last_seen_at) '+
  'SELECT product_id,0 FROM ml_monitor_links WHERE id IN ('+ids.map(()=>'?').join(',')+')'
 ).bind(...ids).run();
 const batch=await createLinkBatch(env,{text});
 const ops=[];
 for(const x of rows){
  ops.push(env.DB.prepare("UPDATE ml_monitor_links SET status='batched',batch_id=? WHERE id=? AND status='available'").bind(batch.batch.id,x.id));
  ops.push(env.DB.prepare("UPDATE ml_monitor_product_meta SET pending_batch_id=?,pending_price_cents=last_seen_price_cents,pending_deal_json=last_seen_deal_json,pending_captured_at=last_seen_at WHERE product_id=(SELECT product_id FROM ml_monitor_links WHERE id=?)").bind(batch.batch.id,x.id));
 }
 const changes=await env.DB.batch(ops);
 if(changes.some(x=>x.meta?.changes!==1))throw fail('Um produto mudou durante a criação do lote. Revise os lotes salvos.',409);
 return batch;
}
// Páginas de deep link podem mostrar o produto em uma referência HTML, em vez de usar HTTP 302.
// A página não é confiável: limita o corpo e só admite um único código MLB/MLBU em URL oficial.
async function productFromShortPage(response){
 const contentType=(response.headers.get('content-type')||'').toLowerCase();
 if(!/^text\/html(?:;|$)/.test(contentType))return null;
 const declared=Number(response.headers.get('content-length')||0);
 if(declared>32768)return null;
 const reader=response.body?.getReader();
 if(!reader)return null;
 let size=0;const chunks=[];
 try{
  for(;;){
   const part=await reader.read();
   if(part.done)break;
   size+=part.value.byteLength;
   if(size>32768){await reader.cancel();return null;}
   chunks.push(part.value);
  }
 }catch{return null;}
 const bytes=new Uint8Array(size);
 let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const html=new TextDecoder().decode(bytes).replace(/\\\//g,'/').replace(/&amp;/gi,'&');
 const links=html.match(/https:\/\/(?:www\.|produto\.)?mercadolivre\.com\.br\/[^\s"'<>\\]{1,700}/gi)||[];
 const unique=new Map();
 for(const raw of links.slice(0,30)){
   const c=urlCandidate(raw);
   if(c?.kind==='product')unique.set(c.product_id,c);
   if(unique.size>1)return null;
 }
 return unique.size===1?[...unique.values()][0]:null;
}
// Em páginas sociais do Mercado Livre, o anúncio principal fica dentro de
// rl-card-featured-wrapper. Só seguimos o botão "Ir para produto" desse bloco:
// as sugestões ("Você também pode gostar") nunca podem ser escolhidas.
// A vitrine pode ter o destaque em HTML ou em links hidratados. A identificação
// "c_id=/home/card-featured/element" do ML diferencia o produto principal
// de "home/affiliate-profile-recommendations". Não usar o primeiro resultado.
function featuredProductFromHtml(html,baseUrl){
 if(typeof html!=='string'||html.length>5500000)return null;
 const unique=new Map(),add=(raw,explicitFeatured=false)=>{
  if(typeof raw!=='string'||raw.length>4600)return;
  const cleaned=raw.replace(/&amp;|&#38;|&#x26;/gi,'&')
   .replace(/&quot;/gi,'"').replace(/\\u0026/gi,'&')
   .replace(/\\u003d/gi,'=').replace(/\\\//g,'/');
  if(!explicitFeatured&&!/(?:c_id=|%2Fc_id%3D|\/home\/card-featured\/element|home_affiliate-profile(?:&|$))/i.test(cleaned))
   return;
  // URL só pode ser confirmada se estiver identificada como cartão destacado.
  if(!explicitFeatured&&!/(?:card-featured|home_affiliate-profile(?:&|$|#))/i.test(cleaned))return;
  let url;try{url=new URL(cleaned,baseUrl).href;}catch{return;}
  const candidate=urlCandidate(url);
  if(candidate?.kind==='product')unique.set(candidate.product_id,candidate);
 };
 const featured=/<(?:section|div)\b[^>]{0,1200}\bclass\s*=\s*(["'])[^"']*\brl-card-featured-wrapper\b[^"']*\1[^>]*>/i.exec(html);
 if(featured){
  const excerpt=html.slice(featured.index+featured[0].length,featured.index+featured[0].length+350000);
  const boundary=excerpt.search(/(?:Voc(?:ê|&ecirc;|&#234;)\s+tamb(?:é|&eacute;|&#233;)m\s+pode\s+gostar|rl-card-recommendations|recommendations-wrapper)/i);
  const scope=boundary>=0?excerpt.slice(0,boundary):excerpt;
  for(const a of (scope.match(/<a\b[^>]{0,5000}>[\s\S]{0,12000}?<\/a\s*>/gi)||[]).slice(0,180)){
   const opening=/^<a\b[^>]*>/i.exec(a)?.[0]||'';
   const label=a.slice(opening.length).replace(/<[^>]{0,2000}>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/\s+/g,' ').trim();
   const action=/poly-action-links__action--link|poly-component__link--action-link/i.test(opening);
   if(!action&&!/\bir\s+para\s+(?:o\s+)?produto\b/i.test(label))continue;
   const href=/\bhref\s*=\s*(?:"([^"]{1,4500})"|'([^']{1,4500})')/i.exec(opening);
   if(href)add(href[1]||href[2],true);
  }
 }
 // Segundo caminho: links públicos do ML marcados como card-featured;
 // funciona mesmo que o nome da classe/contêiner mude.
 for(const tag of (html.match(/<a\b[^>]{0,5500}>/gi)||[]).slice(0,400)){
  const href=/\bhref\s*=\s*(?:"([^"]{1,4500})"|'([^']{1,4500})')/i.exec(tag);
  if(href)add(href[1]||href[2]);
 }
 // Hidratação Next/React às vezes guarda a URL em scripts, sem uma tag <a>.
 // Só aceita URLs explicitamente identificadas como card-featured.
 const encoded=html.replace(/\\u0026/gi,'&').replace(/\\u003d/gi,'=')
  .replace(/\\\//g,'/').replace(/&amp;/gi,'&');
 const urlPattern=/https:\/\/(?:www\.|produto\.)?mercadolivre\.com\.br\/[^\s"'<>\\]{6,4200}/gi;
 let inspected=0;
 for(const hit of encoded.matchAll(urlPattern)){
  if(++inspected>1200)break;
  const raw=hit[0].replace(/[),;]+$/g,'');
  if(!/card-featured/.test(raw))continue;
  add(raw);
 }
 return unique.size===1?[...unique.values()][0]:null;
}
// A vitrine de afiliado pode usar /sec/ no botão "Ir para produto".
// Seguir somente o cartão destacado, nunca a grade de recomendações.
export function featuredActionLinksFromHtml(html,baseUrl){
 if(typeof html!=='string'||html.length>5_500_000)return [];
 const wrapper=/<(?:section|div)\b[^>]{0,1500}\bclass\s*=\s*(["'])[^"']*\b(?:rl-card-featured-wrapper|card-featured-wrapper)\b[^"']*\1[^>]*>/i.exec(html);
 if(!wrapper)return [];
 const snippet=html.slice(wrapper.index+wrapper[0].length,wrapper.index+wrapper[0].length+350000);
 const boundary=snippet.search(/(?:Voc(?:ê|&ecirc;|&#234;)\s+tamb(?:é|&eacute;|&#233;)m\s+pode\s+gostar|rl-card-recommendations|recommendations-wrapper)/i);
 const scope=boundary>=0?snippet.slice(0,boundary):snippet;
 const links=new Set();
 for(const node of (scope.match(/<a\b[^>]{0,5500}>[\s\S]{0,18000}?<\/a\s*>/gi)||[]).slice(0,140)){
  const tag=/^<a\b[^>]*>/i.exec(node)?.[0]||'';
  const label=node.slice(tag.length).replace(/<[^>]{0,2000}>/g,' ').replace(/\s+/g,' ').trim();
  if(!/\bir\s+para\s+(?:o\s+)?produto\b/i.test(label)&&
     !/poly-component__link--action-link|poly-action-links__action--link/i.test(tag))continue;
  const href=/\bhref\s*=\s*(?:"([^"]{1,4500})"|'([^']{1,4500})')/i.exec(tag);
  if(!href)continue;
  let u;try{u=new URL((href[1]||href[2]).replace(/&amp;|&#38;|&#x26;/gi,'&'),baseUrl);}catch{continue;}
  if(!trustedHop(u.href)||/^\/social(?:\/|$)/i.test(u.pathname))continue;
  links.add(u.href);
  if(links.size>=6)break;
 }
 return [...links];
}
async function resolveFeaturedActionLink(value,fetcher=fetch){
 let current=value;const visited=new Set();
 for(let hop=0;hop<6;hop++){
  const u=trustedHop(current);
  if(!u||visited.has(u.href)||/^\/social(?:\/|$)/i.test(u.pathname))return null;
  visited.add(u.href);
  const candidate=urlCandidate(u.href);
  if(candidate?.kind==='product')return candidate;
  if(couponLandingUrl(u.href))return null;
  let response;
  try{response=await fetcher(u.href,{method:'GET',redirect:'manual',
   headers:{accept:'text/html,application/xhtml+xml'},signal:AbortSignal.timeout(4500)});}
  catch{return null;}
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');
   if(!location)return null;
   try{current=new URL(location,u.href).href;}catch{return null;}
   continue;
  }
  if(response.status===200)return await productFromShortPage(response);
  return null;
 }
 return null;
}
async function featuredProductWithOfficialRedirect(html,baseUrl,fetcher=fetch){
 const direct=featuredProductFromHtml(html,baseUrl);
 if(direct)return direct;
 const identified=new Map();
 for(const link of featuredActionLinksFromHtml(html,baseUrl)){
  const product=await resolveFeaturedActionLink(link,fetcher);
  if(product?.kind==='product')identified.set(product.product_id,product);
  if(identified.size>1)return null;
 }
 return identified.size===1?[...identified.values()][0]:null;
}
async function featuredProductFromShowcasePage(response,baseUrl,fetcher=fetch){
 const type=(response.headers.get('content-type')||'').toLowerCase();
 if(!/^text\/html(?:;|$)/.test(type))return null;
 // Vitrines /social possuem listas extensas de produtos recomendados. A
 // publicidade principal aparece no início; tamanho total >5,5MB não é
 // motivo para descartar o produto. Ler no máximo 4MB, sem percorrer a
 // grade de recomendações nem baixar HTML ilimitado.
 const maxBytes=4_000_000;
 const decoder=new TextDecoder(),pieces=[];let size=0;
 const reader=response.body?.getReader();
 if(!reader){
  if(typeof response.text!=='function')return null;
  try{return await featuredProductWithOfficialRedirect((await response.text()).slice(0,maxBytes),baseUrl,fetcher);}
  catch{return null;}
 }
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   const take=Math.min(value.byteLength,maxBytes-size);
   if(take>0){pieces.push(decoder.decode(value.subarray(0,take),{stream:true}));size+=take;}
   if(size>=maxBytes)break;
  }
 }catch{return null;}
 finally{try{await reader.cancel();}catch{ }try{reader.releaseLock();}catch{ }}
 return await featuredProductWithOfficialRedirect(pieces.join('')+decoder.decode(),baseUrl,fetcher);
}
export {featuredProductFromHtml};
// Quando uma URL intermediária inclui explicitamente o destino Mercado Livre,
// usa só esse destino validado, sem consultar domínios externos.
export function trustedEmbeddedRedirect(input){
 let u;try{u=new URL(input);}catch{return null;}
 if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
 const keys=['url','redirect_url','redirect','target','destination','dest','link','u','murl','m_url'];
 const found=new Set();
 for(const key of keys){
  for(let value of u.searchParams.getAll(key).slice(0,2)){
   for(let i=0;i<3;i++){
    if(typeof value!=='string'||value.length>3500)break;
    let candidate;try{candidate=new URL(value);}catch{}
    if(candidate?.protocol==='https:'&&!candidate.username&&!candidate.password&&!candidate.port&&
       (SHORT_HOSTS.has(candidate.hostname.toLowerCase())||REDIRECT_HOSTS.has(candidate.hostname.toLowerCase()))){
      found.add(candidate.href);break;
    }
    try{const decoded=decodeURIComponent(value);if(decoded===value)break;value=decoded;}catch{break;}
   }
  }
 }
 return found.size===1?[...found][0]:null;
}
function trustedHop(input){
 try{
  const u=new URL(input);
  return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&
   (SHORT_HOSTS.has(u.hostname.toLowerCase())||REDIRECT_HOSTS.has(u.hostname.toLowerCase()))?u:null;
 }catch{return null;}
}
// A falha de resolução não prova que o domínio foi rejeitado: há vitrines,
// páginas intermediárias, rate limit e links de outros sites. Informe o motivo.
export async function inspectMonitorShortlink(value,{fetcher=fetch}={}){
 let current=value;const visited=new Set();let previousSocial=null;
 for(let hop=0;hop<7;hop++){
  let externalUrl;
  try{externalUrl=new URL(current);}catch{}
  const host=externalUrl?.hostname.toLowerCase();
  const loginHost=['auth.mercadolivre.com.br','login.mercadolivre.com.br'].includes(host);
  const loginPath=REDIRECT_HOSTS.has(host)&&/^\/jms\/mlb\/lgz\/login(?:\/|$)/i.test(externalUrl.pathname);
  if(loginHost||loginPath)
   return {product:null,kind:'auth',social_url:previousSocial,reason:'A vitrine do Mercado Livre solicitou login; não foi possível confirmar um produto público'};
  const u=trustedHop(current);
  if(!u){
   const embedded=trustedEmbeddedRedirect(current);
   if(embedded){current=embedded;continue;}
   let domain='desconhecido';
   try{domain=new URL(current).hostname.toLowerCase().slice(0,120);}catch{}
   return {product:null,kind:'external',reason:'Redirecionamento para domínio não verificado ('+domain+'); revisão manual necessária'};
  }
  if(visited.has(u.href))return {product:null,kind:'loop',reason:'Redirecionamento circular do link'};
  visited.add(u.href);
  const product=urlCandidate(u.href);
  if(product?.kind==='product')return {product,kind:'product',reason:null};
  if(couponLandingUrl(u.href))return {product:null,kind:'coupon',reason:'Página oficial de cupons: não é um anúncio individual'};
  const social=/^\/social(?:\/|$)/i.test(u.pathname)&&REDIRECT_HOSTS.has(u.hostname.toLowerCase());
  if(social)previousSocial=u.href;
  let res;
  try{
   res=await fetcher(u.href,{redirect:'manual',method:'GET',signal:AbortSignal.timeout(4500),
    headers:{accept:'text/html,application/xhtml+xml'}});
  }catch{
   return {product:null,kind:'temporary',reason:'Falha de conexão ou tempo esgotado ao consultar o link'};
  }
  if([301,302,303,307,308].includes(res.status)){
   const location=res.headers.get('location');
   if(!location)return {product:null,kind:'redirect',reason:'Redirecionamento sem endereço de destino'};
   try{current=new URL(location,u.href).href;}
   catch{return {product:null,kind:'redirect',reason:'Redirecionamento com destino inválido'};}
   continue;
  }
  if([403,429].includes(res.status))
   return {product:null,kind:'temporary',reason:'O site limitou ou negou a consulta automática ('+res.status+')'};
  if(res.status>=500)
   return {product:null,kind:'temporary',reason:'O site está indisponível temporariamente ('+res.status+')'};
  if(res.status===200){
   if(social){
    const copy=res.clone();
    const featured=await featuredProductFromShowcasePage(res,u.href,fetcher);
    if(featured){
     // O preço pertence exclusivamente ao cartão principal confirmado.
     let featured_price=null;
     try{featured_price=extractFeaturedShowcasePrice((await copy.text()).slice(0,5500000),featured.product_id);}catch{}
     return {product:featured,kind:'featured_product',social_url:u.href,featured_price,reason:null};
    }
    return {product:null,kind:'showcase',social_url:u.href,reason:'Vitrine encontrada, mas o botão do produto principal não pôde ser identificado no HTML público'};
   }
   const candidate=await productFromShortPage(res);
   if(candidate)return {product:candidate,kind:'product',reason:null};
   return {product:null,kind:'intermediate',reason:'Página sem identificação segura de um produto individual'};
  }
  return {product:null,kind:'http',reason:'O link não apresentou produto verificável (HTTP '+res.status+')'};
 }
 return {product:null,kind:'redirect',reason:'O link passou por muitos redirecionamentos'};
}
// Browser Run é usado apenas se o HTML não contém o CTA. Sem teto diário
// artificial: o D1 mantém estatística por dia e aplica intervalo entre
// chamadas para reduzir custo, excesso de acessos e respostas HTTP 429.
// Os limites reais e a cobrança do plano Cloudflare continuam valendo.
const MONITOR_RENDER_COOLDOWN=30;
export async function claimSocialBrowserBudget(env,now=epoch()){
 if(typeof env?.BROWSER?.quickAction!=='function')return false;
 await ensureMonitor(env);
 const day=new Date(now*1000).toISOString().slice(0,10);
 const result=await env.DB.prepare(
  "UPDATE ml_monitor_browser_budget SET "+
  "daily_count=CASE WHEN day_key=? THEN daily_count+1 ELSE 1 END,day_key=?,last_at=? "+
  "WHERE id=1 AND last_at<=?"
 ).bind(day,day,now,now-MONITOR_RENDER_COOLDOWN).run();
 return result.meta?.changes===1;
}
async function claimMonitorItemBrowserAttempt(env,shortlinkId,at){
 const result=await env.DB.prepare(
  "INSERT INTO ml_monitor_browser_attempts(shortlink_id,last_attempt_at) VALUES(?,?) "+
  "ON CONFLICT(shortlink_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at "+
  "WHERE last_attempt_at<=?"
 ).bind(shortlinkId,at,at-600).run();
 return result.meta?.changes===1;
}
// Primeira alternativa: HTML completo do produto principal. Se o ML renderizar
// o botão só depois, use scrape com seletores restritos à vitrine principal.
// Nunca seleciona um link de "Quem viu este produto também comprou".
export async function browserFeaturedProduct(env,socialUrl,{includeDetails=false}={}){
 if(typeof env?.BROWSER?.quickAction!=='function')return null;
 let u;
 try{u=new URL(socialUrl);}catch{return null;}
 if(u.protocol!=='https:'||!REDIRECT_HOSTS.has(u.hostname.toLowerCase())||
    !/^\/social(?:\/|$)/i.test(u.pathname))return null;
 const opts={url:u.href,gotoOptions:{waitUntil:'networkidle2',timeout:20000},
  rejectResourceTypes:['image','font','media']};
 try{
  const rendered=await env.BROWSER.quickAction('content',opts);
  if(rendered?.ok){
    const copy=includeDetails&&typeof rendered.clone==='function'?rendered.clone():null;
    const candidate=await featuredProductFromShowcasePage(rendered,u.href);
    if(candidate){
     if(!copy)return candidate;
     let featured_price=null;
     try{featured_price=extractFeaturedShowcasePrice((await copy.text()).slice(0,5500000),candidate.product_id);}catch{}
     return {...candidate,featured_price};
    }
  }else console.warn('Browser Run vitrine HTML:',rendered?.status||'sem resposta');
 }catch(error){console.warn('Browser Run vitrine HTML:',String(error?.message||error).slice(0,130));}
 try{
  // Cloudflare /scrape retorna o primeiro elemento de cada seletor.
  // O primeiro <a> costuma ser o título da oferta, NÃO o botão "Ir para
  // produto". Aceitar também o título, sempre dentro do cartão destacado.
  const selectors=[
   '.rl-card-featured-wrapper',
   '.rl-card-featured-wrapper a.poly-component__title[href]',
   '.rl-card-featured-wrapper a.poly-component__link--action-link[href]',
   '[class*="card-featured"] a.poly-component__title[href]',
   // Compatibilidade: instâncias antigas do navegador usam estes seletores.
   '.rl-card-featured-wrapper a[href]',
   '[class*="card-featured"] a[href]'
  ];
  const scraped=await env.BROWSER.quickAction('scrape',{
   ...opts,elements:selectors.map(selector=>({selector}))
  });
  if(!scraped?.ok||typeof scraped.json!=='function')return null;
  const payload=await scraped.json();
  const sections=Array.isArray(payload)?payload:
   Array.isArray(payload?.result)?payload.result:
   Array.isArray(payload?.results)?payload.results:[];
  const identified=new Map();
  for(const section of sections){
   if(!selectors.includes(section?.selector))continue;
   const elements=Array.isArray(section.results)?section.results:
    (section.results&&typeof section.results==='object'?[section.results]:[]);
   for(const element of elements.slice(0,5)){
    if(section.selector==='.rl-card-featured-wrapper'){
     const html=String(element.html||'').slice(0,350000);
     if(html){
      const scoped=/<(?:section|div)\b[^>]*\brl-card-featured-wrapper\b/i.test(html)
       ?html:'<div class="rl-card-featured-wrapper">'+html+'</div>';
      const candidate=await featuredProductWithOfficialRedirect(scoped,u.href);
      if(candidate?.kind==='product')identified.set(candidate.product_id,candidate);
     }
     continue;
    }
    // O link do título principal tem escopo de card e serve como destino
    // seguro quando a vitrine não expõe o CTA nos resultados do scraper.
    const href=(element.attributes||[]).find(x=>x.name==='href')?.value;
    let absolute;try{absolute=new URL(href,u.href).href;}catch{continue;}
    const candidate=await resolveFeaturedActionLink(absolute);
    if(candidate?.kind==='product')identified.set(candidate.product_id,candidate);
   }
   if(identified.size>1)return null; // nunca escolher entre produtos distintos
  }
  return identified.size===1?[...identified.values()][0]:null;
 }catch(error){console.warn('Browser Run vitrine scrape:',String(error?.message||error).slice(0,130));}
 return null;
}
export async function redirectSource(value){
 return (await inspectMonitorShortlink(value)).product;
}
// Cada tentativa é independente: HTML da vitrine pode mudar entre leituras.
// Cron da Cloudflare é de 1 minuto; a segunda pulsação roda após 30 segundos.
// Falhas HTTP 403/429 usam backoff para não forçar o Mercado Livre.
// O bloqueio em D1 evita consultas duplicadas por acionamentos simultâneos.
export function monitorRetryDelaySeconds(attempts){
 // Links que ainda podem revelar um produto voltam em até 60 segundos.
 // Desacelerar 403/429 separadamente para respeitar o Mercado Livre.
 return attempts<=8?30:60;
}
export async function resolveMonitorShortlinks(env,{now=null,fetcher=fetch}={}){
 await ensureMonitor(env);
 const state=await env.DB.prepare('SELECT enabled FROM ml_monitor_settings WHERE id=1').first();
 if(!state?.enabled)return {skipped:'disabled'};
 const at=Number.isSafeInteger(now)&&now>0?now:epoch();
 // Uma pulsação por cron. Se a data parar de avançar, o painel denuncia
 // claramente que o Worker não está rodando em vez de dizer "em revisão".
 await env.DB.prepare('UPDATE ml_monitor_worker_heartbeat SET last_run_at=? WHERE id=1').bind(at).run();
 // Versões anteriores aplicavam até 30 minutos de espera a vitrines /social.
 // Elas já podem ser tratadas pelo Browser Run atualizado. Antecipar a fila
 // antiga sem mudar status, sem apagar registros e sem habilitar grupos pausados.
 await env.DB.prepare(
  "UPDATE ml_monitor_retry_schedule SET next_retry_at=? "+
  "WHERE next_retry_at>? AND last_attempt_at<=? AND shortlink_id IN ("+
  "SELECT s.id FROM ml_monitor_shortlinks s JOIN ml_monitor_groups g ON g.id=s.group_id "+
  "WHERE g.authorized=1 AND s.status='review' AND ("+
  "s.reason IS NULL OR ("+
  "s.reason NOT LIKE 'Redirecionamento para domínio não verificado%' AND "+
  "s.reason NOT LIKE 'Redirecionamento circular%' AND "+
  "s.reason NOT LIKE 'Produto associado por confirmação manual%' AND "+
  "s.reason NOT LIKE '%(429)%' AND s.reason NOT LIKE '%(403)%' AND "+
  "s.reason NOT LIKE '%solicitou login%' "+
  "))"
  +")"
 ).bind(at,at+60,at-60).run();
 let ignoredFromBacklog=0;
 // Recupera os cupons antigos parados em "revisão manual". Não exclui URL
 // externa genérica nem ofertas que apenas anunciam desconto com cupom.
 const oldCouponReviews=(await env.DB.prepare(
  "SELECT s.id,s.group_id,s.short_url,s.message_hint,s.reason FROM ml_monitor_shortlinks s "+
  "JOIN ml_monitor_groups g ON g.id=s.group_id WHERE g.authorized=1 "+
  "AND s.status='review' AND (s.reason LIKE 'Redirecionamento para domínio não verificado%' "+
  "OR s.reason='Destino fora dos domínios permitidos do Mercado Livre') "+
  "AND s.message_hint LIKE '%cupom%' ORDER BY s.id LIMIT 80"
 ).all()).results;
 for(const item of oldCouponReviews){
  if(!couponOnlyAnnouncement(item.message_hint))continue;
  try{await ignoreMonitorCoupon(env,item,at,'Aviso exclusivo de cupom com destino externo; ignorado para não bloquear ofertas');ignoredFromBacklog++;}
  catch(error){console.warn('Cupom antigo não pôde ser isolado:',String(error?.message||error).slice(0,90));}
 }
 const query=
  "SELECT s.*,g.instance_name,g.group_jid,rs.next_retry_at,rs.lease_until,rs.auto_attempts "+
  "FROM ml_monitor_shortlinks s JOIN ml_monitor_groups g ON g.id=s.group_id "+
  "LEFT JOIN ml_monitor_retry_schedule rs ON rs.shortlink_id=s.id "+
  // Uma pausa no grupo bloqueia apenas captação nova; autorização continua.
  "WHERE g.authorized=1 "+
  "AND (s.status='pending' OR (s.status='review' AND ("+
  "s.reason IS NULL OR s.reason='Destino fora dos domínios permitidos do Mercado Livre' OR ("+
  "s.reason NOT LIKE 'Redirecionamento para domínio não verificado%' AND "+
  "s.reason NOT LIKE 'Redirecionamento circular%' AND "+
  "s.reason NOT LIKE 'Produto associado por confirmação manual%')))) "+
  "AND COALESCE(rs.next_retry_at,0)<=? AND COALESCE(rs.lease_until,0)<=? "+
  // Não permitir que os links mais recentes e os retries ruins deixem os
  // antigos permanentemente para trás. Toda linha recebe seu próprio lease.
  "ORDER BY CASE WHEN s.status='pending' THEN 0 ELSE 1 END, "+
  "COALESCE(rs.next_retry_at,0),s.created_at ASC,s.id ASC LIMIT 6";
 const items=(await env.DB.prepare(query).bind(at,at).all()).results;
 let browserBudget=1;
 const outcomes=await Promise.allSettled(items.map(async item=>{
  let claimed=false;
  try{
   const created=await env.DB.prepare(
    "INSERT OR IGNORE INTO ml_monitor_retry_schedule(shortlink_id,next_retry_at,last_attempt_at,auto_attempts,lease_until) "+
    "VALUES(?,0,0,0,?)"
   ).bind(item.id,at+90).run();
   if(created.meta?.changes===1)claimed=true;
   else{
    const row=await env.DB.prepare(
     "UPDATE ml_monitor_retry_schedule SET lease_until=? "+
     "WHERE shortlink_id=? AND next_retry_at<=? AND lease_until<=?"
    ).bind(at+90,item.id,at,at).run();
    claimed=row.meta?.changes===1;
   }
   if(!claimed)return {resolved:0,reviewed:0,ignored:0};
   let result;
   try{result=await inspectMonitorShortlink(item.short_url,{fetcher});}
   catch{result={product:null,kind:'temporary',reason:'Erro temporário consultando anúncio'};}
   const tries=Number(item.auto_attempts||0);
   // No máximo um Browser Run por pulsação. D1 controla o intervalo e contabiliza uso diário.
   // Tentativas antigas não eliminam a renderização: links podem estar em
   // revisão há dias sem ter recebido nenhuma consulta de navegador.
   const shouldBrowser=!result.product&&result.social_url&&
    ['showcase','auth'].includes(result.kind);
   if(shouldBrowser&&browserBudget>0){
    const perItem=await env.DB.prepare(
     'SELECT last_attempt_at FROM ml_monitor_browser_attempts WHERE shortlink_id=?'
    ).bind(item.id).first();
    if(!perItem||perItem.last_attempt_at<=at-600){
     browserBudget=0; // reservar antes do await, evitando concorrência
     if(await claimSocialBrowserBudget(env,at)){
      await claimMonitorItemBrowserAttempt(env,item.id,at);
      const rendered=await browserFeaturedProduct(env,result.social_url);
      if(rendered)result={product:rendered,kind:'featured_product',reason:null,featured_price:rendered.featured_price||null};
     }
    }
   }
   if(result.product){
    try{
     await saveProduct(env,{group_id:item.group_id,message_id:item.message_id,hint:item.message_hint},result.product);
     if(result.kind==='featured_product'){
      try{await persistFeaturedMonitorPrice(env,result.product.product_id,result.featured_price||result.product.featured_price,at);}
      catch{/* Classificação continua mesmo se a gravação do preço falhar. */}
     }
     const updated=await env.DB.prepare(
      "UPDATE ml_monitor_shortlinks SET status='resolved',tries=tries+1,reason=NULL "+
      "WHERE id=? AND status IN ('pending','review')"
     ).bind(item.id).run();
     await env.DB.prepare('DELETE FROM ml_monitor_retry_schedule WHERE shortlink_id=?').bind(item.id).run();
     await env.DB.prepare('DELETE FROM ml_monitor_browser_attempts WHERE shortlink_id=?').bind(item.id).run();
     return {resolved:updated.meta?.changes===1?1:0,reviewed:0,ignored:0};
    }catch{
     result={product:null,kind:'temporary',reason:'Erro temporário ao salvar o produto confirmado'};
    }
   }
   // Descartar somente quando o destino É uma página de cupom, ou quando
   // a mensagem é explicitamente só um anúncio de cupom sem item anunciado.
   if(result.kind==='coupon'||couponOnlyAnnouncement(item.message_hint)){
    await ignoreMonitorCoupon(env,item,at,result.kind==='coupon'
     ?'Destino confirmado como página de cupons, não anúncio de produto'
     :'Mensagem exclusiva de cupom sem produto individual confirmado');
    return {resolved:0,reviewed:0,ignored:1};
   }
   // As demais falhas não viram produto; são reavaliadas com backoff.
   const retryable=!['external','loop'].includes(result.kind);
   const attempts=tries+1;
   const throttled=result.kind==='temporary'&&/(?:403|429|limitou|negou)/i.test(result.reason||'');
   const delay=!retryable?86400:
    (throttled||result.kind==='auth'?300:monitorRetryDelaySeconds(attempts));
   await env.DB.prepare(
    "UPDATE ml_monitor_shortlinks SET status='review',tries=tries+1,reason=? "+
    "WHERE id=? AND status IN ('pending','review')"
   ).bind(result.reason||'Destino não verificável automaticamente',item.id).run();
   await env.DB.prepare(
    "UPDATE ml_monitor_retry_schedule SET last_attempt_at=?,next_retry_at=?,auto_attempts=auto_attempts+1,lease_until=0 "+
    "WHERE shortlink_id=?"
   ).bind(at,at+delay,item.id).run();
   return {resolved:0,reviewed:1,ignored:0};
  }catch(error){
   // Falhar em um item não deve abortar os outros 5 nem manter seu lease preso.
   console.warn('Falha isolada na revisão do link',item.id,String(error?.message||error).slice(0,100));
   if(claimed)try{
    await env.DB.prepare(
     "UPDATE ml_monitor_retry_schedule SET lease_until=0,next_retry_at=? "+
     "WHERE shortlink_id=?"
    ).bind(at+60,item.id).run();
   }catch{}
   return {resolved:0,reviewed:0,ignored:0};
  }
 }));
 const totals={resolved:0,reviewed:0,ignored:ignoredFromBacklog};
 for(const o of outcomes){
  if(o.status!=='fulfilled')continue;
  totals.resolved+=o.value.resolved||0;
  totals.reviewed+=o.value.reviewed||0;
  totals.ignored+=o.value.ignored||0;
 }
 await env.DB.prepare(
  'UPDATE ml_monitor_worker_heartbeat SET last_run_at=?,last_reviewed=?,last_resolved=?,last_ignored=? WHERE id=1'
 ).bind(at,totals.reviewed,totals.resolved,totals.ignored).run();
 return {resolved:totals.resolved,reviewed:totals.reviewed};
}
