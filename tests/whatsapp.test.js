import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import {
  evolutionOrigin,validateGroupJid,validateInstance,ensureWhatsAppTables,
  listWhatsAppGroups,updateWhatsAppSettings,getWhatsAppState,runWhatsAppScheduled,
  connectAffiliateWhatsApp,getAffiliateWhatsAppConnection,AFFILIATE_INSTANCE_NAME
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

test('conexão automática cria somente a instância exclusiva, gera QR e mantém envios desligados',async()=>{
  const DB=dbMock(),env=envFor(DB),calls=[];
  let exists=false;
  try{
    globalThis.fetch=async(url,opts={})=>{
      const address=String(url);calls.push({address,method:opts.method||'GET',body:opts.body});
      if(address===BASE+'/instance/fetchInstances')
        return Response.json(exists?[{name:'outra-instancia',connectionStatus:'open'},{name:AFFILIATE_INSTANCE_NAME,connectionStatus:'connecting'}]:[{name:'outra-instancia',connectionStatus:'open'}]);
      if(address===BASE+'/instance/create'){
        assert.equal(opts.method,'POST');
        assert.deepEqual(JSON.parse(opts.body),{instanceName:AFFILIATE_INSTANCE_NAME,integration:'WHATSAPP-BAILEYS',qrcode:true});
        exists=true;
        return Response.json({instance:{instanceName:AFFILIATE_INSTANCE_NAME,status:'connecting'},hash:{apikey:'INSTANCE_PRIVATE_KEY'},qrcode:{base64:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='}},{status:201});
      }
      if(address===BASE+'/instance/connectionState/'+AFFILIATE_INSTANCE_NAME)
        return Response.json({instance:{instanceName:AFFILIATE_INSTANCE_NAME,state:'connecting'}});
      if(address===BASE+'/instance/connect/'+AFFILIATE_INSTANCE_NAME)
        return Response.json({base64:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='});
      throw new Error('URL inesperada: '+address);
    };
    const before=await getAffiliateWhatsAppConnection(env);
    assert.equal(before.state,'not_created');
    const result=await connectAffiliateWhatsApp(env);
    assert.equal(result.instance_name,AFFILIATE_INSTANCE_NAME);
    assert.equal(result.state,'connecting');
    assert.equal(result.qr_image,'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
    assert.equal(JSON.stringify(result).includes('INSTANCE_PRIVATE_KEY'),false);
    const settings=(await getWhatsAppState(env)).config;
    assert.equal(settings.instance_name,AFFILIATE_INSTANCE_NAME);
    assert.equal(settings.enabled,0);
    assert.equal(settings.public_registered,0);
    const second=await connectAffiliateWhatsApp(env);
    assert.ok(second.qr_image.startsWith('data:image/png;base64,'));
    assert.equal(calls.filter(c=>c.address===BASE+'/instance/create').length,1);
    assert.ok(calls.every(c=>!c.address.includes('/instance/delete')&&!c.address.includes('/instance/logout')));
  }finally{globalThis.fetch=native;DB.close();}
});

test('instância já conectada é reutilizada sem gerar QR nem criar outra',async()=>{
  const DB=dbMock(),env=envFor(DB),calls=[];
  try{
    globalThis.fetch=async(url)=>{
      const s=String(url);calls.push(s);
      if(s===BASE+'/instance/fetchInstances')return Response.json([{name:AFFILIATE_INSTANCE_NAME,connectionStatus:'open'}]);
      if(s===BASE+'/instance/connectionState/'+AFFILIATE_INSTANCE_NAME)return Response.json({instance:{state:'open'}});
      throw new Error('Não deveria chamar '+s);
    };
    const out=await connectAffiliateWhatsApp(env);
    assert.equal(out.state,'open');
    assert.equal(out.qr_image,null);
    assert.deepEqual(calls,[BASE+'/instance/fetchInstances',BASE+'/instance/connectionState/'+AFFILIATE_INSTANCE_NAME]);
  }finally{globalThis.fetch=native;DB.close();}
});

test('não cria instância se a listagem for desconhecida ou se não houver chave global',async()=>{
  const DB=dbMock(),env=envFor(DB);
  try{
    const noKey={...env,EVOLUTION_API_KEY:undefined};
    await assert.rejects(connectAffiliateWhatsApp(noKey),/EVOLUTION_API_KEY/);
    assert.equal((await getAffiliateWhatsAppConnection(noKey)).state,'unconfigured');
    let created=false;
    globalThis.fetch=async(url)=>{
      if(String(url).includes('fetchInstances'))return Response.json({unexpected:'shape'});
      if(String(url).includes('create'))created=true;
      throw new Error('Acesso inesperado');
    };
    await assert.rejects(connectAffiliateWhatsApp(env),/confirmar as instâncias existentes/);
    assert.equal(created,false);
  }finally{globalThis.fetch=native;DB.close();}
});

test('conversor QR consulta connect quando a criação devolve apenas código; nunca expõe a API Key',async()=>{
  const DB=dbMock(),env=envFor(DB),calls=[];
  try{
    globalThis.fetch=async(url,opts={})=>{
      const s=String(url);calls.push(s);
      if(s===BASE+'/instance/fetchInstances')return Response.json([]);
      if(s===BASE+'/instance/create')return Response.json({instance:{instanceName:AFFILIATE_INSTANCE_NAME},qrcode:{code:'2@PRIVATE,SECRET'}});
      if(s===BASE+'/instance/connectionState/'+AFFILIATE_INSTANCE_NAME)return Response.json({instance:{state:'connecting'}});
      if(s===BASE+'/instance/connect/'+AFFILIATE_INSTANCE_NAME)return Response.json({code:'2@PRIVATE,SECRET',base64:'iVBORw0KGgoAAAANSUhEUg=='});
      throw new Error('URL inesperada: '+s);
    };
    const result=await connectAffiliateWhatsApp(env);
    assert.equal(result.qr_image,'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
    assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
    assert.equal(JSON.stringify(result).includes(env.EVOLUTION_API_KEY),false);
    assert.ok(calls.includes(BASE+'/instance/connect/'+AFFILIATE_INSTANCE_NAME));
  }finally{globalThis.fetch=native;DB.close();}
});

test('rota de QR Code só funciona com sessão administrativa e origem válida',async()=>{
  const DB=dbMock(),env=envFor(DB);
  try{
    const url='https://afiliados.example.test/api/whatsapp/auto-connect';
    const headers={'content-type':'application/json',origin:'https://afiliados.example.test'};
    assert.equal((await worker.fetch(new Request(url,{method:'POST',headers,body:'{}'}),env)).status,401);
    const login=await worker.fetch(new Request('https://afiliados.example.test/api/login',{method:'POST',headers,body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const bad=await worker.fetch(new Request(url,{method:'POST',headers:{...headers,origin:'https://malicioso.example.test',cookie},body:'{}'}),env);
    assert.equal(bad.status,403);
    globalThis.fetch=async(url)=>{
      const s=String(url);
      if(s===BASE+'/instance/fetchInstances')return Response.json([{name:AFFILIATE_INSTANCE_NAME}]);
      if(s===BASE+'/instance/connectionState/'+AFFILIATE_INSTANCE_NAME)return Response.json({instance:{state:'open'}});
      throw new Error('Chamada inesperada: '+s);
    };
    const allowed=await worker.fetch(new Request(url,{method:'POST',headers:{...headers,cookie},body:'{}'}),env);
    assert.equal(allowed.status,200);
    assert.equal((await allowed.json()).state,'open');
  }finally{globalThis.fetch=native;DB.close();}
});

test('erro de autenticação menciona a chave global sem expô-la',async()=>{
  const DB=dbMock(),env=envFor(DB);
  try{
    globalThis.fetch=async(url,opts={})=>{
      assert.equal(String(url),BASE+'/instance/fetchInstances');
      assert.equal(opts.headers.apikey,env.EVOLUTION_API_KEY);
      return Response.json({message:'Unauthorized'},{status:401});
    };
    await assert.rejects(connectAffiliateWhatsApp(env),error=>{
      assert.match(error.message,/HTTP 401/);
      assert.match(error.message,/fetchInstances/);
      assert.match(error.message,/API Key GLOBAL/);
      assert.doesNotMatch(error.message,/TEST_KEY_NEVER_REAL/);
      return true;
    });
  }finally{globalThis.fetch=native;DB.close();}
});


test('intervalo exclusivo do WhatsApp controla os envios sem mudar o Telegram',async()=>{
  const DB=dbMock(),env=envFor(DB),calls=[];
  try{
    mockFetch((url,opts)=>{
      if(url.startsWith('https://meli.la/'))
        return new Response('<html></html>',{headers:{'content-type':'text/html'}});
      if(url===BASE+'/message/sendText/'+INSTANCE){
        const msg=JSON.parse(opts.body);
        assert.equal(msg.number,GROUP);
        calls.push(msg);
        return Response.json({key:{id:'MSG_'+calls.length}});
      }
      throw new Error('Unexpected URL '+url);
    });
    DB.prepare('UPDATE settings SET interval_minutes=15 WHERE id=1').run();
    await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,interval_minutes:120});
    const active=await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:true,enabled:true,interval_minutes:120});
    assert.equal(active.interval_minutes,120);
    assert.equal((await getWhatsAppState(env)).schedule.interval_minutes,120);
    const now=Math.floor(Date.now()/1000);
    for (let i=0;i<2;i++)
      DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,published_at) VALUES(?,?,?,?,?,?)")
        .bind('Produto de teste '+i+' para WhatsApp', 'https://meli.la/2bsHW5'+(i?'z':'y'),'Geral',now,'published',now+2+i).run();
    assert.equal((await runWhatsAppScheduled(env)).status,'sent');
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'interval'});
    assert.equal(calls.length,1);
    assert.ok((await getWhatsAppState(env)).schedule.last_attempt_at>0);
    DB.prepare('UPDATE whatsapp_schedule_custom SET last_attempt_at=? WHERE id=1').bind(now-121*60).run();
    DB.prepare('UPDATE whatsapp_instance_pacing SET last_attempt_at=? WHERE instance_name=?').bind(now-121*60,INSTANCE).run();
    assert.equal((await runWhatsAppScheduled(env)).status,'sent');
    assert.equal(calls.length,2);
    assert.equal(DB.prepare('SELECT interval_minutes FROM settings WHERE id=1').first().interval_minutes,15);
    assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM whatsapp_deliveries WHERE status='sent'").first().total,2);
  }finally{globalThis.fetch=native;DB.close();}
});

test('intervalo inválido é rejeitado sem alterar a configuração existente',async()=>{
  const DB=dbMock(),env=envFor(DB);
  try{
    const state=await getWhatsAppState(env);
    assert.equal(state.schedule.interval_minutes,60);
    for(const interval_minutes of [0,-1,1441,2.5,'',null,NaN])
      await assert.rejects(updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,interval_minutes}),/Intervalo do WhatsApp inválido/);
    for(const interval_minutes of [1,5,7,10,20,31,999,1440]) {
      const out=await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,interval_minutes});
      assert.equal(out.interval_minutes,interval_minutes);
      assert.equal((await getWhatsAppState(env)).schedule.interval_minutes,interval_minutes);
    }
    assert.equal((await getWhatsAppState(env)).schedule.interval_minutes,1440);
    assert.equal((await getWhatsAppState(env)).config.enabled,0);
  }finally{DB.close();}
});

test('intervalo persiste após salvar e reinicializar tabelas, sem recriar o banco',async()=>{
  const DB=dbMock(),env=envFor(DB);
  try{
    await getWhatsAppState(env);
    await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,interval_minutes:240});
    await ensureWhatsAppTables(env);
    assert.equal((await getWhatsAppState(env)).schedule.interval_minutes,240);
    // Requisição de painel antigo sem intervalo não apaga a preferência nova.
    await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false});
    assert.equal((await getWhatsAppState(env)).schedule.interval_minutes,240);
  }finally{DB.close();}
});


test('migração incremental preserva intervalo e relógio antigo sem alterar a tabela legada',async()=>{
  const DB=dbMock(),env=envFor(DB);
  try {
    DB.prepare("CREATE TABLE whatsapp_schedule (id INTEGER PRIMARY KEY CHECK(id=1), interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes IN (15,30,60,120,180,240,360)), last_attempt_at INTEGER NOT NULL DEFAULT 0)").run();
    DB.prepare("INSERT INTO whatsapp_schedule(id,interval_minutes,last_attempt_at) VALUES(1,120,123456)").run();
    const first=await getWhatsAppState(env);
    assert.equal(first.schedule.interval_minutes,120);
    assert.equal(first.schedule.last_attempt_at,123456);
    const changed=await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,interval_minutes:20});
    assert.equal(changed.interval_minutes,20);
    assert.equal((await getWhatsAppState(env)).schedule.interval_minutes,20);
    assert.equal(DB.prepare('SELECT interval_minutes,last_attempt_at FROM whatsapp_schedule WHERE id=1').first().interval_minutes,120);
    await ensureWhatsAppTables(env);
    assert.equal((await getWhatsAppState(env)).schedule.interval_minutes,20);
  }finally{DB.close();}
});

test('intervalo arbitrário do WhatsApp de 7 minutos é respeitado entre duas ofertas',async()=>{
  const DB=dbMock(),env=envFor(DB),sent=[];
  try {
    mockFetch((url,opts)=>{
      if(url.startsWith('https://meli.la/')) return new Response('<html></html>',{headers:{'content-type':'text/html'}});
      if(url===BASE+'/message/sendText/'+INSTANCE){
        sent.push(JSON.parse(opts.body));
        return Response.json({key:{id:'CUSTOM_'+sent.length}});
      }
      throw Error('Unexpected '+url);
    });
    await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:false,enabled:false,interval_minutes:7});
    await updateWhatsAppSettings(env,{instance_name:INSTANCE,group_jid:GROUP,public_registered:true,enabled:true,interval_minutes:7});
    const now=Math.floor(Date.now()/1000);
    for(let i=0;i<2;i++)DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,published_at) VALUES(?,?,?,?,?,?)")
       .bind('Oferta customizada '+i,'https://meli.la/2bsHW'+(i?'5z':'5y'),'Geral',now,'published',now+2+i).run();
    assert.equal((await runWhatsAppScheduled(env)).status,'sent');
    DB.prepare('UPDATE whatsapp_schedule_custom SET last_attempt_at=? WHERE id=1').bind(now-6*60).run();
    assert.deepEqual(await runWhatsAppScheduled(env),{skipped:'interval'});
    DB.prepare('UPDATE whatsapp_schedule_custom SET last_attempt_at=? WHERE id=1').bind(now-8*60).run();
    DB.prepare('UPDATE whatsapp_instance_pacing SET last_attempt_at=? WHERE instance_name=?').bind(now-8*60,INSTANCE).run();
    assert.equal((await runWhatsAppScheduled(env)).status,'sent');
    assert.equal(sent.length,2);
  }finally{globalThis.fetch=native;DB.close();}
});
