// Modelos personalizados persistentes no D1, independentes da fila e dos destinos.
// Novas contas mantêm o texto antigo até habilitarem explicitamente seu modelo.
import {MESSAGE_DEFAULT_TEXT,validateMessageTemplateBody,renderMessageTemplate} from './message-template-engine.js';

const CREATE_TEMPLATES="CREATE TABLE IF NOT EXISTS crj_message_templates ("+
 "id INTEGER PRIMARY KEY AUTOINCREMENT,"+
 "platform TEXT NOT NULL CHECK(platform IN ('mercadolivre','shopee')),"+
 "name TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";
const CREATE_SETTINGS="CREATE TABLE IF NOT EXISTS crj_message_template_settings ("+
 "platform TEXT PRIMARY KEY CHECK(platform IN ('mercadolivre','shopee')),"+
 "enabled INTEGER NOT NULL DEFAULT 0,active_template_id INTEGER,updated_at INTEGER NOT NULL DEFAULT 0)";
const now=()=>Math.floor(Date.now()/1000);
const fail=(msg,status=400)=>Object.assign(new Error(msg),{status});
const platformOf=value=>['mercadolivre','shopee'].includes(value)?value:(()=>{throw fail('Plataforma inválida.');})();
const VALID_NAME=/^[^\u0000-\u001f<>]{2,70}$/;
export async function ensureMessageTemplates(env){
 await env.DB.prepare(CREATE_TEMPLATES).run();
 await env.DB.prepare(CREATE_SETTINGS).run();
 for(const platform of ['mercadolivre','shopee']){
  await env.DB.prepare("INSERT OR IGNORE INTO crj_message_template_settings(platform,enabled,updated_at) VALUES(?,0,0)").bind(platform).run();
  const first=await env.DB.prepare('SELECT id FROM crj_message_templates WHERE platform=? ORDER BY id LIMIT 1').bind(platform).first();
  if(!first){
   const result=await env.DB.prepare('INSERT INTO crj_message_templates(platform,name,body,created_at,updated_at) VALUES(?,?,?,?,?)')
    .bind(platform,'Modelo CR Jornada',MESSAGE_DEFAULT_TEXT,now(),now()).run();
   const id=Number(result.meta?.last_row_id);
   if(Number.isSafeInteger(id)&&id>0)await env.DB.prepare('UPDATE crj_message_template_settings SET active_template_id=? WHERE platform=? AND active_template_id IS NULL').bind(id,platform).run();
  }
 }
}
export async function listMessageTemplates(env,platform){
 platform=platformOf(platform);
 await ensureMessageTemplates(env);
 const [settings,templates]=await Promise.all([
  env.DB.prepare('SELECT enabled,active_template_id FROM crj_message_template_settings WHERE platform=?').bind(platform).first(),
  env.DB.prepare('SELECT id,platform,name,body,created_at,updated_at FROM crj_message_templates WHERE platform=? ORDER BY id').bind(platform).all()
 ]);
 return {platform,enabled:settings?.enabled===1,active_template_id:Number(settings?.active_template_id||0),
  templates:templates.results,fields:['NOME_DO_PRODUTO','PRECO_ANTIGO','PRECO_NOVO','DESCONTO','CUPOM','PARCELAMENTO','LINK','LINKS','TEXTO_ORIGINAL']};
}
export async function saveMessageTemplate(env,payload){
 const platform=platformOf(payload?.platform);
 const name=String(payload?.name||'').trim();
 if(!VALID_NAME.test(name))throw fail('Dê um nome de 2 a 70 caracteres, sem tags HTML.');
 const body=validateMessageTemplateBody(payload?.body);
 await ensureMessageTemplates(env);
 let id=Number(payload?.id||0);
 if(id){
  if(!Number.isSafeInteger(id)||id<1)throw fail('ID de modelo inválido.');
  const updated=await env.DB.prepare('UPDATE crj_message_templates SET name=?,body=?,updated_at=? WHERE id=? AND platform=?')
   .bind(name,body,now(),id,platform).run();
  if(updated.meta?.changes!==1)throw fail('Modelo não encontrado nesta plataforma.',404);
 }else{
  const count=await env.DB.prepare('SELECT COUNT(*) AS total FROM crj_message_templates WHERE platform=?').bind(platform).first();
  if(Number(count?.total||0)>=12)throw fail('Limite de 12 modelos por plataforma.');
  const result=await env.DB.prepare('INSERT INTO crj_message_templates(platform,name,body,created_at,updated_at) VALUES(?,?,?,?,?)')
   .bind(platform,name,body,now(),now()).run();
  id=Number(result.meta?.last_row_id);
 }
 return {ok:true,id,...await listMessageTemplates(env,platform)};
}
export async function saveMessageTemplateSettings(env,payload){
 const platform=platformOf(payload?.platform);
 if(typeof payload?.enabled!=='boolean')throw fail('Informe se o modelo padrão ficará ativo.');
 await ensureMessageTemplates(env);
 const id=Number(payload?.active_template_id);
 if(!Number.isSafeInteger(id)||id<1)throw fail('Selecione um modelo válido.');
 const exists=await env.DB.prepare('SELECT id FROM crj_message_templates WHERE platform=? AND id=?').bind(platform,id).first();
 if(!exists)throw fail('Modelo não encontrado na plataforma escolhida.');
 await env.DB.prepare('UPDATE crj_message_template_settings SET enabled=?,active_template_id=?,updated_at=? WHERE platform=?')
  .bind(payload.enabled?1:0,id,now(),platform).run();
 return {ok:true,...await listMessageTemplates(env,platform)};
}
export async function deleteMessageTemplate(env,payload){
 const platform=platformOf(payload?.platform);const id=Number(payload?.id);
 if(!Number.isSafeInteger(id)||id<1)throw fail('ID inválido.');
 await ensureMessageTemplates(env);
 const count=await env.DB.prepare('SELECT COUNT(*) AS total FROM crj_message_templates WHERE platform=?').bind(platform).first();
 if(Number(count?.total||0)<=1)throw fail('Mantenha ao menos um modelo para esta plataforma.');
 const existing=await env.DB.prepare('SELECT id FROM crj_message_templates WHERE id=? AND platform=?').bind(id,platform).first();
 if(!existing)throw fail('Modelo não encontrado.',404);
 await env.DB.prepare('DELETE FROM crj_message_templates WHERE id=? AND platform=?').bind(id,platform).run();
 const fallback=await env.DB.prepare('SELECT id FROM crj_message_templates WHERE platform=? ORDER BY id LIMIT 1').bind(platform).first();
 await env.DB.prepare('UPDATE crj_message_template_settings SET active_template_id=?,enabled=CASE WHEN active_template_id=? THEN 0 ELSE enabled END WHERE platform=? AND active_template_id=?')
  .bind(fallback.id,id,platform,id).run();
 return {ok:true,...await listMessageTemplates(env,platform)};
}
export async function withActiveMessageTemplate(env,offer,platform='mercadolivre'){
 if(!env?.DB||!['mercadolivre','shopee'].includes(platform)||!offer)return offer;
 try{
  // Sem estado global/cache: mudanças no modelo chegam ao próximo envio.
  await ensureMessageTemplates(env);
  const entry=await env.DB.prepare('SELECT t.body FROM crj_message_template_settings s JOIN crj_message_templates t ON t.id=s.active_template_id AND t.platform=s.platform WHERE s.platform=? AND s.enabled=1').bind(platform).first();
  return entry?.body?{...offer,message_template:entry.body}:offer;
 }catch(error){
  console.warn('Modelo de mensagem indisponível; mantendo padrão:',String(error?.message||error).slice(0,90));
  return offer;
 }
}
export function previewMessageTemplate(payload){
 platformOf(payload?.platform);
 const body=validateMessageTemplateBody(payload?.body);
 const at=Date.now(),epoch=Math.floor(at/1000);
 const example={
  title:'Kit de ferramentas para casa (EXEMPLO)',affiliate_url:'https://promoml.app/AbCdEf123_-X',
  created_at:epoch,promo_captured_at:epoch,
  promo_terms_json:JSON.stringify({
   price_cents:3482,old_price_cents:4990,price_source:'mercadolivre',
   payment_mode:'unspecified',card_price_cents:null,
   installments:3,installment_cents:1161,installments_no_interest:true,
   coupon_required:false,coupon_code:null
  })
 };
 const opts={now:at,random:()=>0};
 return {ok:true,whatsapp:renderMessageTemplate(example,body,{network:'whatsapp',...opts}),
  telegram:renderMessageTemplate(example,body,{network:'telegram',...opts}),
  note:'Valores e link demonstrativos. Nos envios reais, campos ausentes ou não confirmados são omitidos.'};
}
