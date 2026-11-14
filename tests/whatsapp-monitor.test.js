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
  const batch=await prepareMonitorBatch(env,{automatic:true});
  assert.equal(batch.items.length,1);
  assert.equal(batch.items[0].source_url,PRODUCT);
  assert.equal(batch.items[0].category,'Ferramentas e Peças Automotivas');
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
  await assert.rejects(prepareMonitorBatch(env,{ids:[captured.id]}),/já foi utilizado/);
  await assert.rejects(prepareMonitorBatch(env,{automatic:true}),/Selecione de 1 a 50/);
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
  assert.match(page,/Preparar lote automaticamente/);
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


test('painel apresenta contagem de produtos únicos, disponíveis, em conversão e já enfileirados por grupo',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Ferramentas',permission_confirmed:true});
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:OTHER,group_name:'Ofertas gerais',permission_confirmed:true});
  let state=await monitorState(env);
  assert.deepEqual(state.counts,{captured:0,available:0,in_conversion:0,queued:0});
  assert.ok(state.groups.every(x=>x.counts.captured===0));
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event());
  const product2='https://www.mercadolivre.com.br/furadeira-sem-fio/p/MLB99887766';
  await ingestMonitorEvent(env,event(OTHER,'Parafusadeira em promoção '+product2));
  // Repetir o mesmo produto em outro grupo não aumenta contadores.
  await ingestMonitorEvent(env,event(OTHER,'Furadeira já vista '+PRODUCT));
  state=await monitorState(env);
  assert.deepEqual(state.counts,{captured:2,available:2,in_conversion:0,queued:0});
  assert.equal(state.groups.find(x=>x.group_jid===GROUP).counts.captured,1);
  assert.equal(state.groups.find(x=>x.group_jid===OTHER).counts.captured,1);
  const selected=state.links.find(x=>x.source_url===PRODUCT);
  const batch=await prepareMonitorBatch(env,{ids:[selected.id]});
  state=await monitorState(env);
  assert.deepEqual(state.counts,{captured:2,available:1,in_conversion:1,queued:0});
  await importLinkBatch(env,batch.batch.id,{
   owner_confirmation:true,pairing_confirmation:true,
   links:[{affiliate_url:'https://meli.la/COUNT12345',category:batch.items[0].category}]
  });
  state=await monitorState(env);
  assert.deepEqual(state.counts,{captured:2,available:1,in_conversion:0,queued:1});
  assert.equal(state.groups.find(x=>x.group_jid===GROUP).counts.queued,1);
  assert.equal(state.groups.find(x=>x.group_jid===OTHER).counts.available,1);
  const html=renderPage();
  assert.match(html,/Produtos únicos captados/);
  assert.match(html,/Enviados à fila/);
  assert.match(CSS,/ml-monitor-counter-grid/);
  assert.match(CLIENT_JS,/mlMonitorApplyCounts/);
  assert.match(CLIENT_JS,/30000/);
 }finally{DB.close();}
});

test('o contador consulta todos os produtos do D1 mesmo com lista visual limitada a 200',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo grande',permission_confirmed:true});
  const group=DB.prepare('SELECT id FROM ml_monitor_groups WHERE group_jid=?').bind(GROUP).first();
  for(let i=0;i<205;i++){
   const pid='MLB'+String(10000000+i);
   DB.prepare("INSERT INTO ml_monitor_links(group_id,message_id,product_id,source_url,title,category,classification,status,created_at) VALUES(?,?,?,?,?,'Geral','needs_review','available',?)")
     .bind(group.id,'test'+i,pid,'https://www.mercadolivre.com.br/produto/p/'+pid,'Produto '+i,1700000000).run();
  }
  const state=await monitorState(env);
  assert.equal(state.links.length,200);
  assert.equal(state.counts.captured,205);
  assert.equal(state.counts.available,205);
  assert.equal(state.groups[0].counts.captured,205);
 }finally{DB.close();}
});
