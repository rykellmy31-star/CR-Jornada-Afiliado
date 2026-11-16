// Pipeline de ingestão: recebe pelo webhook, enriquece e enfileira em background.
// NUNCA publica mensagens, altera intervalos ou reivindica envio Telegram/WhatsApp.
import {resolveMonitorShortlinks,recoverMissingMonitorPrices} from './whatsapp-link-monitor.js';
import {classifyMonitorMissingCategories} from './monitor-official-categories.js';
import {runGroupCopyBatch} from './group-copy.js';

export async function processCapturedGroupOffers(env,{captured=0,pending=0}={}){
 if(!env?.DB||(!captured&&!pending))return {skipped:'nothing_new'};
 const [automation,monitor]=await Promise.all([
  env.DB.prepare('SELECT enabled FROM ml_group_copy_auto_settings WHERE id=1').first(),
  env.DB.prepare('SELECT enabled FROM ml_monitor_settings WHERE id=1').first()
 ]);
 if(!automation?.enabled||!monitor?.enabled)return {skipped:'disabled'};
 // Uma mensagem pode conter um link meli.la: resolver só novos pendentes
 // rapidamente. Links que exigem navegador seguem no Cron com retentativa.
 let links={skipped:'no_shortlinks'};
 if(pending>0)links=await resolveMonitorShortlinks(env,{
  limit:Math.min(3,Math.max(1,pending)),preferRecent:true,allowBrowser:false
 });
 // Preço já presente na legenda não precisa de consulta ao site.
 // Categorias desconhecidas usam a API pública oficial; o Cron faz o restante.
 const [prices,categories]=await Promise.allSettled([
  recoverMissingMonitorPrices(env,{allowEvolution:false}),
  classifyMonitorMissingCategories(env,{limit:2,preferRecent:true})
 ]);
 const imported=await runGroupCopyBatch(env,{limit:2,preferRecent:true});
 return {links,prices:prices.status==='fulfilled'?prices.value:{skipped:'retry_in_cron'},
  categories:categories.status==='fulfilled'?categories.value:{skipped:'retry_in_cron'},
  imported};
}
