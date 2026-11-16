import {ensureMonitor,monitorState,bulkValidateMonitorShortlinks,prepareMonitorBatch} from './whatsapp-link-monitor.js';

// Controle persistente no D1. A interface apenas solicita o trabalho;
// o Cron da Cloudflare avança em pequenos lotes, sem navegador aberto.
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
// Produtos já identificados e classificados entram no lote de CONVERSÃO,
// nunca são publicados diretamente. Respeita o lote existente e seu limite 50.
async function currentConversion(env){
 const open=await env.DB.prepare(
  "SELECT b.id,COUNT(i.id) AS total FROM ml_link_batches b "+
  "LEFT JOIN ml_link_batch_items i ON i.batch_id=b.id "+
  "WHERE b.status='awaiting_links' GROUP BY b.id ORDER BY b.id DESC LIMIT 1"
 ).first();
 const remaining=await env.DB.prepare(
  "SELECT COALESCE(SUM(CASE WHEN category<>'Geral' AND trim(category)<>'' THEN 1 ELSE 0 END),0) AS eligible,"+
  "COALESCE(SUM(CASE WHEN category='Geral' OR trim(category)='' THEN 1 ELSE 0 END),0) AS needs_category "+
  "FROM ml_monitor_links WHERE status='available'"
 ).first();
 return {batch_id:Number(open?.id||0),batch_items:Number(open?.total||0),
  eligible_waiting:Number(remaining?.eligible||0),
  needs_category:Number(remaining?.needs_category||0)};
}
async function prepareConfirmedForConversion(env){
 const existing=await currentConversion(env);
 // Em modo automático, NÃO transferir produtos para lotes de conversão manual.
 // Essa transição antiga tirava produtos de status='available' e os escondia
 // do importador automático, fazendo o contador cair sem qualquer publicação.
 const hasSettings=await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ml_group_copy_auto_settings'").first();
 if(hasSettings){
  const auto=await env.DB.prepare(
   'SELECT enabled,experimental_acknowledged FROM ml_group_copy_auto_settings WHERE id=1'
  ).first();
  if(auto?.enabled===1&&auto?.experimental_acknowledged===1)
   return {...existing,created:false,delegated_to_automatic_import:true};
 }
 if(existing.batch_id||!existing.eligible_waiting)return {...existing,created:false};
 const prepared=await prepareMonitorBatch(env,{automatic:true});
 return {...await currentConversion(env),created:true,created_batch_id:Number(prepared.batch.id)};
}
export async function backgroundReviewState(env){
 if(!env?.DB)return publicJob(null);
 await ensureJob(env);
 // /api/monitor/state consulta em paralelo: as tabelas de conversão podem
 // ainda não existir em uma instalação nova.
 await ensureMonitor(env);
 return {...publicJob(await jobRow(env)),conversion:await currentConversion(env)};
}
export async function queueBackgroundReview(env){
 if(!env?.DB)throw new Error('Banco de dados indisponível.');
 const state=await monitorState(env); // garante tabelas do monitor e autorização.
 await ensureJob(env);
 const old=await jobRow(env);
 if(ACTIVE.has(old?.status))return {ok:true,already_running:true,job:{...publicJob(old),conversion:await currentConversion(env)}};
 const t=stamp(),total=Number((state.shortlinks||[]).find(x=>x.status==='review')?.total||0);
 const automatic=Number(state.retry_progress?.automatic||0);
 if(!automatic){
  const conversion=await prepareConfirmedForConversion(env);
  await env.DB.prepare(
   "UPDATE ml_monitor_background_review SET status='completed',total=?,cursor=0,"+
   "processed=0,resolved=0,not_confirmed=0,requires_manual=?,busy=0,"+
   "started_at=?,updated_at=?,last_run_at=0,next_run_at=0,lease_until=0,last_error='' WHERE id=1"
  ).bind(total,total,t,t).run();
  return {ok:true,already_running:false,job:{...publicJob(await jobRow(env)),conversion}};
 }
 const status=state.enabled?'running':'waiting_monitor';
 // Atômico: cliques simultâneos não apagam o progresso de uma tarefa ativa.
 await env.DB.prepare(
  "UPDATE ml_monitor_background_review SET status=?,total=?,cursor=0,"+
  "processed=0,resolved=0,not_confirmed=0,requires_manual=0,busy=0,"+
  "started_at=?,updated_at=?,last_run_at=0,next_run_at=?,lease_until=0,last_error='' "+
  "WHERE id=1 AND status IN ('idle','completed','error')"
 ).bind(status,total,t,t,t).run();
 return {ok:true,already_running:false,job:{...publicJob(await jobRow(env)),conversion:await currentConversion(env)}};
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
 // Destrava tarefas criadas na versão antiga com teto diário de 120.
 // Mantém contagens e cursor; nunca apaga resultados ou recomeça um lote.
 await env.DB.prepare(
  "UPDATE ml_monitor_background_review SET status='waiting_retry',next_run_at=0,updated_at=? "+
  "WHERE id=1 AND status='waiting_budget' AND lease_until<=?"
 ).bind(at,at).run();
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
  // Não deixe links sem confirmação bloquearem o lote dos produtos prontos.
  // Só antecipe um lote CHEIO. Se houver 1-49 produtos e a revisão ainda
  // estiver processando mais itens, espere a passagem acabar para não
  // abrir um lote pequeno que bloqueia o restante.
  const readyForBatch=await currentConversion(env);
  const earlyConversion=readyForBatch.eligible_waiting>=50
   ?await prepareConfirmedForConversion(env):null;
  const result=await bulkValidateMonitorShortlinks(env,{
   after_id:Number(row.cursor||0),limit:3,now:at
  });
  const advance=Number(result.next_cursor||row.cursor||0);
  if(result.has_more&&advance<=Number(row.cursor||0)){
   await updateJob(env,{status:'waiting_retry',cursor:0,next_run_at:at+180,
     last_error:'A paginação não avançou; uma nova rodada será tentada.',last_run_at:at,updated_at:at,lease_until:0});
   return {skipped:'cursor_no_progress'};
  }
  const checks=Number((result.results||[]).length);
  let status='running',cursor=advance,next=at+60;
  let conversion=null;
  if(!result.has_more){
   conversion=earlyConversion?.created?earlyConversion:
    await prepareConfirmedForConversion(env);
   const latest=await monitorState(env);
   if(!Number(latest.retry_progress?.automatic||0)){
    status='completed';next=0;
   }else{
    // Os links não confirmados permanecem para novas rodadas, inclusive
    // depois que a página for fechada. O Cron comum também revalida.
    const due=Number(latest.retry_progress?.next_retry_at||0);
    status='waiting_retry';next=Math.max(at+60,due>0?due:at+180);
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
   next_run_at:next,last_run_at:at,updated_at:at,lease_until:0,
   last_error:status==='waiting_retry'&&checks===0
    ?'Todos os links automáticos aguardam a próxima tentativa segura.':''
  });
  return {status,processed:checks,resolved:Number(result.resolved||0),conversion};
 }catch(error){
  const reason=String(error?.message||error).slice(0,160);
  await updateJob(env,{status:'waiting_retry',next_run_at:at+120,last_run_at:at,updated_at:at,lease_until:0,last_error:reason});
  return {status:'waiting_retry',error:reason};
 }
}
