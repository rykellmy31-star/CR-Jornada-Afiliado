import { composeOfferMessage } from './logic.js';
import { findProductImage } from './images.js';
import { ensureCouponTable } from './coupons.js';

// Integração independente, desligada por padrão. Sem destinatários individuais.
const CREATE_CONFIG = `CREATE TABLE IF NOT EXISTS whatsapp_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled INTEGER NOT NULL DEFAULT 0,
  instance_name TEXT NOT NULL DEFAULT '',
  group_jid TEXT NOT NULL DEFAULT '',
  public_registered INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)`;
const CREATE_DELIVERIES = `CREATE TABLE IF NOT EXISTS whatsapp_deliveries (
  offer_id INTEGER NOT NULL,
  group_jid TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending','sent','needs_review')),
  message_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (offer_id, group_jid),
  FOREIGN KEY (offer_id) REFERENCES offers(id)
)`;
const CREATE_SCHEDULE = `CREATE TABLE IF NOT EXISTS whatsapp_schedule (
  id INTEGER PRIMARY KEY CHECK (id=1),
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes IN (15,30,60,120,180,240,360)),
  last_attempt_at INTEGER NOT NULL DEFAULT 0
)`;
const WHATSAPP_INTERVALS = new Set([15,30,60,120,180,240,360]);
const INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const GROUP_RE = /^[0-9]{6,30}(?:-[0-9]{6,20})?@g\.us$/;
const nowSec = () => Math.floor(Date.now()/1000);

export function validateInstance(value) {
  const s=String(value||'').trim();
  if (!INSTANCE_RE.test(s)) throw new Error('Nome de instância Evolution inválido.');
  return s;
}
export function validateGroupJid(value) {
  const s=String(value||'').trim();
  if (!GROUP_RE.test(s)) throw new Error('Selecione um grupo válido conectado à sua instância (terminação @g.us).');
  return s;
}
export function evolutionOrigin(value) {
  let u;
  try { u=new URL(value); } catch { throw new Error('EVOLUTION_API_URL precisa ser uma URL HTTPS válida.'); }
  const h=u.hostname.toLowerCase();
  if (u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash
      ||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')
      ||/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)||h.startsWith('['))
    throw new Error('Configure EVOLUTION_API_URL com o endereço público HTTPS do seu servidor, sem porta/caminho.');
  return u.origin;
}
function configured(env) { return !!env.EVOLUTION_API_URL && typeof env.EVOLUTION_API_KEY==='string' && !!env.EVOLUTION_API_KEY.trim(); }
function globalApiKey(env) { return String(env.EVOLUTION_API_KEY || '').trim(); }
async function evoFetch(env,instance,path,options={}) {
  if (!configured(env)) throw new Error('Configure o Secret EVOLUTION_API_KEY na Cloudflare (EVOLUTION_API_URL já está definido no Worker).');
  const origin=evolutionOrigin(env.EVOLUTION_API_URL);
  const url=origin+path+'/'+encodeURIComponent(validateInstance(instance))+
    (path==='/group/fetchAllGroups'?'?getParticipants=false':'');
  const response=await fetch(url,{
    ...options,redirect:'manual',headers:{apikey:globalApiKey(env),accept:'application/json',...(options.body?{'content-type':'application/json'}:{})},
    signal:AbortSignal.timeout(14000)
  });
  if(!response.ok) {
    if(response.status===401||response.status===403)throw new Error('Evolution API recusou a chave ou não autorizou a instância.');
    throw new Error('Evolution API respondeu HTTP '+response.status+'.');
  }
  const data=await response.json().catch(()=>null);
  if(!data||data.error)throw new Error('Resposta inválida da Evolution API.');
  return data;
}
// Identidade fixa e isolada: nunca cria, desconecta ou altera outras instâncias.
export const AFFILIATE_INSTANCE_NAME = 'cr-jornada-afiliados';

async function evolutionAdmin(env,path,{method='GET',body}={}) {
  if (!configured(env)) throw new Error('Configure o Secret EVOLUTION_API_KEY na Cloudflare antes de conectar.');
  const origin=evolutionOrigin(env.EVOLUTION_API_URL);
  const response=await fetch(origin+path,{
    method,redirect:'manual',
    headers:{apikey:globalApiKey(env),accept:'application/json',...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(18000)
  });
  if(!response.ok){
    const error=new Error(response.status===401||response.status===403
      ?'Evolution respondeu HTTP '+response.status+' em '+path+'. Verifique se EVOLUTION_API_KEY é a API Key GLOBAL usada no Evolution Manager (não a chave da instância).'
      :'A Evolution API respondeu HTTP '+response.status+' em '+path+'.');
    error.status=response.status;
    throw error;
  }
  const data=await response.json().catch(()=>null);
  if (!data || typeof data!=='object'||data.error)
    throw new Error('Resposta inválida da Evolution API.');
  return data;
}
function listedInstances(payload){
  // Falha fechada para respostas desconhecidas: jamais criar instância duplicada
  // só porque uma versão da API mudou a estrutura de listagem.
  if(Array.isArray(payload))return payload;
  if(Array.isArray(payload?.instances))return payload.instances;
  if(Array.isArray(payload?.data))return payload.data;
  throw new Error('Não foi possível confirmar as instâncias existentes na Evolution API.');
}
async function ownInstance(env){
  const data=await evolutionAdmin(env,'/instance/fetchInstances');
  return listedInstances(data).find(item=>
    (item?.name||item?.instanceName||item?.instance?.instanceName||item?.instance?.name)===AFFILIATE_INSTANCE_NAME
  )||null;
}
function validQrImage(response) {
  const sources=[response?.qrcode?.base64,response?.qrCode?.base64,response?.base64,
    response?.qrcode?.image,response?.qrCode?.image];
  for(const src of sources) {
    if(typeof src!=='string'||src.length>300000)continue;
    const full=src.startsWith('data:')?src:'data:image/png;base64,'+src;
    if(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(full))
      return full;
  }
  return null;
}
async function connectionStatus(env){
  const data=await evolutionAdmin(env,'/instance/connectionState/'+AFFILIATE_INSTANCE_NAME);
  const state=data?.instance?.state||data?.state||data?.instance?.connectionStatus;
  if(!['open','close','connecting','refused'].includes(state))
    throw new Error('Estado de conexão não reconhecido pela Evolution API.');
  return state;
}
export async function getAffiliateWhatsAppConnection(env){
  if(!configured(env))return {configured:false,instance_name:AFFILIATE_INSTANCE_NAME,exists:false,state:'unconfigured'};
  const instance=await ownInstance(env);
  if(!instance)return {configured:true,instance_name:AFFILIATE_INSTANCE_NAME,exists:false,state:'not_created'};
  const state=await connectionStatus(env);
  return {configured:true,instance_name:AFFILIATE_INSTANCE_NAME,exists:true,state};
}
export async function connectAffiliateWhatsApp(env){
  if(!configured(env))throw new Error('Configure o Secret EVOLUTION_API_KEY na Cloudflare antes de gerar o QR Code.');
  await ensureWhatsAppTables(env);
  let instance=await ownInstance(env);
  let created=null;
  if(!instance){
    try{
      created=await evolutionAdmin(env,'/instance/create',{
        method:'POST',body:{instanceName:AFFILIATE_INSTANCE_NAME,integration:'WHATSAPP-BAILEYS',qrcode:true}
      });
    }catch(error){
      // Duas sessões podem clicar ao mesmo tempo: só recupera o conflito
      // após confirmar que a instância criada tem o nome esperado.
      if(error.status!==409&&error.status!==400)throw error;
      instance=await ownInstance(env);
      if(!instance)throw error;
    }
  }
  // Liga o cadastro do painel à instância exclusiva. NUNCA ativa envios aqui.
  // Alteração de instância descarta apenas o vínculo de grupo no painel.
  await env.DB.prepare("UPDATE whatsapp_settings SET instance_name=?,group_jid='',enabled=0,public_registered=0,started_at=0,last_error=NULL,updated_at=? WHERE id=1 AND instance_name<>?")
    .bind(AFFILIATE_INSTANCE_NAME,nowSec(),AFFILIATE_INSTANCE_NAME).run();

  const state=await connectionStatus(env);
  if(state==='open')return {instance_name:AFFILIATE_INSTANCE_NAME,exists:true,state,qr_image:null};
  let qr=validQrImage(created);
  if(!qr){
    const connected=await evolutionAdmin(env,'/instance/connect/'+AFFILIATE_INSTANCE_NAME);
    qr=validQrImage(connected);
  }
  return {instance_name:AFFILIATE_INSTANCE_NAME,exists:true,state,qr_image:qr};
}

export async function ensureWhatsAppTables(env) {
  await env.DB.prepare(CREATE_CONFIG).run();
  await env.DB.prepare('INSERT OR IGNORE INTO whatsapp_settings(id) VALUES(1)').run();
  await env.DB.prepare(CREATE_DELIVERIES).run();
  await env.DB.prepare(CREATE_SCHEDULE).run();
  await env.DB.prepare('INSERT OR IGNORE INTO whatsapp_schedule(id) VALUES(1)').run();
}
export async function getWhatsAppState(env) {
  await ensureWhatsAppTables(env);
  const [config,deliveries,schedule]=await Promise.all([
    env.DB.prepare('SELECT * FROM whatsapp_settings WHERE id=1').first(),
    env.DB.prepare("SELECT d.offer_id,d.status,d.last_error,d.updated_at,o.title FROM whatsapp_deliveries d JOIN offers o ON o.id=d.offer_id ORDER BY d.updated_at DESC LIMIT 12").all(),
    env.DB.prepare('SELECT interval_minutes,last_attempt_at FROM whatsapp_schedule WHERE id=1').first()
  ]);
  return {config,schedule,server_configured:configured(env),deliveries:deliveries.results};
}
export async function listWhatsAppGroups(env,instance) {
  const data=await evoFetch(env,instance,'/group/fetchAllGroups',{method:'GET'});
  const groups=Array.isArray(data)?data:Array.isArray(data.groups)?data.groups:Array.isArray(data.data)?data.data:[];
  return groups.map(g=>({
    id:String(g.id||g.jid||g.groupJid||''),
    name:String(g.subject||g.name||'Grupo sem nome').slice(0,100)
  })).filter(g=>GROUP_RE.test(g.id)).slice(0,250);
}
export async function updateWhatsAppSettings(env,body) {
  await ensureWhatsAppTables(env);
  if(typeof body?.enabled!=='boolean'||typeof body?.public_registered!=='boolean')
    throw new Error('Seleções de WhatsApp inválidas.');
  const [prev,previousSchedule]=await Promise.all([
    env.DB.prepare('SELECT * FROM whatsapp_settings WHERE id=1').first(),
    env.DB.prepare('SELECT interval_minutes FROM whatsapp_schedule WHERE id=1').first()
  ]);
  // Requisições antigas sem interval_minutes preservam o intervalo salvo.
  const interval=body.interval_minutes===undefined ? previousSchedule.interval_minutes : Number(body.interval_minutes);
  if(!WHATSAPP_INTERVALS.has(interval)||!Number.isInteger(interval))
    throw new Error('Intervalo do WhatsApp inválido. Escolha uma opção disponível.');
  const name=validateInstance(body.instance_name);
  const jid=validateGroupJid(body.group_jid);
  const changed=name!==prev.instance_name||jid!==prev.group_jid;
  if(body.enabled||body.public_registered) {
    const groups=await listWhatsAppGroups(env,name);
    if(!groups.some(g=>g.id===jid))throw new Error('Grupo não localizado na instância Evolution conectada.');
  }
  const registered=changed?false:body.public_registered;
  const enabled=changed?false:body.enabled;
  if(enabled&&!registered)throw new Error('Confirme que o grupo é público, aberto e cadastrado na Central de Afiliados.');
  if(enabled&&!configured(env))throw new Error('Configure a Evolution API antes de ativar o WhatsApp.');
  const timestamp=nowSec();
  await env.DB.prepare('UPDATE whatsapp_settings SET enabled=?,instance_name=?,group_jid=?,public_registered=?,started_at=?,last_error=NULL,updated_at=? WHERE id=1')
    .bind(+enabled,name,jid,+registered,(changed||(!prev.enabled&&enabled))?timestamp:prev.started_at,timestamp).run();
  // O relógio do WhatsApp não altera o intervalo do Telegram.
  if(changed||(!prev.enabled&&enabled))
    await env.DB.prepare('UPDATE whatsapp_schedule SET interval_minutes=?,last_attempt_at=0 WHERE id=1').bind(interval).run();
  else
    await env.DB.prepare('UPDATE whatsapp_schedule SET interval_minutes=? WHERE id=1').bind(interval).run();
  return {ok:true,enabled,group_changed:changed,interval_minutes:interval};
}
export async function testWhatsApp(env) {
  await ensureWhatsAppTables(env);
  const cfg=await env.DB.prepare('SELECT * FROM whatsapp_settings WHERE id=1').first();
  if(!cfg.public_registered||!cfg.group_jid)throw new Error('Confirme primeiro um grupo público cadastrado no Mercado Livre.');
  const groups=await listWhatsAppGroups(env,cfg.instance_name);
  if(!groups.some(g=>g.id===cfg.group_jid))throw new Error('Grupo não pertence à instância selecionada.');
  const data=await evoFetch(env,cfg.instance_name,'/message/sendText',{
    method:'POST',body:JSON.stringify({number:cfg.group_jid,text:'✅ Teste de conexão CR Jornada Afiliados. Nenhuma oferta foi publicada.'})
  });
  if(typeof data.key?.id!=='string'||!data.key.id)throw new Error('Evolution não confirmou o identificador do teste; confira o grupo antes de tentar novamente.');
  return {ok:true,message_id:data.key.id};
}
function textForWhatsApp(offer){
  const link=offer.affiliate_url;
  const message=composeOfferMessage(offer).replace(/🔗 Link de afiliado:$/,'🔗 Comprar aqui:');
  // Preserva o link completo mesmo ao montar legendas curtas.
  return (message.length+link.length+1>1024?message.slice(0,1023-link.length):message)+'\n'+link;
}
async function sendOfferWhatsApp(env,cfg,offer){
  const text=textForWhatsApp(offer);
  let image=null;
  try{image=await findProductImage(offer.affiliate_url);}catch(e){console.warn('Foto WhatsApp:',String(e?.message||e).slice(0,100));}
  const body=image?{
    number:cfg.group_jid,mediatype:'image',mimetype:image.endsWith('.png')?'image/png':'image/jpeg',
    media:image,caption:text,fileName:'oferta-mercado-livre.jpg',filename:'oferta-mercado-livre.jpg'
  }:{number:cfg.group_jid,text,linkPreview:true};
  const data=await evoFetch(env,cfg.instance_name,image?'/message/sendMedia':'/message/sendText',{method:'POST',body:JSON.stringify(body)});
  if(typeof data.key?.id!=='string'||!data.key.id)throw new Error('Evolution não confirmou o envio; confira o grupo antes de reenviar.');
  return {message_id:data.key.id,format:image?'photo':'text'};
}
export async function runWhatsAppScheduled(env){
  if(!env.DB)return {skipped:'db'};
  await ensureWhatsAppTables(env);
  const cfg=await env.DB.prepare('SELECT * FROM whatsapp_settings WHERE id=1').first();
  if(!cfg.enabled||!cfg.public_registered||!configured(env))return {skipped:'disabled'};
  const schedule=await env.DB.prepare('SELECT interval_minutes,last_attempt_at FROM whatsapp_schedule WHERE id=1').first();
  const timestamp=nowSec();
  const minGap=schedule.interval_minutes*60;
  if(schedule.last_attempt_at>0&&timestamp-schedule.last_attempt_at<minGap)
    return {skipped:'interval'};
  await ensureCouponTable(env);
  const offer=await env.DB.prepare(`SELECT o.*,c.kind AS coupon_kind,c.code AS coupon_code,c.discount_type AS coupon_discount_type,c.discount_value AS coupon_discount_value,
    c.min_cart_cents AS coupon_min_cart_cents,c.max_discount_cents AS coupon_max_discount_cents,c.start_day AS coupon_start_day,
    c.end_day AS coupon_end_day,c.source_url AS coupon_source_url,c.notes AS coupon_notes,c.owner_confirmed AS coupon_owner_confirmed
    FROM offers o LEFT JOIN offer_coupons c ON c.offer_id=o.id
    LEFT JOIN whatsapp_deliveries d ON d.offer_id=o.id AND d.group_jid=?
    WHERE o.status='published' AND o.published_at>=? AND d.offer_id IS NULL
    ORDER BY o.published_at ASC,o.id ASC LIMIT 1`).bind(cfg.group_jid,cfg.started_at).first();
  if(!offer)return {skipped:'empty'};
  // Reserva atomicamente o próximo envio, inclusive entre execuções concorrentes.
  const slot=await env.DB.prepare('UPDATE whatsapp_schedule SET last_attempt_at=? WHERE id=1 AND (last_attempt_at=0 OR last_attempt_at<=?)')
    .bind(timestamp,timestamp-minGap).run();
  if(slot.meta?.changes!==1)return {skipped:'interval'};
  const claim=await env.DB.prepare("INSERT OR IGNORE INTO whatsapp_deliveries(offer_id,group_jid,status,created_at,updated_at) VALUES(?,?,'sending',?,?)")
    .bind(offer.id,cfg.group_jid,timestamp,timestamp).run();
  if(claim.meta?.changes!==1)return {skipped:'claimed'};
  try{
    const result=await sendOfferWhatsApp(env,cfg,offer);
    await env.DB.prepare("UPDATE whatsapp_deliveries SET status='sent',message_id=?,updated_at=? WHERE offer_id=? AND group_jid=? AND status='sending'")
      .bind(result.message_id,nowSec(),offer.id,cfg.group_jid).run();
    await env.DB.prepare('UPDATE whatsapp_settings SET last_error=NULL WHERE id=1').run();
    return {status:'sent',offer_id:offer.id,format:result.format};
  }catch(error){
    const reason=String(error?.message||error).slice(0,220);
    await env.DB.prepare("UPDATE whatsapp_deliveries SET status='needs_review',last_error=?,updated_at=? WHERE offer_id=? AND group_jid=? AND status='sending'")
      .bind(reason,nowSec(),offer.id,cfg.group_jid).run();
    await env.DB.prepare('UPDATE whatsapp_settings SET last_error=? WHERE id=1').bind(reason).run();
    return {status:'needs_review',error:reason,offer_id:offer.id};
  }
}
export async function retryWhatsAppDelivery(env,offerId){
  await ensureWhatsAppTables(env);
  const id=Number(offerId);
  if(!Number.isInteger(id)||id<1)throw new Error('Oferta inválida.');
  const cfg=await env.DB.prepare('SELECT * FROM whatsapp_settings WHERE id=1').first();
  if(!cfg.enabled||!cfg.public_registered)throw new Error('O WhatsApp precisa estar autorizado e ativo.');
  const updated=await env.DB.prepare("DELETE FROM whatsapp_deliveries WHERE offer_id=? AND group_jid=? AND status='needs_review'")
    .bind(id,cfg.group_jid).run();
  if(updated.meta?.changes!==1)throw new Error('Esta oferta não está pendente de revisão.');
  return {ok:true};
}
