import {classifyProduct,ensureAutomationCenter} from './automation-center.js';
import {createLinkBatch,productId,validateSourceUrl,ensureLinkBatches} from './link-batches.js';
import {listWhatsAppGroups,evolutionOrigin} from './whatsapp.js';
import {canRequeueProduct} from './monitor-repeat-policy.js';
import {extractPromotionTerms,promotionDescription} from './promotion-terms.js';

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
 "CREATE TABLE IF NOT EXISTS ml_monitor_discard_reasons(reason TEXT PRIMARY KEY,occurrences INTEGER NOT NULL DEFAULT 0,last_at INTEGER)"
];
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const epoch=()=>Math.floor(Date.now()/1000);
const GROUP=/^\d{6,30}(?:-\d{6,20})?@g\.us$/;
const INSTANCE=/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/;
const HOSTS=new Set(['www.mercadolivre.com.br','mercadolivre.com.br','produto.mercadolivre.com.br']);
const SHORT_HOSTS=new Set(['meli.la','melila.me']); // melila.me é de terceiros; nunca publicar como link de afiliado próprio.
export async function ensureMonitor(env){for(const query of SCHEMA)await env.DB.prepare(query).run();await ensureLinkBatches(env);}
export function extractUrls(text){
 if(typeof text!=='string')return [];
 // Links de legendas encaminhadas podem conter caracteres invisíveis ou
 // quebra de linha logo depois da barra do encurtador.
 const normalized=text.slice(0,8000)
  .replace(/[\u200b-\u200d\u2060\ufeff]/g,'')
  .replace(/(https:\/\/(?:melila\.me|meli\.la)\/)[\t \r\n]+(?=[A-Za-z0-9_-]{5,50}(?:\b|\/|[?#]|$))/gi,'$1');
 return [...new Set((normalized.match(/https:\/\/[^\s<>"'()[\]{}]+/gi)||[])
  .map(url=>url.replace(/[.,;!?]+$/g,'')))].slice(0,30);
}
// Só visita texto e contêineres de mensagens, sem varrer base64 ou metadados.
function extractMessageText(message,entry=null){
 const values=[],seen=new Set(),visited=new Set();
 const nested=['message','ephemeralMessage','viewOnceMessage','viewOnceMessageV2',
  'viewOnceMessageV2Extension','documentWithCaptionMessage','editedMessage','imageMessage',
  'videoMessage','documentMessage','extendedTextMessage','buttonsResponseMessage',
  'interactiveMessage','textMessage','mediaMessage','content','messageContent','captionMessage'];
 let format='outro',nodeCount=0;
 function walk(node,label,depth){
  if(depth>7||nodeCount++>80||!node||typeof node!=='object'||Array.isArray(node)||visited.has(node))return;
  visited.add(node);
  for(const field of ['conversation','text','caption','body','selectedDisplayText','messageText']){
   const value=node[field];
   if(typeof value==='string'&&value.trim()&&!seen.has(value)){
    seen.add(value);values.push(value.slice(0,8000));
    if(format==='outro')format=label==='outro'?field:label;
   }
  }
  for(const field of nested){
   const child=node[field],label2=['message','content','messageContent'].includes(field)?label:field;
   if(field==='content'&&typeof child==='string'&&child.trim()&&!seen.has(child)){
    seen.add(child);values.push(child.slice(0,8000));if(format==='outro')format='content';
   }else if(child&&typeof child==='object')walk(child,label2,depth+1);
  }
 }
 walk(message,'outro',0);if(entry&&entry!==message)walk(entry,'outro',0);
 return {text:values.join('\n').slice(0,8000),format};
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
  const hint=text.replace(/https:\/\/[^\s<>"'()[\]{}]+/gi,'').replace(/\s+/g,' ').trim().slice(0,180);
  result.push({instance,group_jid:entry.key.remoteJid,message_id:String(entry.key.id||'').slice(0,150),hint,urls,format});
 }
 return result;
}
function urlCandidate(input){
 let u;try{u=new URL(input);}catch{return null;}
 if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
 if(SHORT_HOSTS.has(u.hostname.toLowerCase())&&/^\/[A-Za-z0-9_-]{5,50}\/?$/.test(u.pathname)){
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
 const [settings,groups,links,pending,categories,counts,perGroup,diagnostics,latestShortlinks,observations,delivery,rejected]=await Promise.all([
  env.DB.prepare('SELECT enabled,updated_at FROM ml_monitor_settings WHERE id=1').first(),
  env.DB.prepare('SELECT id,instance_name,group_jid,group_name,enabled,created_at FROM ml_monitor_groups ORDER BY id DESC LIMIT 100').all(),
  env.DB.prepare("SELECT l.id,l.product_id,l.title,l.source_url,l.category,l.classification,l.status,l.created_at,g.group_name,m.last_seen_price_cents,m.last_seen_deal_json,m.last_queued_at FROM ml_monitor_links l JOIN ml_monitor_groups g ON g.id=l.group_id LEFT JOIN ml_monitor_product_meta m ON m.product_id=l.product_id ORDER BY l.id DESC LIMIT 200").all(),
  env.DB.prepare("SELECT status,COUNT(*) AS total FROM ml_monitor_shortlinks GROUP BY status").all(),
  (async()=>{await ensureAutomationCenter(env);return env.DB.prepare('SELECT name FROM affiliate_group_categories WHERE enabled=1 ORDER BY name').all()})(),
  env.DB.prepare("SELECT COUNT(l.id) AS captured,COALESCE(SUM(CASE WHEN l.status='available' THEN 1 ELSE 0 END),0) AS available,COALESCE(SUM(CASE WHEN l.status='batched' AND b.status='awaiting_links' THEN 1 ELSE 0 END),0) AS in_conversion,COALESCE(SUM(CASE WHEN l.status='batched' AND b.status='imported' THEN 1 ELSE 0 END),0) AS queued FROM ml_monitor_links l LEFT JOIN ml_link_batches b ON b.id=l.batch_id").first(),
  env.DB.prepare("SELECT l.group_id,COUNT(*) AS captured,COALESCE(SUM(CASE WHEN l.status='available' THEN 1 ELSE 0 END),0) AS available,COALESCE(SUM(CASE WHEN l.status='batched' AND b.status='awaiting_links' THEN 1 ELSE 0 END),0) AS in_conversion,COALESCE(SUM(CASE WHEN l.status='batched' AND b.status='imported' THEN 1 ELSE 0 END),0) AS queued FROM ml_monitor_links l LEFT JOIN ml_link_batches b ON b.id=l.batch_id GROUP BY l.group_id").all(),
  env.DB.prepare("SELECT events_received,events_while_off,messages_with_links,authorized_messages,links_recognized,last_event_at,last_authorized_at,last_link_at FROM ml_monitor_diagnostics WHERE id=1").first(),
  env.DB.prepare("SELECT s.short_url,s.status,s.reason,s.tries,s.created_at,g.group_name FROM ml_monitor_shortlinks s JOIN ml_monitor_groups g ON g.id=s.group_id WHERE s.status IN ('pending','review') ORDER BY s.id DESC LIMIT 8").all(),
  env.DB.prepare("SELECT o.domain,o.reason,o.message_format,o.created_at,g.group_name FROM ml_monitor_url_observations o JOIN ml_monitor_groups g ON g.id=o.group_id ORDER BY o.id DESC LIMIT 12").all(),
  env.DB.prepare("SELECT group_id,received_messages,with_urls,last_received_at,last_format FROM ml_monitor_group_delivery").all(),
  env.DB.prepare("SELECT reason,occurrences,last_at FROM ml_monitor_discard_reasons ORDER BY occurrences DESC LIMIT 8").all()
 ]);
 const normalizedCounts=x=>({
  captured:Number(x?.captured||0),
  available:Number(x?.available||0),
  in_conversion:Number(x?.in_conversion||0),
  queued:Number(x?.queued||0)
 });
 const perGroupMap=new Map(perGroup.results.map(x=>[x.group_id,normalizedCounts(x)]));
 const deliveryMap=new Map(delivery.results.map(x=>[x.group_id,x]));
 return {enabled:!!settings?.enabled,webhook_secret_configured:typeof env.MONITOR_WEBHOOK_TOKEN==='string'&&env.MONITOR_WEBHOOK_TOKEN.length>=24,
   counts:normalizedCounts(counts),
   diagnostics:diagnostics||{},
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
// Quando a legenda não vem no webhook, consulta apenas essa mensagem do grupo permitido.
async function recoverCaptionFromEvolution(env,msg){
 if(!env.EVOLUTION_API_URL||!env.EVOLUTION_API_KEY||!INSTANCE.test(msg.instance)||
  !GROUP.test(msg.group_jid)||!/^[A-Za-z0-9._:-]{4,150}$/.test(msg.message_id))return null;
 try{
  const url=evolutionOrigin(env.EVOLUTION_API_URL)+'/chat/findMessages/'+encodeURIComponent(msg.instance);
  const res=await fetch(url,{method:'POST',redirect:'manual',
   headers:{apikey:String(env.EVOLUTION_API_KEY).trim(),accept:'application/json','content-type':'application/json'},
   body:JSON.stringify({where:{key:{remoteJid:msg.group_jid,id:msg.message_id}},limit:5}),
   signal:AbortSignal.timeout(4500)});
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
   hint:recovered.text.replace(/https:\/\/[^\s<>"'()[\]{}]+/gi,'').replace(/\s+/g,' ').trim().slice(0,180)};
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
export async function redirectSource(value){
 let current=value;
 for(let hop=0;hop<5;hop++){
   let u;
   try{u=new URL(current);}catch{return null;}
   if(u.protocol!=='https:'||u.username||u.password||u.port||(!HOSTS.has(u.hostname.toLowerCase())&&!SHORT_HOSTS.has(u.hostname.toLowerCase())))return null;
   const known=urlCandidate(u.href);
   if(known?.kind==='product')return known;
   const response=await fetch(current,{redirect:'manual',method:'GET',signal:AbortSignal.timeout(4000)});
   if([301,302,303,307,308].includes(response.status)){
     const to=response.headers.get('location');
     if(!to)return null;
     current=new URL(to,current).href;
     continue;
   }
   if(response.status===200&&SHORT_HOSTS.has(u.hostname.toLowerCase()))
     return productFromShortPage(response);
   return null;
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
