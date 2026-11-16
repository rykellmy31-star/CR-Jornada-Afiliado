// Classificação automática das ofertas copiadas a partir do preditor PÚBLICO e
// OFICIAL de categorias do Mercado Livre (MLB).
// Não inventa categorias por IA, não usa tokens de afiliado e nunca altera
// categorias escolhidas manualmente nem o encaminhamento dos destinos.
import {ensureMonitor} from './whatsapp-link-monitor.js';
import {ensureAutomationCenter} from './automation-center.js';

const TABLE_MAP="CREATE TABLE IF NOT EXISTS ml_monitor_official_category_map ("+
 "ml_category_id TEXT PRIMARY KEY,domain_id TEXT NOT NULL,official_label TEXT NOT NULL,"+
 "group_category_id INTEGER NOT NULL REFERENCES affiliate_group_categories(id),created_at INTEGER NOT NULL)";
const TABLE_ITEMS="CREATE TABLE IF NOT EXISTS ml_monitor_official_category_items ("+
 "product_id TEXT PRIMARY KEY,ml_category_id TEXT NOT NULL,domain_id TEXT NOT NULL,"+
 "official_label TEXT NOT NULL,group_category_id INTEGER NOT NULL,classified_at INTEGER NOT NULL)";
const TABLE_RETRY="CREATE TABLE IF NOT EXISTS ml_monitor_official_category_retry ("+
 "product_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,"+
 "next_retry_at INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '')";
const TABLE_STATE="CREATE TABLE IF NOT EXISTS ml_monitor_official_category_state ("+
 "id INTEGER PRIMARY KEY CHECK(id=1),lease_until INTEGER NOT NULL DEFAULT 0,last_run_at INTEGER NOT NULL DEFAULT 0,"+
 "last_classified INTEGER NOT NULL DEFAULT 0,last_created INTEGER NOT NULL DEFAULT 0,last_reused INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '')";
const now=()=>Math.floor(Date.now()/1000);
const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
 .toLocaleLowerCase('pt-BR').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const safeLabel=value=>{
 const candidate=String(value||'').replace(/\s+/g,' ').trim();
 return candidate.length>=3&&candidate.length<=60&&/^[\p{L}\p{N} &/()\-]+$/u.test(candidate)?candidate:null;
};
export async function ensureOfficialCategories(env){
 await ensureMonitor(env);
 await ensureAutomationCenter(env);
 for(const sql of [TABLE_MAP,TABLE_ITEMS,TABLE_RETRY,TABLE_STATE])await env.DB.prepare(sql).run();
 await env.DB.prepare('INSERT OR IGNORE INTO ml_monitor_official_category_state(id) VALUES(1)').run();
}
export function readOfficialPrediction(data){
 if(!Array.isArray(data)||!data.length)return null;
 const first=data[0];
 if(!first||typeof first!=='object'||!/^MLB\d{3,12}$/.test(String(first.category_id||'')))return null;
 const domain=String(first.domain_id||'');
 if(domain&&!/^MLB-[A-Z0-9_]{3,100}$/.test(domain))return null;
 const officialLabel=safeLabel(first.domain_name)||safeLabel(first.category_name);
 if(!officialLabel)return null;
 return {category_id:first.category_id,domain_id:domain,official_label:officialLabel,
   category_name:safeLabel(first.category_name)};
}
export async function predictOfficialCategory(title,{fetcher=fetch}={}){
 const text=String(title||'').replace(/\s+/g,' ').trim().slice(0,170);
 if(text.length<6||/^Produto Mercado Livre MLB/i.test(text))return null;
 const url='https://api.mercadolibre.com/sites/MLB/domain_discovery/search?q='+encodeURIComponent(text);
 let response;
 try{
  response=await fetcher(url,{
   method:'GET',redirect:'manual',headers:{accept:'application/json'},
   signal:AbortSignal.timeout(10000)
  });
 }catch{return {error:'Consulta pública do Mercado Livre indisponível'};}
 if(response.status===429||response.status===403||response.status===401)
  return {error:'Mercado Livre limitou a consulta de categorias (HTTP '+response.status+')'};
 if(!response.ok)return {error:'Consulta de categoria retornou HTTP '+response.status};
 const mime=String(response.headers.get('content-type')||'');
 if(mime&&!/application\/json/i.test(mime))return {error:'Resposta não JSON do Mercado Livre'};
 let data;try{
  const body=await response.text();
  if(body.length>300000)return {error:'Resposta de categoria muito grande'};
  data=JSON.parse(body);
 }catch{return {error:'Resposta de categoria ilegível'};}
 const prediction=readOfficialPrediction(data);
 return prediction||{error:'Mercado Livre não informou categoria confiável para o produto'};
}
// Título genérico ou preditor indisponível: consultar a categoria do anúncio
// oficial pelo código MLB. Só aceita o ID e o nome devolvidos pela própria API.
export async function lookupOfficialItemCategory(productId,{fetcher=fetch}={}){
 const id=String(productId||'').trim();
 if(!/^MLB\d{6,15}$/.test(id))return null;
 async function getJson(url){
  try{
   const response=await fetcher(url,{method:'GET',redirect:'manual',
    headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
   if(!response.ok)return null;
   const mime=String(response.headers.get('content-type')||'');
   if(mime&&!/application\/json/i.test(mime))return null;
   const body=await response.text();
   return body.length<=100000?JSON.parse(body):null;
  }catch{return null;}
 }
 const item=await getJson('https://api.mercadolibre.com/items/'+id+'?attributes=id,title,category_id,domain_id');
 if(!item||item.id!==id||!/^MLB\d{3,12}$/.test(String(item.category_id||'')))return null;
 const category=await getJson('https://api.mercadolibre.com/categories/'+item.category_id);
 const label=category?.id===item.category_id?safeLabel(category.name):null;
 if(!label)return null;
 const domain=String(item.domain_id||'');
 return {category_id:item.category_id,
  domain_id:/^MLB-[A-Z0-9_]{3,100}$/.test(domain)?domain:'',
  official_label:label,category_name:label};
}
function matchExisting(categories,official){
 // ID oficial prevalece, depois nome exato (acentos, caixa e espaços).
 // Nunca escolhe categoria pela primeira palavra do título; isso causaria
 // erros como shampoo automotivo colocado em Beleza.
 const normalized=new Set([official.official_label,official.category_name].filter(Boolean).map(normalize));
 return categories.find(c=>normalized.has(normalize(c.name)))||null;
}
export async function officialCategoryStats(env){
 await ensureOfficialCategories(env);
 const [state,pending]=await Promise.all([
  env.DB.prepare('SELECT * FROM ml_monitor_official_category_state WHERE id=1').first(),
  env.DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id "+
   "LEFT JOIN ml_link_batches b ON b.id=l.batch_id "+
   "WHERE (l.status='available' OR (l.status='batched' AND b.status='awaiting_links')) "+
   "AND g.authorized=1 "+
   "AND l.classification<>'selected' AND (l.classification='needs_review' OR l.category='Geral' OR trim(l.category)='')").first()
 ]);
 return {waiting:Number(pending?.total||0),last_run_at:Number(state?.last_run_at||0),
  last_classified:Number(state?.last_classified||0),last_created:Number(state?.last_created||0),
  last_reused:Number(state?.last_reused||0),last_error:String(state?.last_error||'')};
}
// Enriquecimento por lote: executa mesmo com painel fechado. Nunca enfileira
// ou envia mensagens; somente atualiza categorias de produtos disponíveis.
export async function classifyMonitorMissingCategories(env,{fetcher=fetch,limit=12,at=null,preferRecent=false}={}){
 if(!env?.DB)return {skipped:'database'};
 await ensureOfficialCategories(env);
 const stamp=Number.isSafeInteger(at)&&at>0?at:now();
 const cap=Math.min(16,Math.max(1,Number.isSafeInteger(limit)?limit:12));
 const lease=stamp+180;
 const acquired=await env.DB.prepare(
  'UPDATE ml_monitor_official_category_state SET lease_until=? WHERE id=1 AND lease_until<=?'
 ).bind(lease,stamp).run();
 if(acquired.meta?.changes!==1)return {skipped:'already_running'};
 let classified=0,created=0,reused=0,failed=0;
 const errors=[];
 try{
  const rows=(await env.DB.prepare(
   "SELECT l.id,l.product_id,l.title,l.category,l.classification "+
   "FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id "+
   "LEFT JOIN ml_monitor_official_category_retry r ON r.product_id=l.product_id "+
   "LEFT JOIN ml_link_batches b ON b.id=l.batch_id "+
   "WHERE (l.status='available' OR (l.status='batched' AND b.status='awaiting_links')) "+
   "AND g.authorized=1 "+
   "AND l.classification<>'selected' AND (l.category='Geral' OR trim(l.category)='' OR l.classification<>'mercadolivre') "+
   "AND COALESCE(r.next_retry_at,0)<=? "+
   "ORDER BY CASE WHEN l.category='Geral' OR l.classification='needs_review' THEN 0 ELSE 1 END,l.id "+(preferRecent?"DESC":"ASC")+" LIMIT ?"
  ).bind(stamp,cap).all()).results;
  // Busca em paralelo, mas a escrita no banco segue serial para não duplicar categorias.
  const predictions=[];
  for(let i=0;i<rows.length;i+=4){
   predictions.push(...await Promise.all(rows.slice(i,i+4).map(async row=>{
    const existing=await env.DB.prepare(
     'SELECT c.id,c.name,c.enabled FROM ml_monitor_official_category_items oc '+
     'JOIN affiliate_group_categories c ON c.id=oc.group_category_id WHERE oc.product_id=?'
    ).bind(row.product_id).first();
    if(existing)return {cached_category:existing};
    const predicted=await predictOfficialCategory(row.title,{fetcher});
    if(predicted&&!predicted.error)return predicted;
    return await lookupOfficialItemCategory(row.product_id,{fetcher})||predicted||
     {error:'A API do Mercado Livre não retornou categoria para o produto'};
   })));
  }
  for(let i=0;i<rows.length;i++){
   const row=rows[i],prediction=predictions[i];
   if(!prediction||prediction.error){
    failed++;
    const message=String(prediction?.error||'Título do produto insuficiente para a categorização oficial').slice(0,150);
    errors.push(message);
    // 10min, 30min, 2h, 6h... consultas limitadas, sem tempestade de requests.
    await env.DB.prepare('INSERT INTO ml_monitor_official_category_retry(product_id,attempts,next_retry_at,last_error) VALUES(?,1,?,?) '+
     'ON CONFLICT(product_id) DO UPDATE SET attempts=attempts+1,next_retry_at=?,last_error=?')
     .bind(row.product_id,stamp+600,message,stamp+Math.min(21600,600*Math.pow(3,Math.min(4,Number((await env.DB.prepare('SELECT attempts FROM ml_monitor_official_category_retry WHERE product_id=?').bind(row.product_id).first())?.attempts||1)))),message).run();
    continue;
   }
   const existingMap=prediction.cached_category?null:await env.DB.prepare(
    'SELECT group_category_id FROM ml_monitor_official_category_map WHERE ml_category_id=?'
   ).bind(prediction.category_id).first();
   const categories=prediction.cached_category?[]:
    (await env.DB.prepare('SELECT id,name,enabled FROM affiliate_group_categories').all()).results;
   const old=existingMap?categories.find(c=>c.id===existingMap.group_category_id):null;
   let cat=prediction.cached_category||old||matchExisting(categories,prediction);
   if(!cat){
    const result=await env.DB.prepare('INSERT OR IGNORE INTO affiliate_group_categories(name,keywords,enabled,created_at,updated_at) VALUES(?,?,1,?,?)')
     .bind(prediction.official_label,'',stamp,stamp).run();
    cat=await env.DB.prepare('SELECT id,name,enabled FROM affiliate_group_categories WHERE name=? COLLATE NOCASE')
     .bind(prediction.official_label).first();
    if(result.meta?.changes===1)created++;else reused++;
   }else reused++;
   if(!cat){failed++;errors.push('A categoria oficial não pôde ser salva');continue;}
   if(!prediction.cached_category)await env.DB.prepare('INSERT OR IGNORE INTO ml_monitor_official_category_map(ml_category_id,domain_id,official_label,group_category_id,created_at) VALUES(?,?,?,?,?)')
    .bind(prediction.category_id,prediction.domain_id,prediction.official_label,cat.id,stamp).run();
   // Nunca reabilitar categorias que o proprietário desativou. Quando ele
   // decidir ativar novamente, a tarefa reusa o mesmo mapeamento, sem criar outra.
   if(cat.enabled!==1){
    failed++;
    const reason='Categoria existente desativada: '+cat.name;
    errors.push(reason);
    await env.DB.prepare('INSERT INTO ml_monitor_official_category_retry(product_id,attempts,next_retry_at,last_error) VALUES(?,1,?,?) '+
     'ON CONFLICT(product_id) DO UPDATE SET attempts=attempts+1,next_retry_at=excluded.next_retry_at,last_error=excluded.last_error')
     .bind(row.product_id,stamp+600,reason).run();
    continue;
   }
   if(!prediction.cached_category)await env.DB.prepare('INSERT INTO ml_monitor_official_category_items(product_id,ml_category_id,domain_id,official_label,group_category_id,classified_at) VALUES(?,?,?,?,?,?) '+
    'ON CONFLICT(product_id) DO UPDATE SET ml_category_id=excluded.ml_category_id,domain_id=excluded.domain_id,official_label=excluded.official_label,group_category_id=excluded.group_category_id,classified_at=excluded.classified_at')
    .bind(row.product_id,prediction.category_id,prediction.domain_id,prediction.official_label,cat.id,stamp).run();
   const updated=await env.DB.prepare(
    "UPDATE ml_monitor_links SET category=?,classification='mercadolivre' "+
    "WHERE id=? AND (status='available' OR "+
    "(status='batched' AND EXISTS(SELECT 1 FROM ml_link_batches b "+
    "WHERE b.id=ml_monitor_links.batch_id AND b.status='awaiting_links'))) "+
    "AND classification<>'selected' AND (category='Geral' OR trim(category)='' OR classification<>'mercadolivre')"
   ).bind(cat.name,row.id).run();
   classified+=Number(updated.meta?.changes||0);
   await env.DB.prepare('DELETE FROM ml_monitor_official_category_retry WHERE product_id=?').bind(row.product_id).run();
  }
  const lastError=errors[0]||'';
  await env.DB.prepare('UPDATE ml_monitor_official_category_state SET last_run_at=?,last_classified=?,last_created=?,last_reused=?,last_error=? WHERE id=1')
   .bind(stamp,classified,created,reused,lastError).run();
  return {processed:classified+failed,classified,created,reused,failed,error:lastError||null};
 }finally{
  await env.DB.prepare('UPDATE ml_monitor_official_category_state SET lease_until=0 WHERE id=1 AND lease_until=?').bind(lease).run();
 }
}
