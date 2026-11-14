import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {CLIENT_JS,renderPage} from '../src/ui.js';
import {getShopeeAccount,saveShopeeProfile,saveShopeeCredentials,verifyShopeeApi,clearShopeeCredentials}
  from '../src/shopee-account.js';

const ORIGIN='https://afiliados.example.test';
const API='https://open-api.affiliate.shopee.com.br/graphql';
const rawSecret='SHOPEE_APP_API_SECRET_FOR_TEST_1234567890';
const realFetch=globalThis.fetch;
function database(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 return {
   prepare(sql){
     let values=[];
     return {
       bind(...v){values=v;return this;},
       first(){return sqlite.prepare(sql).get(...values)||null;},
       all(){return {results:sqlite.prepare(sql).all(...values)};},
       run(){const r=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
     };
   },close(){sqlite.close();}
 };
}
const envFor=DB=>({
 DB,ADMIN_PASSWORD:'SHOPEE_ACCOUNT_ADMIN_TEST_PASSWORD',
 SESSION_SECRET:'SHOPEE_ACCOUNT_TEST_ENCRYPTION_SECRET_LONG'
});

test('Shopee começa sem conta ou API, sem tocar perfil e tabelas Mercado Livre',async()=>{
 const DB=database(),env=envFor(DB);
 try{
  const initial=await getShopeeAccount(env);
  assert.equal(initial.affiliate_name,'');
  assert.equal(initial.api_status,'not_configured');
  assert.equal(initial.api_configured,false);
  assert.equal(DB.prepare('SELECT telegram_chat_id FROM settings WHERE id=1').first().telegram_chat_id,'@achadinhosmlcr');
  assert.equal(DB.prepare('SELECT COUNT(*) total FROM shopee_account').first().total,1);
  assert.equal(DB.prepare('SELECT COUNT(*) total FROM offers').first().total,0);
  assert.deepEqual(await getShopeeAccount(env),initial);
 }finally{DB.close();}
});

test('perfil Shopee é separado, editável e não dá falso positivo de conexão',async()=>{
 const DB=database(),env=envFor(DB);
 try{
  const saved=await saveShopeeProfile(env,{affiliate_name:'Minha Loja Shopee',affiliate_id:'shopee_1234'});
  assert.equal(saved.affiliate_name,'Minha Loja Shopee');
  assert.equal(saved.affiliate_id,'shopee_1234');
  assert.equal(saved.api_configured,false);
  assert.equal(saved.api_status,'not_configured');
  assert.equal(DB.prepare('SELECT telegram_chat_id FROM settings WHERE id=1').first().telegram_chat_id,'@achadinhosmlcr');
  await assert.rejects(saveShopeeProfile(env,{affiliate_id:'não aceito'}),/letras/);
  assert.equal((await getShopeeAccount(env)).affiliate_id,'shopee_1234');
 }finally{DB.close();}
});

test('App ID e Senha de API Shopee são criptografados e não vazam em respostas',async()=>{
 const DB=database(),env=envFor(DB);
 try{
  await saveShopeeProfile(env,{affiliate_name:'Shopee própria',affiliate_id:'12345'});
  const saved=await saveShopeeCredentials(env,{app_id:'123456789012',api_secret:rawSecret});
  assert.equal(saved.api_configured,true);
  assert.equal(saved.api_status,'credentials_saved');
  assert.equal(saved.api_app_id,'123456789012');
  assert.equal(saved.affiliate_name,'Shopee própria');
  assert.equal(JSON.stringify(saved).includes(rawSecret),false);
  const storage=DB.prepare('SELECT api_secret_cipher FROM shopee_account WHERE id=1').first().api_secret_cipher;
  assert.ok(storage&&!storage.includes(rawSecret));
  assert.equal(JSON.stringify(await getShopeeAccount(env)).includes('api_secret_cipher'),false);
  assert.equal(JSON.stringify(await getShopeeAccount(env)).includes(rawSecret),false);
  await assert.rejects(saveShopeeCredentials(env,{app_id:'xx',api_secret:rawSecret}),/App ID/);
  await assert.rejects(saveShopeeCredentials(env,{app_id:'123456789',api_secret:'senhadeLOGIN com espaço'}),/Senha da API/);
  assert.equal((await getShopeeAccount(env)).api_configured,true);
 }finally{DB.close();}
});

test('verificação da Shopee exige resposta GraphQL real para sinalizar conexão',async()=>{
 const DB=database(),env=envFor(DB);
 try{
  await assert.rejects(verifyShopeeApi(env),/não tem App ID/);
  await saveShopeeCredentials(env,{app_id:'123456789012',api_secret:rawSecret});
  let requestCount=0;
  globalThis.fetch=async (url,init)=>{
   requestCount++;
   assert.equal(url,API);
   assert.equal(init.method,'POST');
   assert.match(init.headers.authorization,/^SHA256 Credential=123456789012, Timestamp=\d+, Signature=[0-9a-f]{64}$/);
   assert.equal(init.headers['content-type'],'application/json');
   assert.deepEqual(JSON.parse(init.body),{query:'query VerifyConnection { __typename }'});
   assert.equal(init.headers.authorization.includes(rawSecret),false);
   return Response.json({data:{__typename:'Query'}});
  };
  const response=await verifyShopeeApi(env);
  assert.equal(requestCount,1);
  assert.equal(response.ok,true);
  assert.equal(response.api_status,'verified');
  assert.equal(response.last_verified_at>0,true);
  assert.equal(JSON.stringify(response).includes(rawSecret),false);
 }finally{globalThis.fetch=realFetch;DB.close();}
});

test('Shopee nega acesso: interface informa pendência sem declarar conexão',async()=>{
 const DB=database(),env=envFor(DB);
 try{
  await saveShopeeCredentials(env,{app_id:'123456789012',api_secret:rawSecret});
  globalThis.fetch=async()=>Response.json({errors:[{extensions:{code:10035}}]});
  const res=await verifyShopeeApi(env);
  assert.equal(res.ok,false);
  assert.equal(res.api_status,'verification_failed');
  assert.match(res.message,/não possui acesso/);
  assert.equal(res.last_verified_at,0);
  assert.equal(JSON.stringify(res).includes(rawSecret),false);
  const current=await getShopeeAccount(env);
  assert.equal(current.api_configured,true);
  assert.equal(current.api_status,'verification_failed');
 }finally{globalThis.fetch=realFetch;DB.close();}
});

test('desconectar credenciais Shopee não apaga o perfil nem tabelas Mercado Livre',async()=>{
 const DB=database(),env=envFor(DB);
 try{
  await saveShopeeProfile(env,{affiliate_name:'Shopee somente',affiliate_id:'sh_1'});
  await saveShopeeCredentials(env,{app_id:'123456789012',api_secret:rawSecret});
  const res=await clearShopeeCredentials(env);
  assert.equal(res.api_configured,false);
  assert.equal(res.affiliate_name,'Shopee somente');
  assert.equal(res.api_app_id,'');
  assert.equal(DB.prepare('SELECT api_secret_cipher FROM shopee_account').first().api_secret_cipher,null);
  assert.equal(DB.prepare('SELECT telegram_chat_id FROM settings WHERE id=1').first().telegram_chat_id,'@achadinhosmlcr');
 }finally{DB.close();}
});

test('API Shopee exige sessão administrativa e valida origem para credenciais',async()=>{
 const DB=database(),env=envFor(DB);
 const headers={'content-type':'application/json',origin:ORIGIN};
 try{
  const unauth=await worker.fetch(new Request(ORIGIN+'/api/shopee/account'),env);
  assert.equal(unauth.status,401);
  const login=await worker.fetch(new Request(ORIGIN+'/api/login',{method:'POST',headers,body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env);
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const bad=await worker.fetch(new Request(ORIGIN+'/api/shopee/account/credentials',{
    method:'POST',headers:{...headers,cookie,origin:'https://malicious.example'},
    body:JSON.stringify({app_id:'123456789012',api_secret:rawSecret})
  }),env);
  assert.equal(bad.status,403);
  const good=await worker.fetch(new Request(ORIGIN+'/api/shopee/account/profile',{
    method:'POST',headers:{...headers,cookie},
    body:JSON.stringify({affiliate_name:'Canal Shopee Independente',affiliate_id:'uid-123'})
  }),env);
  assert.equal(good.status,200);
  const state=await worker.fetch(new Request(ORIGIN+'/api/shopee/account',{headers:{cookie}}),env);
  assert.equal(state.status,200);
  assert.equal((await state.json()).affiliate_name,'Canal Shopee Independente');
 }finally{DB.close();}
});

test('painel separa identidade Shopee, contém conexão e não expõe senha em script',()=>{
 const html=renderPage();
 for(const id of ['affiliate-profile-name','affiliate-platform-label','intro-description',
   'shopee-account-panel','shopee-affiliate-name','shopee-affiliate-id',
   'shopee-api-app-id','shopee-api-secret','shopee-api-status',
   'shopee-api-verify','shopee-api-clear','shopee-account-badge'])
   assert.ok(html.includes('id="'+id+'"'),'Falta campo: '+id);
 assert.match(html,/https:\/\/affiliate\.shopee\.com\.br\/open_api/);
 assert.doesNotThrow(()=>new Function(CLIENT_JS));
 assert.match(CLIENT_JS,/Perfil afiliado • Shopee/);
 assert.match(CLIENT_JS,/shoAccountState\?\.affiliate_name/);
 assert.match(CLIENT_JS,/\/api\/shopee\/account\/credentials\/verify/);
});
