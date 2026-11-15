import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {ensureMonitor,extractUrls,parseMonitorEvent,monitorState,addMonitorGroup,
 saveMonitorSettings,ingestMonitorEvent,prepareMonitorBatch,updateMonitorLinkCategory,
 resolveMonitorShortlinks,reviewMonitorShortlink,inspectMonitorShortlink,featuredProductFromHtml,trustedEmbeddedRedirect,claimSocialBrowserBudget,browserFeaturedProduct} from '../src/whatsapp-link-monitor.js';
import {readLinkBatch,importLinkBatch} from '../src/link-batches.js';
import {renderPage,CSS,CLIENT_JS} from '../src/ui.js';
import {MONITOR_HTML,MONITOR_CLIENT_JS,MONITOR_CSS} from '../src/ui-whatsapp-monitor.js';
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

test('painel mostra opção para aprovar e revalidar links em revisão',()=>{
 const html=renderPage();
 assert.match(html,/id="ml-monitor-review-list"/);
 assert.match(CLIENT_JS,/mlMonitorApplyReviews/);
 assert.match(CLIENT_JS,/Aprovar produto para conversão/);
 assert.match(CLIENT_JS,/Tentar validar novamente/);
 assert.doesNotThrow(()=>new Function(CLIENT_JS));
});
test('aprovação manual exige endereço do Mercado Livre e confirmação',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Oferta https://meli.la/MANUAL12345'));
  DB.prepare("UPDATE ml_monitor_shortlinks SET status='review'").run();
  const id=DB.prepare("SELECT id FROM ml_monitor_shortlinks").first().id;
  const approve=(source_url,confirm_same_product=true)=>
    reviewMonitorShortlink(env,id,{action:'approve',source_url,confirm_same_product});
  assert.equal((await monitorState(env)).recent_shortlinks[0].id,id);
  await assert.rejects(approve(PRODUCT,false),/Confirme que abriu/);
  await assert.rejects(approve('https://www.netshoes.com.br/tenis'),/Mercado Livre/);
  await assert.rejects(approve('https://meli.la/OTHER12345'),/Mercado Livre/);
  globalThis.fetch=async()=>new Response('Forbidden',{status:403});
  const result=await approve(PRODUCT,true);
  assert.equal(result.resolved,true);
  assert.equal(result.manual,true);
  const state=await monitorState(env);
  assert.equal(state.links.length,1);
  assert.equal(state.links[0].source_url,PRODUCT);
  assert.equal(state.shortlinks.find(x=>x.status==='resolved').total,1);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM offers").first().total,0);
  await assert.rejects(approve(PRODUCT),/não está mais em revisão/);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});
test('revalidar resolve link ou mantém em revisão se destino indisponível',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'De R$ 100 por R$ 50 https://meli.la/RETRY12345'));
  DB.prepare("UPDATE ml_monitor_shortlinks SET status='review'").run();
  const id=DB.prepare("SELECT id FROM ml_monitor_shortlinks").first().id;
  globalThis.fetch=async()=>new Response('Forbidden',{status:403});
  assert.equal((await reviewMonitorShortlink(env,id,{action:'retry'})).resolved,false);
  assert.equal(DB.prepare("SELECT status FROM ml_monitor_shortlinks").first().status,'review');
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:RAW}});
  assert.equal((await reviewMonitorShortlink(env,id,{action:'retry'})).resolved,true);
  assert.equal((await monitorState(env)).links[0].last_seen_price_cents,5000);
  assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM offers").first().total,0);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});
test('não aprova endereço manual divergente do produto verificado',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'https://meli.la/MISMATCH12345'));
  DB.prepare("UPDATE ml_monitor_shortlinks SET status='review'").run();
  const id=DB.prepare("SELECT id FROM ml_monitor_shortlinks").first().id;
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:'https://www.mercadolivre.com.br/outro/p/MLB99999999'}});
  await assert.rejects(reviewMonitorShortlink(env,id,{
   action:'approve',source_url:PRODUCT,confirm_same_product:true
  }),/não corresponde/);
  assert.equal((await monitorState(env)).counts.captured,0);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});
test('API de revisão requer login',async()=>{
 const {env,DB}=setup();
 try{
  const response=await worker.fetch(new Request('https://afiliados.example.test/api/monitor/shortlinks/1/review',{
   method:'POST',headers:{origin:'https://afiliados.example.test','content-type':'application/json'},
   body:JSON.stringify({action:'approve',source_url:PRODUCT,confirm_same_product:true})
  }),env);
  assert.equal(response.status,401);
 }finally{DB.close();}
});

test('meli.la de vitrine /social não é produto, diagnóstico identifica vitrine',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 const social='https://www.mercadolivre.com.br/social/fabriciotechcombr?matt_word=s01setup&matt_tool=26256765';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo vitrine',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Veja aqui https://meli.la/1nATbu7'));
  const calls=[];
  globalThis.fetch=async url=>{
   calls.push(String(url));
   if(String(url)==='https://meli.la/1nATbu7')
    return new Response(null,{status:302,headers:{location:social}});
   return new Response('<html><body>Vitrine sem HTML público do destaque</body></html>',{status:200,headers:{'content-type':'text/html'}});
  };
  const start=1700000000;
  for(let i=0;i<3;i++){
   const outcome=await resolveMonitorShortlinks(env,{now:start+i*31});
   assert.equal(outcome.resolved,0);
   assert.equal(outcome.reviewed,1);
  }
  assert.deepEqual(calls,Array(3).fill(['https://meli.la/1nATbu7',social]).flat());
  const short=DB.prepare('SELECT status,reason FROM ml_monitor_shortlinks').first();
  assert.equal(short.status,'review');
  assert.match(short.reason,/Vitrine encontrada, mas o botão do produto principal/);
  assert.equal((await monitorState(env)).counts.captured,0);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('meli.la com redirecionamento por .com e depois .com.br confirma produto único',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Oferta por R$ 99 https://meli.la/MULTIHOP7'));
  const calls=[];
  globalThis.fetch=async url=>{
   const u=String(url);calls.push(u);
   if(u==='https://meli.la/MULTIHOP7')return new Response(null,{status:302,headers:{location:'https://www.mercadolivre.com/sec/1234'}});
   if(u==='https://www.mercadolivre.com/sec/1234')return new Response(null,{status:301,headers:{location:PRODUCT}});
   throw new Error('URL inesperada: '+u);
  };
  assert.equal((await resolveMonitorShortlinks(env)).resolved,1);
  assert.deepEqual(calls,['https://meli.la/MULTIHOP7','https://www.mercadolivre.com/sec/1234']);
  const product=(await monitorState(env)).links[0];
  assert.equal(product.source_url,PRODUCT);
  assert.equal(product.last_seen_price_cents,9900);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('meli.la com HTTP403 entra em revisão com novas tentativas automáticas a cada 30s',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'https://meli.la/BLOCK4037'));
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('denied',{status:403});};
  const start=1700000000;
  assert.equal((await resolveMonitorShortlinks(env,{now:start})).reviewed,1);
  let short=DB.prepare('SELECT status,reason,tries FROM ml_monitor_shortlinks').first();
  assert.equal(short.status,'review');
  assert.match(short.reason,/negou a consulta automática \(403\)/);
  assert.equal(short.tries,1);
  assert.equal((await resolveMonitorShortlinks(env,{now:start+29})).reviewed,0);
  assert.equal(calls,1,'não repetir antes de 30 segundos');
  assert.equal((await resolveMonitorShortlinks(env,{now:start+30})).reviewed,1);
  short=DB.prepare('SELECT status,tries FROM ml_monitor_shortlinks').first();
  assert.equal(short.status,'review');
  assert.equal(short.tries,2);
  assert.equal(calls,2);
  assert.equal((await monitorState(env)).counts.captured,0);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('revisa automaticamente erros genéricos antigos de meli.la uma vez sem aprovar vitrine',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'https://meli.la/OLDREVIEW9'));
  DB.prepare("UPDATE ml_monitor_shortlinks SET status='review',reason='Sem destino seguro de produto',tries=1").run();
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{location:PRODUCT}});};
  assert.equal((await resolveMonitorShortlinks(env)).resolved,1);
  assert.equal(DB.prepare('SELECT status FROM ml_monitor_shortlinks').first().status,'resolved');
  assert.equal(calls,1);
  assert.equal((await resolveMonitorShortlinks(env)).resolved,0);
  assert.equal(calls,1);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('inspecionar erro de vitrine ou redirect externo retorna causa em vez de falso sucesso',async()=>{
 const gallery=await inspectMonitorShortlink('https://meli.la/1nATbu7',{
  fetcher:async url=>String(url)==='https://meli.la/1nATbu7'
   ?new Response(null,{status:302,headers:{location:'https://www.mercadolivre.com.br/social/lojavitrine'}})
   :new Response('<html>Vitrine sem renderização</html>',{status:200,headers:{'content-type':'text/html'}})
 });
 assert.equal(gallery.kind,'showcase');
 assert.equal(gallery.product,null);
 const outside=await inspectMonitorShortlink('https://meli.la/OUTSIDE7',{
  fetcher:async()=>new Response(null,{status:302,headers:{location:'https://shopee.com.br/produto'}})
 });
 assert.equal(outside.kind,'external');
 assert.equal(outside.product,null);
});

const FEATURED_SOCIAL_URL='https://www.mercadolivre.com.br/social/fabriciotechcombr';
const FEATURED_PRODUCT_URL='https://www.mercadolivre.com.br/capa-de-cobrir-moto-protetora-sol-chuva-impermeavel-p-m-g/up/MLBU1714113915?pdp_filters=item_id:MLB6593318302';
const RECOMMENDED_PRODUCT_URL='https://www.mercadolivre.com.br/alto-falante-aleatorio/p/MLB88888888';
function socialGalleryHtml({withFeatured=true,otherMain=false}={}){
 return '<!DOCTYPE html><html><body>'+
  '<div class="rl-card-featured-wrapper"><div data-testid="poly-card">'+
  '<h2>Capa De Cobrir Moto Protetora Sol Chuva Impermeável P M G Preto G</h2><span>R$ 59,90</span>'+
  (withFeatured?'<a class="poly-action-links__action--link" href="'+
   (otherMain?RECOMMENDED_PRODUCT_URL:FEATURED_PRODUCT_URL.replace('&','&amp;'))+'">Ir para produto</a>':'')+
  '</div></div>'+
  '<section class="rl-card-recommendations"><h2>Você também pode gostar</h2>'+
  '<a class="poly-action-links__action--link" href="'+RECOMMENDED_PRODUCT_URL+'">Ir para produto</a></section>'+
  '</body></html>';
}
test('exemplo real meli.la: segue o botão do destaque acima das recomendações',()=>{
 const found=featuredProductFromHtml(socialGalleryHtml(),FEATURED_SOCIAL_URL);
 assert.equal(found?.kind,'product');
 assert.equal(found?.product_id,'MLBU1714113915');
 assert.equal(found?.url,FEATURED_PRODUCT_URL.split('?')[0]);
});
test('vitrine sem botão do destaque não escolhe produtos sugeridos',()=>{
 assert.equal(featuredProductFromHtml(socialGalleryHtml({withFeatured:false}),FEATURED_SOCIAL_URL),null);
 assert.equal(featuredProductFromHtml('<a href="'+FEATURED_PRODUCT_URL+'">Ir para produto</a>',FEATURED_SOCIAL_URL),null);
});
test('inspeção meli.la > /social > botão Ir para produto identifica apenas produto principal',async()=>{
 const called=[];
 const inspected=await inspectMonitorShortlink('https://meli.la/1nATbu7',{
  fetcher:async url=>{
   called.push(String(url));
   if(String(url)==='https://meli.la/1nATbu7')
    return new Response(null,{status:302,headers:{location:FEATURED_SOCIAL_URL}});
   if(String(url)===FEATURED_SOCIAL_URL)
    return new Response(socialGalleryHtml(),{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
   throw new Error('unexpected '+url);
  }
 });
 assert.deepEqual(called,['https://meli.la/1nATbu7',FEATURED_SOCIAL_URL]);
 assert.equal(inspected.kind,'featured_product');
 assert.equal(inspected.product?.product_id,'MLBU1714113915');
 assert.equal(inspected.product?.url,FEATURED_PRODUCT_URL.split('?')[0]);
});
test('link antigo em revisão de vitrine é automaticamente reprocessado para produto principal',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Galeria de Produtos',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Protetor de moto de R$ 135 por R$ 59,90 https://meli.la/1nATbu7'));
  DB.prepare("UPDATE ml_monitor_shortlinks SET status='review',reason='Link abre uma vitrine com vários produtos, não um anúncio individual',tries=1").run();
  globalThis.fetch=async url=>String(url)==='https://meli.la/1nATbu7'
   ?new Response(null,{status:302,headers:{location:FEATURED_SOCIAL_URL}})
   :new Response(socialGalleryHtml(),{status:200,headers:{'content-type':'text/html'}});
  assert.equal((await resolveMonitorShortlinks(env)).resolved,1);
  const state=await monitorState(env);
  assert.equal(state.links.length,1);
  assert.equal(state.links[0].source_url,FEATURED_PRODUCT_URL.split('?')[0]);
  assert.equal(state.links[0].last_seen_price_cents,5990);
  assert.equal(state.shortlinks.find(x=>x.status==='resolved')?.total,1);
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});


test('meli.promo/s/WUS7Tq reconhecido mesmo sem protocolo ou com linha quebrada',()=>{
 const short='https://meli.promo/s/WUS7Tq';
 assert.deepEqual(extractUrls('📢 Compre: '+short),[short]);
 assert.deepEqual(extractUrls('📢 Compre: meli.promo/s/WUS7Tq'),[short]);
 assert.deepEqual(extractUrls('📢 Compre: https://meli.promo/s/\nWUS7Tq'),[short]);
 const parsed=parseMonitorEvent(event(GROUP,'JBL ST200 por R$ 105,00 '+short));
 assert.equal(parsed.length,1);
 assert.deepEqual(parsed[0].urls,[short]);
});
test('meli.promo/s/WUS7Tq segue vitrine e captura o destaque JBL, sem reutilizar afiliado',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 const short='https://meli.promo/s/WUS7Tq';
 const social='https://www.mercadolivre.com.br/social/dafhbgecd60351?matt_word=gear';
 const product='https://www.mercadolivre.com.br/jbl-super-tweeter-st200-preto/p/MLB12345678';
 const recommendation='https://www.mercadolivre.com.br/fone-bluetooth/p/MLB99999999';
 const page='<html><body><div class="rl-card-featured-wrapper"><div data-testid="poly-card">'+
  '<h2>JBL Super Tweeter ST200 Preto</h2><span>R$ 105,73</span>'+
  '<a class="poly-action-links__action--link" href="'+product+'?matt_tool=old-owner">Ir para produto</a>'+
  '</div></div><section class="rl-card-recommendations"><h2>Você também pode gostar</h2>'+
  '<a class="poly-action-links__action--link" href="'+recommendation+'">Ir para produto</a>'+
  '</section></body></html>';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Gear Ofertas',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const message='JBL ST200 POR 105 REAIS 🔥 ✅ De R$ 120,00 por R$ 105,00 🛒 '+short;
  assert.equal((await ingestMonitorEvent(env,event(GROUP,message))).pending,1);
  assert.equal(DB.prepare('SELECT short_url FROM ml_monitor_shortlinks').first().short_url,short);
  const calls=[];
  globalThis.fetch=async (url,options)=>{
   calls.push(String(url));
   assert.equal(options.redirect,'manual');
   if(String(url)===short)return new Response(null,{status:302,headers:{location:social}});
   if(String(url)===social)return new Response(page,{status:200,headers:{'content-type':'text/html'}});
   throw new Error('URL inesperada '+url);
  };
  const outcome=await resolveMonitorShortlinks(env);
  assert.equal(outcome.resolved,1);
  assert.deepEqual(calls,[short,social]);
  const state=await monitorState(env);
  assert.equal(state.counts.captured,1);
  assert.equal(state.links[0].source_url,product);
  assert.equal(state.links[0].last_seen_price_cents,10500);
  assert.equal(state.shortlinks.find(x=>x.status==='resolved').total,1);
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});
test('meli.promo não libera link externo nem rotas incorretas',async()=>{
 const invalid=parseMonitorEvent(event(GROUP,'https://meli.promo/admin/WUS7Tq'));
 assert.equal(invalid.length,1);
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Gear Ofertas',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'https://meli.promo/admin/WUS7Tq'));
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM ml_monitor_shortlinks').first().total,0);
  await ingestMonitorEvent(env,event(GROUP,'https://meli.promo/s/SHOPEE1'));
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:'https://shopee.com.br/produto'}})
  const checked=await resolveMonitorShortlinks(env);
  assert.equal(checked.resolved,0);
  assert.equal(DB.prepare("SELECT status FROM ml_monitor_shortlinks").first().status,'review');
  assert.equal((await monitorState(env)).counts.captured,0);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});

test('painel de monitoramento com seções recolhíveis e contadores visíveis',()=>{
 assert.match(MONITOR_HTML,/<details class="ml-monitor-fold" id="ml-monitor-groups-fold">/);
 assert.match(MONITOR_HTML,/<details class="ml-monitor-fold" id="ml-monitor-products-fold">/);
 assert.match(MONITOR_HTML,/id="ml-monitor-diagnostics"/);
 assert.match(MONITOR_HTML,/id="ml-monitor-count-captured"/);
 assert.match(MONITOR_HTML,/id="ml-monitor-auto-batch"/);
 assert.doesNotMatch(MONITOR_HTML,/<details[^>]+open(?:\s|>)/);
 assert.match(MONITOR_CSS,/details\[data-monitor-panel\]>summary::before/);
 assert.match(MONITOR_CSS,/summary:focus-visible/);
 assert.doesNotThrow(()=>new Function(MONITOR_CLIENT_JS));
});
test('diagnóstico começa fechado e preserva setinhas abertas após atualizar contadores',()=>{
 const start=MONITOR_CLIENT_JS.indexOf('function mlMonitorApplyDiagnostics(');
 const end=MONITOR_CLIENT_JS.indexOf('function mlMonitorApplyReviews(',start);
 assert.ok(start>=0&&end>start);
 let open=[];
 const box={
  innerHTML:'',
  querySelectorAll(selector){
   assert.equal(selector,'details[data-monitor-panel]');
   return open.map(key=>({open:true,dataset:{monitorPanel:key}}));
  }
 };
 const run=new Function('$','escape',MONITOR_CLIENT_JS.slice(start,end)+
  '\nreturn mlMonitorApplyDiagnostics;')(
   id=>id==='ml-monitor-diagnostics'?box:null,
   value=>String(value??'')
  );
 const state={
  enabled:true,
  diagnostics:{events_received:10,last_event_at:1234567890,authorized_messages:7,
   messages_with_links:5,links_recognized:4},
  shortlinks:[{status:'pending',total:1},{status:'review',total:2},{status:'resolved',total:3}],
  recent_shortlinks:[{short_url:'https://meli.la/ABCDEFG',status:'review',reason:'Sem destino'}],
  recent_domains:[{group_name:'Grupo',domain:'meli.la',reason:'encurtador_aceito',
   created_at:1234567890,message_format:'imageMessage'}],
  rejected_events:[{reason:'instancia_diferente',occurrences:1,last_at:1234567890}]
 };
 run(state);
 for(const key of ['shortlinks','domains','discarded'])
  assert.match(box.innerHTML,new RegExp('<details data-monitor-panel="'+key+'"><summary>'));
 assert.doesNotMatch(box.innerHTML,/<details[^>]+open>/);
 open=['domains','discarded'];
 state.diagnostics.events_received=11;
 run(state);
 assert.match(box.innerHTML,/<details data-monitor-panel="domains" open>/);
 assert.match(box.innerHTML,/<details data-monitor-panel="discarded" open>/);
 assert.match(box.innerHTML,/<details data-monitor-panel="shortlinks"><summary>/);
 assert.match(box.innerHTML,/Eventos recebidos: <b>11<\/b>/);
});
test('revisões permanecem fechadas inicialmente e preservam abertura ao atualizar',()=>{
 const start=MONITOR_CLIENT_JS.indexOf('function mlMonitorApplyReviews(');
 const end=MONITOR_CLIENT_JS.indexOf('function mlMonitorApplyCounts(',start);
 assert.ok(start>=0&&end>start);
 let isOpen=false;
 const box={
  innerHTML:'',
  querySelector(selector){
   assert.equal(selector,'details[data-monitor-panel="reviews"]');
   return isOpen?{open:true}:null;
  },
  querySelectorAll(){return [];}
 };
 const run=new Function('$','escape',MONITOR_CLIENT_JS.slice(start,end)+
  '\nreturn mlMonitorApplyReviews;')(
   id=>id==='ml-monitor-review-list'?box:null,
   value=>String(value??'')
  );
 const state={recent_shortlinks:[{
  id:1,short_url:'https://meli.la/ABCDEFG',status:'review',group_name:'Promoções',
  reason:'Sem destino seguro'
 }]};
 run(state);
 assert.match(box.innerHTML,/<details data-monitor-panel="reviews" class="ml-monitor-fold">/);
 assert.doesNotMatch(box.innerHTML,/<details[^>]+open>/);
 isOpen=true;
 run(state);
 assert.match(box.innerHTML,/<details data-monitor-panel="reviews" class="ml-monitor-fold" open>/);
 assert.match(box.innerHTML,/Aprovar produto para conversão/);
});



test('badges de links em revisão mostram total real, não o limite dos registros carregados',()=>{
 const start=MONITOR_CLIENT_JS.indexOf('function mlMonitorApplyReviews(');
 const end=MONITOR_CLIENT_JS.indexOf('function mlMonitorApplyCounts(',start);
 assert.ok(start>=0&&end>start);
 const box={innerHTML:'',querySelector(){return null;},querySelectorAll(){return [];}};
 const run=new Function('
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 const source='https://meli.la/1fxaUbj',start=1700000000;
 const destination='https://www.mercadolivre.com.br/resina-acqua-multiuso-36l/p/MLB12345678';
 const social='https://www.mercadolivre.com.br/social/so-promos-originais';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Construção',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Resina de R$ 98 por R$ 74 '+source));
  let first=true,calls=0;
  globalThis.fetch=async url=>{
   calls++;
   if(String(url)===source)return new Response(null,{status:302,headers:{location:social}});
   if(String(url)===social){
    if(first){first=false;return new Response('<html><body>Aguarde</body></html>',{
      status:200,headers:{'content-type':'text/html'}});}
    return new Response('<html><body><div class="rl-card-featured-wrapper">'+
      '<a class="poly-action-links__action--link" href="'+destination+'">Ir para produto</a>'+
      '</div><section class="rl-card-recommendations">'+
      '<a href="https://www.mercadolivre.com.br/outro/p/MLB99999999">Ir para produto</a></section>'+
      '</body></html>',{status:200,headers:{'content-type':'text/html'}});
   }
   throw Error('unexpected '+url);
  };
  const a=await resolveMonitorShortlinks(env,{now:start});
  assert.equal(a.reviewed,1);
  assert.equal(DB.prepare("SELECT status FROM ml_monitor_shortlinks").first().status,'review');
  assert.equal((await resolveMonitorShortlinks(env,{now:start+20})).resolved,0);
  assert.equal(calls,2);
  const b=await resolveMonitorShortlinks(env,{now:start+31});
  assert.equal(b.resolved,1);
  assert.equal(calls,4);
  assert.equal(DB.prepare("SELECT status FROM ml_monitor_shortlinks").first().status,'resolved');
  const state=await monitorState(env);
  assert.equal(state.counts.captured,1);
  assert.equal(state.links[0].source_url,destination);
  assert.equal(state.links[0].last_seen_price_cents,7400);
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('dois acionamentos concorrentes nao verificam o mesmo link novamente',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Oferta https://meli.la/LOCKLOCK7'));
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('rate limit',{status:429});};
  const [first,second]=await Promise.all([
   resolveMonitorShortlinks(env,{now:1700000000}),
   resolveMonitorShortlinks(env,{now:1700000000})
  ]);
  assert.equal(first.reviewed+second.reviewed,1);
  assert.equal(calls,1);
  assert.equal(DB.prepare('SELECT tries FROM ml_monitor_shortlinks').first().tries,1);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('revisao externa nunca vira produto e tem intervalo progressivo para links bloqueados',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'https://meli.la/EXTERNAL7'));
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://www.netshoes.com.br/produto'}});};
  await resolveMonitorShortlinks(env,{now:1700000000});
  assert.equal(DB.prepare("SELECT status FROM ml_monitor_shortlinks").first().status,'review');
  await resolveMonitorShortlinks(env,{now:1700000031});
  assert.equal(calls,1);
  assert.equal((await monitorState(env)).counts.captured,0);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});


test('meli.promo/s/igrYkt abre vitrine Mercado Livre com login: não é loja externa nem produto aprovado',async()=>{
 const source='https://meli.promo/s/igrYkt',
   social='https://www.mercadolivre.com.br/social/igrYkt/lists',
   login='https://www.mercadolivre.com.br/jms/mlb/lgz/login?go=https%3A%2F%2Fwww.mercadolivre.com.br%2Fsocial%2FigrYkt%2Flists';
 const calls=[];
 const outcome=await inspectMonitorShortlink(source,{fetcher:async url=>{
  calls.push(String(url));
  if(String(url)===source)return new Response(null,{status:302,headers:{location:social}});
  if(String(url)===social)return new Response(null,{status:302,headers:{location:login}});
  throw Error('Não era esperado acessar o formulário de login: '+url);
 }});
 assert.equal(outcome.kind,'auth');
 assert.equal(outcome.product,null);
 assert.match(outcome.reason,/solicitou login/);
 assert.deepEqual(calls,[source,social]);
});
test('parâmetro de redirecionamento para anúncio oficial pode ser seguido sem acessar intermediário externo',async()=>{
 const short='https://meli.promo/s/TEST123',
  target='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
 const intermediate='https://intermediario.example.com/link?url='+encodeURIComponent(target);
 assert.equal(trustedEmbeddedRedirect(intermediate),target);
 assert.equal(trustedEmbeddedRedirect('https://intermediario.example.com/?url=https%3A%2F%2Fshopee.com.br%2Fproduto'),null);
 assert.equal(trustedEmbeddedRedirect('https://intermediario.example.com/?url='+encodeURIComponent(target)+'&target='+encodeURIComponent('https://www.mercadolivre.com.br/outro/p/MLB99999999')),null);
 let requests=0;
 const result=await inspectMonitorShortlink(short,{fetcher:async url=>{
  requests++;
  assert.equal(String(url),short,'nunca acessa o domínio intermediário externo');
  return new Response(null,{status:302,headers:{location:intermediate}});
 }});
 assert.equal(requests,1);
 assert.equal(result.kind,'product');
 assert.equal(result.product.product_id,'MLB12345678');
});
test('redirecionamento para loja externa informa domínio real e não promete validação automática',async()=>{
 const item='https://meli.promo/s/igrYkt';
 const result=await inspectMonitorShortlink(item,{fetcher:async()=>new Response(null,{status:302,
  headers:{location:'https://tracking.example.org/redirect?id=ABC'}})});
 assert.equal(result.kind,'external');
 assert.match(result.reason,/tracking\.example\.org/);
 assert.match(result.reason,/revisão manual necessária/);
 assert.doesNotMatch(result.reason,/produto confirmado/);
 assert.match(MONITOR_CLIENT_JS,/Redirecionamento para domínio não verificado/);
 assert.match(MONITOR_CLIENT_JS,/não libera links externos automaticamente/);
});
test('revisão antiga com motivo genérico reavalia uma vez e substitui motivo por domínio específico',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Oferta '+ 'https://meli.promo/s/igrYkt'));
  DB.prepare("UPDATE ml_monitor_shortlinks SET status='review',tries=2,reason='Destino fora dos domínios permitidos do Mercado Livre'").run();
  let requests=0;
  globalThis.fetch=async()=>{requests++;return new Response(null,{status:302,
   headers:{location:'https://intermediario.example.com/link'}});};
  assert.equal((await resolveMonitorShortlinks(env,{now:1700000000})).reviewed,1);
  const row=DB.prepare("SELECT status,reason FROM ml_monitor_shortlinks").first();
  assert.equal(row.status,'review');
  assert.match(row.reason,/intermediario\.example\.com/);
  await resolveMonitorShortlinks(env,{now:1700000031});
  assert.equal(requests,1,'não insiste indefinidamente em domínio externo desconhecido');
 }finally{globalThis.fetch=oldFetch;DB.close();}
});


test('real tracking do Mercado Livre identifica o destaque mesmo sem classe rl-card-featured',()=>{
 const featured='https://www.mercadolivre.com.br/parafusadeira-e-furadeira-sem-fio-bateria-38-10mm-com-maleta-e-acessorios-the-black-tools/p/MLB42162174';
 const tracked=featured+'?matt_tool=40081166#polycard_client=recommendations_home_affiliate-profile&reco_item_pos=0&c_id=/home/card-featured/element';
 const recommended='https://www.mercadolivre.com.br/parafusadeira-outro/p/MLB30144703?x=1#polycard_client=recommendations_home_affiliate_profile_v2p-recommendations&reco_item_pos=0&c_id=/home/affiliate-profile-recommendations/element';
 const html='<html><body><a href="'+tracked.replaceAll('&','&amp;')+'">Produto destacado</a>'+
  '<a href="'+tracked+'">Ir para produto</a>'+
  '<h2>Você também pode gostar</h2><a href="'+recommended+'">Outra furadeira</a></body></html>';
 const result=featuredProductFromHtml(html,'https://www.mercadolivre.com.br/social/prorelampago');
 assert.equal(result?.product_id,'MLB42162174');
 assert.equal(result?.url,featured);
 const onlyRecommended='<html><a href="'+recommended+'">Ir para produto</a></html>';
 assert.equal(featuredProductFromHtml(onlyRecommended,'https://www.mercadolivre.com.br/social/prorelampago'),null);
});
test('renderização JS reconhece botão do destaque após primeiro HTML não trazer o botão',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 const short='https://meli.la/1dt9xQD';
 const social='https://www.mercadolivre.com.br/social/prorelampago?matt_word=test';
 const featured='https://www.mercadolivre.com.br/parafusadeira-e-furadeira-sem-fio-bateria-38-10mm-com-maleta-e-acessorios-the-black-tools/p/MLB42162174';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Promo Ferramentas',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Black Tools POR R$94,90 '+short));
  let renderCalls=0;
  env.BROWSER={
   async quickAction(kind,opts){
    renderCalls++;
    assert.equal(kind,'content');
    assert.equal(opts.url,social);
    assert.equal(opts.gotoOptions.waitUntil,'networkidle2');
    return new Response('<html><div class="rl-card-featured-wrapper">'+
      '<div class="poly-action-links__action poly-action-links__action--link">'+
      '<a class="poly-component__link poly-component__link--action-link" href="'+featured+'">Ir para produto</a>'+
      '</div></div><section class="rl-card-recommendations">'+
      '<a href="https://www.mercadolivre.com.br/alternativo/p/MLB99999999">Ir para produto</a></section></html>',
      {status:200,headers:{'content-type':'text/html'}});
   }
  };
  let requests=0;
  globalThis.fetch=async url=>{
   requests++;
   if(String(url)===short)return new Response(null,{status:302,headers:{location:social}});
   if(String(url)===social)return new Response('<html><p>JavaScript carregando...</p></html>',{
    status:200,headers:{'content-type':'text/html'}});
   throw Error('URL inesperada '+url);
  };
  const result=await resolveMonitorShortlinks(env,{now:1700000000});
  assert.equal(result.resolved,1);
  assert.equal(renderCalls,1);
  assert.equal(requests,2);
  const state=await monitorState(env);
  assert.equal(state.links[0].product_id,'MLB42162174');
  assert.equal(state.links[0].source_url,featured);
  assert.equal(state.links[0].last_seen_price_cents,9490);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('orçamento de Browser Run limita 12 por dia e uma chamada a cada 65 segundos',async()=>{
 const {env,DB}=setup();
 try{
  let used=0;
  env.BROWSER={quickAction:async()=>new Response('')};
  const start=1700000000;
  assert.equal(await claimSocialBrowserBudget(env,start),true);used++;
  assert.equal(await claimSocialBrowserBudget(env,start+30),false);
  for(let k=1;k<12;k++){
   assert.equal(await claimSocialBrowserBudget(env,start+k*66),true);
   used++;
  }
  assert.equal(used,12);
  assert.equal(await claimSocialBrowserBudget(env,start+12*66),false);
  assert.equal((await DB.prepare('SELECT daily_count FROM ml_monitor_browser_budget').first()).daily_count,12);
  assert.equal(await claimSocialBrowserBudget(env,start+86400),true);
 }finally{DB.close();}
});
test('Browser Run não captura recomendações se a vitrine não entregar produto destacado',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Promo',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'https://meli.promo/s/TESTFALHA'));
  env.BROWSER={quickAction:async()=>new Response('<html><h2>Você também pode gostar</h2>'+
   '<a href="https://www.mercadolivre.com.br/furadeira-outra/p/MLB99999999">Ir para produto</a></html>',
   {status:200,headers:{'content-type':'text/html'}})};
  globalThis.fetch=async url=>String(url)==='https://meli.promo/s/TESTFALHA'
   ?new Response(null,{status:302,headers:{location:'https://www.mercadolivre.com.br/social/teste'}})
   :new Response('<html>Carregando...</html>',{status:200,headers:{'content-type':'text/html'}});
  const outcome=await resolveMonitorShortlinks(env,{now:1700000000});
  assert.equal(outcome.resolved,0);
  assert.equal(outcome.reviewed,1);
  assert.equal((await monitorState(env)).counts.captured,0);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});


test('meli.promo vitrine com JS captura principal JBL após renderização e ignora sugestões',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 const short='https://meli.promo/s/WUS7Tq';
 const social='https://www.mercadolivre.com.br/social/gearofertas';
 const jbl='https://www.mercadolivre.com.br/jbl-super-tweeter-st200-preto/p/MLB42162174';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Gear Ofertas',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'JBL Super Tweeter ST200 por R$ 105,00 '+short));
  globalThis.fetch=async url=>String(url)===short
   ?new Response(null,{status:302,headers:{location:social}})
   :new Response('<html>Aplicativo carregando</html>',{status:200,headers:{'content-type':'text/html'}});
  let renderCalls=0;
  env.BROWSER={async quickAction(){
   renderCalls++;
   return new Response('<html><div class="rl-card-featured-wrapper">'+
    '<a class="poly-component__link poly-component__link--action-link" href="'+jbl+'">Ir para produto</a>'+
    '</div><section class="rl-card-recommendations">'+
    '<a href="https://www.mercadolivre.com.br/outro/p/MLB99999999">Ir para produto</a></section></html>',
    {headers:{'content-type':'text/html'}});
  }};
  assert.equal((await resolveMonitorShortlinks(env,{now:1700000000})).resolved,1);
  assert.equal(renderCalls,1);
  const state=await monitorState(env);
  assert.equal(state.links[0].source_url,jbl);
  assert.equal(state.links[0].last_seen_price_cents,10500);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});
,'escape',MONITOR_CLIENT_JS.slice(start,end)+
  '\nreturn mlMonitorApplyReviews;')(
  id=>id==='ml-monitor-review-list'?box:null,
  value=>String(value??'')
 );
 const state={
  shortlinks:[{status:'review',total:35}],
  recent_shortlinks:Array.from({length:25},(_,i)=>({
   id:i+1,short_url:'https://meli.la/TEST'+String(i+1000),status:'review',
   group_name:'Grupo autorizado',reason:'Redirecionamento indisponível'
  }))
 };
 run(state);
 assert.match(box.innerHTML,/<summary>🔎 Links em revisão <span class="ml-monitor-fold-count">35<\/span><\/summary>/);
 assert.match(box.innerHTML,/Exibindo 25 de 35 links em revisão/);
});

test('revisão de vitrine é resolvida automaticamente na segunda tentativa sem abrir o painel',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 const source='https://meli.la/1fxaUbj',start=1700000000;
 const destination='https://www.mercadolivre.com.br/resina-acqua-multiuso-36l/p/MLB12345678';
 const social='https://www.mercadolivre.com.br/social/so-promos-originais';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Construção',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Resina de R$ 98 por R$ 74 '+source));
  let first=true,calls=0;
  globalThis.fetch=async url=>{
   calls++;
   if(String(url)===source)return new Response(null,{status:302,headers:{location:social}});
   if(String(url)===social){
    if(first){first=false;return new Response('<html><body>Aguarde</body></html>',{
      status:200,headers:{'content-type':'text/html'}});}
    return new Response('<html><body><div class="rl-card-featured-wrapper">'+
      '<a class="poly-action-links__action--link" href="'+destination+'">Ir para produto</a>'+
      '</div><section class="rl-card-recommendations">'+
      '<a href="https://www.mercadolivre.com.br/outro/p/MLB99999999">Ir para produto</a></section>'+
      '</body></html>',{status:200,headers:{'content-type':'text/html'}});
   }
   throw Error('unexpected '+url);
  };
  const a=await resolveMonitorShortlinks(env,{now:start});
  assert.equal(a.reviewed,1);
  assert.equal(DB.prepare("SELECT status FROM ml_monitor_shortlinks").first().status,'review');
  assert.equal((await resolveMonitorShortlinks(env,{now:start+20})).resolved,0);
  assert.equal(calls,2);
  const b=await resolveMonitorShortlinks(env,{now:start+31});
  assert.equal(b.resolved,1);
  assert.equal(calls,4);
  assert.equal(DB.prepare("SELECT status FROM ml_monitor_shortlinks").first().status,'resolved');
  const state=await monitorState(env);
  assert.equal(state.counts.captured,1);
  assert.equal(state.links[0].source_url,destination);
  assert.equal(state.links[0].last_seen_price_cents,7400);
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('dois acionamentos concorrentes nao verificam o mesmo link novamente',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Oferta https://meli.la/LOCKLOCK7'));
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('rate limit',{status:429});};
  const [first,second]=await Promise.all([
   resolveMonitorShortlinks(env,{now:1700000000}),
   resolveMonitorShortlinks(env,{now:1700000000})
  ]);
  assert.equal(first.reviewed+second.reviewed,1);
  assert.equal(calls,1);
  assert.equal(DB.prepare('SELECT tries FROM ml_monitor_shortlinks').first().tries,1);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('revisao externa nunca vira produto e tem intervalo progressivo para links bloqueados',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'https://meli.la/EXTERNAL7'));
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://www.netshoes.com.br/produto'}});};
  await resolveMonitorShortlinks(env,{now:1700000000});
  assert.equal(DB.prepare("SELECT status FROM ml_monitor_shortlinks").first().status,'review');
  await resolveMonitorShortlinks(env,{now:1700000031});
  assert.equal(calls,1);
  assert.equal((await monitorState(env)).counts.captured,0);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});


test('meli.promo/s/igrYkt abre vitrine Mercado Livre com login: não é loja externa nem produto aprovado',async()=>{
 const source='https://meli.promo/s/igrYkt',
   social='https://www.mercadolivre.com.br/social/igrYkt/lists',
   login='https://www.mercadolivre.com.br/jms/mlb/lgz/login?go=https%3A%2F%2Fwww.mercadolivre.com.br%2Fsocial%2FigrYkt%2Flists';
 const calls=[];
 const outcome=await inspectMonitorShortlink(source,{fetcher:async url=>{
  calls.push(String(url));
  if(String(url)===source)return new Response(null,{status:302,headers:{location:social}});
  if(String(url)===social)return new Response(null,{status:302,headers:{location:login}});
  throw Error('Não era esperado acessar o formulário de login: '+url);
 }});
 assert.equal(outcome.kind,'auth');
 assert.equal(outcome.product,null);
 assert.match(outcome.reason,/solicitou login/);
 assert.deepEqual(calls,[source,social]);
});
test('parâmetro de redirecionamento para anúncio oficial pode ser seguido sem acessar intermediário externo',async()=>{
 const short='https://meli.promo/s/TEST123',
  target='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
 const intermediate='https://intermediario.example.com/link?url='+encodeURIComponent(target);
 assert.equal(trustedEmbeddedRedirect(intermediate),target);
 assert.equal(trustedEmbeddedRedirect('https://intermediario.example.com/?url=https%3A%2F%2Fshopee.com.br%2Fproduto'),null);
 assert.equal(trustedEmbeddedRedirect('https://intermediario.example.com/?url='+encodeURIComponent(target)+'&target='+encodeURIComponent('https://www.mercadolivre.com.br/outro/p/MLB99999999')),null);
 let requests=0;
 const result=await inspectMonitorShortlink(short,{fetcher:async url=>{
  requests++;
  assert.equal(String(url),short,'nunca acessa o domínio intermediário externo');
  return new Response(null,{status:302,headers:{location:intermediate}});
 }});
 assert.equal(requests,1);
 assert.equal(result.kind,'product');
 assert.equal(result.product.product_id,'MLB12345678');
});
test('redirecionamento para loja externa informa domínio real e não promete validação automática',async()=>{
 const item='https://meli.promo/s/igrYkt';
 const result=await inspectMonitorShortlink(item,{fetcher:async()=>new Response(null,{status:302,
  headers:{location:'https://tracking.example.org/redirect?id=ABC'}})});
 assert.equal(result.kind,'external');
 assert.match(result.reason,/tracking\.example\.org/);
 assert.match(result.reason,/revisão manual necessária/);
 assert.doesNotMatch(result.reason,/produto confirmado/);
 assert.match(MONITOR_CLIENT_JS,/Redirecionamento para domínio não verificado/);
 assert.match(MONITOR_CLIENT_JS,/não libera links externos automaticamente/);
});
test('revisão antiga com motivo genérico reavalia uma vez e substitui motivo por domínio específico',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Oferta '+ 'https://meli.promo/s/igrYkt'));
  DB.prepare("UPDATE ml_monitor_shortlinks SET status='review',tries=2,reason='Destino fora dos domínios permitidos do Mercado Livre'").run();
  let requests=0;
  globalThis.fetch=async()=>{requests++;return new Response(null,{status:302,
   headers:{location:'https://intermediario.example.com/link'}});};
  assert.equal((await resolveMonitorShortlinks(env,{now:1700000000})).reviewed,1);
  const row=DB.prepare("SELECT status,reason FROM ml_monitor_shortlinks").first();
  assert.equal(row.status,'review');
  assert.match(row.reason,/intermediario\.example\.com/);
  await resolveMonitorShortlinks(env,{now:1700000031});
  assert.equal(requests,1,'não insiste indefinidamente em domínio externo desconhecido');
 }finally{globalThis.fetch=oldFetch;DB.close();}
});


test('real tracking do Mercado Livre identifica o destaque mesmo sem classe rl-card-featured',()=>{
 const featured='https://www.mercadolivre.com.br/parafusadeira-e-furadeira-sem-fio-bateria-38-10mm-com-maleta-e-acessorios-the-black-tools/p/MLB42162174';
 const tracked=featured+'?matt_tool=40081166#polycard_client=recommendations_home_affiliate-profile&reco_item_pos=0&c_id=/home/card-featured/element';
 const recommended='https://www.mercadolivre.com.br/parafusadeira-outro/p/MLB30144703?x=1#polycard_client=recommendations_home_affiliate_profile_v2p-recommendations&reco_item_pos=0&c_id=/home/affiliate-profile-recommendations/element';
 const html='<html><body><a href="'+tracked.replaceAll('&','&amp;')+'">Produto destacado</a>'+
  '<a href="'+tracked+'">Ir para produto</a>'+
  '<h2>Você também pode gostar</h2><a href="'+recommended+'">Outra furadeira</a></body></html>';
 const result=featuredProductFromHtml(html,'https://www.mercadolivre.com.br/social/prorelampago');
 assert.equal(result?.product_id,'MLB42162174');
 assert.equal(result?.url,featured);
 const onlyRecommended='<html><a href="'+recommended+'">Ir para produto</a></html>';
 assert.equal(featuredProductFromHtml(onlyRecommended,'https://www.mercadolivre.com.br/social/prorelampago'),null);
});
test('renderização JS reconhece botão do destaque após primeiro HTML não trazer o botão',async()=>{
 const {env,DB}=setup(),originalFetch=globalThis.fetch;
 const short='https://meli.la/1dt9xQD';
 const social='https://www.mercadolivre.com.br/social/prorelampago?matt_word=test';
 const featured='https://www.mercadolivre.com.br/parafusadeira-e-furadeira-sem-fio-bateria-38-10mm-com-maleta-e-acessorios-the-black-tools/p/MLB42162174';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Promo Ferramentas',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'Black Tools POR R$94,90 '+short));
  let renderCalls=0;
  env.BROWSER={
   async quickAction(kind,opts){
    renderCalls++;
    assert.equal(kind,'content');
    assert.equal(opts.url,social);
    assert.equal(opts.gotoOptions.waitUntil,'networkidle2');
    return new Response('<html><div class="rl-card-featured-wrapper">'+
      '<div class="poly-action-links__action poly-action-links__action--link">'+
      '<a class="poly-component__link poly-component__link--action-link" href="'+featured+'">Ir para produto</a>'+
      '</div></div><section class="rl-card-recommendations">'+
      '<a href="https://www.mercadolivre.com.br/alternativo/p/MLB99999999">Ir para produto</a></section></html>',
      {status:200,headers:{'content-type':'text/html'}});
   }
  };
  let requests=0;
  globalThis.fetch=async url=>{
   requests++;
   if(String(url)===short)return new Response(null,{status:302,headers:{location:social}});
   if(String(url)===social)return new Response('<html><p>JavaScript carregando...</p></html>',{
    status:200,headers:{'content-type':'text/html'}});
   throw Error('URL inesperada '+url);
  };
  const result=await resolveMonitorShortlinks(env,{now:1700000000});
  assert.equal(result.resolved,1);
  assert.equal(renderCalls,1);
  assert.equal(requests,2);
  const state=await monitorState(env);
  assert.equal(state.links[0].product_id,'MLB42162174');
  assert.equal(state.links[0].source_url,featured);
  assert.equal(state.links[0].last_seen_price_cents,9490);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('orçamento de Browser Run limita 12 por dia e uma chamada a cada 65 segundos',async()=>{
 const {env,DB}=setup();
 try{
  let used=0;
  env.BROWSER={quickAction:async()=>new Response('')};
  const start=1700000000;
  assert.equal(await claimSocialBrowserBudget(env,start),true);used++;
  assert.equal(await claimSocialBrowserBudget(env,start+30),false);
  for(let k=1;k<12;k++){
   assert.equal(await claimSocialBrowserBudget(env,start+k*66),true);
   used++;
  }
  assert.equal(used,12);
  assert.equal(await claimSocialBrowserBudget(env,start+12*66),false);
  assert.equal((await DB.prepare('SELECT daily_count FROM ml_monitor_browser_budget').first()).daily_count,12);
  assert.equal(await claimSocialBrowserBudget(env,start+86400),true);
 }finally{DB.close();}
});
test('Browser Run não captura recomendações se a vitrine não entregar produto destacado',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Promo',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'https://meli.promo/s/TESTFALHA'));
  env.BROWSER={quickAction:async()=>new Response('<html><h2>Você também pode gostar</h2>'+
   '<a href="https://www.mercadolivre.com.br/furadeira-outra/p/MLB99999999">Ir para produto</a></html>',
   {status:200,headers:{'content-type':'text/html'}})};
  globalThis.fetch=async url=>String(url)==='https://meli.promo/s/TESTFALHA'
   ?new Response(null,{status:302,headers:{location:'https://www.mercadolivre.com.br/social/teste'}})
   :new Response('<html>Carregando...</html>',{status:200,headers:{'content-type':'text/html'}});
  const outcome=await resolveMonitorShortlinks(env,{now:1700000000});
  assert.equal(outcome.resolved,0);
  assert.equal(outcome.reviewed,1);
  assert.equal((await monitorState(env)).counts.captured,0);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});


test('meli.promo vitrine com JS captura principal JBL após renderização e ignora sugestões',async()=>{
 const {env,DB}=setup(),oldFetch=globalThis.fetch;
 const short='https://meli.promo/s/WUS7Tq';
 const social='https://www.mercadolivre.com.br/social/gearofertas';
 const jbl='https://www.mercadolivre.com.br/jbl-super-tweeter-st200-preto/p/MLB42162174';
 try{
  await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Gear Ofertas',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event(GROUP,'JBL Super Tweeter ST200 por R$ 105,00 '+short));
  globalThis.fetch=async url=>String(url)===short
   ?new Response(null,{status:302,headers:{location:social}})
   :new Response('<html>Aplicativo carregando</html>',{status:200,headers:{'content-type':'text/html'}});
  let renderCalls=0;
  env.BROWSER={async quickAction(){
   renderCalls++;
   return new Response('<html><div class="rl-card-featured-wrapper">'+
    '<a class="poly-component__link poly-component__link--action-link" href="'+jbl+'">Ir para produto</a>'+
    '</div><section class="rl-card-recommendations">'+
    '<a href="https://www.mercadolivre.com.br/outro/p/MLB99999999">Ir para produto</a></section></html>',
    {headers:{'content-type':'text/html'}});
  }};
  assert.equal((await resolveMonitorShortlinks(env,{now:1700000000})).resolved,1);
  assert.equal(renderCalls,1);
  const state=await monitorState(env);
  assert.equal(state.links[0].source_url,jbl);
  assert.equal(state.links[0].last_seen_price_cents,10500);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});
