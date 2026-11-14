import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {ensureMonitor,extractUrls,parseMonitorEvent,monitorState,addMonitorGroup,
 saveMonitorSettings,ingestMonitorEvent,prepareMonitorBatch,updateMonitorLinkCategory,
 resolveMonitorShortlinks} from '../src/whatsapp-link-monitor.js';
import {readLinkBatch,importLinkBatch} from '../src/link-batches.js';
import {renderPage,CSS,CLIENT_JS} from '../src/ui.js';
const TOKEN='monitor-test-webhook-token-strong-123456';
const GROUP='120363000111222333@g.us';
const OTHER='120363000999888777@g.us';
const INSTANCE='cr-jornada-afiliados';
const PRODUCT='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
const RAW=PRODUCT+'?matt_tool=123456&utm_source=outro-afiliado';
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){
    let args=[];
    return {bind(...v){args=v;return this;},
      first(){return db.prepare(sql).get(...args)||null;},
      all(){return {results:db.prepare(sql).all(...args)};},
      run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
    };
   },
   async batch(commands){
     db.exec('BEGIN');
     try{const r=commands.map(x=>x.run());db.exec('COMMIT');return r;}
     catch(error){db.exec('ROLLBACK');throw error;}
   },
   close(){db.close();}
 };
 const env={DB,MONITOR_WEBHOOK_TOKEN:TOKEN,ADMIN_PASSWORD:'example local test password',SESSION_SECRET:'local session secret for test only not production'};
 return {env,DB};
}
function event(group=GROUP,text='🔥 Furadeira de impacto em oferta: '+RAW,fromMe=false,instance=INSTANCE){
 return {event:'messages.upsert',instance,data:{key:{remoteJid:group,fromMe,id:'ABCD1234'},message:{extendedTextMessage:{text}}}};
}
test('extrai somente URLs em mensagens de grupos recebidas, sem registrar conversas privadas',()=>{
 assert.deepEqual(extractUrls('Teste '+PRODUCT+' e '+PRODUCT),[PRODUCT]);
 assert.equal(parseMonitorEvent(event()).length,1);
 assert.equal(parseMonitorEvent(event(OTHER,PRODUCT,true)).length,0);
 assert.equal(parseMonitorEvent(event('5511999999999@s.whatsapp.net')).length,0);
 assert.equal(parseMonitorEvent({...event(),event:'connection.update'}).length,0);
});
test('captura só quando ativa e no grupo autorizado; remove rastreamento e duplicaçao',async()=>{
 const {env,DB}=setup();
 try{
  await ensureMonitor(env);
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Achadinhos autorizados',permission_confirmed:true});
  assert.deepEqual(await ingestMonitorEvent(env,event()),{ok:true,ignored:'monitor_off'});
  assert.equal((await monitorState(env)).links.length,0);
  await saveMonitorSettings(env,{enabled:true});
  assert.equal((await ingestMonitorEvent(env,event(OTHER))).accepted??0,0);
  await ingestMonitorEvent(env,event());
  await ingestMonitorEvent(env,event());
  const state=await monitorState(env);
  assert.equal(state.links.length,1);
  assert.equal(state.links[0].category,'Ferramentas e Peças Automotivas');
  assert.equal(state.links[0].source_url,PRODUCT);
  assert.equal(state.groups.length,1);
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
 }finally{DB.close();}
});
test('seleciona links por categoria e gera lote de URL sem disparar mensagens',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Achadinhos autorizados',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event());
  const captured=(await monitorState(env)).links[0];
  assert.ok(captured);
  const batch=await prepareMonitorBatch(env,{ids:[captured.id]});
  assert.equal(batch.items.length,1);
  assert.equal(batch.items[0].source_url,PRODUCT);
  assert.equal(batch.items[0].category,'Ferramentas e Peças Automotivas');
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
  await assert.rejects(prepareMonitorBatch(env,{ids:[captured.id]}),/já foi utilizado/);
  await importLinkBatch(env,batch.batch.id,{
    owner_confirmation:true,pairing_confirmation:true,
    links:[{affiliate_url:'https://meli.la/ABCDEF12',category:captured.category}]
  });
  const imported=await readLinkBatch(env,batch.batch.id);
  assert.equal(imported.batch.status,'imported');
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM offers WHERE status='ready'").first().total,1);
  assert.equal(DB.prepare('SELECT category FROM offers').first().category,captured.category);
 }finally{DB.close();}
});
test('mensagens curtas meli.la passam por resolução controlada em vez de converter afiliação alheia',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Achadinhos autorizados',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Encontramos https://meli.la/ABCDE12345'));
  assert.equal((await monitorState(env)).links.length,0);
  globalThis.fetch=async url=>{
    assert.match(String(url),/^https:\/\/meli\.la\/ABCDE12345/);
    return new Response('',{status:302,headers:{location:RAW}});
  };
  const result=await resolveMonitorShortlinks(env);
  assert.equal(result.resolved,1);
  assert.equal((await monitorState(env)).links[0].source_url,PRODUCT);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_shortlinks WHERE status='resolved'").first().total,1);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('webhook exige segredo correto, painel continua autenticado e interface contém captura',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Achadinhos autorizados',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const origin='https://afiliados.example.test',body=JSON.stringify(event());
  const wrong=await worker.fetch(new Request(origin+'/hooks/wa-links/incorrect-token-123456789012345',{method:'POST',headers:{'content-type':'application/json'},body}),env);
  assert.equal(wrong.status,404);
  const okay=await worker.fetch(new Request(origin+'/hooks/wa-links/'+TOKEN,{method:'POST',headers:{'content-type':'application/json'},body}),env);
  assert.equal(okay.status,200);
  assert.equal((await monitorState(env)).links.length,1);
  const unauthorized=await worker.fetch(new Request(origin+'/api/monitor/state'),env);
  assert.equal(unauthorized.status,401);
  const page=renderPage();
  assert.match(page,/Robô de captura/);
  assert.match(page,/Preparar lote com os produtos selecionados/);
  assert.match(CLIENT_JS,/refreshWhatsAppMonitor/);
  assert.match(CLIENT_JS,/data-monitor-category-id/);
  assert.match(CSS,/ml-whatsapp-monitor/);
 }finally{DB.close();}
});
test('categoria desconhecida exige classificação antes do lote',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Achadinhos autorizados',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Confira '+PRODUCT.replace('furadeira-de-impacto','produto-incomum')));
  const item=(await monitorState(env)).links[0];
  assert.equal(item.category,'Geral');
  await assert.rejects(prepareMonitorBatch(env,{ids:[item.id]}),/Defina a categoria/);
  await updateMonitorLinkCategory(env,item.id,{category:'Ferramentas e Peças Automotivas'});
  const batch=await prepareMonitorBatch(env,{ids:[item.id]});
  assert.equal(batch.items.length,1);
 }finally{DB.close();}
});
