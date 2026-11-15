import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {identifyFromOfficialLink,parseAffiliateIdentity,parseMercadoLivreProduct,connectAffiliateStore,affiliateStoreState,previewAffiliateLink,createAffiliateShortlink,followAffiliateShortlink} from '../src/affiliate-stores.js';
import {renderPage,CSS,CLIENT_JS} from '../src/ui.js';
import worker from '../src/index.js';

function env(){
 const db=new DatabaseSync(':memory:');
 return {env:{DB:{prepare(sql){
   let args=[];
   return {bind(...values){args=values;return this;},
     first(){return db.prepare(sql).get(...args)||null;},
     all(){return {results:db.prepare(sql).all(...args)};},
     run(){return db.prepare(sql).run(...args);}};
 }}},close:()=>db.close()};
}
const official='https://meli.la/2XzEMvr';
const target='https://www.mercadolivre.com.br/social/rykellmy_007?matt_word=rykellmy_007&matt_tool=33321398&forceInApp=true&ref=EXAMPLE';
const product='https://www.mercadolivre.com.br/kit-4-pisca-led-seta-sequencial-cb250-twister-titan-160/up/MLBU1978369947#tracking';
const fakeFetch=async()=>new Response('',{status:302,headers:{location:target}});

test('reconhece etiqueta apenas pelo redirecionamento oficial e bloqueia hosts inesperados',async()=>{
 assert.deepEqual(await identifyFromOfficialLink(official,fakeFetch),{label:'rykellmy_007',tool_id:'33321398'});
 assert.deepEqual(parseAffiliateIdentity(target),{label:'rykellmy_007',tool_id:'33321398'});
 await assert.rejects(identifyFromOfficialLink('https://meli.la.evil.test/ABCD123',fakeFetch),/meli.la/);
 await assert.rejects(identifyFromOfficialLink(official,async()=>new Response('',{status:302,headers:{location:'https://example.com/private'}})),/site não autorizado/);
 await assert.rejects(identifyFromOfficialLink(official,async()=>new Response('<html></html>',{status:200})),/não foi possível ler o redirecionamento/i);
 assert.throws(()=>parseAffiliateIdentity('https://www.mercadolivre.com.br/social/outra?matt_word=rykellmy_007&matt_tool=33321398'),/Não foi possível reconhecer/);
});
test('cadastro grava identificação no banco, oferece prévia e cria link curto com redirect permitido',async()=>{
 const {env:app,close}=env();
 try{
  assert.equal((await affiliateStoreState(app)).mercadolivre.configured,false);
  await connectAffiliateStore(app,{official_url:official},fakeFetch);
  assert.deepEqual((await affiliateStoreState(app)).mercadolivre.label,'rykellmy_007');
  const preview=await previewAffiliateLink(app,{product_url:product});
  assert.equal(preview.commission_verified,false);
  assert.equal(preview.product_url,product.split('#')[0]);
  assert.equal(new URL(preview.target_url).searchParams.get('matt_word'),'rykellmy_007');
  assert.equal(new URL(preview.target_url).searchParams.get('matt_tool'),'33321398');
  const result=await createAffiliateShortlink(app,{product_url:product},'https://bot.crjornada.com');
  assert.match(result.short_url,/^https:\/\/bot\.crjornada\.com\/l\/[a-zA-Z0-9_-]{12}$/);
  const code=result.short_url.split('/').at(-1);
  const redirect=await followAffiliateShortlink(app,code);
  assert.equal(redirect.status,302);
  assert.equal(redirect.headers.get('location'),preview.target_url);
  assert.equal((await followAffiliateShortlink(app,'badcode')).status,404);
  await assert.rejects(previewAffiliateLink(app,{product_url:'https://evil.test/a/up/MLBU1978369947'}),/Mercado Livre Brasil/);
  assert.throws(()=>parseMercadoLivreProduct('https://www.mercadolivre.com.br/gz/account-verification?go=https://evil.test'),/endereço completo/);
  const unauthorized=await worker.fetch(new Request('https://bot.crjornada.com/api/stores/mercadolivre'),{...app,SESSION_SECRET:'test-secret'});
  assert.equal(unauthorized.status,401);
  const publicResult=await worker.fetch(new Request(result.short_url),app);
  assert.equal(publicResult.status,302);
 }finally{close();}
});
test('LOJAS aparece no menu, tem formulário e navegação independente das filas',()=>{
 const page=renderPage();
 assert.match(page,/data-panel="stores"/);
 assert.match(page,/id="stores-ml-official-url"/);
 assert.match(page,/id="stores-product-url"/);
 assert.match(CSS,/\.stores-panel/);
 assert.match(CLIENT_JS,/selectedPage==='stores'/);
 assert.match(CLIENT_JS,/refreshStores/);
});
