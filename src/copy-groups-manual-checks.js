// Fila persistente de consultas manuais na aba COPIAR DE GRUPOS.
// O navegador apenas agenda e acompanha: as buscas externas rodam no Cron.
// Isso impede que uma busca longa expire a requisição HTTP do painel.
import {classifyMonitorMissingCategories,officialCategoryStats} from './monitor-official-categories.js';
import {recoverMissingMonitorPrices,ensureMonitor} from './whatsapp-link-monitor.js';

const CREATE="CREATE TABLE IF NOT EXISTS ml_group_manual_check_jobs ("+
 "kind TEXT PRIMARY KEY CHECK(kind IN ('categories','prices')),"+
 "status TEXT NOT NULL DEFAULT 'idle',"+
 "remaining INTEGER NOT NULL DEFAULT 0,"+
 "attempts INTEGER NOT NULL DEFAULT 0,"+
 "processed INTEGER NOT NULL DEFAULT 0,"+
 "classified INTEGER NOT NULL DEFAULT 0,"+
 "created INTEGER NOT NULL DEFAULT 0,"+
 "reused INTEGER NOT NULL DEFAULT 0,"+
 "failed INTEGER NOT NULL DEFAULT 0,"+
 "checked INTEGER NOT NULL DEFAULT 0,"+
 "found INTEGER NOT NULL DEFAULT 0,"+
 "requested_at INTEGER NOT NULL DEFAULT 0,"+
 "updated_at INTEGER NOT NULL DEFAULT 0,"+
 "lease_until INTEGER NOT NULL DEFAULT 0,"+
 "last_error TEXT NOT NULL DEFAULT '')";
const VALID=new Set(['categories','prices']);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const stamp=()=>Math.floor(Date.now()/1000);
const safeKind=kind=>VALID.has(kind)?kind:(()=>{throw fail('Tipo de verificação desconhecido.');})();
export async function ensureManualGroupChecks(env){
 if(!env?.DB)throw fail('Banco de dados indisponível.',503);
 await env.DB.prepare(CREATE).run();
 for(const kind of VALID)await env.DB.prepare('INSERT OR IGNORE INTO ml_group_manual_check_jobs(kind) VALUES(?)').bind(kind).run();
}
function output(row){
 if(!row)return null;
 return {kind:row.kind,status:row.status,remaining:Number(row.remaining||0),
   attempts:Number(row.attempts||0),processed:Number(row.processed||0),
   classified:Number(row.classified||0),created:Number(row.created||0),
   reused:Number(row.reused||0),failed:Number(row.failed||0),
   checked:Number(row.checked||0),found:Number(row.found||0),
   requested_at:Number(row.requested_at||0),updated_at:Number(row.updated_at||0),
   last_error:String(row.last_error||'')};
}
export async function readManualGroupCheck(env,kind){
 safeKind(kind);await ensureManualGroupChecks(env);
 const row=await env.DB.prepare('SELECT * FROM ml_group_manual_check_jobs WHERE kind=?').bind(kind).first();
 const value=output(row);
 // Um Worker interrompido não faz o botão ficar eternamente "executando".
 if(value.status==='running'&&Number(row.lease_until||0)<=stamp()){
  await env.DB.prepare("UPDATE ml_group_manual_check_jobs SET status='pending',lease_until=0 "+
   "WHERE kind=? AND status='running' AND lease_until<=?").bind(kind,stamp()).run();
  return output(await env.DB.prepare('SELECT * FROM ml_group_manual_check_jobs WHERE kind=?').bind(kind).first());
 }
 return value;
}
export async function requestManualGroupCheck(env,kind){
 kind=safeKind(kind);await ensureManualGroupChecks(env);
 const at=stamp();
 const current=await readManualGroupCheck(env,kind);
 if(current?.status==='pending'||current?.status==='running')
  return {ok:true,already_queued:true,...current};
 // O clique agenda todos os produtos pendentes, mesmo com o painel fechado. O Cron regular continuará
 // procurando os demais produtos automaticamente com o painel fechado.
 let remaining;
 if(kind==='categories')remaining=(await officialCategoryStats(env)).waiting;
 else{
  await ensureMonitor(env);
  const row=await env.DB.prepare(
   "SELECT COUNT(DISTINCT l.product_id) AS total FROM ml_monitor_links l "+
   "JOIN ml_monitor_groups g ON g.id=l.group_id "+
   "LEFT JOIN ml_monitor_product_meta m ON m.product_id=l.product_id "+
   "WHERE g.authorized=1 AND l.message_id<>'' "+
   "AND l.status IN ('available','batched') "+
   "AND (m.last_seen_price_cents IS NULL OR m.last_seen_price_cents<=0)"
  ).first();
  remaining=Number(row?.total||0);
 }
 await env.DB.prepare(
  "UPDATE ml_group_manual_check_jobs SET status=?,remaining=?,attempts=0,"+
  "processed=0,classified=0,created=0,reused=0,failed=0,checked=0,found=0,"+
  "requested_at=?,updated_at=?,lease_until=0,last_error='' "+
  "WHERE kind=? AND status NOT IN ('pending','running')"
 ).bind(remaining>0?'pending':'completed',remaining,at,at,kind).run();
 return {ok:true,already_queued:false,...await readManualGroupCheck(env,kind)};
}
export async function executeManualGroupCheck(env,kind,{fetcher=fetch,at=null}={}){
 kind=safeKind(kind);await ensureManualGroupChecks(env);
 const now=Number.isSafeInteger(at)&&at>0?at:stamp();
 const lease=now+120;
 const claimed=await env.DB.prepare(
  "UPDATE ml_group_manual_check_jobs SET status='running',lease_until=?,updated_at=? "+
  "WHERE kind=? AND status IN ('pending','running') AND remaining>0 AND lease_until<=?"
 ).bind(lease,now,kind,now).run();
 if(claimed.meta?.changes!==1)return {skipped:'not_pending_or_busy',...await readManualGroupCheck(env,kind)};
 const row=await env.DB.prepare('SELECT * FROM ml_group_manual_check_jobs WHERE kind=?').bind(kind).first();
 try{
  // Até doze itens por execução: o Cron suporta chamadas lentas à API,
  // e a resposta do botão jamais fica aguardando consultas externas.
  const result=kind==='categories'
   ?await classifyMonitorMissingCategories(env,{fetcher,limit:12,at:now})
   :await recoverMissingMonitorPrices(env,{allowEvolution:true,limit:8});
  if(result?.skipped){
   await env.DB.prepare("UPDATE ml_group_manual_check_jobs SET status='pending',lease_until=?,updated_at=? "+
    "WHERE kind=? AND status='running' AND lease_until=?").bind(now+15,now,kind,lease).run();
   return {skipped:result.skipped,...await readManualGroupCheck(env,kind)};
  }
  const processed=kind==='categories'?Math.max(0,Number(result?.processed||0))
   :Math.max(0,Number(result?.inspected||0));
  const remaining=Math.max(0,Number(row.remaining||0)-processed);
  const final=remaining===0||processed===0?'completed':'pending';
  const reason=String(result?.error||'').slice(0,180);
  await env.DB.prepare(
   "UPDATE ml_group_manual_check_jobs SET status=?,remaining=?,processed=processed+?,"+
   "classified=classified+?,created=created+?,reused=reused+?,failed=failed+?,"+
   "checked=checked+?,found=found+?,updated_at=?,lease_until=0,last_error=? "+
   "WHERE kind=? AND status='running' AND lease_until=?"
  ).bind(final,remaining,processed,
   Number(result?.classified||0),Number(result?.created||0),Number(result?.reused||0),Number(result?.failed||0),
   Number(result?.inspected??result?.checked??0),Number(result?.recovered??result?.found??0),now,reason,kind,lease).run();
  return await readManualGroupCheck(env,kind);
 }catch(error){
  const message=String(error?.message||error).slice(0,180);
  const attempts=Number(row.attempts||0)+1;
  await env.DB.prepare(
   "UPDATE ml_group_manual_check_jobs SET status=?,attempts=?,updated_at=?,lease_until=?,last_error=? "+
   "WHERE kind=? AND status='running' AND lease_until=?"
  ).bind(attempts>=3?'failed':'pending',attempts,now,attempts>=3?0:now+30,message,kind,lease).run();
  return await readManualGroupCheck(env,kind);
 }
}
