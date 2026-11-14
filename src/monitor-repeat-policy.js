// Regra isolada de repetição do monitor Mercado Livre. Não altera os envios existentes.
export const REPEAT_WINDOW_SECONDS=7*24*60*60;
export const REPEAT_META_SCHEMA="CREATE TABLE IF NOT EXISTS ml_monitor_product_meta(product_id TEXT PRIMARY KEY,last_seen_price_cents INTEGER,last_seen_at INTEGER NOT NULL DEFAULT 0,pending_batch_id INTEGER,pending_price_cents INTEGER,last_queued_at INTEGER NOT NULL DEFAULT 0,last_queued_price_cents INTEGER)";

export async function ensureRepeatMeta(env){
 await env.DB.prepare(REPEAT_META_SCHEMA).run();
 const current=new Set((await env.DB.prepare("PRAGMA table_info(ml_monitor_product_meta)").all()).results.map(x=>x.name));
 for(const [name,type] of [['last_seen_deal_json','TEXT'],['pending_deal_json','TEXT'],['pending_captured_at','INTEGER']]){
   if(!current.has(name))await env.DB.prepare('ALTER TABLE ml_monitor_product_meta ADD COLUMN '+name+' '+type).run();
 }
}
export async function ensureOfferPromoColumns(env){
 const current=new Set((await env.DB.prepare('PRAGMA table_info(offers)').all()).results.map(x=>x.name));
 for(const [name,type] of [['promo_terms_json','TEXT'],['promo_captured_at','INTEGER']]){
   if(!current.has(name))await env.DB.prepare('ALTER TABLE offers ADD COLUMN '+name+' '+type).run();
 }
}


function cents(amount){
 if(!/^\d{1,6}(?:\.\d{3})*(?:,\d{2})?$/.test(amount))return null;
 const normalized=amount.replace(/\./g,'').replace(',','.');
 const n=Math.round(Number(normalized)*100);
 return Number.isSafeInteger(n)&&n>0&&n<=99999999?n:null;
}
// Apenas preço explicitamente associado à oferta na mensagem. Evita confundir
// "de R$ 199 por R$ 149" ou múltiplas promoções com o preço correto.
export function extractOfferPriceCents(hint){
 if(typeof hint!=='string'||!hint)return null;
 const text=hint.slice(0,1000);
 const pattern=/R\$\s*(\d{1,6}(?:\.\d{3})*(?:,\d{2})?)(?![\d.,])/gi;
 const seen=[...text.matchAll(pattern)].map(m=>({
  value:cents(m[1]),
  before:text.slice(Math.max(0,m.index-24),m.index).trim().toLocaleLowerCase('pt-BR')
 })).filter(m=>m.value!==null);
 if(seen.length===0)return null;
 if(seen.length===1)return seen[0].value;
 const marked=seen.filter(m=>/(?:^|[\s:;,])(?:por|agora|apenas|hoje|a\s+partir\s+de)\s*(?:[:=-]\s*)?$/.test(m.before));
 // Mais de um preço final candidato é ambíguo: nunca habilita repetição.
 return marked.length===1?marked[0].value:null;
}

export function canRequeueProduct(lastQueuedAt,lastQueuedPrice,newPrice,currentTime){
 if(!Number.isSafeInteger(lastQueuedAt)||lastQueuedAt<=0)return false;
 if(currentTime-lastQueuedAt>=REPEAT_WINDOW_SECONDS)return true;
 return Number.isSafeInteger(lastQueuedPrice)&&lastQueuedPrice>0 &&
  Number.isSafeInteger(newPrice)&&newPrice>0 &&newPrice!==lastQueuedPrice;
}
