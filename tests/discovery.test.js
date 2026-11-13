import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureDiscoveryTables, parseKeywords, normalizeCatalogResult, createOAuthUrl,
  completeOAuth, getDiscoveryState, setDiscoveryConfig, dismissDiscovery, searchCatalog, disconnectDiscovery
} from '../src/discovery.js';

function dbMock() {
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE offers (id INTEGER PRIMARY KEY, title TEXT, affiliate_url TEXT)');
 return {
  prepare(sql) {
   let params=[];
   return {
    bind(...args){params=args;return this;},
    first(){return db.prepare(sql).get(...params)||null;},
    all(){return {results:db.prepare(sql).all(...params)};},
    run(){const r=db.prepare(sql).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
   };
  },close(){db.close();}
 };
}
const envFor=db=>({
 DB:db,
 MELI_APP_ID:'test-app-id',
 MELI_APP_SECRET:'secret-not-real',
 MELI_TOKEN_KEY:Buffer.alloc(32,9).toString('base64')
});
test('radar: palavras-chave são limitadas e produto não vira automaticamente link de afiliado',()=>{
 assert.deepEqual(parseKeywords(' Fone Bluetooth, fone bluetooth; AIR FRYER'),['fone bluetooth','air fryer']);
 assert.throws(()=>parseKeywords(''));
 assert.throws(()=>parseKeywords('a'));
 assert.throws(()=>parseKeywords(Array(13).fill('palavra').join(',')));
 const p=normalizeCatalogResult({id:'MLB123456789',name:'Produto de catálogo teste',status:'active',pictures:[{url:'https://http2.mlstatic.com/D_NQ_ABC.jpg'}]},'fone');
 assert.equal(p.source_url,'https://www.mercadolivre.com.br/p/MLB123456789');
 assert.equal(p.image_url,'https://http2.mlstatic.com/D_NQ_ABC.jpg');
 assert.equal(normalizeCatalogResult({id:'MLA12345',name:'Produto inválido'},'teste'),null);
 assert.equal(normalizeCatalogResult({id:'MLB12345',name:'Produto válido',status:'inactive'},'teste'),null);
});
test('radar fica desligado sem aplicativo autorizado, sem afetar o bot',async()=>{
 const db=dbMock();
 try{
  const env={DB:db};
  const state=await getDiscoveryState(env);
  assert.equal(state.settings.enabled,0);
  assert.equal(state.connected,false);
  assert.equal(state.app_configured,false);
  await assert.rejects(setDiscoveryConfig(env,{enabled:true,keywords:'ferramentas',interval_minutes:60}),/credenciais/);
  assert.deepEqual(await searchCatalog(env),{skipped:'disabled'});
 }finally{db.close();}
});
test('OAuth com state de uso único, tokens criptografados, renovação e pesquisa via API',async()=>{
 const db=dbMock(), env=envFor(db);
 const oldFetch=globalThis.fetch;
 const calls=[];
 globalThis.fetch=async (url,init={})=>{
  const str=String(url);
  calls.push(str);
  if(str.endsWith('/oauth/token')){
   const fields=new URLSearchParams(init.body);
   assert.equal(fields.get('client_secret'),'secret-not-real');
   const refresh=fields.get('grant_type')==='refresh_token';
   return new Response(JSON.stringify({
    access_token:refresh?'ACCESSTOKEN2':'ACCESSTOKEN1',
    refresh_token:refresh?'REFRESHTOKEN2':'REFRESHTOKEN1',expires_in:21600
   }),{status:200});
  }
  if(str.startsWith('https://api.mercadolibre.com/products/search?')){
   assert.equal(new URL(str).searchParams.get('site_id'),'MLB');
   assert.ok(['fone bluetooth','ferramentas'].includes(new URL(str).searchParams.get('q')));
   assert.match(init.headers.Authorization,/^Bearer ACCESSTOKEN[12]$/);
   return new Response(JSON.stringify({results:[
    {id:'MLB123450123',name:'Fone Bluetooth modelo 1',status:'active'},
    {id:'MLB123450124',name:'Fone Bluetooth modelo 2',status:'active'}
   ]}),{status:200});
  }
  throw Error('Unexpected URL '+str);
 };
 try{
  const origin='https://afiliados.example.test';
  const link=await createOAuthUrl(env,origin);
  const u=new URL(link);
  assert.equal(u.origin,'https://auth.mercadolivre.com.br');
  assert.equal(u.searchParams.get('redirect_uri'),origin+'/api/discovery/callback');
  assert.ok(u.searchParams.get('state').length>30);
  await assert.rejects(completeOAuth(env,origin,'CODEAUTH123456789','wrong-unauthorized-state'),/expirada|inválida/);
  await completeOAuth(env,origin,'CODEAUTH123456789',u.searchParams.get('state'));
  await assert.rejects(completeOAuth(env,origin,'CODEAUTH123456789',u.searchParams.get('state')),/expirada|inválida/);
  const state=await getDiscoveryState(env);
  assert.equal(state.connected,true);
  const stored=db.prepare('SELECT token_cipher FROM discovery_oauth WHERE id=1').first().token_cipher;
  assert.doesNotMatch(stored,/ACCESSTOKEN1|REFRESHTOKEN1/);
  await setDiscoveryConfig(env,{enabled:true,keywords:'fone bluetooth, ferramentas',interval_minutes:60});
  const scanned=await searchCatalog(env);
  assert.equal(scanned.added,2);
  const after=await getDiscoveryState(env);
  assert.equal(after.products.length,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
  assert.deepEqual(await searchCatalog(env),{skipped:'interval'});
  await dismissDiscovery(env,'MLB123450123');
  assert.equal((await getDiscoveryState(env)).products.length,1);
  db.prepare('UPDATE discovery_oauth SET expires_at=0 WHERE id=1').run();
  db.prepare('UPDATE discovery_settings SET last_run_at=NULL WHERE id=1').run();
  const refresh=await searchCatalog(env);
  assert.equal(refresh.added,0);
  assert.equal(calls.filter(x=>x.endsWith('/oauth/token')).length,2);
  await disconnectDiscovery(env);
  const disconnected=await getDiscoveryState(env);
  assert.equal(disconnected.connected,false);
  assert.equal(disconnected.settings.enabled,0);
 }finally{globalThis.fetch=oldFetch;db.close();}
});
test('permissão negada pela API pausa pesquisas sem publicar produto',async()=>{
 const db=dbMock(), env=envFor(db);
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async url=>{
  if(String(url).includes('/oauth/token')) return new Response(JSON.stringify({access_token:'TEST123456',refresh_token:'REFRESH987654',expires_in:21600}),{status:200});
  return new Response(JSON.stringify({error:'forbidden'}),{status:403});
 };
 try{
  const origin='https://afiliados.example.test';
  const u=new URL(await createOAuthUrl(env,origin));
  await completeOAuth(env,origin,'CODEAUTH123456789',u.searchParams.get('state'));
  await setDiscoveryConfig(env,{enabled:true,keywords:'ferramentas',interval_minutes:60});
  const result=await searchCatalog(env);
  assert.match(result.error,/negou acesso/);
  const state=await getDiscoveryState(env);
  assert.equal(state.settings.enabled,0);
  assert.equal(state.products.length,0);
 }finally{globalThis.fetch=oldFetch;db.close();}
});
