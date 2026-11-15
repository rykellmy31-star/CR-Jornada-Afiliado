import {validateAffiliateUrl,normalizeOffer} from './logic.js';
import {classifyProduct,ensureAutomationCenter,upsertProductCategory} from './automation-center.js';
import {getPrimaryCategory,categoryMatches} from './multichannel.js';
import {ensureWhatsAppTables} from './whatsapp.js';
import {ensureRepeatMeta,ensureOfferPromoColumns} from './monitor-repeat-policy.js';
import {safePromotionTerms} from './promotion-terms.js';
const SCHEMA=[
 "CREATE TABLE IF NOT EXISTS ml_link_batches(id INTEGER PRIMARY KEY AUTOINCREMENT,status TEXT NOT NULL DEFAULT 'awaiting_links' CHECK(status IN ('awaiting_links','imported')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,imported_at INTEGER)",
 "CREATE TABLE IF NOT EXISTS ml_link_batch_items(id INTEGER PRIMARY KEY AUTOINCREMENT,batch_id INTEGER NOT NULL REFERENCES ml_link_batches(id),position INTEGER NOT NULL,title TEXT NOT NULL,source_url TEXT NOT NULL,category TEXT NOT NULL,classification TEXT NOT NULL,affiliate_url TEXT,offer_id INTEGER,status TEXT NOT NULL DEFAULT 'awaiting_links' CHECK(status IN ('awaiting_links','queued')),UNIQUE(batch_id,position),UNIQUE(batch_id,source_url))",
 "CREATE INDEX IF NOT EXISTS idx_ml_link_batch_items ON ml_link_batch_items(batch_id,position)",
 // Complementar e compatível com lotes existentes: o CHECK legado não
 // permite adicionar 'ineligible' à coluna status de ml_link_batch_items.
 "CREATE TABLE IF NOT EXISTS ml_link_batch_ineligible(item_id INTEGER PRIMARY KEY REFERENCES ml_link_batch_items(id),batch_id INTEGER NOT NULL REFERENCES ml_link_batches(id),reason TEXT NOT NULL,created_at INTEGER NOT NULL)",
 "CREATE INDEX IF NOT EXISTS idx_ml_link_batch_ineligible_batch ON ml_link_batch_ineligible(batch_id)"
];
const now=()=>Math.floor(Date.now()/1000);
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
export async function ensureLinkBatches(env){for(const sql of SCHEMA)await env.DB.prepare(sql).run();await ensureRepeatMeta(env);await ensureOfferPromoColumns(env);}
export function productId(value){const m=String(value||'').match(/\b(MLBU?)[-_]?(\d{6,})\b/i);return m?m[1].toUpperCase()+m[2]:null;}
export function validateSourceUrl(value){
 let u;try{u=new URL(String(value||'').trim());}catch{throw bad('Insira uma URL original válida do Mercado Livre.');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||
   !['www.mercadolivre.com.br','mercadolivre.com.br','produto.mercadolivre.com.br'].includes(u.hostname.toLowerCase()))
   throw bad('Use somente o link HTTPS de um produto do Mercado Livre brasileiro.');
 if(!productId(u.pathname))throw bad('O link não identifica um produto MLB/MLBU. Não copie resultados de busca.');
 u.hash='';return u.href;
}
function titleFromUrl(source){
 const segments=new URL(source).pathname.split('/').filter(Boolean);
 let slug=segments.find(x=>x.includes('-')&&!/^MLBU?[-_]?\d/i.test(x))||'';
 slug=slug.replace(/-?p-?MLBU?[-_]?\d+.*/i,'').replace(/MLBU?[-_]?\d+/gi,'').replace(/-?JM$/i,'').replace(/[-_]+/g,' ').trim();
 return slug.length>=5?slug.slice(0,180):'';
}
export function parseSelection(text){
 if(typeof text!=='string'||text.length>18000)throw bad('Lista muito extensa.');
 const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 if(lines.length<1||lines.length>50)throw bad('Informe entre 1 e 50 produtos por lote.');
 const unique=new Set();
 return lines.map((line,i)=>{
   const f=line.split('|').map(x=>x.trim()),k=f.findIndex(x=>/^https:\/\//i.test(x));
   if(f.length>3||k<0||k>1)throw bad('Linha '+(i+1)+': use Nome | URL | Categoria ou apenas URL.');
   const source_url=validateSourceUrl(f[k]);
   if(unique.has(source_url))throw bad('Produto repetido na linha '+(i+1)+'.');
   unique.add(source_url);
   const title=(k===0?titleFromUrl(source_url):f[0]).trim();
   const category=f[k+1]||'';
   if(title.length<5||title.length>180)throw bad('Linha '+(i+1)+': informe Nome | URL | Categoria para identificar o produto.');
   if(category.length>60)throw bad('Categoria muito longa na linha '+(i+1)+'.');
   return {title,source_url,category};
 });
}
export async function createLinkBatch(env,body){
 const selected=parseSelection(body?.text);
 await ensureLinkBatches(env);await ensureAutomationCenter(env);
 const categories=(await env.DB.prepare('SELECT * FROM affiliate_group_categories WHERE enabled=1 ORDER BY name').all()).results;
 const rows=selected.map(x=>{
   const c=classifyProduct(x.title,x.category,categories);
   if(x.category&&x.category!=='Geral'&&!c.category)throw bad('Categoria inexistente ou desativada: '+x.category);
   return {...x,category:c.category?.name||'Geral',classification:c.classification};
 });
 const t=now();
 const created=await env.DB.prepare("INSERT INTO ml_link_batches(status,created_at,updated_at) VALUES('awaiting_links',?,?)").bind(t,t).run();
 const id=Number(created.meta?.last_row_id);
 try{
   await env.DB.batch(rows.map((x,i)=>env.DB.prepare(
     'INSERT INTO ml_link_batch_items(batch_id,position,title,source_url,category,classification) VALUES(?,?,?,?,?,?)'
   ).bind(id,i+1,x.title,x.source_url,x.category,x.classification)));
 }catch(e){
   await env.DB.prepare("DELETE FROM ml_link_batches WHERE id=? AND status='awaiting_links'").bind(id).run();throw e;
 }
 return readLinkBatch(env,id);
}
export async function readLinkBatch(env,id){
 await ensureLinkBatches(env);
 const n=Number(id);
 if(!Number.isSafeInteger(n)||n<1)throw bad('Lote inválido.');
 const batch=await env.DB.prepare('SELECT * FROM ml_link_batches WHERE id=?').bind(n).first();
 if(!batch)throw bad('Lote não encontrado.',404);
 const result=await env.DB.prepare(
  "SELECT i.id,i.position,i.title,i.source_url,i.category,i.classification,i.affiliate_url,i.offer_id,"+
  "CASE WHEN skipped.item_id IS NOT NULL THEN 'ineligible' ELSE i.status END AS status,"+
  "skipped.reason AS ineligible_reason "+
  "FROM ml_link_batch_items i LEFT JOIN ml_link_batch_ineligible skipped ON skipped.item_id=i.id "+
  "WHERE i.batch_id=? ORDER BY i.position"
 ).bind(n).all();
 return {batch,items:result.results};
}
export async function listLinkBatches(env){
 await ensureLinkBatches(env);
 // Relatórios já convertidos saem da ferramenta; o histórico interno permanece no D1.
 const recent=(await env.DB.prepare("SELECT id,status,created_at,imported_at FROM ml_link_batches WHERE status='awaiting_links' ORDER BY id DESC LIMIT 15").all()).results;
 const awaiting=recent.find(x=>x.status==='awaiting_links');
 return {recent,current:awaiting?await readLinkBatch(env,awaiting.id):null};
}
// A exportação oficial devolve uma linha por produto: alguns são recusados
// pelo Programa. Não eliminar linhas: isso deslocaria TODOS os links seguintes.
export const INELIGIBLE_MARKER='Este produto não cumpre com os requisitos do Programa.';
export function isIneligibleWarning(line){
 return /^\s*(?:⚠️?\s*)?este produto não cumpre com os requisitos do programa\.?\s*$/iu
   .test(String(line||''));
}
export function validatePairs(items,links){
 if(!Array.isArray(links)||items.length!==links.length||!items.length||items.length>50)
   throw bad('Cole uma linha para CADA produto, incluindo os avisos de não elegibilidade.');
 const seen=new Set();
 const result=links.map((v,i)=>{
   if(v?.ineligible===true){
     if(v?.affiliate_url)throw bad('Linha '+(i+1)+': não misture aviso de produto inelegível com link.');
     if(v?.reason!=='program_ineligible')throw bad('Linha '+(i+1)+': justificativa de não elegibilidade inválida.');
     return {ineligible:true,reason:v.reason,source:items[i]};
   }
   const affiliate_url=validateAffiliateUrl(v?.affiliate_url);
   if(seen.has(affiliate_url))throw bad('O mesmo link foi colado mais de uma vez.');
   seen.add(affiliate_url);
   const a=productId(items[i].source_url),b=productId(affiliate_url);
   if(a&&b&&a!==b)throw bad('O link da linha '+(i+1)+' parece pertencer a outro produto.');
   return {affiliate_url,source:items[i]};
 });
 if(!result.some(x=>!x.ineligible))
   throw bad('Este lote não possui links convertidos válidos.');
 return result;
}
export async function importLinkBatch(env,id,body){
 const data=await readLinkBatch(env,id);
 if(data.batch.status!=='awaiting_links')throw bad('Este lote já foi importado.',409);
 if(body?.owner_confirmation!==true||body?.pairing_confirmation!==true)
   throw bad('Confirme a origem dos links e que cada link convertido corresponde ao produto exibido.');
 const pairs=validatePairs(data.items,body?.links);
 await ensureAutomationCenter(env);
 const cats=(await env.DB.prepare('SELECT name FROM affiliate_group_categories WHERE enabled=1').all()).results;
 const skipped=pairs.filter(x=>x.ineligible);
 const chosen=pairs.filter(x=>!x.ineligible).map(x=>{
   const i=x.source.position-1;
   const c=String(body.links[i].category||x.source.category||'').trim();
   if(c!=='Geral'&&!cats.some(y=>y.name.toLocaleLowerCase('pt-BR')===c.toLocaleLowerCase('pt-BR')))
     throw bad('Categoria não cadastrada na linha '+(i+1)+'.');
   return {...x,category:c||'Geral'};
 });
 await ensureWhatsAppTables(env);
 const allowed=await getPrimaryCategory(env);
 if(chosen.some(x=>!categoryMatches(x.category,allowed)))
   throw bad('Seu canal principal aceita somente '+allowed+'. Ajuste a categoria do canal ou do lote.');
 const urls=chosen.map(x=>x.affiliate_url),qs=urls.map(()=>'?').join(',');
 const queries=[
   'SELECT affiliate_url FROM offers WHERE affiliate_url IN ('+qs+')',
   'SELECT affiliate_url FROM channel_offers WHERE affiliate_url IN ('+qs+')',
   'SELECT affiliate_url FROM whatsapp_direct_offers WHERE affiliate_url IN ('+qs+')'
 ];
 const duplicates=await Promise.all(queries.map(sql=>env.DB.prepare(sql).bind(...urls).all()));
 if(duplicates.some(r=>r.results.length))throw bad('Um dos links já está cadastrado em outra fila. Revise antes de continuar.',409);
 const t=now(),ops=[],sourceDeals=new Map();
 // Registre os dois avisos em uma operação transacional, sem acrescentar
 // ofertas e sem consumir um link convertido de outra posição.
 for(const item of skipped){
   ops.push(env.DB.prepare(
     'INSERT INTO ml_link_batch_ineligible(item_id,batch_id,reason,created_at) VALUES(?,?,?,?)'
   ).bind(item.source.id,Number(id),item.reason,t));
 }
 // A janela de sete dias começa ao colocar o produto monitorado na fila.
 // O preço usado na comparação é o que foi registrado ao preparar este lote.
 const hasMonitor=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ml_monitor_links'").first();
 if(hasMonitor){
   const captured=(await env.DB.prepare("SELECT l.product_id,l.source_url,m.pending_deal_json,m.pending_captured_at,sp.price_cents AS site_price_cents,sp.status AS site_status,sp.checked_at AS site_checked_at FROM ml_monitor_links l JOIN ml_monitor_product_meta m ON m.product_id=l.product_id LEFT JOIN ml_monitor_site_prices sp ON sp.product_id=l.product_id WHERE l.batch_id=? AND l.status='batched'").bind(Number(id)).all()).results;
   const chosenSources=new Set(chosen.map(x=>x.source.source_url));
   for(const item of captured){
     if(!chosenSources.has(item.source_url))continue;
     sourceDeals.set(item.source_url,item);
     ops.push(env.DB.prepare("INSERT OR IGNORE INTO ml_monitor_product_meta(product_id,last_seen_at) VALUES(?,0)").bind(item.product_id));
     ops.push(env.DB.prepare("UPDATE ml_monitor_product_meta SET last_queued_at=?,last_queued_price_cents=pending_price_cents,pending_batch_id=NULL,pending_price_cents=NULL,pending_deal_json=NULL,pending_captured_at=NULL WHERE product_id=? AND (pending_batch_id=? OR pending_batch_id IS NULL)")
       .bind(t,item.product_id,Number(id)));
   }
 }
 chosen.forEach(x=>{
   const source=sourceDeals.get(x.source.source_url);
   const groupPromo=safePromotionTerms(source?.pending_deal_json);
   const checkedAt=Number(source?.site_checked_at);
   const sitePrice=Number(source?.site_price_cents);
   const verifiedSite=source?.site_status==='ok'&&Number.isSafeInteger(sitePrice)&&sitePrice>0
     &&Number.isSafeInteger(checkedAt)&&checkedAt>0&&t-checkedAt>=0&&t-checkedAt<=6*60*60;
   // A mensagem do grupo tem prioridade. O preço oficial serve somente como
   // alternativa quando falta preço confiável na legenda do WhatsApp.
   const useSite=verifiedSite&&!(Number.isSafeInteger(groupPromo?.price_cents)&&groupPromo.price_cents>0);
   const promo=useSite?{
     price_cents:sitePrice,old_price_cents:null,price_source:'mercadolivre',
     payment_mode:groupPromo?.payment_mode||'unspecified',
     installments:groupPromo?.installments??null,
     installment_cents:groupPromo?.installment_cents??null,
     installments_no_interest:groupPromo?.installments_no_interest||false,
     card_price_cents:groupPromo?.card_price_cents??null,
     coupon_required:false,coupon_code:null
   }:groupPromo;
   const capturedAt=useSite?checkedAt:Number(source?.pending_captured_at);
   const offer=normalizeOffer({title:x.source.title,affiliate_url:x.affiliate_url,category:x.category,
     price:promo?.price_cents!=null?(promo.price_cents/100).toFixed(2):null,
     old_price:promo?.old_price_cents!=null?(promo.old_price_cents/100).toFixed(2):null,
     owner_confirmation:true});
   ops.push(env.DB.prepare("INSERT INTO offers(title,affiliate_url,category,price_cents,old_price_cents,promo_terms_json,promo_captured_at,created_at,status) VALUES(?,?,?,?,?,?,?,?,'ready')")
     .bind(offer.title,offer.affiliate_url,offer.category,offer.price_cents,offer.old_price_cents,
       promo?JSON.stringify(promo):null,promo&&Number.isSafeInteger(capturedAt)&&capturedAt>0?capturedAt:null,t));
   ops.push(env.DB.prepare("UPDATE ml_link_batch_items SET affiliate_url=?,offer_id=(SELECT id FROM offers WHERE affiliate_url=?),category=?,status='queued' WHERE id=? AND batch_id=? AND status='awaiting_links'")
     .bind(x.affiliate_url,x.affiliate_url,x.category,x.source.id,Number(id)));
 });
 ops.push(env.DB.prepare("UPDATE ml_link_batches SET status='imported',imported_at=?,updated_at=? WHERE id=? AND status='awaiting_links'").bind(t,t,Number(id)));
 if(typeof env.DB.batch!=='function')throw bad('O banco não oferece importação transacional.',503);
 await env.DB.batch(ops);
 for(const x of chosen)try{
   await upsertProductCategory(env,'mercadolivre',{title:x.source.title,affiliate_url:x.affiliate_url,category:x.category});
 }catch(err){console.warn('Classificação pendente:',String(err.message||err).slice(0,100));}
 return {ok:true,batch_id:Number(id),queued:chosen.length,ineligible:skipped.length};
}
