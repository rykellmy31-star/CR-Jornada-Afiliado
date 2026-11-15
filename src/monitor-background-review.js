import {monitorState,bulkValidateMonitorShortlinks,MONITOR_BROWSER_DAILY_LIMIT} from './whatsapp-link-monitor.js';

// Controle persistente no D1. A interface apenas solicita o trabalho;
// o Cron da Cloudflare avança um link por execução, sem navegador aberto.
const TABLE="CREATE TABLE IF NOT EXISTS ml_monitor_background_review ("+
 "id INTEGER PRIMARY KEY CHECK(id=1),"+
 "status TEXT NOT NULL DEFAULT 'idle',"+
 "cursor INTEGER NOT NULL DEFAULT 0,"+
 "total INTEGER NOT NULL DEFAULT 0,"+
 "processed INTEGER NOT NULL DEFAULT 0,"+
 "resolved INTEGER NOT NULL DEFAULT 0,"+
 "not_confirmed INTEGER NOT NULL DEFAULT 0,"+
 "requires_manual INTEGER NOT NULL DEFAULT 0,"+
 "busy INTEGER NOT NULL DEFAULT 0,"+
 "started_at INTEGER NOT NULL DEFAULT 0,"+
 "updated_at INTEGER NOT NULL DEFAULT 0,"+
 "last_run_at INTEGER NOT NULL DEFAULT 0,"+
 "next_run_at INTEGER NOT NULL DEFAULT 0,"+
 "lease_until INTEGER NOT NULL DEFAULT 0,"+
 "last_error TEXT NOT NULL DEFAULT '')";
const ACTIVE=new Set(['running','waiting_retry','waiting_budget','waiting_monitor']);
const stamp=()=>Math.floor(Date.now()/1000);

async function ensureJob(env){
 await env.DB.prepare(TABLE).run();
 await env.DB.prepare("INSERT OR IGNORE INTO ml_monitor_background_review(id,status) VALUES(1,'idle')").run();
}
async function jobRow(env){
 return await env.DB.prepare("SELECT * FROM ml_monitor_background_review WHERE id=1").first();
}
function publicJob(row){
 return {
  status:row?.status||'idle',
  total:Number(row?.total||0),
  processed:Number(row?.processed||0),
  resolved:Number(row?.resolved||0),
  not_confirmed:Number(row?.not_confirmed||0),
  requires_manual:Number(row?.requires_manual||0),
  busy:Number(row?.busy||0),
  started_at:Number(row?.started_at||0),
  last_run_at:Number(row?.last_run_at||0),
  next_run_at:Number(row?.next_run_at||0),
  updated_at:Number(row?.updated_at||0),
  last_error:String(row?.last_error||'').slice(0,160)
 };
}
export async function backgroundReviewState(env){
 if(!env?.DB)return publicJob(null);
 await ensureJob(env);
 return publicJob(await jobRow(env));
}
export async function queueBackgroundReview(env){
 if(!env?.DB)throw new Error('Banco de dados indisponível.');
 const state=await monitorState(env); // garante tabelas do monitor e autorização.
 await ensureJob(env);
 const old=await jobRow(env);
 if(ACTIVE.has(old?.status))return {ok:true,already_running:true,job:publicJob(old)};
 const t=stamp(),total=Number((state.shortlinks||[]).find(x=>x.status==='review')?.total||0);
 const automatic=Number(state.retry_progress?.automatic||0);
 if(!automatic){
  await env.DB.prepare(
   "UPDATE ml_monitor_background_review SET status='completed',total=?,cursor=0,"+
   "processed=0,resolved=0,not_confirmed=0,requires_manual=?,busy=0,"+
   "started_at=?,updated_at=?,last_run_at=0,next_run_at=0,lease_until=0,last_error='' WHERE id=1"
  ).bind(total,total,t,t).run();
  return {ok:true,already_running:false,job:publicJob(await jobRow(env))};
 }
 const status=state.enabled?'running':'waiting_monitor';
 // Atômico: cliques simultâneos não apagam o progresso de uma tarefa ativa.
 await env.DB.prepare(
  "UPDATE ml_monitor_background_review SET status=?,total=?,cursor=0,"+
  "processed=0,resolved=0,not_confirmed=0,requires_manual=0,busy=0,"+
  "started_at=?,updated_at=?,last_run_at=0,next_run_at=?,lease_until=0,last_error='' "+
  "WHERE id=1 AND status IN ('idle','completed','error')"
 ).bind(status,total,t,t,t).run();
 return {ok:true,already_running:false,job:publicJob(await jobRow(env))};
}
function nextUtcDay(t){
 const date=new Date(t*1000);
 return Math.floor(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+1)/1000)+30;
}
async function updateJob(env,values){
 const keys=Object.keys(values);
 await env.DB.prepare(
  'UPDATE ml_monitor_background_review SET '+keys.map(k=>k+'=?').join(',')+
  ' WHERE id=1'
 ).bind(...keys.map(k=>values[k])).run();
}

export async function runBackgroundReview(env,{now=null}={}){
 if(!env?.DB)return {skipped:'db'};
 await ensureJob(env);
 const at=Number.isSafeInteger(now)&&now>0?now:stamp();
 const claimed=await env.DB.prepare(
  "UPDATE ml_monitor_background_review SET lease_until=?,status='running',updated_at=? "+
  "WHERE id=1 AND status IN ('running','waiting_retry','waiting_budget','waiting_monitor') "+
  "AND next_run_at<=? AND lease_until<=?"
 ).bind(at+240,at,at,at).run();
 if(claimed.meta?.changes!==1)return {skipped:'not_due'};
 const row=await jobRow(env);
 try{
  const state=await monitorState(env);
  if(!state.enabled){
   await updateJob(env,{status:'waiting_monitor',next_run_at:at+60,last_run_at:at,updated_at:at,lease_until:0});
   return {skipped:'monitor_off'};
  }
  const usage=await env.DB.prepare(
   'SELECT day_key,daily_count FROM ml_monitor_browser_budget WHERE id=1'
  ).first();
  const utcDay=new Date(at*1000).toISOString().slice(0,10);
  if(state.browser_binding_available!==false&&usage?.day_key===utcDay&&
     Number(usage.daily_count||0)>=MONITOR_BROWSER_DAILY_LIMIT){
   const next=nextUtcDay(at);
   await updateJob(env,{status:'waiting_budget',next_run_at:next,last_run_at:at,updated_at:at,lease_until:0});
   return {skipped:'daily_browser_limit',next_run_at:next};
  }
  const result=await bulkValidateMonitorShortlinks(env,{after_id:Number(row.cursor||0),limit:1});
  const advance=Number(result.next_cursor||row.cursor||0);
  if(result.has_more&&advance<=Number(row.cursor||0)){
   await updateJob(env,{status:'waiting_retry',cursor:0,next_run_at:at+180,
     last_error:'A paginação não avançou; uma nova rodada será tentada.',last_run_at:at,updated_at:at,lease_until:0});
   return {skipped:'cursor_no_progress'};
  }
  const checks=Number((result.results||[]).length);
  let status='running',cursor=advance,next=at+60;
  if(!result.has_more){
   const latest=await monitorState(env);
   if(!Number(latest.retry_progress?.automatic||0)){
    status='completed';next=0;
   }else{
    // Os links não confirmados permanecem para novas rodadas, inclusive
    // depois que a página for fechada. O Cron comum também revalida.
    status='waiting_retry';next=at+300;
   }
   cursor=0;
  }
  await updateJob(env,{
   status,cursor,
   processed:Number(row.processed||0)+checks,
   resolved:Number(row.resolved||0)+Number(result.resolved||0),
   not_confirmed:Number(row.not_confirmed||0)+Number(result.not_confirmed||0),
   requires_manual:Number(row.requires_manual||0)+Number(result.requires_manual||0),
   busy:Number(row.busy||0)+Number(result.busy||0),
   next_run_at:next,last_run_at:at,updated_at:at,lease_until:0,last_error:''
  });
  return {status,processed:checks,resolved:Number(result.resolved||0)};
 }catch(error){
  const reason=String(error?.message||error).slice(0,160);
  await updateJob(env,{status:'waiting_retry',next_run_at:at+120,last_run_at:at,updated_at:at,lease_until:0,last_error:reason});
  return {status:'waiting_retry',error:reason};
 }
}
