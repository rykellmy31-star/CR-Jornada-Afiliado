import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {ensureMonitor,addMonitorGroup,monitorState,saveMonitorSettings} from '../src/whatsapp-link-monitor.js';
import {deriveMonitorWebhookToken,installMonitorWebhook,monitorWebhookReady} from '../src/monitor-webhook-setup.js';
import {CLIENT_JS,renderPage} from '../src/ui.js';

const INSTANCE='cr-jornada-afiliados';
const GROUP='120363000111222333@g.us';
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){
  let args=[];
  return {bind(...values){args=values;return this;},
    first(){return db.prepare(sql).get(...args)||null;},
    all(){return {results:db.prepare(sql).all(...args)};},
    run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}}
 }};
 return {db,env:{DB,SESSION_SECRET:'secret_for_hook_auth_at_least_32_bytes_long',ADMIN_PASSWORD:'a test password',
  EVOLUTION_API_URL:'https://evolution.crjornada.com',EVOLUTION_API_KEY:'fake-global-key'}};
}
async function group(env){
 await ensureMonitor(env);
 await addMonitorGroup(env,{instance_name:INSTANCE,group_jid:GROUP,group_name:'Grupo de testes autorizado',permission_confirmed:true});
}
test('aba COPIAR DE GRUPOS atualiza os contadores e permite configurar recepção sem ir à Conversão',()=>{
 const html=renderPage();
 assert.match(html,/id="ml-monitor-install"/);
 assert.match(CLIENT_JS,/selectedPage!=='copygroups'/);
 assert.match(CLIENT_JS,/\/api\/monitor\/webhook\/install/);
});
test('configuração automática consulta webhook existente e jamais sobrescreve integração de outra aplicação',async()=>{
 const {db,env}=setup();
 try{
  await group(env);
  let calls=0;
  const fetcher=async()=>{calls++;return new Response(JSON.stringify({enabled:true,url:'https://outro-sistema.exemplo/hook',events:['MESSAGES_UPSERT']}),{status:200});};
  await assert.rejects(installMonitorWebhook(env,{instance_name:INSTANCE},{fetcher}),/não substituí essa integração/i);
  assert.equal(calls,1);
  assert.equal(await monitorWebhookReady(env),false);
  assert.equal((await monitorState(env)).webhook_secret_configured,false);
  await assert.rejects(saveMonitorSettings(env,{enabled:true}),/Configurar recepção/);
 }finally{db.close();}
});
test('configura Evolution com HMAC, confirma, liga monitor e ingere evento só com token correto',async()=>{
 const {db,env}=setup();
 try{
  await group(env);
  const state={enabled:false,url:'',events:[]};const calls=[];
  const fetcher=async(url,options)=>{
   calls.push({url,method:options.method});
   if(options.method==='POST'){
    const body=JSON.parse(options.body);
    assert.deepEqual(body.events,['MESSAGES_UPSERT']);
    assert.equal(body.enabled,true);
    assert.equal(body.webhookBase64,false);
    Object.assign(state,{url:body.url,enabled:true,events:body.events,webhookByEvents:false});
    return new Response(JSON.stringify({webhook:{webhook:state}}),{status:201});
   }
   return new Response(JSON.stringify({webhook:state}),{status:200});
  };
  const config=await installMonitorWebhook(env,{instance_name:INSTANCE},{fetcher});
  assert.equal(config.webhook_verified,true);
  assert.equal(calls.length,3);
  assert.match(state.url,/^https:\/\/bot\.crjornada\.com\/hooks\/wa-links\/auto\/cr-jornada-afiliados\/[A-Za-z0-9_-]{43}$/);
  assert.equal(await monitorWebhookReady(env),true);
  assert.equal((await monitorState(env)).webhook_secret_configured,true);
  await saveMonitorSettings(env,{enabled:true});
  const token=await deriveMonitorWebhookToken(env,INSTANCE);
  const wrong=await worker.fetch(new Request('https://bot.crjornada.com/hooks/wa-links/auto/'+INSTANCE+'/'+'A'.repeat(43),{
   method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'messages.upsert',instance:INSTANCE,data:{}})}),env);
  assert.equal(wrong.status,404);
  const result=await worker.fetch(new Request(state.url,{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({event:'messages.upsert',instance:INSTANCE,
    data:{key:{remoteJid:GROUP,fromMe:false,id:'msg-123'},
      message:{conversation:'Oferta https://www.mercadolivre.com.br/furadeira-impacto/p/MLB12345678'}}})
  }),env);
  assert.equal(result.status,200,await result.text().catch(()=>undefined));
  const updated=await monitorState(env);
  assert.equal(updated.enabled,true);
  assert.equal(updated.groups[0].delivery.received_messages,1);
  assert.equal(updated.counts.captured,1);
  assert.equal((await deriveMonitorWebhookToken(env,INSTANCE)),token);
 }finally{db.close();}
});
