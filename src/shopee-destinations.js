import {normalizeTelegramHandle,normalizeChannelCategory,categoryMatches} from './multichannel.js';
import {evolutionOrigin,listWhatsAppGroups} from './whatsapp.js';

const FIRST_ID=1000;
const SHARED_INSTANCE='cr-jornada-shopee';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const now=()=>Math.floor(Date.now()/1000);
const TOKEN=/^\d{7,14}:[A-Za-z0-9_-]{30,}$/;
const JID=/^[0-9]{6,30}(?:-[0-9]{6,20})?@g\.us$/;
const CREATE=[
  "CREATE TABLE IF NOT EXISTS shopee_telegram_channels (id INTEGER PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'Geral',telegram_chat_id TEXT NOT NULL UNIQUE,token_encrypted TEXT,channel_registered INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS shopee_whatsapp_groups (id INTEGER PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'Geral',instance_mode TEXT NOT NULL CHECK(instance_mode IN ('shared','dedicated')),instance_name TEXT NOT NULL,group_jid TEXT NOT NULL DEFAULT '',public_registered INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_shopee_wa_jid ON shopee_whatsapp_groups(instance_name,group_jid) WHERE group_jid<>''"
];
export async function ensureShopeeDestinationTables(env){
  for(const sql of CREATE)await env.DB.prepare(sql).run();
}
function validId(value){
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<FIRST_ID)throw fail('Selecione um canal ou grupo criado na Shopee.');
  return n;
}
function checkNetwork(network){
  if(!['telegram','whatsapp'].includes(network))throw fail('Escolha Telegram ou WhatsApp.');
  return network;
}
function title(value){
  const s=String(value||'').trim();
  if(s.length<3||s.length>80)throw fail('Informe um nome de 3 a 80 caracteres.');
  return s;
}
async function getRaw(env,network,id){
  const n=validId(id);
  await ensureShopeeDestinationTables(env);
  const table=network==='telegram'?'shopee_telegram_channels':'shopee_whatsapp_groups';
  checkNetwork(network);
  const row=await env.DB.prepare('SELECT * FROM '+table+' WHERE id=?').bind(n).first();
  if(!row)throw fail('Esse destino não pertence à Shopee.',404);
  return row;
}
function sanitized(network,r){
  if(network==='telegram'){
    const {token_encrypted,...visible}=r;
    return {network,target_id:r.id,name:r.name,category:r.category,handle:r.telegram_chat_id,
      bot_configured:!!token_encrypted,base_enabled:!!r.enabled,base_registered:!!r.channel_registered,
      ...visible};
  }
  return {network,target_id:r.id,name:r.name,category:r.category,handle:r.group_jid||r.instance_name,
    instance_name:r.instance_name,instance_mode:r.instance_mode,group_jid:r.group_jid,
    base_enabled:!!r.enabled,base_registered:!!r.public_registered};
}
export async function listShopeeOwnDestinations(env){
  await ensureShopeeDestinationTables(env);
  const [tele,wa]=await Promise.all([
    env.DB.prepare('SELECT * FROM shopee_telegram_channels ORDER BY id').all(),
    env.DB.prepare('SELECT * FROM shopee_whatsapp_groups ORDER BY id').all()
  ]);
  return [...tele.results.map(r=>sanitized('telegram',r)),...wa.results.map(r=>sanitized('whatsapp',r))];
}
export async function shoOwnDestination(env,network,id){
  return sanitized(checkNetwork(network),await getRaw(env,network,id));
}
export async function createShopeeOwnDestination(env,body){
  const network=checkNetwork(body?.network),name=title(body?.name);
  const category=normalizeChannelCategory(body?.category||'Geral');
  await ensureShopeeDestinationTables(env);
  const stamp=now();
  if(network==='telegram'){
    const chat=normalizeTelegramHandle(body?.telegram_chat_id);
    const duplicate=await env.DB.prepare('SELECT id FROM shopee_telegram_channels WHERE lower(telegram_chat_id)=?').bind(chat).first();
    if(duplicate)throw fail('Este canal Telegram já está cadastrado na Shopee.',409);
    const r=await env.DB.prepare("INSERT INTO shopee_telegram_channels(id,name,category,telegram_chat_id,created_at,updated_at) VALUES((SELECT COALESCE(MAX(id),999)+1 FROM shopee_telegram_channels),?,?,?,?,?)")
      .bind(name,category,chat,stamp,stamp).run();
    return {ok:true,id:Number(r.meta?.last_row_id),network,enabled:false};
  }
  const mode=body?.instance_mode||'shared';
  if(!['shared','dedicated'].includes(mode))throw fail('Escolha o número Shopee compartilhado ou um número exclusivo.');
  // Primeiro criamos a linha como desligada. Instâncias do Mercado Livre não são tocadas.
  const r=await env.DB.prepare("INSERT INTO shopee_whatsapp_groups(id,name,category,instance_mode,instance_name,created_at,updated_at) VALUES((SELECT COALESCE(MAX(id),999)+1 FROM shopee_whatsapp_groups),?,?,?,'',?,?)")
    .bind(name,category,mode,stamp,stamp).run();
  const id=Number(r.meta?.last_row_id);
  const instance=mode==='shared'?SHARED_INSTANCE:'cr-jornada-shopee-grupo-'+id;
  await env.DB.prepare('UPDATE shopee_whatsapp_groups SET instance_name=? WHERE id=?').bind(instance,id).run();
  return {ok:true,id,network,enabled:false};
}
async function secretKey(secret){
  if(typeof secret!=='string'||secret.length<16)throw fail('SESSION_SECRET precisa estar configurado para proteger tokens.',503);
  const master=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode('crj-shopee-telegram-2026'),
    info:new TextEncoder().encode('shopee-bot-token-v1')},master,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
const base64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const parse64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
async function encrypt(env,token){
  if(!TOKEN.test(token))throw fail('Token exclusivo do BotFather inválido.');
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},await secretKey(env.SESSION_SECRET),new TextEncoder().encode(token));
  return base64(nonce)+'.'+base64(ciphertext);
}
async function decrypt(env,cipher){
  try{
    const [nonce,body]=cipher.split('.');
    return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:parse64(nonce)},await secretKey(env.SESSION_SECRET),parse64(body)));
  }catch{throw fail('Não foi possível decifrar o token da Shopee. Cadastre novamente o token do BotFather.',503);}
}
async function telegram(token,method,payload){
  const response=await fetch('https://api.telegram.org/bot'+token+'/'+method,{
    method:payload?'POST':'GET',
    ...(payload?{headers:{'content-type':'application/json'},body:JSON.stringify(payload)}:{}),
    signal:AbortSignal.timeout(15000)
  });
  const data=await response.json().catch(()=>null);
  if(!response.ok||data?.ok!==true)throw fail('Telegram recusou a operação. Verifique o token e as permissões do canal.',503);
  return data.result;
}
async function telegramBot(token){
  const r=await telegram(token,'getMe');
  if(!r?.is_bot||!Number.isSafeInteger(r.id))throw fail('O token não corresponde a um bot Telegram.');
  return r;
}
async function verifyTelegram(token,chat){
  const bot=await telegramBot(token);
  const c=await telegram(token,'getChat?chat_id='+encodeURIComponent(chat));
  if(c?.type!=='channel')throw fail('O destino da Shopee deve ser um canal público.');
  const membership=await telegram(token,'getChatMember?chat_id='+encodeURIComponent(chat)+'&user_id='+bot.id);
  if(!['administrator','creator'].includes(membership?.status)||membership.can_post_messages===false)
    throw fail('O bot precisa ser administrador do canal Shopee com permissão para postar.');
}
export async function saveShopeeOwnTelegram(env,id,body){
  const old=await getRaw(env,'telegram',id);
  const name=title(body?.name),category=normalizeChannelCategory(body?.category);
  const chat=normalizeTelegramHandle(body?.telegram_chat_id);
  if(typeof body?.enabled!=='boolean'||typeof body?.channel_registered!=='boolean')
    throw fail('Confirme ativação e autorização do canal.');
  const tokenInput=String(body?.bot_token||'').trim();
  let cipher=old.token_encrypted;
  if(tokenInput){await telegramBot(tokenInput);cipher=await encrypt(env,tokenInput);}
  const changed=chat!==old.telegram_chat_id||!!tokenInput;
  const registered=changed?false:body.channel_registered,enabled=changed?false:body.enabled;
  if(enabled&&!registered)throw fail('Confirme o cadastro público do canal Shopee e a autorização de divulgação.');
  if(registered&&enabled){
    if(!cipher)throw fail('Cadastre primeiro o bot exclusivo da Shopee.');
    await verifyTelegram(await decrypt(env,cipher),chat);
  }
  try{
    await env.DB.prepare('UPDATE shopee_telegram_channels SET name=?,category=?,telegram_chat_id=?,token_encrypted=?,channel_registered=?,enabled=?,updated_at=? WHERE id=?')
      .bind(name,category,chat,cipher,+registered,+enabled,now(),old.id).run();
  }catch(e){if(/UNIQUE/i.test(String(e.message)))throw fail('Este canal já existe na Shopee.',409);throw e;}
  return {ok:true,changed,enabled,bot_configured:!!cipher};
}
async function evo(env,path,options={}){
  if(!env.EVOLUTION_API_URL||!env.EVOLUTION_API_KEY)throw fail('Configure a Evolution API para conectar os grupos Shopee.',503);
  const res=await fetch(evolutionOrigin(env.EVOLUTION_API_URL)+path,{
    method:options.method||'GET',redirect:'manual',
    headers:{apikey:String(env.EVOLUTION_API_KEY).trim(),accept:'application/json',...(options.body?{'content-type':'application/json'}:{})},
    ...(options.body?{body:JSON.stringify(options.body)}:{}),signal:AbortSignal.timeout(16000)
  });
  if(!res.ok){
    const error=fail(res.status===401||res.status===403?'Chave global Evolution recusada.':'Evolution API retornou HTTP '+res.status+'.',503);
    error.httpStatus=res.status;throw error;
  }
  const data=await res.json().catch(()=>null);
  if(!data||typeof data!=='object'||data.error)throw fail('A Evolution retornou dados inválidos.',503);
  return data;
}
function qrImage(data){
  for(const source of [data?.qrcode?.base64,data?.qrCode?.base64,data?.base64,data?.qrcode?.image]){
    if(typeof source!=='string'||source.length>300000)continue;
    const image=source.startsWith('data:')?source:'data:image/png;base64,'+source;
    if(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))return image;
  }
  return null;
}
export async function shopeeWhatsAppConnection(env,id,create=false){
  const g=await getRaw(env,'whatsapp',id);
  // Só instâncias reservadas à Shopee podem ser criadas/consultadas aqui.
  if(g.instance_name!==SHARED_INSTANCE&&g.instance_name!=='cr-jornada-shopee-grupo-'+g.id)
    throw fail('Instância Shopee inválida.',400);
  const existing=await evo(env,'/instance/fetchInstances');
  const items=Array.isArray(existing)?existing:Array.isArray(existing.instances)?existing.instances:Array.isArray(existing.data)?existing.data:null;
  if(!items)throw fail('Não foi possível listar as instâncias Evolution.',503);
  const name=x=>x?.name||x?.instanceName||x?.instance?.name||x?.instance?.instanceName;
  const found=items.some(x=>name(x)===g.instance_name);
  let created=null;
  if(!found&&create){
    try{created=await evo(env,'/instance/create',{method:'POST',body:{instanceName:g.instance_name,integration:'WHATSAPP-BAILEYS',qrcode:true}});}
    catch(error){
      if(![400,409].includes(error.httpStatus))throw error;
      const again=await evo(env,'/instance/fetchInstances');
      const list=Array.isArray(again)?again:Array.isArray(again.instances)?again.instances:Array.isArray(again.data)?again.data:[];
      if(!list.some(x=>name(x)===g.instance_name))throw error;
    }
  }
  if(!found&&!create)return {exists:false,state:'not_created',instance_name:g.instance_name,qr_image:null};
  const state=await evo(env,'/instance/connectionState/'+encodeURIComponent(g.instance_name));
  const status=state?.instance?.state||state?.state||state?.instance?.connectionStatus;
  if(!['open','close','connecting','refused'].includes(status))throw fail('Estado Evolution desconhecido.',503);
  if(status==='open')return {exists:true,state:'open',instance_name:g.instance_name,qr_image:null};
  let image=qrImage(created);
  if(create&&!image)image=qrImage(await evo(env,'/instance/connect/'+encodeURIComponent(g.instance_name)));
  return {exists:true,state:status,instance_name:g.instance_name,qr_image:image};
}
export async function shopeeWhatsAppOptions(env,id){
  const g=await getRaw(env,'whatsapp',id);
  return {groups:await listWhatsAppGroups(env,g.instance_name)};
}
export async function saveShopeeOwnWhatsApp(env,id,body){
  const old=await getRaw(env,'whatsapp',id);
  const name=title(body?.name),category=normalizeChannelCategory(body?.category);
  const jid=String(body?.group_jid||'').trim();
  if(jid&&!JID.test(jid))throw fail('Escolha um grupo válido da Evolution API.');
  if(typeof body?.public_registered!=='boolean'||typeof body?.enabled!=='boolean')
    throw fail('Confirme a autorização e a ativação do WhatsApp.');
  const changed=jid!==old.group_jid;
  const registered=changed?false:body.public_registered,enabled=changed?false:body.enabled;
  if(enabled&&!registered)throw fail('Confirme o cadastro do grupo Shopee como mídia de divulgação.');
  if((registered||enabled)&&!jid)throw fail('Selecione o grupo WhatsApp antes de ativar.');
  if(registered||enabled){
    const options=await listWhatsAppGroups(env,old.instance_name);
    if(!options.some(x=>x.id===jid))throw fail('O número Shopee não participa desse grupo.');
  }
  try{
    await env.DB.prepare('UPDATE shopee_whatsapp_groups SET name=?,category=?,group_jid=?,public_registered=?,enabled=?,updated_at=? WHERE id=?')
      .bind(name,category,jid,+registered,+enabled,now(),old.id).run();
  }catch(e){if(/UNIQUE/i.test(String(e.message)))throw fail('Este grupo já foi cadastrado nesta instância Shopee.',409);throw e;}
  return {ok:true,changed,enabled};
}
export async function testShopeeOwnDestination(env,network,id){
  checkNetwork(network);
  const g=await getRaw(env,network,id);
  if(network==='telegram'){
    if(!g.enabled||!g.channel_registered||!g.token_encrypted)throw fail('Configure, autorize e ative o canal e o bot Shopee.');
    const token=await decrypt(env,g.token_encrypted);
    await verifyTelegram(token,g.telegram_chat_id);
    const result=await telegram(token,'sendMessage',{chat_id:g.telegram_chat_id,text:'✅ Teste do canal Shopee CR Jornada Afiliados. Nenhuma oferta foi publicada.'});
    return {ok:true,message_id:String(result.message_id)};
  }
  if(!g.enabled||!g.public_registered||!g.group_jid)throw fail('Configure, autorize e ative o grupo Shopee.');
  const groups=await listWhatsAppGroups(env,g.instance_name);
  if(!groups.some(x=>x.id===g.group_jid))throw fail('O grupo não está conectado ao número Shopee.');
  const sent=await evo(env,'/message/sendText/'+encodeURIComponent(g.instance_name),{method:'POST',body:{number:g.group_jid,text:'✅ Teste do grupo Shopee CR Jornada Afiliados. Nenhuma oferta foi publicada.'}});
  if(!sent?.key?.id)throw fail('A Evolution não confirmou o teste.');
  return {ok:true,message_id:sent.key.id};
}
export async function sendShopeeOwnText(env,network,id,text){
  checkNetwork(network);
  const g=await getRaw(env,network,id);
  if(network==='telegram'){
    if(!g.enabled||!g.channel_registered||!g.token_encrypted)throw fail('O canal Shopee está inativo ou não autorizado.');
    const token=await decrypt(env,g.token_encrypted);
    await verifyTelegram(token,g.telegram_chat_id);
    const sent=await telegram(token,'sendMessage',{chat_id:g.telegram_chat_id,text,disable_web_page_preview:false});
    if(!Number.isSafeInteger(sent?.message_id))throw fail('Mensagem Telegram não confirmada; confira o canal.');
    return {message_id:String(sent.message_id)};
  }
  if(!g.enabled||!g.public_registered||!g.group_jid)throw fail('O grupo Shopee está inativo ou não autorizado.');
  const groups=await listWhatsAppGroups(env,g.instance_name);
  if(!groups.some(x=>x.id===g.group_jid))throw fail('O número Shopee não participa do grupo.');
  const sent=await evo(env,'/message/sendText/'+encodeURIComponent(g.instance_name),{
    method:'POST',body:{number:g.group_jid,text,linkPreview:true}
  });
  if(typeof sent?.key?.id!=='string'||!sent.key.id)throw fail('Mensagem Evolution não confirmada; confira o grupo.');
  return {message_id:sent.key.id};
}
export async function shopeeWhatsAppInstance(env,id){
  const g=await getRaw(env,'whatsapp',id);
  return g.instance_name;
}
