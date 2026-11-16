// Ligação segura do webhook da instância de grupos ao Worker da CR Jornada.
// Não exige que o operador copie segredos no navegador e nunca sobrescreve
// um webhook existente pertencente a outro serviço.
import {evolutionOrigin} from './whatsapp.js';

const INSTANCE=/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/;
const CREATE="CREATE TABLE IF NOT EXISTS ml_monitor_webhook_install (instance_name TEXT PRIMARY KEY, webhook_url TEXT NOT NULL, verified_at INTEGER NOT NULL)";
const ADMIN_ORIGIN='https://bot.crjornada.com';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const now=()=>Math.floor(Date.now()/1000);
export const monitorInstanceValid=value=>typeof value==='string'&&INSTANCE.test(value);

export async function ensureMonitorWebhookInstall(env){
 await env.DB.prepare(CREATE).run();
}
export async function deriveMonitorWebhookToken(env,instance){
 if(!monitorInstanceValid(instance)||typeof env?.SESSION_SECRET!=='string'||env.SESSION_SECRET.length<24)
  throw fail('A sessão do Worker não está configurada para proteger o webhook.',503);
 const encoder=new TextEncoder();
 const key=await crypto.subtle.importKey('raw',encoder.encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signed=await crypto.subtle.sign('HMAC',key,encoder.encode('crj-wa-monitor-auto-v1:'+instance));
 return btoa(String.fromCharCode(...new Uint8Array(signed))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
export async function monitorWebhookReady(env){
 if(typeof env?.MONITOR_WEBHOOK_TOKEN==='string'&&env.MONITOR_WEBHOOK_TOKEN.length>=24)return true;
 if(!env?.DB||typeof env.SESSION_SECRET!=='string'||env.SESSION_SECRET.length<24)return false;
 await ensureMonitorWebhookInstall(env);
 const row=await env.DB.prepare('SELECT instance_name FROM ml_monitor_webhook_install LIMIT 1').first();
 return !!row;
}
async function evolutionWebhook(env,instance,path,method='GET',body=null,fetcher=fetch){
 if(!monitorInstanceValid(instance))throw fail('Nome da instância inválido.');
 if(!env.EVOLUTION_API_URL||typeof env.EVOLUTION_API_KEY!=='string'||!env.EVOLUTION_API_KEY.trim())
  throw fail('A chave global EVOLUTION_API_KEY ainda não está configurada no Worker.',503);
 const url=evolutionOrigin(env.EVOLUTION_API_URL)+path+'/'+encodeURIComponent(instance);
 let response;
 try{
  response=await fetcher(url,{method,redirect:'manual',headers:{
   apikey:env.EVOLUTION_API_KEY.trim(),accept:'application/json',
   ...(body?{'content-type':'application/json'}:{})
  },...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});
 }catch{throw fail('Não foi possível consultar a Evolution API. Confira a conexão da instância.',503);}
 if(!response.ok)throw fail(response.status===401||response.status===403?
  'A Evolution API recusou a chave de acesso; verifique EVOLUTION_API_KEY.':
  'A Evolution não confirmou o webhook (HTTP '+response.status+'). Nenhuma configuração foi alterada.',503);
 try{return await response.json();}
 catch{throw fail('A Evolution não retornou JSON verificável. Nenhuma configuração foi confirmada.',503);}
}
function unwrapWebhook(data){
 const w=data?.webhook;
 const candidate=w?.webhook&&typeof w.webhook==='object'?w.webhook
  :w&&typeof w==='object'?w
  :data?.data?.webhook&&typeof data.data.webhook==='object'?data.data.webhook
  :data?.data&&typeof data.data==='object'?data.data:data;
 if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))throw fail('Webhook da Evolution com formato desconhecido. Não fiz alterações.',503);
 const url=candidate.url;
 if(url!==undefined&&typeof url!=='string')throw fail('URL do webhook da Evolution é inválida; nenhuma alteração.',503);
 const enabled=candidate.enabled===true;
 const events=Array.isArray(candidate.events)?candidate.events.filter(x=>typeof x==='string'&&x.length<70):[];
 return {url:typeof url==='string'?url.trim():'',enabled,events,byEvents:!!(candidate.webhookByEvents??candidate.webhook_by_events)};
}
export async function installMonitorWebhook(env,body,{fetcher=fetch}={}){
 const instance=String(body?.instance_name||'').trim();
 if(!monitorInstanceValid(instance))throw fail('Informe a instância correta da Evolution API.');
 if(!env?.DB)throw fail('Banco de dados indisponível.',503);
 await ensureMonitorWebhookInstall(env);
 const allowed=await env.DB.prepare(
  'SELECT COUNT(*) AS total FROM ml_monitor_groups WHERE instance_name=? AND enabled=1 AND authorized=1'
 ).bind(instance).first();
 if(!Number(allowed?.total||0))throw fail('Cadastre primeiro um grupo autorizado dessa instância.');
 const token=await deriveMonitorWebhookToken(env,instance);
 const target=ADMIN_ORIGIN+'/hooks/wa-links/auto/'+encodeURIComponent(instance)+'/'+token;
 // A consulta é obrigatória: não mudar webhooks desconhecidos ou de outros serviços.
 const current=unwrapWebhook(await evolutionWebhook(env,instance,'/webhook/find','GET',null,fetcher));
 if(current.url && current.url!==target){
  throw fail('Esta instância já utiliza outro webhook na Evolution. Não substituí essa integração. Use uma instância exclusiva ou configure um encaminhamento adicional.',409);
 }
 const events=[...new Set([...current.events,'MESSAGES_UPSERT'])];
 if(!current.enabled||current.url!==target||!current.events.includes('MESSAGES_UPSERT')||current.byEvents){
  await evolutionWebhook(env,instance,'/webhook/set','POST',{
   enabled:true,url:target,webhookByEvents:false,webhookBase64:false,events
  },fetcher);
 }
 const verified=unwrapWebhook(await evolutionWebhook(env,instance,'/webhook/find','GET',null,fetcher));
 if(!verified.enabled||verified.url!==target||!verified.events.includes('MESSAGES_UPSERT')||verified.byEvents)
  throw fail('A Evolution não confirmou o webhook. A captura permanece desligada.',503);
 await env.DB.prepare(
  'INSERT INTO ml_monitor_webhook_install(instance_name,webhook_url,verified_at) VALUES(?,?,?) '+
  'ON CONFLICT(instance_name) DO UPDATE SET webhook_url=excluded.webhook_url,verified_at=excluded.verified_at'
 ).bind(instance,target,now()).run();
 return {ok:true,instance_name:instance,webhook_verified:true};
}
