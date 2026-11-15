// Previsões apenas de leitura. A fila continua sendo controlada pelos
// agendadores existentes, que publicam por ordem de created_at,id.
const ONE_MINUTE=60000,ONE_DAY=86400000,BAHIA_UTC_OFFSET_MS=3*3600000;
const maxItems=5000;
const valid=(n,min,max)=>Number.isInteger(Number(n))&&Number(n)>=min&&Number(n)<=max;
const toMinute=ms=>Math.ceil(ms/ONE_MINUTE)*ONE_MINUTE;
function bahiaDayKey(ms){
 return new Date(ms-BAHIA_UTC_OFFSET_MS).toISOString().slice(0,10);
}
function bahiaDayStartUtc(ms){
 const day=bahiaDayKey(ms);
 return Date.parse(day+'T00:00:00.000Z')+BAHIA_UTC_OFFSET_MS;
}
function categoryAllowed(offer,settings){
 const selected=String(settings.category||'Geral').toLocaleLowerCase('pt-BR');
 return selected==='geral'||String(offer.category||'').toLocaleLowerCase('pt-BR')===selected;
}
// Recebe a fila completa em ordem ascendente, não apenas os últimos 100
// registros apresentados no histórico. NÃO altera dados nem envia mensagens.
export function forecastTelegramQueue({settings,offers,now=Date.now(),
 publishedByDay={},lastPublishedAt=null,masterEnabled=null,maxForecast=5000}={}){
 const forecast={};
 if(!settings||!Array.isArray(offers))return {by_id:forecast,status:'unavailable',generated_at:Math.floor(now/1000)};
 const validSettings=
  valid(settings.interval_minutes,1,1440)&&valid(settings.max_daily,1,48)&&
  valid(settings.start_hour,0,23)&&valid(settings.end_hour,1,24)&&
  Number(settings.start_hour)<Number(settings.end_hour);
 let status='active';
 if(masterEnabled===false||!settings.automation_enabled||!settings.telegram_enabled||!settings.channel_registered)
  status='paused';
 else if(!validSettings||!Number.isFinite(now))status='unavailable';
 const result={by_id:forecast,status,generated_at:Math.floor(now/1000)};
 if(status!=='active')return result;
 const interval=Number(settings.interval_minutes)*ONE_MINUTE;
 const maxDaily=Number(settings.max_daily),startHour=Number(settings.start_hour),endHour=Number(settings.end_hour);
 const used=new Map(Object.entries(publishedByDay||{}).map(([day,count])=>[day,Math.max(0,Number(count)||0)]));
 const last=Number.isFinite(Number(lastPublishedAt))&&Number(lastPublishedAt)>0?Number(lastPublishedAt)*1000:null;
 let slot=toMinute(Math.max(now,last===null?now:last+interval));
 let lastSlot=null,completed=0;
 // O fuso de Bahia não tem horário de verão; a janela de envio é UTC−3.
 const horizon=now+366*ONE_DAY;
 const eligible=offers.filter(offer=>offer.status==='ready'&&categoryAllowed(offer,settings))
  .sort((a,b)=>(Number(a.created_at)||0)-(Number(b.created_at)||0)||Number(a.id)-Number(b.id));
 for(const offer of eligible.slice(0,Math.max(0,Math.min(maxItems,maxForecast)))){
  let guard=0;
  while(slot<horizon&&guard++<370){
   const start=bahiaDayStartUtc(slot),day=bahiaDayKey(slot);
   const first=start+startHour*3600000,end=start+endHour*3600000;
   if(slot<first){slot=first;continue;}
   if(slot>=end||Number(used.get(day)||0)>=maxDaily){
    slot=start+ONE_DAY+startHour*3600000;continue;
   }
   // O Worker é acionado por minuto; nunca estimar um disparo no passado.
   slot=toMinute(slot);
   if(slot>=end)continue;
   forecast[String(offer.id)]=Math.floor(slot/1000);
   used.set(day,Number(used.get(day)||0)+1);
   lastSlot=slot;completed++;
   slot+=interval;
   break;
  }
  if(slot>=horizon)break;
 }
 return {...result,scheduled:completed,last_scheduled_at:lastSlot?Math.floor(lastSlot/1000):null};
}

export async function readTelegramForecast(env,{settings,table='offers',channelId=null,now=Date.now()}={}){
 // table é constante interna; nenhum identificador da requisição é interpolado.
 if(table!=='offers'&&table!=='channel_offers')throw Error('Fila de Telegram inválida');
 if(!settings)return {by_id:{},status:'unavailable',generated_at:Math.floor(now/1000)};
 const condition=table==='offers'?'':' AND channel_id=?';
 const param=table==='offers'?[]:[Number(channelId)];
 const [ready,published,last,master]=await Promise.all([
  env.DB.prepare('SELECT id,category,status,created_at FROM '+table+
   " WHERE status='ready'"+condition+' ORDER BY created_at,id LIMIT 5000').bind(...param).all(),
  env.DB.prepare('SELECT published_day,COUNT(*) AS total FROM '+table+
   " WHERE status='published'"+condition+' GROUP BY published_day').bind(...param).all(),
  env.DB.prepare('SELECT MAX(published_at) AS t FROM '+table+
   " WHERE status='published'"+condition).bind(...param).first(),
  env.DB.prepare('SELECT enabled FROM automation_master WHERE id=1').first().catch(()=>null)
 ]);
 const byDay=Object.fromEntries((published.results||[]).filter(row=>typeof row.published_day==='string').map(row=>[row.published_day,Number(row.total)||0]));
 return forecastTelegramQueue({settings,offers:ready.results||[],now,publishedByDay:byDay,
   lastPublishedAt:last?.t,masterEnabled:master?.enabled===0?false:master?.enabled===1?true:null});
}
