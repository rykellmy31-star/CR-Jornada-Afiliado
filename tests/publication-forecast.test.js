import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {forecastTelegramQueue,readTelegramForecast} from '../src/publication-forecast.js';
import {renderPage,CSS,CLIENT_JS} from '../src/ui.js';

const base={
 category:'Geral',interval_minutes:30,max_daily:48,start_hour:8,end_hour:21,
 automation_enabled:1,telegram_enabled:1,channel_registered:1
};
const at=(day,h,m=0,s=0)=>Date.parse(day+'T00:00:00.000Z')+(h+3)*3600000+m*60000+s*1000;
const offer=(id,createdAt=id,category='Geral')=>({id,created_at:createdAt,category,status:'ready'});
const get=(result,id)=>new Date(result.by_id[String(id)]*1000).toISOString();

function memory(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={
  prepare(sql){let args=[];
   return {bind(...v){args=v;return this;},
    first(){return db.prepare(sql).get(...args)||null;},
    all(){return {results:db.prepare(sql).all(...args)};},
    run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}
   };
  },close(){db.close();}
 };
 return {DB,db};
}
test('fila diária de 08h às 21h, intervalo de 30 min: primeira 08h, última 20h30 e próxima no dia seguinte',()=>{
 const now=at('2026-11-15',8,0,0);
 const r=forecastTelegramQueue({settings:base,offers:Array.from({length:28},(_,i)=>offer(i+1)),now});
 assert.equal(r.status,'active');
 assert.equal(r.scheduled,28);
 assert.equal(get(r,1),'2026-11-15T11:00:00.000Z');
 assert.equal(get(r,26),'2026-11-15T23:30:00.000Z');
 assert.equal(get(r,27),'2026-11-16T11:00:00.000Z');
 assert.equal(get(r,28),'2026-11-16T11:30:00.000Z');
});
test('limite diário respeitado mesmo quando janela permite mais horários',()=>{
 const r=forecastTelegramQueue({settings:{...base,max_daily:2,interval_minutes:15},
  offers:[offer(1),offer(2),offer(3),offer(4)],now:at('2026-11-15',8)});
 assert.equal(get(r,1),'2026-11-15T11:00:00.000Z');
 assert.equal(get(r,2),'2026-11-15T11:15:00.000Z');
 assert.equal(get(r,3),'2026-11-16T11:00:00.000Z');
 assert.equal(get(r,4),'2026-11-16T11:15:00.000Z');
});
test('conta publicações anteriores e último envio real, com segundos não arredondados para trás',()=>{
 const r=forecastTelegramQueue({settings:base,
  offers:[offer(7),offer(3)],now:at('2026-11-15',11,0),
  publishedByDay:{'2026-11-15':2},lastPublishedAt:at('2026-11-15',10,45,35)/1000});
 assert.equal(get(r,3),'2026-11-15T14:16:00.000Z');
 assert.equal(get(r,7),'2026-11-15T14:46:00.000Z');
 const limited=forecastTelegramQueue({settings:{...base,max_daily:2},
  offers:[offer(7)],now:at('2026-11-15',11),
  publishedByDay:{'2026-11-15':2},lastPublishedAt:at('2026-11-15',10,45,35)/1000});
 assert.equal(get(limited,7),'2026-11-16T11:00:00.000Z');
});
test('previsão só para categoria do canal, respeita a ordem de cadastro, desempate id',()=>{
 const r=forecastTelegramQueue({settings:{...base,category:'Beleza'},
  now:at('2026-11-15',9),
  offers:[offer(9,3,'Ferramentas'),offer(7,2,'Beleza'),offer(8,2,'Beleza'),offer(10,1,'Moda')]});
 assert.equal(r.by_id['9'],undefined);
 assert.equal(r.by_id['10'],undefined);
 assert.equal(get(r,7),'2026-11-15T12:00:00.000Z');
 assert.equal(get(r,8),'2026-11-15T12:30:00.000Z');
});
test('automação principal, canal ou controle mestre pausado: não promete data futura',()=>{
 for(const settings of [
  {...base,automation_enabled:0},{...base,telegram_enabled:0},{...base,channel_registered:0}
 ]){
  const r=forecastTelegramQueue({settings,offers:[offer(1)],now:at('2026-11-15',8)});
  assert.equal(r.status,'paused');
  assert.deepEqual(r.by_id,{});
 }
 const master=forecastTelegramQueue({settings:base,offers:[offer(1)],now:at('2026-11-15',8),masterEnabled:false});
 assert.equal(master.status,'paused');
 assert.deepEqual(master.by_id,{});
});
test('fora da janela ou limite de intervalo um dia: reagenda sem gerar envio na madrugada',()=>{
 const after=forecastTelegramQueue({settings:base,offers:[offer(1)],now:at('2026-11-15',22,30)});
 assert.equal(get(after,1),'2026-11-16T11:00:00.000Z');
 const daily=forecastTelegramQueue({settings:{...base,interval_minutes:1440,max_daily:48},
   offers:[offer(1),offer(2)],now:at('2026-11-15',20,30)});
 assert.equal(get(daily,1),'2026-11-15T23:30:00.000Z');
 assert.equal(get(daily,2),'2026-11-16T23:30:00.000Z');
});
test('consulta ao banco conta ofertas antigas fora dos últimos 100 exibidos, sem modificar fila',async()=>{
 const {DB,db}=memory();
 try{
  DB.prepare("UPDATE settings SET automation_enabled=1,telegram_enabled=1,channel_registered=1,interval_minutes=30,max_daily=48,start_hour=8,end_hour=21").run();
  for(let i=0;i<105;i++)DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status) VALUES(?,?,?,?,?)")
   .bind('Produto teste '+i,'https://meli.la/PROD'+String(i).padStart(8,'0'),'Geral',i+1,'ready').run();
  const forecast=await readTelegramForecast({DB},{settings:await DB.prepare('SELECT * FROM settings').first(),now:at('2026-11-15',8)});
  assert.equal(Object.keys(forecast.by_id).length,105);
  assert.ok(forecast.by_id['105']>forecast.by_id['100']);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM offers WHERE status='ready'").first().total,105);
 }finally{db.close();}
});
test('UI mostra coluna e texto de previsão sem editar configuração nem publicar automaticamente',()=>{
 const page=renderPage();
 assert.match(page,/<th>Próxima publicação \(previsão\)<\/th>/);
 assert.match(page,/Horários previstos calculados pela ordem da fila/);
 assert.match(CLIENT_JS,/forecastOfferCell/);
 assert.match(CLIENT_JS,/data\.publication_forecast/);
 assert.match(CLIENT_JS,/Automação pausada/);
 assert.match(CLIENT_JS,/Previsão sujeita a alterações/);
 assert.match(CSS,/queue-forecast-time/);
 assert.doesNotThrow(()=>new Function(CLIENT_JS));
});
