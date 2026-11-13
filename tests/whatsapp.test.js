import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import {
  evolutionOrigin,validateGroupJid,validateInstance,ensureWhatsAppTables,
  listWhatsAppGroups,updateWhatsAppSettings,getWhatsAppState,runWhatsAppScheduled
} from '../src/whatsapp.js';

function dbMock(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url),'utf8'));
  return {
    prepare(sql){
      let params=[];
      return {
        bind(...p){params=p;return this;},
        first(){return db.prepare(sql).get(...params)||null;},
        all(){return {results:db.prepare(sql).all(...params)};},
        run(){const r=db.prepare(sql).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
      };
    },
    close(){db.close();}
  };
}
const BASE='https://evo.example.com';
const INSTANCE='afiliados';
const GROUP='120363888999777@g.us';
const envFor=DB=>({DB,ADMIN_PASSWORD:'secret for test 123456',SESSION_SECRET:'session secret for test 123456',EVOLUTION_API_URL:BASE,EVOLUTION_API_KEY:'TEST_KEY_NEVER_REAL'});
const groupsResponse=[{id:GROUP,subject:'Achadinhos Mercado Livre'},{id:'123@s.whatsapp.net',subject:'Contato privado'}];
const native=globalThis.fetch;
function mockFetch(handlers){
  const calls=[];
  globalThis.fetch=async(url,options={})=>{
    const s=String(url);calls.push({url:s,options});
    if(s===BASE+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false') return new Response(JSON.stringify(groupsResponse),{status:200,headers:{'content-type':'application/json'}});
    if(handlers) return handlers(s,options);
    throw new Error('Requisição inesperada: '+s);
  };
  return calls;
}
test('Evolution valida apenas URL HTTPS segura, instância conhecida e ID de grupo',()=>{
  assert.equal(evolutionOrigin('https://evo.example.com/'),BASE);
  for(const u of ['http://evo.example.com','https://127.0.0.1','https://localhost','https://evo.example.com:8443','https://evo.example.com/a','https://user:pw@evo.example.com']) assert.throws(()=>evolutionOrigin(u));
  assert.equal(validateGroupJid(GROUP),GROUP);
  for(const jid of ['5511987654321','5511987654321@s.whatsapp.net','https://chat.whatsapp.com/INVITE','bad@g.us']) assert.throws(()=>validateGroupJid(jid));
  assert.equal(validateInstance(INSTANCE),INSTANCE);
  assert.throws(()=>validateInstance('../internal'));
});

test('WhatsApp fica desligado por padrão e lista somente grupos da instância',async()=>{
  const DB=dbMock();
  try {
    const env=envFor(DB);
    const state=await getWhatsAppState(env);
    assert.equal(state.config.enabled,0);
    assert.equal(state.config.public_registered,0);
    assert.equal(state.server_configured,true);
    const calls=mockFetch();
    const found=await listWhatsAppGroups(env,INSTANCE);
    assert.deepEqual(found,[{id:GROUP,name:'Achadinhos Mercado Livre'}]);
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,BASE+'/group/fetchAllGroups/'+INSTANCE+'?getParticipants=false');
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'disabled'});
  }finally{globalThis.fetch=native;DB.close();}
});

test('configurar grupo exige reconfirmação e não envia mensagens antigas',async()=>{
  const DB=dbMock();const env=envFor(DB);
  try{
    mockFetch();
    const first=await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:true,enabled:true});
    assert.equal(first.group_changed,true);
    assert.equal(first.enabled,false);
    assert.equal((await getWhatsAppState(env)).config.public_registered,0);
    const second=await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:true,enabled:true});
    assert.equal(second.enabled,true);
    const state=await getWhatsAppState(env);
    assert.equal(state.config.enabled,1);
    assert.equal(state.config.public_registered,1);
    assert.ok(state.config.started_at>0);
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
    await assert.rejects(updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:'120363000000000@g.us',public_registered:true,enabled:true}),/não localizado/);
  }finally{globalThis.fetch=native;DB.close();}
});

test('envia foto da oferta ao grupo após publicação no Telegram e evita repetição',async()=>{
  const DB=dbMock();const env=envFor(DB);const sent=[];
  try{
    mockFetch((url,opts)=>{
      if(url==='https://meli.la/2bsHW5y')return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_999-MLB123-P.webp">',{headers:{'content-type':'text/html'}});
      if(url==='https://http2.mlstatic.com/D_NQ_NP_999-MLB123-F.jpg')return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'800000'}});
      if(url===BASE+'/message/sendMedia/'+INSTANCE){
        const body=JSON.parse(opts.body);
        assert.equal(body.number,GROUP);
        assert.equal(body.mediatype,'image');
        assert.equal(body.media,'https://http2.mlstatic.com/D_NQ_NP_999-MLB123-F.jpg');
        assert.match(body.caption,/https:\/\/meli\.la\/2bsHW5y/);
        assert.match(body.caption,/Publicidade/);
        sent.push(body);
        return new Response(JSON.stringify({key:{id:'MSG12345'}}),{status:201});
      }
      throw new Error('URL inesperada '+url);
    });
    await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false});
    await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:true,enabled:true});
    const now=Math.floor(Date.now()/1000);
    DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,published_at) VALUES(?,?,?,?,?,?)")
      .bind('Produto de teste com fotografia','https://meli.la/2bsHW5y','Geral',now,'published',now+2).run();
    assert.equal((await runWhatsAppScheduled(env)).status,'sent');
    assert.equal(sent.length,1);
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
    const state=await getWhatsAppState(env);
    assert.equal(state.deliveries[0].status,'sent');
    assert.equal(state.deliveries[0].message_id,undefined);
  }finally{globalThis.fetch=native;DB.close();}
});

test('falha ambígua fica em revisão sem reenviar automaticamente',async()=>{
  const DB=dbMock();const env=envFor(DB);const sent=[];
  try{
    mockFetch((url,opts)=>{
      if(url==='https://meli.la/2bsHW5y')return new Response('<html></html>',{headers:{'content-type':'text/html'}});
      if(url===BASE+'/message/sendText/'+INSTANCE){
        sent.push(JSON.parse(opts.body));
        return new Response(JSON.stringify({status:'PENDING'}),{status:200});
      }
      throw new Error('URL inesperada '+url);
    });
    await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false});
    await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:true,enabled:true});
    const now=Math.floor(Date.now()/1000);
    DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,published_at) VALUES(?,?,?,?,?,?)")
      .bind('Produto de teste sem fotografia','https://meli.la/2bsHW5y','Geral',now,'published',now+2).run();
    const result=await runWhatsAppScheduled(env);
    assert.equal(result.status,'needs_review');
    assert.equal(sent.length,1);
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'empty'});
    assert.equal((await getWhatsAppState(env)).deliveries[0].status,'needs_review');
  }finally{globalThis.fetch=native;DB.close();}
});

test('API de WhatsApp exige sessão administrativa para consultar grupos e alterar configuração',async()=>{
  const DB=dbMock();const env=envFor(DB);
  try{
    assert.equal((await worker.fetch(new Request('https://afiliados.example.test/api/whatsapp/state'),env)).status,401);
    assert.equal((await worker.fetch(new Request('https://afiliados.example.test/api/whatsapp/groups?instance=afiliados'),env)).status,401);
    const login=await worker.fetch(new Request('https://afiliados.example.test/api/login',{method:'POST',headers:{origin:'https://afiliados.example.test','content-type':'application/json'},body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const state=await worker.fetch(new Request('https://afiliados.example.test/api/whatsapp/state',{headers:{cookie}}),env);
    assert.equal(state.status,200);
    assert.equal((await state.json()).config.enabled,0);
  }finally{globalThis.fetch=native;DB.close();}
});
