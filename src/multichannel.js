import { normalizeOffer, shouldSend, localTimeParts, telegramPayload } from './logic.js';
import { findProductImage } from './images.js';
import { normalizeCoupon } from './coupons.js';

// Tabelas ADITIVAS: o canal 1 continua usando settings/offers/offer_coupons/logs.
// Canais adicionais nunca recebem automaticamente ofertas do canal principal.
const SCHEMA=[
`CREATE TABLE IF NOT EXISTS telegram_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Geral',
  telegram_chat_id TEXT NOT NULL UNIQUE,
  bot_mode TEXT NOT NULL DEFAULT 'shared' CHECK(bot_mode IN ('shared','dedicated')),
  token_encrypted TEXT,
  channel_registered INTEGER NOT NULL DEFAULT 0,
  telegram_enabled INTEGER NOT NULL DEFAULT 0,
  automation_enabled INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL DEFAULT 30 CHECK(interval_minutes BETWEEN 1 AND 1440),
  max_daily INTEGER NOT NULL DEFAULT 12 CHECK(max_daily BETWEEN 1 AND 48),
  start_hour INTEGER NOT NULL DEFAULT 8,
  end_hour INTEGER NOT NULL DEFAULT 21,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS channel_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES telegram_channels(id),
  title TEXT NOT NULL,
  affiliate_url TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Geral',
  price_cents INTEGER,
  old_price_cents INTEGER,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','sending','published','needs_review')),
  published_at INTEGER,
  published_day TEXT,
  telegram_message_id INTEGER,
  last_error TEXT
)`,
`CREATE INDEX IF NOT EXISTS idx_channel_offers_queue ON channel_offers(channel_id,status,created_at)`,
`CREATE INDEX IF NOT EXISTS idx_channel_offers_dates ON channel_offers(channel_id,status,published_day)`,
`CREATE TABLE IF NOT EXISTS channel_offer_coupons (
  offer_id INTEGER PRIMARY KEY REFERENCES channel_offers(id),
  kind TEXT NOT NULL CHECK(kind IN ('code','activation')),
  code TEXT, discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
  discount_value INTEGER NOT NULL,
  min_cart_cents INTEGER NOT NULL DEFAULT 0, max_discount_cents INTEGER,
  start_day TEXT NOT NULL,end_day TEXT NOT NULL,source_url TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',owner_confirmed INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS channel_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES telegram_channels(id),
  offer_id INTEGER, event TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
)`
];
const OFFERS_SQL="SELECT o.*, c.kind AS coupon_kind,c.code AS coupon_code,c.discount_type AS coupon_discount_type,c.discount_value AS coupon_discount_value,c.min_cart_cents AS coupon_min_cart_cents,c.max_discount_cents AS coupon_max_discount_cents,c.start_day AS coupon_start_day,c.end_day AS coupon_end_day,c.source_url AS coupon_source_url,c.notes AS coupon_notes,c.owner_confirmed AS coupon_owner_confirmed FROM channel_offers o LEFT JOIN channel_offer_coupons c ON c.offer_id=o.id";
const epoch=()=>Math.floor(Date.now()/1000);
const BAD_TOKEN=/^\d{7,14}:[A-Za-z0-9_-]{30,}$/;
function bad(msg,status=400){return Object.assign(new Error(msg),{status});}
function channelId(value){const id=Number(value);if(!Number.isSafeInteger(id)||id<2)return null;return id;}
export function normalizeTelegramHandle(input){
  let value=String(input||'').trim();
  if(/^https:\/\/t\.me\//i.test(value)){
    const url=new URL(value);
    if(url.hostname.toLowerCase()!=='t.me'||url.port||url.username||url.password||url.search||url.hash)
      throw bad('Informe um endereço público de canal válido.');
    value='@'+url.pathname.replace(/^\/+|\/+$/g,'');
  }
  if(!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value))throw bad('Informe um canal público @nome ou https://t.me/nome.');
  return value.toLowerCase();
}
function trimField(value,max,label){
  const s=String(value||'').trim();
  if(!s||s.length>max)throw bad(label+' deve ter de 1 a '+max+' caracteres.');
  return s;
}
function parseSettings(data){
  const interval=Number(data.interval_minutes),maxDaily=Number(data.max_daily);
  const start=Number(data.start_hour),end=Number(data.end_hour);
  if(data.interval_minutes===''||!Number.isInteger(interval)||interval<1||interval>1440||
     !Number.isInteger(maxDaily)||maxDaily<1||maxDaily>48||
     !Number.isInteger(start)||start<0||start>23||
     !Number.isInteger(end)||end<1||end>24||start>=end)
    throw bad('Horários, intervalo ou limite diário inválidos.');
  for(const key of ['channel_registered','telegram_enabled','automation_enabled'])
    if(typeof data[key]!=='boolean')throw bad('Confirme os controles de publicação.');
  return {interval,maxDaily,start,end};
}
async function cryptKey(secret){
  if(typeof secret!=='string'||secret.length<16)throw bad('SESSION_SECRET muito curto para proteger os tokens.',503);
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',
    salt:new TextEncoder().encode('cr-jornada-affiliates-multichannel-v1'),
    info:new TextEncoder().encode('telegram-token-encryption')},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
const b64=arr=>btoa(String.fromCharCode(...new Uint8Array(arr)));
const from64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function encryptToken(secret,token){
  if(!BAD_TOKEN.test(token))throw bad('Token do BotFather fora do formato esperado.');
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},await cryptKey(secret),new TextEncoder().encode(token));
  return b64(iv)+'.'+b64(encrypted);
}
async function decryptToken(secret,cipher){
  try{
    const [nonce,encrypted]=cipher.split('.');
    return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(nonce)},await cryptKey(secret),from64(encrypted)));
  }catch{throw bad('Token criptografado indisponível. Cadastre novamente o token desse bot no painel.',503);}
}
export async function ensureMultiChannelTables(env){
  for(const statement of SCHEMA)await env.DB.prepare(statement).run();
}
const sanitized=c=>{if(!c)return null;const {token_encrypted,...rest}=c;return {...rest,bot_configured:c.bot_mode==='shared'?null:!!token_encrypted};};
async function row(env,id){
  const channel=channelId(id);
  if(!channel)throw bad('Canal inválido.');
  await ensureMultiChannelTables(env);
  const found=await env.DB.prepare('SELECT * FROM telegram_channels WHERE id=?').bind(channel).first();
  if(!found)throw bad('Canal não encontrado.',404);
  return found;
}
async function globalToken(env,c){
  if(c.bot_mode==='shared'){
    if(!env.TELEGRAM_BOT_TOKEN)throw bad('Configure TELEGRAM_BOT_TOKEN para usar o bot principal.',503);
    return env.TELEGRAM_BOT_TOKEN;
  }
  if(!c.token_encrypted)throw bad('Cadastre o token exclusivo deste canal.',400);
  return decryptToken(env.SESSION_SECRET,c.token_encrypted);
}
async function api(token,method,payload=null){
  const endpoint='https://api.telegram.org/bot'+token+'/'+method;
  const response=await fetch(endpoint,payload?{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)
  }:{signal:AbortSignal.timeout(12000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.ok){
    const error=bad('Telegram recusou a operação '+method+'. Verifique o bot, as permissões e o canal.',400);
    error.telegramStatus=response.status;
    throw error;
  }
  return data.result;
}
async function verifyToken(token){
  const me=await api(token,'getMe');
  if(!me?.is_bot||!Number.isInteger(me.id))throw bad('Token do BotFather não corresponde a um bot.');
  return me;
}
async function verifyChannel(token,chat){
  const result=await api(token,'getChat?chat_id='+encodeURIComponent(chat));
  if(result?.type!=='channel')throw bad('O destino precisa ser um canal público do Telegram.');
  const me=await verifyToken(token);
  const status=await api(token,'getChatMember?chat_id='+encodeURIComponent(chat)+'&user_id='+me.id);
  if(!['administrator','creator'].includes(status?.status)||status.can_post_messages===false)
    throw bad('Adicione o bot como administrador do canal, com permissão para publicar.');
  return true;
}
async function destinationAvailable(env,handle,exceptId=null){
  const legacy=await env.DB.prepare('SELECT telegram_chat_id FROM settings WHERE id=1').first();
  if(legacy?.telegram_chat_id?.toLowerCase()===handle)throw bad('Este canal já é o canal principal.',409);
  const existing=await env.DB.prepare('SELECT id FROM telegram_channels WHERE lower(telegram_chat_id)=?').bind(handle).first();
  if(existing&&existing.id!==exceptId)throw bad('Esse @canal já está cadastrado no painel.',409);
}
async function log(env,channelId,event,detail='',offerId=null){
  await env.DB.prepare('INSERT INTO channel_logs(channel_id,offer_id,event,detail,created_at) VALUES(?,?,?,?,?)')
    .bind(channelId,offerId,event,String(detail).slice(0,250),epoch()).run();
}
export async function listTelegramChannels(env){
  await ensureMultiChannelTables(env);
  const [legacy,extras]=await Promise.all([
    env.DB.prepare('SELECT telegram_chat_id,automation_enabled,interval_minutes,max_daily FROM settings WHERE id=1').first(),
    env.DB.prepare("SELECT c.id,c.name,c.category,c.telegram_chat_id,c.bot_mode,c.channel_registered,c.telegram_enabled,c.automation_enabled,c.interval_minutes,c.max_daily,c.start_hour,c.end_hour,c.token_encrypted, (SELECT COUNT(*) FROM channel_offers o WHERE o.channel_id=c.id AND o.status='ready') AS ready_count FROM telegram_channels c ORDER BY c.id").all()
  ]);
  return [{id:1,name:'Canal principal',category:'Geral',telegram_chat_id:legacy?.telegram_chat_id||'@achadinhosmlcr',
    bot_mode:'principal',automation_enabled:legacy?.automation_enabled||0,
    interval_minutes:legacy?.interval_minutes||30,max_daily:legacy?.max_daily||12,ready_count:0},
    ...extras.results.map(sanitized)];
}
export async function createTelegramChannel(env,body){
  await ensureMultiChannelTables(env);
  const name=trimField(body.name,80,'Nome do canal');
  const category=trimField(body.category||'Geral',60,'Categoria');
  const handle=normalizeTelegramHandle(body.telegram_chat_id);
  const mode=body.bot_mode==='dedicated'?'dedicated':'shared';
  if(body.bot_mode&&!['shared','dedicated'].includes(body.bot_mode))throw bad('Tipo de bot inválido.');
  await destinationAvailable(env,handle);
  let token=null;
  if(mode==='dedicated'&&body.bot_token){
    const supplied=String(body.bot_token).trim();
    await verifyToken(supplied);
    token=await encryptToken(env.SESSION_SECRET,supplied);
  }
  const now=epoch();
  const inserted=await env.DB.prepare('INSERT INTO telegram_channels(id,name,category,telegram_chat_id,bot_mode,token_encrypted,created_at,updated_at) VALUES((SELECT COALESCE(MAX(id),1)+1 FROM telegram_channels),?,?,?,?,?,?,?)')
    .bind(name,category,handle,mode,token,now,now).run();
  const id=Number(inserted.meta?.last_row_id);
  if(!id||id<2)throw bad('Não foi possível criar o canal.',500);
  await log(env,id,'channel_created','Canal adicionado desligado por padrão.');
  return {ok:true,id};
}
export async function channelState(env,id){
  const c=await row(env,id);
  const [offers,counts,logs]=await Promise.all([
    env.DB.prepare(OFFERS_SQL+' WHERE o.channel_id=? ORDER BY o.created_at DESC,o.id DESC LIMIT 100').bind(c.id).all(),
    env.DB.prepare('SELECT status,COUNT(*) AS total FROM channel_offers WHERE channel_id=? GROUP BY status').bind(c.id).all(),
    env.DB.prepare('SELECT event,detail,created_at,offer_id FROM channel_logs WHERE channel_id=? ORDER BY id DESC LIMIT 20').bind(c.id).all()
  ]);
  return {settings:{...sanitized(c),telegram_chat_id:c.telegram_chat_id},channel:sanitized(c),
    offers:offers.results,counts:counts.results,logs:logs.results,
    telegram_token_configured:c.bot_mode==='shared'?!!env.TELEGRAM_BOT_TOKEN:!!c.token_encrypted};
}
export async function updateTelegramChannel(env,id,body){
  const previous=await row(env,id);
  const {interval,maxDaily,start,end}=parseSettings(body);
  const name=trimField(body.name||previous.name,80,'Nome do canal');
  const category=trimField(body.category||previous.category,60,'Categoria');
  const handle=normalizeTelegramHandle(body.telegram_chat_id);
  const mode=body.bot_mode;
  if(!['shared','dedicated'].includes(mode))throw bad('Selecione um bot válido.');
  await destinationAvailable(env,handle,previous.id);
  const tokenInput=String(body.bot_token||'').trim();
  const tokenChanged=!!tokenInput||mode!==previous.bot_mode;
  let cipher=mode==='dedicated'?previous.token_encrypted:null;
  if(mode!==previous.bot_mode)cipher=null;
  if(tokenInput){
    if(mode!=='dedicated')throw bad('Escolha bot exclusivo para cadastrar um token.');
    await verifyToken(tokenInput);
    cipher=await encryptToken(env.SESSION_SECRET,tokenInput);
  }
  const changed=handle!==previous.telegram_chat_id||tokenChanged;
  const registered=changed?false:body.channel_registered;
  const enabled=changed?false:body.telegram_enabled;
  const automation=changed?false:body.automation_enabled;
  if((enabled||automation)&&!registered)throw bad('Confirme o cadastro do canal na Central de Afiliados.');
  if(automation&&!enabled)throw bad('Habilite o Telegram antes da automação.');
  if(registered&&enabled){
    const token=mode==='shared'?await globalToken(env,{bot_mode:'shared'}):
      cipher?await decryptToken(env.SESSION_SECRET,cipher):null;
    if(!token)throw bad('Cadastre o token exclusivo deste canal.');
    await verifyChannel(token,handle);
  }
  if(category!==previous.category){
    const pending=await env.DB.prepare("SELECT COUNT(*) AS total FROM channel_offers WHERE channel_id=? AND status IN ('ready','sending')").bind(previous.id).first();
    if(pending?.total)throw bad('Publique ou resolva a fila antes de mudar a categoria do canal.');
  }
  const time=epoch();
  await env.DB.prepare(`UPDATE telegram_channels SET name=?,category=?,telegram_chat_id=?,bot_mode=?,token_encrypted=?,
  channel_registered=?,telegram_enabled=?,automation_enabled=?,interval_minutes=?,max_daily=?,start_hour=?,end_hour=?,
  last_attempt_at=CASE WHEN ? THEN 0 ELSE last_attempt_at END,updated_at=? WHERE id=?`)
    .bind(name,category,handle,mode,cipher,+registered,+enabled,+automation,interval,maxDaily,start,end,
      changed||(!previous.automation_enabled&&automation)?1:0,time,previous.id).run();
  await log(env,previous.id,'settings_updated',changed?'Bot ou destino alterado; envio pausado.':'Configurações atualizadas.');
  return {ok:true,channel_changed:changed};
}
export async function testTelegramChannel(env,id){
  const c=await row(env,id);
  if(!c.channel_registered)throw bad('Confirme o cadastro público do canal na Central de Afiliados.');
  const token=await globalToken(env,c);
  await verifyChannel(token,c.telegram_chat_id);
  const message=await api(token,'sendMessage',{chat_id:c.telegram_chat_id,
    text:'✅ Teste de integração CR Jornada Afiliados. Nenhuma oferta foi publicada.'});
  await log(env,c.id,'channel_test','Teste de envio confirmado.');
  return {ok:true,message_id:message.message_id};
}
export async function addChannelOffer(env,id,body){
  const c=await row(env,id);
  const offer=normalizeOffer(body);
  if(c.category!=='Geral'&&offer.category.toLocaleLowerCase('pt-BR')!==c.category.toLocaleLowerCase('pt-BR'))
    throw bad('Este canal aceita somente ofertas da categoria '+c.category+'.');
  const duplicated=await env.DB.prepare('SELECT id FROM offers WHERE affiliate_url=?').bind(offer.affiliate_url).first();
  if(duplicated)throw bad('Este link já está no canal principal. Use uma oferta diferente para cada canal.',409);
  const time=epoch();
  let result;
  try{
    result=await env.DB.prepare('INSERT INTO channel_offers(channel_id,title,affiliate_url,category,price_cents,old_price_cents,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(c.id,offer.title,offer.affiliate_url,offer.category,offer.price_cents,offer.old_price_cents,time).run();
  }catch(e){if(/UNIQUE/i.test(String(e.message||e)))throw bad('Este link já pertence a outro canal.',409);throw e;}
  await log(env,c.id,'offer_added',offer.title,result.meta?.last_row_id||null);
  return {ok:true};
}
export async function saveChannelCoupon(env,id,body){
  const c=await row(env,id);
  const coupon=normalizeCoupon(body);
  const o=await env.DB.prepare('SELECT status FROM channel_offers WHERE id=? AND channel_id=?').bind(coupon.offer_id,c.id).first();
  if(!o)throw bad('Oferta não encontrada neste canal.',404);
  if(o.status!=='ready')throw bad('Só é possível vincular cupom a ofertas na fila.',409);
  const sql="INSERT INTO channel_offer_coupons(offer_id,kind,code,discount_type,discount_value,min_cart_cents,max_discount_cents,start_day,end_day,source_url,notes,owner_confirmed,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(offer_id) DO UPDATE SET kind=excluded.kind,code=excluded.code,discount_type=excluded.discount_type,discount_value=excluded.discount_value,min_cart_cents=excluded.min_cart_cents,max_discount_cents=excluded.max_discount_cents,start_day=excluded.start_day,end_day=excluded.end_day,source_url=excluded.source_url,notes=excluded.notes,updated_at=excluded.updated_at";
  await env.DB.prepare(sql).bind(coupon.offer_id,coupon.kind,coupon.code,coupon.discount_type,coupon.discount_value,coupon.min_cart_cents,coupon.max_discount_cents,coupon.start_day,coupon.end_day,coupon.source_url,coupon.notes,epoch()).run();
  await log(env,c.id,'coupon_saved','Cupom oficial informado.',coupon.offer_id);
  return {ok:true};
}
export async function requeueChannelOffer(env,id,offerId){
  const c=await row(env,id);
  const res=await env.DB.prepare("UPDATE channel_offers SET status='ready',last_error=NULL WHERE id=? AND channel_id=? AND status='needs_review'")
    .bind(Number(offerId),c.id).run();
  if(res.meta?.changes!==1)throw bad('Somente ofertas em revisão podem ser reenfileiradas.',409);
  await log(env,c.id,'manual_requeue','Reenfileiramento após conferência.',Number(offerId));
  return {ok:true};
}
async function sendOfferWithImage(token,chat,offer){
  const payload=telegramPayload(offer,chat);
  let photo=null;
  try{photo=await findProductImage(offer.affiliate_url);}
  catch(err){console.warn('Imagem indisponível para novo canal:',offer.id,String(err?.message||'').slice(0,80));}
  if(photo){
    try{
      const msg=await api(token,'sendPhoto',{chat_id:chat,photo,caption:payload.text.slice(0,1024),reply_markup:payload.reply_markup});
      return {message:msg,format:'photo'};
    }catch(error){
      if(error.telegramStatus!==400)throw error;
      // Um erro 400 da foto é recusa explícita, seguro tentar enviar texto.
    }
  }
  const msg=await api(token,'sendMessage',{...payload,text:payload.text+'\n'+offer.affiliate_url});
  return {message:msg,format:photo?'text_photo_rejected':'text_no_image'};
}
export async function publishChannelOffer(env,id,offerId){
  const c=await row(env,id);
  if(!c.telegram_enabled||!c.channel_registered)throw bad('Habilite e autorize o canal antes de publicar.');
  const token=await globalToken(env,c);
  await verifyChannel(token,c.telegram_chat_id);
  const offer=await env.DB.prepare(OFFERS_SQL+' WHERE o.channel_id=? AND o.id=?').bind(c.id,Number(offerId)).first();
  if(!offer)throw bad('Oferta não encontrada neste canal.',404);
  const claim=await env.DB.prepare("UPDATE channel_offers SET status='sending',last_error=NULL WHERE id=? AND channel_id=? AND status='ready'").bind(offer.id,c.id).run();
  if(claim.meta?.changes!==1)throw bad('Oferta já publicada ou em revisão.',409);
  try{
    const result=await sendOfferWithImage(token,c.telegram_chat_id,offer);
    const now=epoch(),day=localTimeParts(new Date()).day;
    await env.DB.prepare("UPDATE channel_offers SET status='published',published_at=?,published_day=?,telegram_message_id=? WHERE id=? AND channel_id=? AND status='sending'")
      .bind(now,day,result.message.message_id,offer.id,c.id).run();
    await env.DB.prepare('UPDATE telegram_channels SET last_attempt_at=? WHERE id=?').bind(now,c.id).run();
    await log(env,c.id,'published','Telegram enviado • '+result.format,offer.id);
    return {status:'published',message_id:result.message.message_id,format:result.format};
  }catch(e){
    const msg=String(e.message||e).slice(0,220);
    await env.DB.prepare("UPDATE channel_offers SET status='needs_review',last_error=? WHERE id=? AND channel_id=? AND status='sending'")
      .bind(msg,offer.id,c.id).run();
    await log(env,c.id,'needs_review',msg,offer.id);
    return {status:'needs_review',error:msg};
  }
}
export async function runMultiChannelScheduled(env){
  if(!env?.DB)return {skipped:'db'};
  await ensureMultiChannelTables(env);
  const channels=await env.DB.prepare("SELECT * FROM telegram_channels WHERE automation_enabled=1 AND telegram_enabled=1 AND channel_registered=1 ORDER BY id LIMIT 30").all();
  const results=[];
  for(const c of channels.results){
    const now=new Date(),day=localTimeParts(now).day;
    const [counts,latest]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total FROM channel_offers WHERE channel_id=? AND status='published' AND published_day=?").bind(c.id,day).first(),
      env.DB.prepare("SELECT MAX(published_at) AS time FROM channel_offers WHERE channel_id=? AND status='published'").bind(c.id).first()
    ]);
    if(!shouldSend(c,now,counts?.total||0,latest?.time?latest.time*1000:null))continue;
    const offer=await env.DB.prepare("SELECT id FROM channel_offers WHERE channel_id=? AND status='ready' ORDER BY created_at,id LIMIT 1").bind(c.id).first();
    if(!offer)continue;
    const stamp=epoch();
    const slot=await env.DB.prepare('UPDATE telegram_channels SET last_attempt_at=? WHERE id=? AND automation_enabled=1 AND telegram_enabled=1 AND channel_registered=1 AND (last_attempt_at=0 OR last_attempt_at<=?)')
      .bind(stamp,c.id,stamp-c.interval_minutes*60).run();
    if(slot.meta?.changes!==1)continue;
    try{
      results.push({channel_id:c.id,...await publishChannelOffer(env,c.id,offer.id)});
    }catch(e){
      await log(env,c.id,'schedule_error',String(e.message||e).slice(0,150));
      results.push({channel_id:c.id,status:'error'});
    }
  }
  return {results};
}
