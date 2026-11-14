import {classifyProduct,ensureAutomationCenter} from './automation-center.js';
import {createLinkBatch,productId,validateSourceUrl,ensureLinkBatches} from './link-batches.js';
import {listWhatsAppGroups} from './whatsapp.js';
import {canRequeueProduct} from './monitor-repeat-policy.js';
import {extractPromotionTerms,promotionDescription} from './promotion-terms.js';

const SCHEMA=[
 "CREATE TABLE IF NOT EXISTS ml_monitor_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)",
 "INSERT OR IGNORE INTO ml_monitor_settings(id,enabled,updated_at) VALUES(1,0,0)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_groups(id INTEGER PRIMARY KEY AUTOINCREMENT,instance_name TEXT NOT NULL,group_jid TEXT NOT NULL,group_name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,authorized INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,UNIQUE(instance_name,group_jid))",
 "CREATE TABLE IF NOT EXISTS ml_monitor_links(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL REFERENCES ml_monitor_groups(id),message_id TEXT NOT NULL DEFAULT '',product_id TEXT NOT NULL UNIQUE,source_url TEXT NOT NULL,title TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'Geral',classification TEXT NOT NULL DEFAULT 'needs_review',status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','batched')),batch_id INTEGER,created_at INTEGER NOT NULL)",
 "CREATE INDEX IF NOT EXISTS idx_ml_monitor_links_queue ON ml_monitor_links(status,category,id)",
 "CREATE TABLE IF NOT EXISTS ml_monitor_shortlinks(id INTEGER PRIMARY KEY AUTOINCREMENT,group_id INTEGER NOT NULL REFERENCES ml_monitor_groups(id),message_id TEXT NOT NULL DEFAULT '',short_url TEXT NOT NULL UNIQUE,message_hint TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','review','resolved')),tries INTEGER NOT NULL DEFAULT 0,reason TEXT,created_at INTEGER NOT NULL)"
];
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const epoch=()=>Math.floor(Date.now()/1000);
const GROUP=/^\d{6,30}(?:-\d{6,20})?@g\.us$/;
const INSTANCE=/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/;
const HOSTS=new Set(['www.mercadolivre.com.br','mercadolivre.com.br','produto.mercadolivre.com.br']);
export async function ensureMonitor(env){for(const query of SCHEMA)await env.DB.prepare(query).run();await ensureLinkBatches(env);}
export function extractUrls(text){
 if(typeof text!=='string')return [];
 return [...new Set((text.slice(0,8000).match(/https:\/\/[^\s<>"'()[\]{}]+/gi)||[])
  .map(s=>s.replace(/[.,;!?]+$/g,'')))].slice(0,30);
}
export function parseMonitorEvent(event){
 if(!event||typeof event!=='object'||!['messages.upsert','MESSAGES_UPSERT','messages-upsert'].includes(event.event))return [];
 const instance=typeof event.instance==='string'?event.instance:'';
 if(!INSTANCE.test(instance))return [];
 const input=Array.isArray(event.data)?event.data:Array.isArray(event.data?.messages)?event.data.messages:[event.data];
 const result=[];
 for(const entry of input.slice(0,25)){
   if(!entry||entry.key?.fromMe!==false||typeof entry.key.remoteJid!=='string'||!GROUP.test(entry.key.remoteJid))continue;
   const msg=entry.message?.ephemeralMessage?.message||entry.message?.viewOnceMessage?.message||entry.message||{};
   const text=[msg.conversation,msg.extendedTextMessage?.text,msg.imageMessage?.caption,
     msg.videoMessage?.caption,msg.documentMessage?.caption,msg.buttonsResponseMessage?.selectedDisplayText]
     .filter(v=>typeof v==='string'&&v).join('\n').slice(0,8000);
   const urls=extractUrls(text);
   if(!urls.length)continue;
   // Guarde apenas a descrição curta da oferta, sem conteúdo de conversas ou links de rastreamento.
   const hint=urls.length===1?text.replace(/https:\/\/[^\s<>"'()[\]{}]+/gi,'').replace(/\s+/g,' ').trim().slice(0,180):'';
   result.push({instance,group_jid:entry.key.remoteJid,message_id:String(entry.key.id||'').slice(0,150),hint,urls});
 }
 return result;
}
function urlCandidate(input){
 let u;try{u=new URL(input);}catch{return null;}
 if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
 if(u.hostname.toLowerCase()==='meli.la'&&/^\/[A-Za-z0-9_-]{5,50}\/?$/.test(u.pathname)){
   u.search='';u.hash='';return {kind:'short',url:u.href};
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
export async function monitorState(env){
 await ensureMonitor(env);
 const [settings,groups,links,pending,categories]=await Promise.all([
  env.DB.prepare('SELECT enabled,updated_at FROM ml_monitor_settings WHERE id=1').first(),
  env.DB.prepare('SELECT id,instance_name,group_jid,group_name,enabled,created_at FROM ml_monitor_groups ORDER BY id DESC LIMIT 100').all(),
  env.DB.prepare("SELECT l.id,l.product_id,l.title,l.source_url,l.category,l.classification,l.status,l.created_at,g.group_name,m.last_seen_price_cents,m.last_queued_at FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id LEFT JOIN ml_monitor_product_meta m ON m.product_id=l.product_id ORDER BY l.id DESC LIMIT 200").all(),
  env.DB.prepare("SELECT status,COUNT(*) AS total FROM ml_monitor_shortlinks GROUP BY status").all(),
  (async()=>{await ensureAutomationCenter(env);return env.DB.prepare('SELECT name FROM affiliate_group_categories WHERE enabled=1 ORDER BY name').all()})()
 ]);
 return {enabled:!!settings?.enabled,webhook_secret_configured:typeof env.MONITOR_WEBHOOK_TOKEN==='string'&&env.MONITOR_WEBHOOK_TOKEN.length>=24,
   groups:groups.results,links:links.results.map(x=>({...x,promotion:promotionDescription(x.last_seen_deal_json)})),shortlinks:pending.results,categories:categories.results.map(x=>x.name)};
}
export async function saveMonitorSettings(env,body){
 await ensureMonitor(env);
 if(typeof body?.enabled!=='boolean')throw fail('Informe se o monitoramento deve ficar ativo ou desativado.');
 if(body.enabled){
   if(!env.MONITOR_WEBHOOK_TOKEN||env.MONITOR_WEBHOOK_TOKEN.length<24)
     throw fail('Antes de ativar, configure o Secret MONITOR_WEBHOOK_TOKEN no Worker da Cloudflare.');
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
export async function ingestMonitorEvent(env,payload){
 await ensureMonitor(env);
 const state=await env.DB.prepare('SELECT enabled FROM ml_monitor_settings WHERE id=1').first();
 if(!state?.enabled)return {ok:true,ignored:'monitor_off'};
 const messages=parseMonitorEvent(payload);
 if(!messages.length)return {ok:true,accepted:0};
 const groupList=(await env.DB.prepare('SELECT id,instance_name,group_jid FROM ml_monitor_groups WHERE enabled=1 AND authorized=1').all()).results;
 let captured=0,pending=0;
 for(const msg of messages){
   const group=groupList.find(x=>x.instance_name===msg.instance&&x.group_jid===msg.group_jid);
   if(!group)continue;
   const entry={...msg,group_id:group.id};
   for(const raw of msg.urls){
     const candidate=urlCandidate(raw);
     if(!candidate)continue;
     if(candidate.kind==='short'){
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
 return {ok:true,captured,pending};
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
async function redirectSource(value){
 let current=value;
 for(let hop=0;hop<5;hop++){
   let u;
   try{u=new URL(current);}catch{return null;}
   if(u.protocol!=='https:'||u.username||u.password||u.port||(!HOSTS.has(u.hostname.toLowerCase())&&u.hostname.toLowerCase()!=='meli.la'))return null;
   const known=urlCandidate(u.href);
   if(known?.kind==='product')return known;
   const response=await fetch(current,{redirect:'manual',method:'GET',signal:AbortSignal.timeout(4000)});
   if(![301,302,303,307,308].includes(response.status))return null;
   const to=response.headers.get('location');
   if(!to)return null;
   current=new URL(to,current).href;
 }
 return null;
}
export async function resolveMonitorShortlinks(env){
 await ensureMonitor(env);
 const state=await env.DB.prepare('SELECT enabled FROM ml_monitor_settings WHERE id=1').first();
 if(!state?.enabled)return {skipped:'disabled'};
 const items=(await env.DB.prepare("SELECT s.*,g.instance_name,g.group_jid FROM ml_monitor_shortlinks s JOIN ml_monitor_groups g ON g.id=s.group_id WHERE s.status='pending' AND g.enabled=1 ORDER BY s.id LIMIT 5").all()).results;
 let resolved=0;
 for(const s of items){
   try{
     const product=await redirectSource(s.short_url);
     if(!product){await env.DB.prepare("UPDATE ml_monitor_shortlinks SET status='review',tries=tries+1,reason='Sem destino seguro de produto' WHERE id=?").bind(s.id).run();continue;}
     await saveProduct(env,{group_id:s.group_id,message_id:s.message_id,hint:s.message_hint},product);
     await env.DB.prepare("UPDATE ml_monitor_shortlinks SET status='resolved',tries=tries+1,reason=NULL WHERE id=?").bind(s.id).run();
     resolved++;
   }catch(error){
     await env.DB.prepare("UPDATE ml_monitor_shortlinks SET status=CASE WHEN tries>=2 THEN 'review' ELSE 'pending' END,tries=tries+1,reason='Falha temporária ao conferir link' WHERE id=?").bind(s.id).run();
   }
 }
 return {resolved};
}
