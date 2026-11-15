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


test('melila.me publicado em grupo permitido passa por redirect seguro e identifica oferta Mercado Livre',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 const thirdParty='https://melila.me/ijeagkktlctt';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const message='OVERSIZED PRA ELAS\nCamiseta T-shirt Feminina Malha Peruana\nDe R$ 109\n💸por R$ 43\n🛒Compra aqui\n'+thirdParty;
  const ingest=await ingestMonitorEvent(env,event(GROUP,message));
  assert.equal(ingest.pending,1);
  assert.equal(ingest.captured,0);
  const item=DB.prepare('SELECT short_url,status FROM ml_monitor_shortlinks').first();
  assert.equal(item.short_url,thirdParty);
  assert.equal(item.status,'pending');
  globalThis.fetch=async (url,options)=>{
    assert.equal(String(url),thirdParty);
    assert.equal(options.redirect,'manual');
    return new Response(null,{status:302,headers:{location:PRODUCT+'?matt_tool=third_party'}});
  };
  const checked=await resolveMonitorShortlinks(env);
  assert.equal(checked.resolved,1);
  const state=await monitorState(env);
  assert.equal(state.counts.captured,1);
  assert.equal(state.links[0].source_url,PRODUCT);
  assert.equal(state.links[0].last_seen_price_cents,4300);
  assert.equal(DB.prepare('SELECT status FROM ml_monitor_shortlinks').first().status,'resolved');
 }finally{globalThis.fetch=originalFetch;DB.close();}
});

test('melila.me pode passar por meli.la; nunca copia comissão do link original',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Compra aqui https://melila.me/abcde12345'));
  const visited=[];
  globalThis.fetch=async (url,options)=>{
    visited.push(String(url));assert.equal(options.redirect,'manual');
    if(String(url)==='https://melila.me/abcde12345')return new Response(null,{status:302,headers:{location:'https://meli.la/ABCDEF123'}});
    if(String(url)==='https://meli.la/ABCDEF123')return new Response(null,{status:302,headers:{location:RAW}});
    throw new Error('Destino não esperado');
  };
  assert.equal((await resolveMonitorShortlinks(env)).resolved,1);
  assert.deepEqual(visited,['https://melila.me/abcde12345','https://meli.la/ABCDEF123']);
  assert.equal((await monitorState(env)).links[0].source_url,PRODUCT);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});

test('melila.me com deep link HTML só aceita um produto explícito do Mercado Livre',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Olha a oferta https://melila.me/xyz123456'));
  globalThis.fetch=async ()=>{
    return new Response('<html><head><meta property="og:url" content="'+PRODUCT+'?src=outro"></head><body>Ver oferta no Mercado Livre</body></html>',{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
  };
  assert.equal((await resolveMonitorShortlinks(env)).resolved,1);
  assert.equal((await monitorState(env)).links[0].source_url,PRODUCT);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});

test('melila.me para Shopee ou página sem produto fica em revisão sem criar oferta',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Link desconhecido https://melila.me/abcd54321'));
  globalThis.fetch=async ()=>new Response(null,{status:302,headers:{location:'https://shopee.com.br/produto-teste'}});
  assert.equal((await resolveMonitorShortlinks(env)).resolved,0);
  assert.equal(DB.prepare('SELECT status FROM ml_monitor_shortlinks').first().status,'review');
  assert.equal((await monitorState(env)).counts.captured,0);
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
  await ingestMonitorEvent(env,event(GROUP,'Novo link https://melila.me/abcd99999'));
  globalThis.fetch=async ()=>new Response('<html>'+PRODUCT+' https://www.mercadolivre.com.br/outro/p/MLB8877665544</html>',{status:200,headers:{'content-type':'text/html'}});
  assert.equal((await resolveMonitorShortlinks(env)).resolved,0);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM ml_monitor_shortlinks WHERE status='review'").first().total,2);
  assert.equal((await monitorState(env)).links.length,0);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});


test('diagnóstico mostra se webhook chegou, se monitor estava desligado e se grupo era autorizado',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo permitido',permission_confirmed:true});
  let state=await monitorState(env);
  assert.equal(state.diagnostics.events_received,0);
  assert.equal(state.diagnostics.last_event_at,null);
  assert.deepEqual(state.recent_shortlinks,[]);
  assert.deepEqual(await ingestMonitorEvent(env,event()),{ok:true,ignored:'monitor_off'});
  state=await monitorState(env);
  assert.equal(state.diagnostics.events_received,1);
  assert.equal(state.diagnostics.events_while_off,1);
  assert.equal(state.diagnostics.authorized_messages,0);
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(OTHER,'Oferta '+PRODUCT));
  state=await monitorState(env);
  assert.equal(state.diagnostics.events_received,2);
  assert.equal(state.diagnostics.messages_with_links,1);
  assert.equal(state.diagnostics.authorized_messages,0);
  assert.equal(state.diagnostics.links_recognized,0);
  await ingestMonitorEvent(env,event(GROUP,'Ofertão https://melila.me/ijeezy55555'));
  state=await monitorState(env);
  assert.equal(state.diagnostics.events_received,3);
  assert.equal(state.diagnostics.messages_with_links,2);
  assert.equal(state.diagnostics.authorized_messages,1);
  assert.equal(state.diagnostics.links_recognized,1);
  assert.ok(state.diagnostics.last_event_at>0);
  assert.ok(state.diagnostics.last_link_at>0);
  assert.equal(state.shortlinks.find(x=>x.status==='pending').total,1);
  assert.equal(state.recent_shortlinks[0].status,'pending');
  assert.equal(state.recent_shortlinks[0].short_url,'https://melila.me/ijeezy55555');
  const page=renderPage();
  assert.match(page,/Diagnóstico da captura/);
  assert.match(CLIENT_JS,/mlMonitorApplyDiagnostics/);
  assert.match(CLIENT_JS,/Nenhum evento chegou ao Worker/);
 }finally{DB.close();}
});

test('diagnóstico não registra webhook com token inválido e expõe razões de links em revisão apenas à sessão',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo permitido',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const wrong=await worker.fetch(new Request('https://afiliados.example.test/hooks/wa-links/token-errado-mas-bem-comprido-123456789',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event())}),env);
  assert.equal(wrong.status,404);
  assert.equal((await monitorState(env)).diagnostics.events_received,0);
  const received=await ingestMonitorEvent(env,event(GROUP,'Oferta https://melila.me/ijeagkktlctt'));
  assert.equal(received.pending,1);
  const before=await monitorState(env);
  assert.equal(before.diagnostics.links_recognized,1);
  DB.prepare("UPDATE ml_monitor_shortlinks SET status='review',reason='Destino não verificável'").run();
  const state=await monitorState(env);
  assert.equal(state.recent_shortlinks[0].reason,'Destino não verificável');
  assert.equal(state.recent_shortlinks[0].status,'review');
  assert.equal(state.shortlinks.find(x=>x.status==='review').total,1);
  assert.equal(state.counts.captured,0);
  const unauth=await worker.fetch(new Request('https://afiliados.example.test/api/monitor/state'),env);
  assert.equal(unauth.status,401);
 }finally{DB.close();}
});


test('oferta com imagem/legenda, dois links e quebra de linha é capturada sem confundir convite do grupo',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo BRUXO',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const caption='ACHADINHOS DA CAAH\nKit De Prato Raso Em Porcelana Arbo 6 Peças\nDE 108 | POR 88,08\n'+
   'CUPOM: DESCONTAOMELI\n🔗 https://melila.me/\nWMkKW9qiqmsu\n'+
   'Participe do Grupo: https://chat.whatsapp.com/ABCD1234567890';
  const payload={event:'messages.upsert',instance:INSTANCE,data:{key:{remoteJid:GROUP,fromMe:false,id:'IMAGE44'},
    message:{imageMessage:{caption}}}};
  const parsed=parseMonitorEvent(payload);
  assert.equal(parsed.length,1);
  assert.equal(parsed[0].format,'imageMessage');
  assert.equal(parsed[0].urls.length,2);
  assert.equal(parsed[0].urls[0],'https://melila.me/WMkKW9qiqmsu');
  assert.equal(parsed[0].urls[1],'https://chat.whatsapp.com/ABCD1234567890');
  assert.match(parsed[0].hint,/Kit De Prato Raso/);
  const result=await ingestMonitorEvent(env,payload);
  assert.equal(result.pending,1);
  const state=await monitorState(env);
  assert.equal(state.diagnostics.links_recognized,1);
  assert.equal(state.diagnostics.authorized_messages,1);
  assert.equal(state.shortlinks.find(x=>x.status==='pending').total,1);
  assert.deepEqual(state.recent_domains.slice(0,2).map(x=>[x.domain,x.reason]),[
   ['chat.whatsapp.com','dominio_nao_permitido'],['melila.me','encurtador_aceito']
  ]);
  assert.ok(state.recent_domains.every(x=>!JSON.stringify(x).includes('ABCD1234567890')));
  assert.equal(DB.prepare('SELECT short_url FROM ml_monitor_shortlinks').first().short_url,'https://melila.me/WMkKW9qiqmsu');
 }finally{DB.close();}
});

test('legenda de imagem de visualização única V2 e zero width reconhecem melila.me',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Perfumes',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const url='https://melila.me/RO2Z3oktIctt';
  const payload={event:'messages.upsert',instance:INSTANCE,data:{key:{remoteJid:GROUP,fromMe:false,id:'IMAGE45'},
    message:{viewOnceMessageV2:{message:{imageMessage:{caption:'Perfume Galactic Men - R$ 109. Compre aqui: https://melila.me/\u200bRO2Z3oktIctt'}}}}}};
  const result=await ingestMonitorEvent(env,payload);
  assert.equal(result.pending,1);
  assert.equal(DB.prepare('SELECT short_url FROM ml_monitor_shortlinks').first().short_url,url);
  const state=await monitorState(env);
  assert.equal(state.recent_domains[0].message_format,'imageMessage');
  assert.equal(state.recent_domains[0].reason,'encurtador_aceito');
  assert.equal(state.diagnostics.links_recognized,1);
 }finally{DB.close();}
});

test('mensagem do grupo sem URLs produz diagnóstico sem guardar mensagens pessoais',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo cadastrado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const secretText='Oferta nova: telefone secreto 5511999999999';
  const payload={event:'messages.upsert',instance:INSTANCE,data:{
    key:{remoteJid:GROUP,fromMe:false,id:'MESSAGE46'},message:{imageMessage:{caption:secretText}}}};
  assert.deepEqual(parseMonitorEvent(payload),[]);
  await ingestMonitorEvent(env,payload);
  const state=await monitorState(env);
  assert.equal(state.diagnostics.messages_with_links,0);
  assert.equal(state.diagnostics.authorized_messages,1);
  assert.equal(state.diagnostics.links_recognized,0);
  assert.equal(state.recent_domains[0].reason,'nenhum_link_na_legenda');
  assert.equal(state.recent_domains[0].message_format,'imageMessage');
  assert.equal(state.recent_domains[0].domain,'—');
  assert.ok(!JSON.stringify(state).includes('5511999999999'));
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
 }finally{DB.close();}
});


test('identifica quais grupos cadastrados realmente entregaram mensagens, mesmo sem links',async()=>{
 const {env,DB}=setup();
 try{
  const third='120363111222333444@g.us';
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'BRUXO DOS DESCONTOS',permission_confirmed:true});
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:OTHER,group_name:'ACHADINHOS DA INTERNET',permission_confirmed:true});
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:third,group_name:'Clube de ferramentas',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Oferta em outro site https://magazineluiza.me/abcde1234'));
  await ingestMonitorEvent(env,event(OTHER,'Mensagem comum sem link'));
  let state=await monitorState(env);
  const bruxo=state.groups.find(g=>g.group_jid===GROUP);
  const achadinhos=state.groups.find(g=>g.group_jid===OTHER);
  const ferramentas=state.groups.find(g=>g.group_jid===third);
  assert.equal(bruxo.delivery.received_messages,1);
  assert.equal(bruxo.delivery.with_urls,1);
  assert.ok(bruxo.delivery.last_received_at>0);
  assert.equal(achadinhos.delivery.received_messages,1);
  assert.equal(achadinhos.delivery.with_urls,0);
  assert.equal(achadinhos.delivery.last_format,'extendedTextMessage');
  assert.equal(ferramentas.delivery.received_messages,0);
  assert.equal(ferramentas.delivery.last_received_at,null);
  assert.equal(state.diagnostics.authorized_messages,2);
  assert.equal(state.diagnostics.links_recognized,0);
  assert.equal(state.counts.captured,0);
  const page=renderPage();
  assert.match(CLIENT_JS,/Mensagens recebidas:/);
  assert.match(CLIENT_JS,/Último evento:/);
 }finally{DB.close();}
});

test('descartes mostram razões sem registrar contatos, textos ou IDs de grupos não autorizados',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'BRUXO',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const unknownGroup='120363999888777666@g.us';
  await ingestMonitorEvent(env,event(unknownGroup,'Ofertão https://melila.me/ABC123456'));
  await ingestMonitorEvent(env,event(GROUP,'O próprio robô https://melila.me/ABC123456',true));
  await ingestMonitorEvent(env,event(GROUP,'Mesmo grupo mas instância diferente https://melila.me/ABC123456',false,'outra-instancia'));
  const state=await monitorState(env);
  assert.equal(state.diagnostics.events_received,3);
  assert.equal(state.diagnostics.authorized_messages,0);
  assert.equal(state.groups[0].delivery.received_messages,0);
  const reasons=Object.fromEntries(state.rejected_events.map(r=>[r.reason,r.occurrences]));
  assert.equal(reasons.grupo_nao_corresponde_aos_cadastrados,1);
  assert.equal(reasons.fromMe_nao_foi_false,1);
  assert.equal(reasons.instancia_diferente,1);
  assert.ok(!JSON.stringify(state).includes(unknownGroup));
  assert.ok(!JSON.stringify(state).includes('ABC123456'));
  assert.match(CLIENT_JS,/Mensagens descartadas antes da leitura/);
 }finally{DB.close();}
});

test('webhook recebe foto com legenda e base64 grande e reconhece melila.me',async()=>{
 const {env,DB}=setup();
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'BRUXO DOS DESCONTOS',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const url='https://melila.me/xC4Lwektlctt';
  const payload={event:'messages.upsert',instance:INSTANCE,data:{
   key:{remoteJid:GROUP,fromMe:false,id:'IMAGE-LARGE-001'},
   message:{imageMessage:{caption:'Só hoje: Capa Chuva Sapato Tênis\\nPor R$ 34,97\\n'+url,
    mimetype:'image/jpeg',base64:'A'.repeat(60_000)}},
   messageType:'imageMessage'}};
  const body=JSON.stringify(payload);
  assert.ok(body.length>20_000);
  const response=await worker.fetch(new Request('https://afiliados.example.test/hooks/wa-links/'+TOKEN,{
   method:'POST',headers:{'content-type':'application/json'},body
  }),env);
  assert.equal(response.status,200,await response.text());
  const state=await monitorState(env);
  assert.equal(state.groups[0].delivery.received_messages,1);
  assert.equal(state.groups[0].delivery.last_format,'imageMessage');
  assert.equal(state.diagnostics.links_recognized,1);
  assert.equal(state.shortlinks.find(x=>x.status==='pending')?.total,1);
  assert.equal(state.counts.captured,0); // Só captura produto após resolver encurtador.
 }finally{DB.close();}
});

test('webhook bloqueia corpo acima do limite de mídia sem registrar evento',async()=>{
 const {env,DB}=setup();
 try{
  const response=await worker.fetch(new Request('https://afiliados.example.test/hooks/wa-links/'+TOKEN,{
   method:'POST',headers:{'content-type':'application/json','content-length':String(8*1024*1024+1)},
   body:'{}'
  }),env);
  assert.equal(response.status,413);
  assert.equal((await monitorState(env)).diagnostics.events_received,0);
 }finally{DB.close();}
});

test('imagem de oferta reconhecida em formatos alternativos da Evolution e legenda com quebra',()=>{
 const short='https://melila.me/MpuhFvqiqmsu';
 const nestedMessage=[
  {ephemeralMessage:{message:{viewOnceMessageV2:{message:{imageMessage:{caption:'COLCHÃO SOLTEIRO '+short}}}}}},
  {message:{documentWithCaptionMessage:{message:{documentMessage:{caption:'Oferta: '+short}}}}},
  {interactiveMessage:{body:{text:'Oferta: '+short}}},
  {imageMessage:{caption:''}}
 ];
 for(const [i,message] of nestedMessage.entries()){
  const payload={event:'MESSAGES_UPSERT',instance:INSTANCE,data:{
   key:{remoteJid:GROUP,fromMe:false,id:'TESTNEST'+i},
   message,...(i===3?{caption:'Oferta: '+short}:{})}};
  const items=parseMonitorEvent(payload);
  assert.equal(items.length,1,'formato '+i);
  assert.deepEqual(items[0].urls,[short],'formato '+i);
 }
 const newline=['https://melila.me/','MpuhFvqiqmsu'].join(String.fromCharCode(10));
 assert.deepEqual(extractUrls(newline),[short]);
});

test('recupera legenda ausente por consulta pontual e somente de grupo autorizado',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 env.EVOLUTION_API_URL='https://evolution.crjornada.com';
 env.EVOLUTION_API_KEY='example-read-key';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'ACHADINHOS DA INTERNET',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const short='https://melila.me/MpuhFvqiqmsu';
  let called=0;
  globalThis.fetch=async (url,options)=>{
   called++;
   assert.equal(String(url),'https://evolution.crjornada.com/chat/findMessages/'+INSTANCE);
   assert.equal(options.method,'POST');
   assert.equal(options.headers.apikey,'example-read-key');
   assert.equal(JSON.parse(options.body).where.key.id,'RECOVER1');
   return new Response(JSON.stringify({messages:{records:[{
    key:{remoteJid:GROUP,fromMe:false,id:'RECOVER1'},
    message:{imageMessage:{caption:'COLCHÃO SOLTEIRO CONFORT MAX 188X88 CM\\n'+short}}}
   ]}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const blank={event:'messages.upsert',instance:INSTANCE,data:{
   key:{remoteJid:GROUP,fromMe:false,id:'RECOVER1'},message:{imageMessage:{mimetype:'image/jpeg'}}}};
  await ingestMonitorEvent(env,blank);
  assert.equal(called,1);
  const state=await monitorState(env);
  assert.equal(state.groups[0].delivery.received_messages,1);
  assert.equal(state.groups[0].delivery.with_urls,1);
  assert.equal(state.diagnostics.links_recognized,1);
  assert.equal(state.recent_domains[0].domain,'melila.me');
  assert.equal(state.recent_domains[0].message_format,'evolution:imageMessage');
  assert.equal(state.shortlinks.find(s=>s.status==='pending').total,1);
  assert.equal(state.counts.captured,0); // Aguarda confirmar produto de destino.
  await ingestMonitorEvent(env,{...blank,data:{...blank.data,key:{...blank.data.key,id:'FORBIDDEN',remoteJid:OTHER}}});
  assert.equal(called,1,'não consultar grupo não autorizado');
 }finally{globalThis.fetch=originalFetch;DB.close();}
});

test('não importa legendas de mensagens diferentes em resultado de busca da Evolution',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 env.EVOLUTION_API_URL='https://evolution.crjornada.com';
 env.EVOLUTION_API_KEY='example-read-key';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo permitido',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  globalThis.fetch=async()=>new Response(JSON.stringify({messages:{records:[{
   key:{remoteJid:OTHER,fromMe:false,id:'RECOVER2'},
   message:{imageMessage:{caption:'https://melila.me/OTHER12345'}}}
  ]}}),{status:200});
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:INSTANCE,data:{
   key:{remoteJid:GROUP,fromMe:false,id:'RECOVER2'},message:{imageMessage:{mimetype:'image/jpeg'}}}});
  const state=await monitorState(env);
  assert.equal(state.counts.captured,0);
  assert.equal(state.diagnostics.links_recognized,0);
  assert.equal(state.groups[0].delivery.received_messages,1);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});

test('interpreta textos e legendas alternativos e mantém somente links Mercado Livre',async()=>{
 const {env,DB}=setup();
 const valid='https://melila.me/AAJLUPqiqmsu';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,
   group_name:'BRUXO DOS DESCONTOS',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const items=[
   {message:{conversation:'Oferta '+valid}},
   {message:{extendedTextMessage:{text:'Oportunidade '+valid}}},
   {message:{imageMessage:{caption:'Imagem '+valid}}},
   {message:{videoMessage:{caption:'Vídeo '+valid}}},
   {message:{documentMessage:{caption:'Documento '+valid}}},
   {message:{ephemeralMessage:{message:{imageMessage:{caption:'Efêmero '+valid}}}}},
   {message:{interactiveMessage:{body:{text:'Interativo '+valid}}}},
   {message:{templateMessage:{hydratedTemplate:{hydratedContentText:'Modelo '+valid}}}},
   {message:{buttonsMessage:{contentText:'Botões '+valid}}},
   {message:{listMessage:{description:'Lista '+valid}}},
   {message:{imageMessage:{caption:''}},caption:'Legenda no nível data '+valid},
   {message:{textMessage:{text:'Texto estruturado '+valid}}}
  ];
  for(const [i,item] of items.entries()){
   const parsed=parseMonitorEvent({event:'messages.upsert',instance:INSTANCE,data:{
    key:{remoteJid:GROUP,fromMe:false,id:'VARIANT-'+i},...item}});
   assert.equal(parsed.length,1,'variante '+i);
   assert.deepEqual(parsed[0].urls,[valid],'variante '+i);
  }
  const mixed=event(GROUP,'Oferta Netshoes https://click.linksynergy.com/deeplink?id=test&url=https%3A%2F%2Fwww.netshoes.com.br - Mercado Livre '+valid);
  const ingested=await ingestMonitorEvent(env,mixed);
  assert.equal(ingested.pending,1);
  assert.equal((await monitorState(env)).diagnostics.links_recognized,1);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM ml_monitor_shortlinks').first().n,1);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM ml_monitor_links').first().n,0);
 }finally{DB.close();}
});
test('reconhece formatos comuns de link sem protocolo e ignora loja externa',()=>{
 const product='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
 assert.deepEqual(extractUrls('Veja www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678'),[product]);
 assert.deepEqual(extractUrls('https://melila.me/\nAAJLUPqiqmsu'),['https://melila.me/AAJLUPqiqmsu']);
 assert.deepEqual(extractUrls('melila.me/AAJLUPqiqmsu'),['https://melila.me/AAJLUPqiqmsu']);
 assert.deepEqual(extractUrls('https://click.linksynergy.com/?id=abc&url=https%3A%2F%2Fwww.netshoes.com.br'),[
  'https://click.linksynergy.com/?id=abc&url=https%3A%2F%2Fwww.netshoes.com.br'
 ]);
 const quoted={event:'messages.upsert',instance:INSTANCE,data:{
  key:{remoteJid:GROUP,fromMe:false,id:'NO-QUOTE'},
  message:{extendedTextMessage:{text:'Mensagem sem link',contextInfo:{quotedMessage:{conversation:'Outro usuário: https://melila.me/AAJLUPqiqmsu'}}}}
 }};
 assert.deepEqual(parseMonitorEvent(quoted),[],'não extrai URL de mensagem citada');
});
