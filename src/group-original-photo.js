// Reprodução fiel da FOTO da oferta recebida num grupo autorizado.
// Apenas mensagens de imagem com link do Mercado Livre NA MESMA LEGENDA.
// Não guarda números de membros e não reutiliza fotos de grupos não autorizados.
import {trustedProductPage} from './images.js';

const GROUP=/^\d{6,30}(?:-\d{6,20})?@g\.us$/;
const INSTANCE=/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/;
const BASE64_LIMIT=1_300_000; // ~975 kB originais, abaixo do limite por linha do D1
const TTL=3*24*60*60;
const CREATE="CREATE TABLE IF NOT EXISTS affiliate_group_original_photos ("+
 "group_id INTEGER NOT NULL,message_id TEXT NOT NULL,mime TEXT NOT NULL,"+
 "image_b64 TEXT NOT NULL,created_at INTEGER NOT NULL,"+
 "PRIMARY KEY(group_id,message_id))";
const now=()=>Math.floor(Date.now()/1000);

export async function ensureGroupOriginalPhotos(env){
 if(env?.DB)await env.DB.prepare(CREATE).run();
}
function mediaMessage(entry){
 const m=entry?.message;
 return m?.imageMessage||m?.ephemeralMessage?.message?.imageMessage||
  m?.viewOnceMessage?.message?.imageMessage||
  m?.viewOnceMessageV2?.message?.imageMessage||null;
}
function hasMLLink(text){
 if(typeof text!=='string')return false;
 return /(?:https?:\/\/)?(?:meli\.la|melila\.me|meli\.promo|(?:www\.|produto\.)?mercadolivre\.com\.br)\//i.test(text);
}
function decodedBase64(raw,mimeHint=''){
 if(typeof raw!=='string')return null;
 const prefix=/^data:(image\/(?:jpeg|png));base64,/i.exec(raw);
 const mime=prefix?prefix[1].toLowerCase():String(mimeHint||'').toLowerCase();
 const b64=prefix?raw.slice(prefix[0].length):raw;
 if(!['image/jpeg','image/png'].includes(mime)||b64.length<120||
  b64.length>BASE64_LIMIT||!/^[-A-Za-z0-9+/]+={0,2}$/.test(b64))return null;
 let first;
 try{first=atob(b64.slice(0,32));}catch{return null;}
 const jpeg=first.charCodeAt(0)===255&&first.charCodeAt(1)===216&&first.charCodeAt(2)===255;
 const png=first.charCodeAt(0)===137&&first.slice(1,4)==='PNG';
 if(mime==='image/jpeg'&&!jpeg||mime==='image/png'&&!png)return null;
 return {mime,image_b64:b64};
}
function originFromEnv(env){
 try{
  const u=new URL(env.EVOLUTION_API_URL);
  return u.protocol==='https:'&&!u.username&&!u.password?u.origin:null;
 }catch{return null;}
}
async function getOriginalMedia(env,entry,instance,{fetcher=fetch}={}){
 const origin=originFromEnv(env);
 if(!origin||!env.EVOLUTION_API_KEY||!INSTANCE.test(instance))return null;
 // Algumas versões Evolution omitem messageType no webhook e envolvem
 // imagem em ephemeralMessage. A API exige o nó imageMessage explícito.
 const fullMessage={...entry,messageType:'imageMessage',
  message:{...entry.message,imageMessage:mediaMessage(entry)}};
 const payload=JSON.stringify({message:fullMessage,convertToMp4:false});
 if(payload.length>150_000)return null;
 try{
  const res=await fetcher(origin+'/chat/getBase64FromMediaMessage/'+encodeURIComponent(instance),{
   method:'POST',redirect:'manual',headers:{
    apikey:String(env.EVOLUTION_API_KEY).trim(),accept:'application/json',
    'content-type':'application/json'
   },body:payload,signal:AbortSignal.timeout(8500)
  });
  if(!res.ok||Number(res.headers.get('content-length')||0)>1_700_000)return null;
  const text=await res.text();
  if(text.length>1_700_000)return null;
  let result;try{result=JSON.parse(text);}catch{return null;}
  const encoded=result?.base64??result?.data?.base64??result?.media?.base64;
  return decodedBase64(encoded,
   result?.mimetype??result?.data?.mimetype??mediaMessage(entry)?.mimetype);
 }catch{return null;}
}
export async function captureGroupOriginalPhotos(env,event,{fetcher=fetch}={}){
 if(!env?.DB||!['messages.upsert','MESSAGES_UPSERT','messages-upsert'].includes(event?.event)||
  !INSTANCE.test(event?.instance||''))return {captured:0};
 const enabled=await env.DB.prepare('SELECT enabled FROM ml_monitor_settings WHERE id=1').first();
 if(!enabled?.enabled)return {captured:0};
 const entries=Array.isArray(event.data)?event.data:
  Array.isArray(event.data?.messages)?event.data.messages:[event.data];
 await ensureGroupOriginalPhotos(env);
 const groups=(await env.DB.prepare(
  'SELECT id,group_jid FROM ml_monitor_groups WHERE enabled=1 AND authorized=1 AND instance_name=?'
 ).bind(event.instance).all()).results||[];
 let captured=0;
 for(const entry of entries.slice(0,10)){
  if(captured>=2)break;
  if(entry?.key?.fromMe!==false||!GROUP.test(entry?.key?.remoteJid||'')||
   !/^[A-Za-z0-9._:-]{4,150}$/.test(entry?.key?.id||''))continue;
  const group=groups.find(g=>g.group_jid===entry.key.remoteJid);
  const photo=mediaMessage(entry);
  if(!group||!photo||!hasMLLink(photo.caption))continue;
  const existing=await env.DB.prepare(
   'SELECT 1 AS found FROM affiliate_group_original_photos WHERE group_id=? AND message_id=?'
  ).bind(group.id,entry.key.id).first();
  if(existing)continue;
  const file=await getOriginalMedia(env,entry,event.instance,{fetcher});
  if(!file)continue;
  await env.DB.prepare(
   'INSERT OR IGNORE INTO affiliate_group_original_photos(group_id,message_id,mime,image_b64,created_at) VALUES(?,?,?,?,?)'
  ).bind(group.id,entry.key.id,file.mime,file.image_b64,now()).run();
  captured++;
 }
 // Fotos temporárias: não acumular imagens de grupos para sempre.
 await env.DB.prepare('DELETE FROM affiliate_group_original_photos WHERE created_at<?')
  .bind(now()-TTL).run();
 return {captured};
}
export async function groupOriginalPhotoForOffer(env,affiliateUrl){
 if(!env?.DB||!trustedProductPage(affiliateUrl))return null;
 await ensureGroupOriginalPhotos(env);
 const queries=[
  "SELECT p.mime,p.image_b64 FROM affiliate_group_original_photos p "+
   "JOIN ml_monitor_links l ON l.group_id=p.group_id AND l.message_id=p.message_id "+
   "JOIN ml_link_batch_items i ON i.source_url=l.source_url "+
   "WHERE i.affiliate_url=? AND p.created_at>=? ORDER BY p.created_at DESC LIMIT 1",
  "SELECT p.mime,p.image_b64 FROM affiliate_group_original_photos p "+
   "JOIN ml_monitor_links l ON l.group_id=p.group_id AND l.message_id=p.message_id "+
   "JOIN affiliate_verified_sources s ON s.source_url=l.source_url "+
   "WHERE s.affiliate_url=? AND p.created_at>=? ORDER BY p.created_at DESC LIMIT 1"
 ];
 for(const sql of queries){
  try{
   const row=await env.DB.prepare(sql).bind(affiliateUrl,now()-TTL).first();
   const candidate=decodedBase64(row?.image_b64,row?.mime);
   if(candidate)return candidate;
  }catch{} // Tabelas opcionais podem não existir em instalações antigas.
 }
 return null;
}
export async function sendTelegramOriginalPhoto(token,chat,photo,payload,{fetcher=fetch}={}){
 const valid=decodedBase64(photo?.image_b64,photo?.mime);
 if(!valid)throw Object.assign(new Error('Imagem recebida no grupo inválida.'),{code:'PHOTO_NOT_READY'});
 const binary=atob(valid.image_b64);
 const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
 const form=new FormData();
 form.set('chat_id',chat);
 form.set('photo',new Blob([bytes],{type:valid.mime}),valid.mime==='image/png'?'oferta.png':'oferta.jpg');
 form.set('caption',payload.text);
 if(payload.parse_mode)form.set('parse_mode',payload.parse_mode);
 if(payload.reply_markup)form.set('reply_markup',JSON.stringify(payload.reply_markup));
 const res=await fetcher('https://api.telegram.org/bot'+token+'/sendPhoto',{
  method:'POST',body:form,signal:AbortSignal.timeout(20000)
 });
 const data=await res.json().catch(()=>null);
 if(res.ok&&data?.ok&&data?.result?.message_id)return data.result;
 if(res.status===400&&/photo|image|file|format|wrong type/i.test(String(data?.description||'')))
  throw Object.assign(new Error('Telegram não aceitou a foto original da oferta.'),{code:'PHOTO_NOT_READY'});
 throw new Error(String(data?.description||'Telegram HTTP '+res.status).slice(0,170));
}


// Recupera imagens de mensagens ANTIGAS ainda presentes na Evolution API.
// Uma mensagem só é elegível se o anúncio e o grupo já estiverem registrados
// e a oferta correspondente continuar na fila. Sem reenvio ou alterações de preço.
export async function restoreGroupPhotosForQueue(env,{fetcher=fetch,at=now()}={}){
 if(!env?.DB||!originFromEnv(env)||!env.EVOLUTION_API_KEY)return {skipped:'unconfigured'};
 await ensureGroupOriginalPhotos(env);
 await env.DB.prepare(
  "CREATE TABLE IF NOT EXISTS affiliate_group_photo_restore_attempts ("+
  "group_id INTEGER NOT NULL,message_id TEXT NOT NULL,last_attempt_at INTEGER NOT NULL DEFAULT 0,"+
  "attempts INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(group_id,message_id))"
 ).run();
 let item;
 try{
  item=await env.DB.prepare(
   "SELECT l.group_id,l.message_id,g.instance_name,g.group_jid "+
   "FROM offers o JOIN ml_link_batch_items bi ON bi.affiliate_url=o.affiliate_url "+
   "JOIN ml_monitor_links l ON l.source_url=bi.source_url "+
   "JOIN ml_monitor_groups g ON g.id=l.group_id "+
   "LEFT JOIN affiliate_group_original_photos p ON p.group_id=l.group_id AND p.message_id=l.message_id "+
   "LEFT JOIN affiliate_group_photo_restore_attempts r ON r.group_id=l.group_id AND r.message_id=l.message_id "+
   "WHERE o.status='ready' AND g.enabled=1 AND g.authorized=1 "+
   "AND l.message_id<>'' AND p.message_id IS NULL "+
   "AND COALESCE(r.last_attempt_at,0)<=? "+
   "ORDER BY o.id ASC LIMIT 1"
  ).bind(at-6*3600).first();
 }catch{return {skipped:'no_source_mapping'};}
 if(!item)return {skipped:'no_pending_images'};
 const lease=await env.DB.prepare(
  "INSERT INTO affiliate_group_photo_restore_attempts(group_id,message_id,last_attempt_at,attempts) "+
  "VALUES(?,?,?,1) ON CONFLICT(group_id,message_id) DO UPDATE SET "+
  "last_attempt_at=excluded.last_attempt_at,attempts=attempts+1 "+
  "WHERE last_attempt_at<=?"
 ).bind(item.group_id,item.message_id,at,at-6*3600).run();
 if(lease.meta?.changes!==1)return {skipped:'busy'};
 if(!INSTANCE.test(item.instance_name)||!GROUP.test(item.group_jid)||
  !/^[A-Za-z0-9._:-]{4,150}$/.test(item.message_id))return {skipped:'invalid_message'};
 try{
  const res=await fetcher(
   originFromEnv(env)+'/chat/findMessages/'+encodeURIComponent(item.instance_name),{
    method:'POST',redirect:'manual',headers:{
     apikey:String(env.EVOLUTION_API_KEY).trim(),accept:'application/json',
     'content-type':'application/json'
    },body:JSON.stringify({where:{key:{remoteJid:item.group_jid,id:item.message_id}},limit:4}),
    signal:AbortSignal.timeout(7500)
   });
  if(!res.ok||Number(res.headers.get('content-length')||0)>1_000_000)return {skipped:'lookup_failed'};
  const body=await res.text();
  if(body.length>1_000_000)return {skipped:'oversized'};
  const json=JSON.parse(body);
  const records=Array.isArray(json)?json:
   Array.isArray(json?.messages?.records)?json.messages.records:
   Array.isArray(json?.records)?json.records:
   Array.isArray(json?.messages)?json.messages:[];
  const record=records.find(m=>m?.key?.remoteJid===item.group_jid&&
   m?.key?.id===item.message_id&&m?.key?.fromMe===false&&mediaMessage(m));
  if(!record)return {skipped:'message_unavailable'};
  const photo=await getOriginalMedia(env,record,item.instance_name,{fetcher});
  if(!photo)return {skipped:'media_unavailable'};
  await env.DB.prepare(
   'INSERT OR IGNORE INTO affiliate_group_original_photos(group_id,message_id,mime,image_b64,created_at) VALUES(?,?,?,?,?)'
  ).bind(item.group_id,item.message_id,photo.mime,photo.image_b64,at).run();
  return {restored:1};
 }catch(error){
  return {skipped:'temporary_failure'};
 }
}
