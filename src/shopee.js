import {parseOptionalBRL,localTimeParts,formatBRL} from './logic.js';
import {categoryMatches} from './multichannel.js';
import {listShopeeOwnDestinations,shoOwnDestination,sendShopeeOwnText,shopeeWhatsAppInstance,ensureShopeeDestinationTables} from './shopee-destinations.js';

const SCHEMA=[
  "CREATE TABLE IF NOT EXISTS shopee_targets (id INTEGER PRIMARY KEY AUTOINCREMENT,network TEXT NOT NULL CHECK(network IN ('telegram','whatsapp')),target_id INTEGER NOT NULL CHECK(target_id>=1),category TEXT NOT NULL DEFAULT 'Geral',enabled INTEGER NOT NULL DEFAULT 0,permission_confirmed INTEGER NOT NULL DEFAULT 0,interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(interval_minutes BETWEEN 1 AND 1440),max_daily INTEGER NOT NULL DEFAULT 12 CHECK(max_daily BETWEEN 1 AND 48),start_hour INTEGER NOT NULL DEFAULT 8,end_hour INTEGER NOT NULL DEFAULT 21,last_attempt_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(network,target_id))",
  "CREATE TABLE IF NOT EXISTS shopee_offers (id INTEGER PRIMARY KEY AUTOINCREMENT,destination_id INTEGER NOT NULL REFERENCES shopee_targets(id),title TEXT NOT NULL,affiliate_url TEXT NOT NULL,category TEXT NOT NULL,price_cents INTEGER,old_price_cents INTEGER,created_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','sending','published','needs_review')),published_at INTEGER,published_day TEXT,message_id TEXT,last_error TEXT,UNIQUE(destination_id,affiliate_url))",
  "CREATE INDEX IF NOT EXISTS idx_shopee_queue ON shopee_offers(destination_id,status,created_at)",
  "CREATE TABLE IF NOT EXISTS shopee_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,destination_id INTEGER NOT NULL,offer_id INTEGER,event TEXT NOT NULL,detail TEXT,created_at INTEGER NOT NULL)"
];
const nowSec=()=>Math.floor(Date.now()/1000);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const allowedNetwork=value=>value==='telegram'||value==='whatsapp';
function targetId(value){
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<1)throw fail('Selecione um canal ou grupo válido.');
  return n;
}
function validateCategory(value){
  const s=String(value||'').trim();
  if(!s||s.length>60)throw fail('Informe uma categoria de até 60 caracteres.');
  return s;
}
export function validateShopeeAffiliateUrl(input){
  if(typeof input!=='string'||input.length>2048)throw fail('Link da Shopee inválido.');
  let url;
  try{url=new URL(input.trim());}catch{throw fail('Informe uma URL válida da Shopee.');}
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.port||
    !['shopee.com.br','www.shopee.com.br','s.shopee.com.br','shp.ee','br.shp.ee'].includes(host)||
    url.pathname==='/'||url.pathname.length>1200)
    throw fail('Cole somente o link HTTPS gerado na sua conta de afiliado da Shopee.');
  return url.href;
}
export function normalizeShopeeOffer(data){
  if(data?.owner_confirmation!==true)throw fail('Confirme que você gerou este link no Portal de Afiliados da Shopee.');
  const title=String(data.title||'').trim();
  if(title.length<5||title.length>180)throw fail('Nome do produto: entre 5 e 180 caracteres.');
  const affiliate_url=validateShopeeAffiliateUrl(data.affiliate_url);
  const category=validateCategory(data.category||'Geral');
  const price_cents=parseOptionalBRL(data.price);
  const old_price_cents=parseOptionalBRL(data.old_price);
  if(price_cents!=null&&old_price_cents!=null&&old_price_cents<=price_cents)
    throw fail('O preço anterior deve ser maior que o atual.');
  return {title,affiliate_url,category,price_cents,old_price_cents};
}
export async function ensureShopeeTables(env){for(const sql of SCHEMA)await env.DB.prepare(sql).run();}
async function available(env){
  await ensureShopeeTables(env);
  // Somente os destinos próprios da Shopee. IDs antigos 1,2,3 do Mercado Livre
  // permanecem armazenados mas são inelegíveis para qualquer publicação Shopee.
  return listShopeeOwnDestinations(env);
}
async function verifyTarget(env,network,value){
  if(!allowedNetwork(network))throw fail('Plataforma de publicação inválida.');
  const id=targetId(value);
  const destinations=await available(env);
  const selected=destinations.find(c=>c.network===network&&c.target_id===id);
  if(!selected)throw fail('Canal ou grupo não encontrado.',404);
  return selected;
}
async function row(env,network,target){
  const c=await verifyTarget(env,network,target);
  const settings=await env.DB.prepare('SELECT * FROM shopee_targets WHERE network=? AND target_id=?')
    .bind(network,c.target_id).first();
  return {base:c,config:settings||{
    network,target_id:c.target_id,category:c.category||'Geral',enabled:0,permission_confirmed:0,
    interval_minutes:60,max_daily:12,start_hour:8,end_hour:21,last_attempt_at:0
  }};
}
async function log(env,destinationId,event,details='',offerId=null){
  await env.DB.prepare('INSERT INTO shopee_logs(destination_id,offer_id,event,detail,created_at) VALUES(?,?,?,?,?)')
    .bind(destinationId,offerId,event,String(details).slice(0,240),nowSec()).run();
}
export async function shopeeDestinations(env){
  const options=await available(env);
  const configs=await env.DB.prepare('SELECT * FROM shopee_targets ORDER BY network,target_id').all();
  const configMap=new Map(configs.results.map(r=>[r.network+':'+r.target_id,r]));
  return {destinations:options.map(c=>({...c,configured:!!configMap.get(c.network+':'+c.target_id),
    shopee_enabled:!!configMap.get(c.network+':'+c.target_id)?.enabled}))};
}
export async function shopeeState(env,network,target){
  const {base,config}=await row(env,network,target);
  if(!config.id)return {base,config,offers:[],counts:[],logs:[]};
  const [offers,counts,logs]=await Promise.all([
    env.DB.prepare('SELECT * FROM shopee_offers WHERE destination_id=? ORDER BY created_at DESC,id DESC LIMIT 100').bind(config.id).all(),
    env.DB.prepare('SELECT status,COUNT(*) AS total FROM shopee_offers WHERE destination_id=? GROUP BY status').bind(config.id).all(),
    env.DB.prepare('SELECT event,detail,created_at,offer_id FROM shopee_logs WHERE destination_id=? ORDER BY id DESC LIMIT 20').bind(config.id).all()
  ]);
  return {base,config,offers:offers.results,counts:counts.results,logs:logs.results};
}
export async function saveShopeeTarget(env,body){
  const {base,config}=await row(env,body?.network,body?.target_id);
  const category=validateCategory(body.category);
  if(!categoryMatches(category,base.category))
    throw fail('Este destino está restrito à categoria '+base.category+'. Escolha a mesma categoria ou altere o destino original.');
  const interval=Number(body.interval_minutes),maximum=Number(body.max_daily);
  const start=Number(body.start_hour),end=Number(body.end_hour);
  if(body.interval_minutes===''||!Number.isInteger(interval)||interval<1||interval>1440||
    !Number.isInteger(maximum)||maximum<1||maximum>48||
    !Number.isInteger(start)||start<0||start>23||!Number.isInteger(end)||end<1||end>24||start>=end)
    throw fail('Intervalo, limite diário ou horário inválidos.');
  if(typeof body.enabled!=='boolean'||typeof body.permission_confirmed!=='boolean')
    throw fail('Confirme os controles de autorização da Shopee.');
  if(config.id&&config.category.toLowerCase()!==category.toLowerCase()&&category.toLowerCase()!=='geral'){
    const waiting=await env.DB.prepare("SELECT COUNT(*) AS total FROM shopee_offers WHERE destination_id=? AND status IN ('ready','sending') AND lower(category)<>lower(?)")
      .bind(config.id,category).first();
    if(waiting?.total)throw fail('A fila Shopee ainda possui ofertas de outra categoria. Resolva-as antes de mudar o filtro.');
  }
  if(body.enabled&&(!body.permission_confirmed||!base.base_enabled||!base.base_registered))
    throw fail('Confirme a autorização e ative primeiro este canal/grupo na aba de origem.');
  const stamp=nowSec();
  if(!config.id){
    await env.DB.prepare('INSERT INTO shopee_targets(network,target_id,category,enabled,permission_confirmed,interval_minutes,max_daily,start_hour,end_hour,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .bind(base.network,base.target_id,category,+body.enabled,+body.permission_confirmed,interval,maximum,start,end,stamp,stamp).run();
  }else{
    await env.DB.prepare('UPDATE shopee_targets SET category=?,enabled=?,permission_confirmed=?,interval_minutes=?,max_daily=?,start_hour=?,end_hour=?,updated_at=? WHERE id=?')
      .bind(category,+body.enabled,+body.permission_confirmed,interval,maximum,start,end,stamp,config.id).run();
  }
  return {ok:true};
}
export async function addShopeeOffer(env,body){
  const {base,config}=await row(env,body?.network,body?.target_id);
  if(!config.id)throw fail('Salve a configuração Shopee deste destino antes de cadastrar ofertas.');
  const offer=normalizeShopeeOffer(body);
  if(!categoryMatches(offer.category,config.category)||!categoryMatches(offer.category,base.category))
    throw fail('Este destino Shopee aceita apenas a categoria '+config.category+'.');
  try{
    const r=await env.DB.prepare('INSERT INTO shopee_offers(destination_id,title,affiliate_url,category,price_cents,old_price_cents,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(config.id,offer.title,offer.affiliate_url,offer.category,offer.price_cents,offer.old_price_cents,nowSec()).run();
    await log(env,config.id,'offer_added',offer.title,r.meta?.last_row_id||null);
    return {ok:true};
  }catch(error){
    if(/UNIQUE/i.test(error.message||''))throw fail('Este link Shopee já foi cadastrado neste destino.',409);
    throw error;
  }
}
function shopeeText(offer){
  const lines=['📣 Publicidade • Oferta Shopee','','🛍️ '+offer.title];
  if(offer.price_cents!=null&&Date.now()-offer.created_at*1000<6*60*60*1000){
    if(offer.old_price_cents>offer.price_cents)
      lines.push('🏷️ De '+formatBRL(offer.old_price_cents)+' por '+formatBRL(offer.price_cents));
    else lines.push('💰 Preço informado: '+formatBRL(offer.price_cents));
  }
  lines.push('','📂 Categoria: '+offer.category,'✅ Verifique preço, disponibilidade e condições antes de comprar.',
    '🔗 Link de afiliado Shopee:',offer.affiliate_url);
  return lines.join('\n');
}
async function claimInstance(env,targetId,stamp){
  const name=await shopeeWhatsAppInstance(env,targetId);
  if(!name.startsWith('cr-jornada-shopee'))throw fail('Essa instância não pertence à Shopee.',409);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS whatsapp_instance_pacing(instance_name TEXT PRIMARY KEY,last_attempt_at INTEGER NOT NULL DEFAULT 0)').run();
  await env.DB.prepare('INSERT OR IGNORE INTO whatsapp_instance_pacing(instance_name,last_attempt_at) VALUES(?,0)').bind(name).run();
  const claim=await env.DB.prepare('UPDATE whatsapp_instance_pacing SET last_attempt_at=? WHERE instance_name=? AND (last_attempt_at=0 OR last_attempt_at<=?)')
    .bind(stamp,name,stamp-60).run();
  if(claim.meta?.changes!==1)throw fail('O número Evolution enviou outra mensagem há menos de um minuto. Tente novamente no próximo ciclo.',409);
}
async function attempt(env,config,offer){
  const t=nowSec();
  const claim=await env.DB.prepare("UPDATE shopee_offers SET status='sending',last_error=NULL WHERE id=? AND destination_id=? AND status='ready'")
    .bind(offer.id,config.id).run();
  if(claim.meta?.changes!==1)return {skipped:'claimed'};
  try{
    const text=shopeeText(offer);
    const sent=await sendShopeeOwnText(env,config.network,config.target_id,text);
    await env.DB.prepare("UPDATE shopee_offers SET status='published',published_at=?,published_day=?,message_id=? WHERE id=? AND status='sending'")
      .bind(nowSec(),localTimeParts(new Date()).day,sent.message_id,offer.id).run();
    await log(env,config.id,'published','Publicação Shopee confirmada.',offer.id);
    return {status:'published',offer_id:offer.id};
  }catch(error){
    const reason=String(error.message||error).slice(0,220);
    await env.DB.prepare("UPDATE shopee_offers SET status='needs_review',last_error=? WHERE id=? AND status='sending'")
      .bind(reason,offer.id).run();
    await log(env,config.id,'needs_review',reason,offer.id);
    return {status:'needs_review',offer_id:offer.id};
  }
}
export async function requeueShopeeOffer(env,network,target,offerId){
  const {config}=await row(env,network,target);
  if(!config.id)throw fail('Destino não configurado.');
  const id=Number(offerId);
  if(!Number.isSafeInteger(id)||id<1)throw fail('Oferta inválida.');
  const changed=await env.DB.prepare("UPDATE shopee_offers SET status='ready',last_error=NULL WHERE id=? AND destination_id=? AND status='needs_review'")
    .bind(id,config.id).run();
  if(changed.meta?.changes!==1)throw fail('Somente ofertas em revisão podem ser reenfileiradas após conferência.',409);
  await log(env,config.id,'manual_requeue','Revisado antes de nova tentativa.',id);
  return {ok:true};
}
export async function publishShopeeOffer(env,network,target,offerId){
  const {base,config}=await row(env,network,target);
  if(!config.id||!config.enabled||!config.permission_confirmed||!base.base_enabled||!base.base_registered)
    throw fail('Ative e autorize a Shopee e o canal/grupo antes de publicar.');
  const id=Number(offerId);
  if(!Number.isSafeInteger(id)||id<1)throw fail('Oferta inválida.');
  const offer=await env.DB.prepare('SELECT * FROM shopee_offers WHERE id=? AND destination_id=?').bind(id,config.id).first();
  if(!offer)throw fail('Oferta não encontrada neste destino.',404);
  if(!categoryMatches(offer.category,config.category)||!categoryMatches(offer.category,base.category))
    throw fail('Categoria diferente da configurada neste destino.');
  if(offer.status!=='ready')throw fail('Oferta já publicada ou em revisão.',409);
  if(config.network==='whatsapp')await claimInstance(env,config.target_id,nowSec());
  return attempt(env,config,offer);
}
export async function runShopeeScheduled(env){
  if(!env?.DB)return {skipped:'db'};
  if(env.MASTER_SCHEDULE_ENABLED===false)return {skipped:'master_off'};
  await ensureShopeeTables(env);
  const rows=await env.DB.prepare('SELECT * FROM shopee_targets WHERE (enabled=1 OR ?=1) AND permission_confirmed=1 ORDER BY id LIMIT 60').bind(env.MASTER_SCHEDULE_ENABLED===true?1:0).all();
  const out=[];
  for(const config of rows.results){
    const date=new Date(),t=nowSec(),local=localTimeParts(date);
    if(local.hour<config.start_hour||local.hour>=config.end_hour)continue;
    const published=await env.DB.prepare("SELECT COUNT(*) AS total FROM shopee_offers WHERE destination_id=? AND status='published' AND published_day=?").bind(config.id,local.day).first();
    if((published?.total||0)>=config.max_daily||t-config.last_attempt_at<config.interval_minutes*60)continue;
    const offer=await env.DB.prepare("SELECT * FROM shopee_offers WHERE destination_id=? AND status='ready' AND (lower(?)='geral' OR lower(category)=lower(?)) ORDER BY created_at,id LIMIT 1")
      .bind(config.id,config.category,config.category).first();
    if(!offer)continue;
    let base;
    try{base=await verifyTarget(env,config.network,config.target_id);}catch{continue;}
    if(!base.base_enabled||!base.base_registered||!categoryMatches(offer.category,base.category))continue;
    const slot=await env.DB.prepare('UPDATE shopee_targets SET last_attempt_at=? WHERE id=? AND (enabled=1 OR ?=1) AND (last_attempt_at=0 OR last_attempt_at<=?)')
      .bind(t,config.id,env.MASTER_SCHEDULE_ENABLED===true?1:0,t-config.interval_minutes*60).run();
    if(slot.meta?.changes!==1)continue;
    if(config.network==='whatsapp'){
      try{await claimInstance(env,config.target_id,t);}
      catch{
        await env.DB.prepare('UPDATE shopee_targets SET last_attempt_at=? WHERE id=? AND last_attempt_at=?')
          .bind(config.last_attempt_at,config.id,t).run();
        continue;
      }
    }
    const result=await attempt(env,config,offer);
    out.push({destination_id:config.id,network:config.network,...result});
  }
  return {results:out};
}
