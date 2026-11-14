import { normalizeOffer,localTimeParts,composeOfferMessage } from './logic.js';
import { normalizeCoupon } from './coupons.js';
import { findProductImage } from './images.js';
import { resolveProductImage } from './offer-images.js';
import { categoryMatches,normalizeChannelCategory } from './multichannel.js';
import { listWhatsAppGroups,connectAffiliateWhatsApp,getAffiliateWhatsAppConnection,evolutionOrigin,ensureWhatsAppTables } from './whatsapp.js';

const CREATE=[
`CREATE TABLE IF NOT EXISTS whatsapp_groups (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT 'Geral',
 instance_mode TEXT NOT NULL CHECK(instance_mode IN ('shared','dedicated')),
 instance_name TEXT NOT NULL,
 group_jid TEXT NOT NULL DEFAULT '',
 public_registered INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 0,
 interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(interval_minutes BETWEEN 1 AND 1440),
 max_daily INTEGER NOT NULL DEFAULT 12 CHECK(max_daily BETWEEN 1 AND 48),
 start_hour INTEGER NOT NULL DEFAULT 8,
 end_hour INTEGER NOT NULL DEFAULT 21,
 last_attempt_at INTEGER NOT NULL DEFAULT 0,
 started_at INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_group_destination ON whatsapp_groups(instance_name,group_jid) WHERE group_jid<>''`,
`CREATE TABLE IF NOT EXISTS whatsapp_group_offers (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 group_id INTEGER NOT NULL REFERENCES whatsapp_groups(id),
 title TEXT NOT NULL, affiliate_url TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT 'Geral',
 price_cents INTEGER,old_price_cents INTEGER,
 created_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','sending','published','needs_review')),
 published_at INTEGER,published_day TEXT,message_id TEXT,last_error TEXT,
 UNIQUE(group_id,affiliate_url)
)`,
`CREATE INDEX IF NOT EXISTS idx_whatsapp_group_queue ON whatsapp_group_offers(group_id,status,created_at)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_global_offer_link ON whatsapp_group_offers(affiliate_url)`,
`CREATE TABLE IF NOT EXISTS whatsapp_group_coupons (
 offer_id INTEGER PRIMARY KEY REFERENCES whatsapp_group_offers(id),
 kind TEXT NOT NULL CHECK(kind IN ('code','activation')),
 code TEXT,discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
 discount_value INTEGER NOT NULL,min_cart_cents INTEGER NOT NULL DEFAULT 0,max_discount_cents INTEGER,
 start_day TEXT NOT NULL,end_day TEXT NOT NULL,source_url TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '',owner_confirmed INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS whatsapp_group_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL REFERENCES whatsapp_groups(id),
 offer_id INTEGER,event TEXT NOT NULL,detail TEXT,created_at INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS whatsapp_instance_pacing (
 instance_name TEXT PRIMARY KEY,last_attempt_at INTEGER NOT NULL DEFAULT 0
)`
];
const OFFER_DETAILS="SELECT o.*,c.kind AS coupon_kind,c.code AS coupon_code,c.discount_type AS coupon_discount_type,c.discount_value AS coupon_discount_value,c.min_cart_cents AS coupon_min_cart_cents,c.max_discount_cents AS coupon_max_discount_cents,c.start_day AS coupon_start_day,c.end_day AS coupon_end_day,c.source_url AS coupon_source_url,c.notes AS coupon_notes,c.owner_confirmed AS coupon_owner_confirmed FROM whatsapp_group_offers o LEFT JOIN whatsapp_group_coupons c ON c.offer_id=o.id";
const PRIMARY_INSTANCE='cr-jornada-afiliados';
const now=()=>Math.floor(Date.now()/1000);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const int=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
const GROUP_ID=/^[0-9]{6,30}(?:-[0-9]{6,20})?@g\.us$/;
const VALID_INST=/^cr-jornada-grupo-([2-9][0-9]{0,8})$/;
const cleanName=v=>{
 const s=String(v||'').trim();
 if(s.length<3||s.length>80)throw fail('Informe um nome de grupo de 3 a 80 caracteres.');
 return s;
};
export async function ensureWhatsAppGroupTables(env){
 for(const sql of CREATE)await env.DB.prepare(sql).run();
}
async function groupRow(env,value){
 const id=Number(value);
 if(!Number.isSafeInteger(id)||id<2)throw fail('Grupo inválido.');
 await ensureWhatsAppGroupTables(env);
 const g=await env.DB.prepare('SELECT * FROM whatsapp_groups WHERE id=?').bind(id).first();
 if(!g)throw fail('Grupo não encontrado.',404);
 return g;
}
async function log(env,g,event,detail='',offerId=null){
 await env.DB.prepare('INSERT INTO whatsapp_group_logs(group_id,offer_id,event,detail,created_at) VALUES(?,?,?,?,?)')
   .bind(g,event,String(detail).slice(0,250),offerId,now()).run();
}
export async function listManagedWhatsAppGroups(env){
 await ensureWhatsAppGroupTables(env);
 await ensureWhatsAppTables(env);
 const [legacy,extras]=await Promise.all([
   env.DB.prepare('SELECT instance_name,group_jid,enabled FROM whatsapp_settings WHERE id=1').first(),
   env.DB.prepare('SELECT id,name,category,instance_mode,instance_name,group_jid,enabled,public_registered,interval_minutes,max_daily,start_hour,end_hour FROM whatsapp_groups ORDER BY id').all()
 ]);
 return [{id:1,name:'WhatsApp principal',category:'Geral',
   instance_mode:'shared',instance_name:legacy?.instance_name||PRIMARY_INSTANCE,
   group_jid:legacy?.group_jid||'',enabled:legacy?.enabled||0},...extras.results];
}
export async function createManagedWhatsAppGroup(env,body){
 await ensureWhatsAppGroupTables(env);
 const name=cleanName(body?.name);
 const category=normalizeChannelCategory(body?.category||'Geral');
 const mode=body?.instance_mode||'shared';
 if(!['shared','dedicated'].includes(mode))throw fail('Escolha o número existente ou um número exclusivo.');
 const time=now();
 const result=await env.DB.prepare(`INSERT INTO whatsapp_groups(id,name,category,instance_mode,instance_name,created_at,updated_at)
 VALUES((SELECT COALESCE(MAX(id),1)+1 FROM whatsapp_groups),?,?,?,'',?,?)`)
  .bind(name,category,mode,time,time).run();
 const id=Number(result.meta?.last_row_id);
 if(!int(id,2,999999999))throw fail('Não foi possível criar grupo.',500);
 const instance=mode==='shared'?PRIMARY_INSTANCE:'cr-jornada-grupo-'+id;
 await env.DB.prepare('UPDATE whatsapp_groups SET instance_name=? WHERE id=?').bind(instance,id).run();
 await log(env,id,'created','Grupo criado desligado por padrão.');
 return {ok:true,id};
}
export async function getManagedWhatsAppGroupState(env,id){
 const g=await groupRow(env,id);
 const [offers,counts,logs]=await Promise.all([
   env.DB.prepare(OFFER_DETAILS+' WHERE o.group_id=? ORDER BY o.created_at DESC,o.id DESC LIMIT 100').bind(g.id).all(),
   env.DB.prepare('SELECT status,COUNT(*) AS total FROM whatsapp_group_offers WHERE group_id=? GROUP BY status').bind(g.id).all(),
   env.DB.prepare('SELECT event,detail,created_at,offer_id FROM whatsapp_group_logs WHERE group_id=? ORDER BY id DESC LIMIT 20').bind(g.id).all()
 ]);
 return {group:g,offers:offers.results,counts:counts.results,logs:logs.results};
}
function parseTiming(body){
 const interval=Number(body?.interval_minutes),maxDaily=Number(body?.max_daily),start=Number(body?.start_hour),end=Number(body?.end_hour);
 if(body?.interval_minutes===''||!int(interval,1,1440)||!int(maxDaily,1,48)||!int(start,0,23)||!int(end,1,24)||start>=end)
   throw fail('Intervalo, limite diário ou horário inválido.');
 if(typeof body?.enabled!=='boolean'||typeof body?.public_registered!=='boolean')
   throw fail('Confirme as opções de autorização e publicação.');
 return {interval,maxDaily,start,end};
}
export async function saveManagedWhatsAppGroup(env,id,body){
 const previous=await groupRow(env,id);
 const {interval,maxDaily,start,end}=parseTiming(body);
 const name=cleanName(body.name);
 const category=normalizeChannelCategory(body.category);
 const jid=String(body.group_jid||'').trim();
 if(jid&&!GROUP_ID.test(jid))throw fail('Escolha um grupo válido da Evolution API.');
 const changed=jid!==previous.group_jid;
 const registered=changed?false:body.public_registered;
 const enabled=changed?false:body.enabled;
 if(enabled&&!registered)throw fail('Confirme que o grupo é público, aberto e cadastrado no Mercado Livre.');
 if((enabled||body.public_registered)&&!jid)throw fail('Selecione primeiro o grupo da Evolution.');
 if(enabled||body.public_registered){
   const found=await listWhatsAppGroups(env,previous.instance_name);
   if(!found.some(x=>x.id===jid))throw fail('O grupo não está conectado à instância Evolution selecionada.');
 }
 if(category!==previous.category){
   const pending=await env.DB.prepare("SELECT COUNT(*) AS total FROM whatsapp_group_offers WHERE group_id=? AND status='ready' AND lower(category)<>lower(?)").bind(previous.id,category).first();
   if(pending?.total&&category.toLocaleLowerCase('pt-BR')!=='geral')
     throw fail('Existem ofertas pendentes de outra categoria. Resolva a fila antes de mudar a categoria.');
 }
 const stamp=now();
 try{
   await env.DB.prepare(`UPDATE whatsapp_groups SET name=?,category=?,group_jid=?,public_registered=?,enabled=?,
     interval_minutes=?,max_daily=?,start_hour=?,end_hour=?,last_attempt_at=CASE WHEN ? THEN 0 ELSE last_attempt_at END,
     started_at=CASE WHEN ? THEN ? ELSE started_at END,last_error=NULL,updated_at=? WHERE id=?`)
     .bind(name,category,jid,+registered,+enabled,interval,maxDaily,start,end,
       changed||(!previous.enabled&&enabled)?1:0,
       changed||(!previous.enabled&&enabled)?1:0,stamp,stamp,previous.id).run();
 }catch(e){if(/UNIQUE/i.test(e.message||''))throw fail('Esse grupo já está configurado nessa instância.',409);throw e;}
 await log(env,previous.id,'settings_updated',changed?'Grupo alterado: publicação pausada.':'Configurações salvas.');
 return {ok:true,group_changed:changed,enabled,interval_minutes:interval};
}
export async function addManagedWhatsAppOffer(env,id,body){
 const g=await groupRow(env,id);
 const offer=normalizeOffer(body);
 if(!categoryMatches(offer.category,g.category))throw fail('Este grupo publica somente a categoria '+g.category+'.');
 let result;
 try{
   result=await env.DB.prepare('INSERT INTO whatsapp_group_offers(group_id,title,affiliate_url,category,price_cents,old_price_cents,created_at) VALUES(?,?,?,?,?,?,?)')
     .bind(g.id,offer.title,offer.affiliate_url,offer.category,offer.price_cents,offer.old_price_cents,now()).run();
 }catch(e){if(/UNIQUE/i.test(e.message||''))throw fail('Este link de afiliado já pertence a um grupo do WhatsApp.',409);throw e;}
 await log(env,g.id,'offer_added',offer.title,result.meta?.last_row_id||null);
 return {ok:true};
}
export async function saveManagedWhatsAppCoupon(env,id,body){
 const g=await groupRow(env,id),c=normalizeCoupon(body);
 const o=await env.DB.prepare('SELECT status FROM whatsapp_group_offers WHERE id=? AND group_id=?').bind(c.offer_id,g.id).first();
 if(!o)throw fail('Oferta não pertence a este grupo.',404);
 if(o.status!=='ready')throw fail('Cupom só pode ser vinculado a ofertas na fila.',409);
 const sql="INSERT INTO whatsapp_group_coupons(offer_id,kind,code,discount_type,discount_value,min_cart_cents,max_discount_cents,start_day,end_day,source_url,notes,owner_confirmed,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(offer_id) DO UPDATE SET kind=excluded.kind,code=excluded.code,discount_type=excluded.discount_type,discount_value=excluded.discount_value,min_cart_cents=excluded.min_cart_cents,max_discount_cents=excluded.max_discount_cents,start_day=excluded.start_day,end_day=excluded.end_day,source_url=excluded.source_url,notes=excluded.notes,updated_at=excluded.updated_at";
 await env.DB.prepare(sql).bind(c.offer_id,c.kind,c.code,c.discount_type,c.discount_value,c.min_cart_cents,c.max_discount_cents,c.start_day,c.end_day,c.source_url,c.notes,now()).run();
 await log(env,g.id,'coupon_saved','Cupom registrado.',c.offer_id);
 return {ok:true};
}
export async function requeueManagedWhatsAppOffer(env,id,offerId){
 const g=await groupRow(env,id);
 const r=await env.DB.prepare("UPDATE whatsapp_group_offers SET status='ready',last_error=NULL WHERE id=? AND group_id=? AND status='needs_review'").bind(Number(offerId),g.id).run();
 if(r.meta?.changes!==1)throw fail('Somente ofertas em revisão podem ser reenfileiradas.',409);
 await log(env,g.id,'manual_requeue','Reenvio após conferência manual.',Number(offerId));
 return {ok:true};
}
function qrImage(payload){
 for(const v of [payload?.qrcode?.base64,payload?.qrCode?.base64,payload?.base64,payload?.qrcode?.image]){
   if(typeof v!=='string'||v.length>300000)continue;
   const image=v.startsWith('data:')?v:'data:image/png;base64,'+v;
   if(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))return image;
 }
 return null;
}
async function evo(env,path,{method='GET',body}={}){
 if(!env.EVOLUTION_API_KEY||!env.EVOLUTION_API_URL)throw fail('Configure a Evolution API na Cloudflare.',503);
 const key=String(env.EVOLUTION_API_KEY).trim();
 const response=await fetch(evolutionOrigin(env.EVOLUTION_API_URL)+path,{
   method,redirect:'manual',
   headers:{apikey:key,accept:'application/json',...(body?{'content-type':'application/json'}:{})},
   ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(16000)
 });
 if(!response.ok){
   const error=fail(response.status===401||response.status===403?'Evolution API recusou a chave global.':
     'Evolution API respondeu HTTP '+response.status+' na operação.',503);
   error.httpStatus=response.status;throw error;
 }
 const data=await response.json().catch(()=>null);
 if(!data||typeof data!=='object'||data.error)throw fail('Resposta inválida da Evolution API.',503);
 return data;
}
const instanceList=x=>Array.isArray(x)?x:Array.isArray(x?.instances)?x.instances:Array.isArray(x?.data)?x.data:null;
const instanceName=x=>x?.name||x?.instanceName||x?.instance?.instanceName||x?.instance?.name;
async function ensureDedicatedInstance(env,g,create=false){
 if(g.instance_mode!=='dedicated'||g.instance_name!=='cr-jornada-grupo-'+g.id||!VALID_INST.test(g.instance_name))
   throw fail('Instância exclusiva inválida.');
 const data=await evo(env,'/instance/fetchInstances');
 const list=instanceList(data);
 if(!list)throw fail('Não foi possível conferir as instâncias existentes.');
 let item=list.find(x=>instanceName(x)===g.instance_name);
 let created=null;
 if(!item&&create){
   try{
     created=await evo(env,'/instance/create',{method:'POST',
       body:{instanceName:g.instance_name,integration:'WHATSAPP-BAILEYS',qrcode:true}});
   }catch(e){
     if(![400,409].includes(e.httpStatus))throw e;
     const again=instanceList(await evo(env,'/instance/fetchInstances'));
     if(!again?.some(x=>instanceName(x)===g.instance_name))throw e;
   }
 }
 return {exists:!!item||!!created||create,created};
}
export async function managedWhatsAppConnection(env,id,create=false){
 const g=await groupRow(env,id);
 if(g.instance_mode==='shared'){
   const data=create?await connectAffiliateWhatsApp(env):await getAffiliateWhatsAppConnection(env);
   return {instance_name:PRIMARY_INSTANCE,exists:data.exists,state:data.state,qr_image:data.qr_image||null};
 }
 const check=await ensureDedicatedInstance(env,g,create);
 if(!check.exists)return {instance_name:g.instance_name,exists:false,state:'not_created',qr_image:null};
 const data=await evo(env,'/instance/connectionState/'+encodeURIComponent(g.instance_name));
 const state=data?.instance?.state||data?.state||data?.instance?.connectionStatus;
 if(!['open','close','connecting','refused'].includes(state))throw fail('Estado desconhecido da Evolution.');
 if(state==='open')return {instance_name:g.instance_name,exists:true,state,qr_image:null};
 let qr=qrImage(check.created);
 if(create&&!qr)qr=qrImage(await evo(env,'/instance/connect/'+encodeURIComponent(g.instance_name)));
 return {instance_name:g.instance_name,exists:true,state,qr_image:qr};
}
export async function listManagedWhatsAppGroupOptions(env,id){
 const g=await groupRow(env,id);
 const options=await listWhatsAppGroups(env,g.instance_name);
 return {groups:options};
}
async function sendWhatsApp(env,g,offer){
 const link=offer.affiliate_url;
 const description=composeOfferMessage(offer);
 const text=(description.length+link.length+1>1024?description.slice(0,1023-link.length):description)+'\n'+link;
 let photo=null;
 try{photo=await resolveProductImage(env,link,findProductImage);}catch(err){console.warn('Foto grupo WA indisponível:',String(err?.message||err).slice(0,90));}
 const body=photo
   ?{number:g.group_jid,mediatype:'image',mimetype:photo.endsWith('.png')?'image/png':'image/jpeg',
     media:photo,caption:text,fileName:'oferta-mercado-livre.jpg'}
   :{number:g.group_jid,text,linkPreview:true};
 const reply=await evo(env,(photo?'/message/sendMedia/':'/message/sendText/')+encodeURIComponent(g.instance_name),
   {method:'POST',body});
 if(typeof reply.key?.id!=='string'||!reply.key.id)
   throw fail('Evolution não confirmou o envio; verifique no grupo antes de reenviar.');
 return {message_id:reply.key.id,format:photo?'image':'text'};
}
export async function testManagedWhatsAppGroup(env,id){
 const g=await groupRow(env,id);
 if(!g.public_registered||!g.group_jid)throw fail('Confirme o grupo público cadastrado no Mercado Livre.');
 const options=await listWhatsAppGroups(env,g.instance_name);
 if(!options.some(x=>x.id===g.group_jid))throw fail('Grupo não encontrado nessa instância.');
 const data=await evo(env,'/message/sendText/'+encodeURIComponent(g.instance_name),{
   method:'POST',body:{number:g.group_jid,text:'✅ Teste de conexão CR Jornada Afiliados. Nenhuma oferta foi publicada.'}
 });
 if(!data.key?.id)throw fail('A Evolution não confirmou o teste.');
 await log(env,g.id,'test_sent','Teste solicitado pelo administrador.');
 return {ok:true,message_id:data.key.id};
}
export async function publishManagedWhatsAppOffer(env,id,offerId){
 const g=await groupRow(env,id);
 if(!g.enabled||!g.public_registered||!g.group_jid)throw fail('Ative o grupo público antes de publicar.');
 const offer=await env.DB.prepare(OFFER_DETAILS+' WHERE o.group_id=? AND o.id=?').bind(g.id,Number(offerId)).first();
 if(!offer)throw fail('Oferta não encontrada neste grupo.',404);
 if(!categoryMatches(offer.category,g.category))throw fail('A oferta não corresponde à categoria do grupo.');
 const claim=await env.DB.prepare("UPDATE whatsapp_group_offers SET status='sending',last_error=NULL WHERE id=? AND group_id=? AND status='ready'").bind(offer.id,g.id).run();
 if(claim.meta?.changes!==1)throw fail('Oferta já enviada ou em revisão.',409);
 try{
   const result=await sendWhatsApp(env,g,offer);
   const stamp=now(),day=localTimeParts(new Date()).day;
   await env.DB.prepare("UPDATE whatsapp_group_offers SET status='published',published_at=?,published_day=?,message_id=? WHERE id=? AND group_id=? AND status='sending'")
     .bind(stamp,day,result.message_id,offer.id,g.id).run();
   await env.DB.prepare('UPDATE whatsapp_groups SET last_attempt_at=?,last_error=NULL WHERE id=?').bind(stamp,g.id).run();
   await log(env,g.id,'published',result.format,offer.id);
   return {status:'published',message_id:result.message_id};
 }catch(e){
   const reason=String(e.message||e).slice(0,220);
   await env.DB.prepare("UPDATE whatsapp_group_offers SET status='needs_review',last_error=? WHERE id=? AND group_id=? AND status='sending'")
     .bind(reason,offer.id,g.id).run();
   await env.DB.prepare('UPDATE whatsapp_groups SET last_error=? WHERE id=?').bind(reason,g.id).run();
   await log(env,g.id,'needs_review',reason,offer.id);
   return {status:'needs_review',error:reason};
 }
}
export async function runManagedWhatsAppScheduled(env){
 if(!env?.DB)return {skipped:'db'};
 await ensureWhatsAppGroupTables(env);
 const rows=await env.DB.prepare('SELECT * FROM whatsapp_groups WHERE enabled=1 AND public_registered=1 AND group_jid<>? ORDER BY id LIMIT 40').bind('').all();
 const results=[];
 for(const g of rows.results){
   const current=new Date(),clock=localTimeParts(current),time=now();
   if(clock.hour<g.start_hour||clock.hour>=g.end_hour)continue;
   const count=await env.DB.prepare("SELECT COUNT(*) AS total FROM whatsapp_group_offers WHERE group_id=? AND status='published' AND published_day=?").bind(g.id,clock.day).first();
   if((count?.total||0)>=g.max_daily)continue;
   if(g.last_attempt_at&&time-g.last_attempt_at<g.interval_minutes*60)continue;
   const offer=await env.DB.prepare("SELECT id FROM whatsapp_group_offers WHERE group_id=? AND status='ready' AND (lower(?)='geral' OR lower(category)=lower(?)) ORDER BY created_at,id LIMIT 1")
     .bind(g.id,g.category,g.category).first();
   if(!offer)continue;
   // Impede ciclos concorrentes do mesmo grupo; também limita disparos simultâneos do mesmo número.
   const claim=await env.DB.prepare('UPDATE whatsapp_groups SET last_attempt_at=? WHERE id=? AND enabled=1 AND (last_attempt_at=0 OR last_attempt_at<=?)')
     .bind(time,g.id,time-g.interval_minutes*60).run();
   if(claim.meta?.changes!==1)continue;
   await env.DB.prepare('INSERT OR IGNORE INTO whatsapp_instance_pacing(instance_name,last_attempt_at) VALUES(?,0)').bind(g.instance_name).run();
   const instance=await env.DB.prepare('UPDATE whatsapp_instance_pacing SET last_attempt_at=? WHERE instance_name=? AND (last_attempt_at=0 OR last_attempt_at<=?)')
     .bind(time,g.instance_name,time-60).run();
   if(instance.meta?.changes!==1){
     await env.DB.prepare('UPDATE whatsapp_groups SET last_attempt_at=? WHERE id=? AND last_attempt_at=?').bind(g.last_attempt_at,g.id,time).run();
     continue;
   }
   try{results.push({group_id:g.id,...await publishManagedWhatsAppOffer(env,g.id,offer.id)});}
   catch(e){await log(env,g.id,'schedule_error',String(e?.message||e).slice(0,140));results.push({group_id:g.id,status:'error'});}
 }
 return {results};
}


// Compartilha texto Shopee no destino WhatsApp já cadastrado e autorizado.
export async function sendPlatformWhatsAppText(env,targetId,text){
  const id=Number(targetId);
  let instance,jid;
  if(id===1){
    // Importação dinâmica não necessária: as tabelas da versão original já são criadas
    // pela central antes de ativar; usamos o mesmo banco e estado sem sobrescrevê-los.
    const config=await env.DB.prepare('SELECT instance_name,group_jid,public_registered,enabled FROM whatsapp_settings WHERE id=1').first();
    if(!config?.enabled||!config.public_registered||!config.group_jid)
      throw fail('Ative e confirme o grupo principal do WhatsApp antes de publicar Shopee.');
    instance=config.instance_name;
    jid=config.group_jid;
  }else{
    const g=await groupRow(env,id);
    if(!g.enabled||!g.public_registered||!g.group_jid)
      throw fail('Ative e confirme o grupo WhatsApp selecionado antes de publicar Shopee.');
    instance=g.instance_name;jid=g.group_jid;
  }
  // O mesmo número pode atender vários grupos: valide que ainda participa deste grupo.
  const groups=await listWhatsAppGroups(env,instance);
  if(!groups.some(g=>g.id===jid))throw fail('Grupo WhatsApp não encontrado no número conectado.');
  const response=await evo(env,'/message/sendText/'+encodeURIComponent(instance),
    {method:'POST',body:{number:jid,text,linkPreview:true}});
  if(typeof response?.key?.id!=='string'||!response.key.id)
    throw fail('Evolution não confirmou o envio; verifique o grupo antes de tentar novamente.');
  return {message_id:response.key.id,instance_name:instance};
}
