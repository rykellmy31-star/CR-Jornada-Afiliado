import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { getPrimaryCategory,savePrimaryCategory,categoryMatches } from '../src/multichannel.js';
import { ensureWhatsAppTables,getWhatsAppState,updateWhatsAppSettings,runWhatsAppScheduled } from '../src/whatsapp.js';
import { listManagedWhatsAppGroups,createManagedWhatsAppGroup,getManagedWhatsAppGroupState,
  saveManagedWhatsAppGroup,addManagedWhatsAppOffer,saveManagedWhatsAppCoupon,
  managedWhatsAppConnection,runManagedWhatsAppScheduled } from '../src/whatsapp-groups.js';
import { CLIENT_JS,renderPage } from '../src/ui.js';

const ORIGIN='https://afiliados.example.test';
const WA_URL='https://evo.example.com';
const GROUP_MOTO='120363888999777@g.us';
const GROUP_FEM='120363888999778@g.us';
const SECRET='ADMIN_TEST_SECRET_KEY_2026_IS_NOT_REAL';
const ownFetch=globalThis.fetch;
function dbMock(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 return {
   prepare(sql){
     let params=[];
     return {
       bind(...p){params=p;return this;},
       first(){return db.prepare(sql).get(...params)||null;},
       all(){return {results:db.prepare(sql).all(...params)};},
       run(){const x=db.prepare(sql).run(...params);return {meta:{changes:Number(x.changes),last_row_id:Number(x.lastInsertRowid)}};}
     };
   },close(){db.close();}
 };
}
const envFor=DB=>({DB,SESSION_SECRET:'SESSION_SECRET_STRONG_FOR_MULTIGROUP_TEST',ADMIN_PASSWORD:'ADMIN_PASSWORD_FOR_TEST',
  EVOLUTION_API_URL:WA_URL,EVOLUTION_API_KEY:SECRET,TELEGRAM_BOT_TOKEN:'FAKE_TELEGRAM_BOT_TOKEN'});
const ad=(link,category)=>({title:'Oferta de teste para categoria '+category,affiliate_url:link,category,owner_confirmation:true});
const options={interval_minutes:7,max_daily:10,start_hour:0,end_hour:24};
async function newGroup(env,name,category,mode='shared'){
 const item=await createManagedWhatsAppGroup(env,{name,category,instance_mode:mode});
 return item.id;
}
async function activate(env,id,group,name,category){
 const payload={name,category,group_jid:group,enabled:false,public_registered:false,...options};
 const first=await saveManagedWhatsAppGroup(env,id,payload);
 assert.equal(first.group_changed,true);
 const second=await saveManagedWhatsAppGroup(env,id,{...payload,enabled:true,public_registered:true});
 assert.equal(second.enabled,true);
}
function mockEvolution(sent=[]){
 globalThis.fetch=async(url,init={})=>{
   const s=String(url);
   if(s===WA_URL+'/group/fetchAllGroups/cr-jornada-afiliados?getParticipants=false')
     return Response.json([{id:GROUP_MOTO,subject:'Motos & Peças'},{id:GROUP_FEM,subject:'Moda Feminina'}]);
   if(s.startsWith('https://meli.la/'))return new Response('<html></html>',{headers:{'content-type':'text/html'}});
   if(s===WA_URL+'/message/sendText/cr-jornada-afiliados'){
     const body=JSON.parse(init.body);
     sent.push(body);
     return Response.json({key:{id:'WA_'+sent.length}});
   }
   throw Error('Unexpected URL '+s);
 };
}
test('configurações existentes do grupo principal do WhatsApp são preservadas',async()=>{
 const DB=dbMock(),env=envFor(DB);
 try{
   await ensureWhatsAppTables(env);
   DB.prepare("UPDATE whatsapp_settings SET instance_name=?,group_jid=?,enabled=1,public_registered=1 WHERE id=1")
     .bind('cr-jornada-afiliados',GROUP_MOTO).run();
   DB.prepare('UPDATE whatsapp_schedule_custom SET interval_minutes=20 WHERE id=1').run();
   DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,published_at) VALUES(?,?,?,?,?,?)")
     .bind('Produto existente','https://meli.la/AbCde9','Geral',100000,'published',1700000000).run();
   const results=await listManagedWhatsAppGroups(env);
   assert.equal(results[0].id,1);
   assert.equal(results[0].group_jid,GROUP_MOTO);
   assert.equal(results[0].enabled,1);
   assert.equal((await getWhatsAppState(env)).schedule.interval_minutes,20);
   assert.equal(DB.prepare("SELECT COUNT(*) total FROM offers").first().total,1);
   assert.equal((await getWhatsAppState(env)).category,'Geral');
 }finally{DB.close();}
});
test('cria vários grupos no mesmo número, categorias e filas independentes',async()=>{
 const DB=dbMock(),env=envFor(DB);
 try{
   const moto=await newGroup(env,'Grupo de Motos','Motos');
   const feminino=await newGroup(env,'Grupo de Mulheres','Feminino');
   assert.deepEqual([moto,feminino],[2,3]);
   const groups=await listManagedWhatsAppGroups(env);
   assert.deepEqual(groups.map(x=>x.id),[1,2,3]);
   assert.equal(groups[1].instance_name,'cr-jornada-afiliados');
   assert.equal(groups[2].instance_name,'cr-jornada-afiliados');
   assert.equal(groups[1].enabled,0);
   await addManagedWhatsAppOffer(env,moto,ad('https://meli.la/AbCde1','Motos'));
   await addManagedWhatsAppOffer(env,feminino,ad('https://meli.la/AbCde2','Feminino'));
   assert.equal((await getManagedWhatsAppGroupState(env,moto)).offers[0].category,'Motos');
   assert.equal((await getManagedWhatsAppGroupState(env,feminino)).offers[0].category,'Feminino');
   await assert.rejects(addManagedWhatsAppOffer(env,moto,ad('https://meli.la/AbCde3','Infantil')),/somente a categoria/);
   await assert.rejects(addManagedWhatsAppOffer(env,feminino,ad('https://meli.la/AbCde1','Feminino')),/já pertence a um grupo/);
   assert.equal(DB.prepare('SELECT COUNT(*) total FROM offers').first().total,0);
 }finally{DB.close();}
});
test('grupo selecionado deve pertencer à instância e a ativação exige reconfirmação',async()=>{
 const DB=dbMock(),env=envFor(DB);
 try{
   mockEvolution();
   const id=await newGroup(env,'Grupo de Peças','Peças');
   const payload={name:'Grupo de Peças',category:'Peças',group_jid:GROUP_MOTO,
     enabled:true,public_registered:true,...options};
   const first=await saveManagedWhatsAppGroup(env,id,payload);
   assert.equal(first.enabled,false);
   assert.equal((await getManagedWhatsAppGroupState(env,id)).group.public_registered,0);
   const second=await saveManagedWhatsAppGroup(env,id,payload);
   assert.equal(second.enabled,true);
   const actual=(await getManagedWhatsAppGroupState(env,id)).group;
   assert.equal(actual.enabled,1);
   assert.equal(actual.public_registered,1);
   await assert.rejects(saveManagedWhatsAppGroup(env,id,{...payload,group_jid:'120363999999999@g.us'}),/não está conectado/);
 }finally{globalThis.fetch=ownFetch;DB.close();}
});
test('grupo não pode reutilizar o mesmo destino de outro grupo na mesma instância',async()=>{
 const DB=dbMock(),env=envFor(DB);
 try{
   const a=await newGroup(env,'Grupo Infantil','Infantil');
   const b=await newGroup(env,'Grupo Peças','Peças');
   await saveManagedWhatsAppGroup(env,a,{name:'Grupo Infantil',category:'Infantil',group_jid:GROUP_MOTO,
     enabled:false,public_registered:false,...options});
   await assert.rejects(saveManagedWhatsAppGroup(env,b,{name:'Grupo Peças',category:'Peças',group_jid:GROUP_MOTO,
     enabled:false,public_registered:false,...options}),/já está configurado/);
 }finally{DB.close();}
});
test('agendador envia ofertas por categoria ao grupo correto e respeita intervalo/número',async()=>{
 const DB=dbMock(),env=envFor(DB),sent=[];
 try{
   mockEvolution(sent);
   const moto=await newGroup(env,'Moto Acessórios','Motos');
   const mulher=await newGroup(env,'Moda Feminina','Feminino');
   await activate(env,moto,GROUP_MOTO,'Moto Acessórios','Motos');
   await activate(env,mulher,GROUP_FEM,'Moda Feminina','Feminino');
   await addManagedWhatsAppOffer(env,moto,ad('https://meli.la/AbCde1','Motos'));
   await addManagedWhatsAppOffer(env,moto,ad('https://meli.la/AbCde3','Motos'));
   await addManagedWhatsAppOffer(env,mulher,ad('https://meli.la/AbCde2','Feminino'));
   const first=await runManagedWhatsAppScheduled(env);
   assert.equal(first.results.length,1);
   assert.equal(sent[0].number,GROUP_MOTO);
   assert.equal(sent[0].text.includes('https://meli.la/AbCde1'),true);
   assert.deepEqual((await runManagedWhatsAppScheduled(env)).results,[]);
   const stamp=Math.floor(Date.now()/1000);
   DB.prepare('UPDATE whatsapp_instance_pacing SET last_attempt_at=? WHERE instance_name=?').bind(stamp-65,'cr-jornada-afiliados').run();
   const second=await runManagedWhatsAppScheduled(env);
   assert.equal(second.results.length,1);
   assert.equal(sent[1].number,GROUP_FEM);
   assert.equal(sent[1].text.includes('https://meli.la/AbCde2'),true);
   assert.equal((await getManagedWhatsAppGroupState(env,moto)).counts.find(x=>x.status==='published').total,1);
   assert.equal((await getManagedWhatsAppGroupState(env,mulher)).counts.find(x=>x.status==='published').total,1);
   assert.equal((await runManagedWhatsAppScheduled(env)).results.length,0);
   assert.equal(sent.length,2);
 }finally{globalThis.fetch=ownFetch;DB.close();}
});
test('mudar categoria não permite misturar ofertas pendentes',async()=>{
 const DB=dbMock(),env=envFor(DB);
 try{
   const id=await newGroup(env,'Moto Peças','Motos');
   await addManagedWhatsAppOffer(env,id,ad('https://meli.la/AbCde1','Motos'));
   await assert.rejects(saveManagedWhatsAppGroup(env,id,{name:'Moto Peças',category:'Infantil',
     group_jid:'',enabled:false,public_registered:false,...options}),/ofertas pendentes/);
   assert.equal((await getManagedWhatsAppGroupState(env,id)).group.category,'Motos');
 }finally{DB.close();}
});
test('número exclusivo usa instância isolada e gera QR sem tocar em outras instâncias',async()=>{
 const DB=dbMock(),env=envFor(DB),calls=[];
 try{
   const id=await newGroup(env,'Brinquedos Infantil','Infantil','dedicated');
   const name='cr-jornada-grupo-'+id;
   assert.equal((await getManagedWhatsAppGroupState(env,id)).group.instance_name,name);
   globalThis.fetch=async(url,opts={})=>{
     const s=String(url);calls.push(s);
     if(s===WA_URL+'/instance/fetchInstances')
       return Response.json(calls.filter(x=>x.endsWith('/instance/create')).length
         ?[{name:'outra-instancia'},{name,connectionStatus:'connecting'}]
         :[{name:'outra-instancia'}]);
     if(s===WA_URL+'/instance/create'){
       assert.equal(opts.method,'POST');
       assert.equal(JSON.parse(opts.body).instanceName,name);
       return Response.json({instance:{instanceName:name},qrcode:{base64:'iVBORw0KGgoAAAANSUhEUg=='}});
     }
     if(s===WA_URL+'/instance/connectionState/'+name)
       return Response.json({instance:{state:'connecting'}});
     if(s===WA_URL+'/instance/connect/'+name)
       return Response.json({base64:'iVBORw0KGgoAAAANSUhEUg=='});
     throw Error('Unexpected '+s);
   };
   const first=await managedWhatsAppConnection(env,id,true);
   assert.equal(first.instance_name,name);
   assert.match(first.qr_image,/^data:image\/png;base64,/);
   assert.equal(calls.filter(x=>x.endsWith('/instance/create')).length,1);
   const again=await managedWhatsAppConnection(env,id,true);
   assert.equal(again.exists,true);
   assert.equal(calls.filter(x=>x.endsWith('/instance/create')).length,1);
   assert.ok(!calls.some(x=>/delete|logout/.test(x)));
 }finally{globalThis.fetch=ownFetch;DB.close();}
});
test('categoria do Telegram principal e WhatsApp principal tem filtros próprios sem apagar histórico',async()=>{
 const DB=dbMock(),env=envFor(DB),sent=[];
 try{
   assert.equal(await getPrimaryCategory(env),'Geral');
   await savePrimaryCategory(env,'Motos');
   assert.equal(await getPrimaryCategory(env),'Motos');
   assert.equal(categoryMatches('motos','Motos'),true);
   assert.equal(categoryMatches('Infantil','Motos'),false);
   await ensureWhatsAppTables(env);
   DB.prepare("UPDATE whatsapp_settings SET instance_name=?,group_jid=?,enabled=1,public_registered=1,started_at=1 WHERE id=1")
     .bind('cr-jornada-afiliados',GROUP_MOTO).run();
   mockEvolution(sent);
   await updateWhatsAppSettings(env,{instance_name:'cr-jornada-afiliados',group_jid:GROUP_MOTO,
     enabled:true,public_registered:true,interval_minutes:7,category:'Peças'});
   assert.equal((await getWhatsAppState(env)).category,'Peças');
   const now=Math.floor(Date.now()/1000);
   for(const [category,url] of [['Motos','https://meli.la/AbCde1'],['Peças','https://meli.la/AbCde2']])
     DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,published_at) VALUES(?,?,?,?,?,?)")
       .bind('Produto de categoria '+category,url,category,now,'published',now+2).run();
   const result=await runWhatsAppScheduled(env);
   assert.equal(result.status,'sent');
   assert.equal(sent.length,1);
   assert.match(sent[0].text,/https:\/\/meli\.la\/AbCde2/);
 }finally{globalThis.fetch=ownFetch;DB.close();}
});
test('cupom e histórico do grupo ficam separados da integração existente',async()=>{
 const DB=dbMock(),env=envFor(DB);
 try{
   const id=await newGroup(env,'Grupo Motos','Motos');
   await addManagedWhatsAppOffer(env,id,ad('https://meli.la/AbCde1','Motos'));
   const offer=(await getManagedWhatsAppGroupState(env,id)).offers[0];
   const coupon={offer_id:offer.id,kind:'code',code:'MOTO10',discount_type:'percent',
     discount_value:10,start_day:'2026-11-01',end_day:'2026-11-30',
     source_url:'https://www.mercadolivre.com.br/promocoes',owner_confirmation:true};
   await saveManagedWhatsAppCoupon(env,id,coupon);
   assert.equal((await getManagedWhatsAppGroupState(env,id)).offers[0].coupon_code,'MOTO10');
   assert.equal(DB.prepare('SELECT COUNT(*) total FROM offers').first().total,0);
   assert.equal(DB.prepare('SELECT COUNT(*) total FROM whatsapp_group_logs').first().total,3);
 }finally{DB.close();}
});
test('API de grupos exige login e mesma origem para todas alterações',async()=>{
 const DB=dbMock(),env=envFor(DB),headers={'content-type':'application/json',origin:ORIGIN};
 try{
   const unauth=await worker.fetch(new Request(ORIGIN+'/api/wa-groups'),env);
   assert.equal(unauth.status,401);
   const login=await worker.fetch(new Request(ORIGIN+'/api/login',{method:'POST',headers,body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env);
   assert.equal(login.status,200);
   const cookie=login.headers.get('set-cookie').split(';')[0];
   const create=await worker.fetch(new Request(ORIGIN+'/api/wa-groups',{method:'POST',headers:{...headers,cookie},
     body:JSON.stringify({name:'Grupo de Motos',category:'Motos',instance_mode:'shared'})}),env);
   assert.equal(create.status,201);
   const id=(await create.json()).id;
   const list=await worker.fetch(new Request(ORIGIN+'/api/wa-groups',{headers:{cookie}}),env);
   assert.equal(list.status,200);
   assert.deepEqual((await list.json()).groups.map(g=>g.id),[1,id]);
   const unauthorized=await worker.fetch(new Request(ORIGIN+'/api/wa-groups/'+id+'/settings',{
     method:'POST',headers:{...headers,origin:'https://evil.example.test',cookie},
     body:JSON.stringify({name:'Grupo de Motos',category:'Motos',group_jid:'',public_registered:false,enabled:false,...options})
   }),env);
   assert.equal(unauthorized.status,403);
 }finally{DB.close();}
});
test('painel contém todos os controles necessários e JavaScript válido',()=>{
 const html=renderPage();
 for(const id of ['wa-multichannel','wa-multi-select','wa-multi-create-form','wa-multi-settings-form',
   'wa-multi-category','wa-multi-connect','wa-multi-qr-image','wa-multi-jid','wa-multi-interval',
   'wa-multi-offer-form','wa-multi-coupon-form','wa-multi-offers','primary-channel-category','wa-category'])
   assert.ok(html.includes('id="'+id+'"'),'Campo ausente: '+id);
 assert.doesNotThrow(()=>new Function(CLIENT_JS));
 assert.match(CLIENT_JS,/\/api\/wa-groups/);
});
