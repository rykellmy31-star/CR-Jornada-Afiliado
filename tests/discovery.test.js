import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureDiscoveryTables, parseKeywords, normalizeCatalogResult, createOAuthUrl,
  completeOAuth, getDiscoveryState, setDiscoveryConfig, setDiscoveryRss, validateGoogleAlertsFeed, parseGoogleAlertsEntries, googleAlertProductUrl, dismissDiscovery, searchCatalog, disconnectDiscovery
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


test('Google Alertas RSS aceita apenas endereço oficial e extrai links reais',()=>{
 const feed='https://www.google.com/alerts/feeds/1234567890/9876543210';
 assert.equal(validateGoogleAlertsFeed(feed),feed);
 for(const invalid of [
  'https://evil.com/alerts/feeds/1234567890/9876543210',
  'https://www.google.com.evil.com/alerts/feeds/1234567890/9876543210',
  'http://www.google.com/alerts/feeds/1234567890/9876543210',
  'https://www.google.com/url?q=https://www.mercadolivre.com.br/p/MLB123456',
  'https://www.google.com/alerts/feeds/1234567890/9876543210?debug=1'
 ])assert.throws(()=>validateGoogleAlertsFeed(invalid));
 assert.equal(googleAlertProductUrl('https://www.mercadolivre.com.br/p/MLB123456789'), 'https://www.mercadolivre.com.br/p/MLB123456789');
 assert.equal(googleAlertProductUrl('https://evil.com/p/MLB123456789'),null);
 const xml='<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Fone &amp; Bluetooth original</title><link href="https://www.google.com/url?url=https%3A%2F%2Fwww.mercadolivre.com.br%2Fp%2FMLB123456789&amp;ct=ga"/></entry><entry><title>Outro produto</title><link href="https://example.org/p/MLB12345"/></entry></feed>';
 const parsed=parseGoogleAlertsEntries(xml);
 assert.equal(parsed.length,1);
 assert.equal(parsed[0].title,'Fone & Bluetooth original');
 assert.equal(parsed[0].source_url,'https://www.mercadolivre.com.br/p/MLB123456789');
});

test('RSS automático funciona sem OAuth e nunca cadastra link de afiliado sem autorização',async()=>{
 const db=dbMock(), env={DB:db};
 const oldFetch=globalThis.fetch, requests=[];
 globalThis.fetch=async (url, options={})=>{
  requests.push(String(url));
  assert.equal(options.redirect,'manual');
  return new Response(
    '<?xml version="1.0" ?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Fone de ouvido Bluetooth sem fio</title><link href="https://www.mercadolivre.com.br/p/MLB99887766"/></entry><entry><title>Fone de ouvido Bluetooth sem fio</title><link href="https://www.mercadolivre.com.br/p/MLB99887766"/></entry></feed>',
    {status:200,headers:{'content-type':'application/atom+xml'}}
  );
 };
 try {
  const url='https://www.google.com/alerts/feeds/1234567890/9876543210';
  await setDiscoveryRss(env,{feed_url:url});
  const before=await getDiscoveryState(env);
  assert.equal(before.rss_configured,true);
  assert.equal(before.settings.enabled,0);
  assert.equal(before.source,'google_alerts');
  await setDiscoveryConfig(env,{enabled:true,keywords:'fone bluetooth',interval_minutes:60});
  assert.equal((await searchCatalog(env)).added,1);
  assert.deepEqual(await searchCatalog(env),{skipped:'interval'});
  assert.equal(requests.length,1);
  const state=await getDiscoveryState(env);
  assert.equal(state.products.length,1);
  assert.match(state.products[0].product_id,/^RSS[a-f0-9]{28}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
  await dismissDiscovery(env,state.products[0].product_id);
  assert.equal((await getDiscoveryState(env)).products.length,0);
  await setDiscoveryRss(env,{remove:true});
  assert.equal((await getDiscoveryState(env)).rss_configured,false);
  assert.equal((await getDiscoveryState(env)).settings.enabled,0);
 }finally{globalThis.fetch=oldFetch;db.close();}
});
