import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import shortener from '../src/promoml-shortener.js';
import {ensureAffiliateStores} from '../src/affiliate-stores.js';

function setup(){
 const db=new DatabaseSync(':memory:');
 const DB={prepare(sql){
   let args=[];
   return {bind(...values){args=values;return this;},
     first(){return db.prepare(sql).get(...args)||null;},
     run(){return db.prepare(sql).run(...args);}};
 }};
 return {env:{DB},db};
}
const dest='https://www.mercadolivre.com.br/kit-4-pisca-led/up/MLBU1978369947?matt_word=rykellmy_007&matt_tool=33321398&forceInApp=true';
const code='ABCdef123_-X';
test('PromoML redireciona URLs cadastradas e não expõe o painel de administração',async()=>{
 const {env,db}=setup();
 try{
  await ensureAffiliateStores(env);
  env.DB.prepare('INSERT INTO crj_affiliate_shortlinks(code,product_url,target_url,label,created_at) VALUES(?,?,?,?,?)')
   .bind(code,dest.split('?')[0],dest,'rykellmy_007',1794784490).run();
  for(const p of ['/'+code,'/s/'+code,'/l/'+code]){
   const res=await shortener.fetch(new Request('https://promoml.app'+p),env);
   assert.equal(res.status,302);
   assert.equal(res.headers.get('location'),dest);
  }
  const res=await shortener.fetch(new Request('https://promoml.app/'+code,{method:'HEAD'}),env);
  assert.equal(res.status,302);
  assert.equal(res.headers.get('location'),dest);
  assert.equal((await shortener.fetch(new Request('https://promoml.app/api/session'),env)).status,404);
  assert.equal((await shortener.fetch(new Request('https://promoml.app/app.js'),env)).status,404);
  assert.equal((await shortener.fetch(new Request('https://promoml.app/XXXXXXXXXXXX'),env)).status,404);
  assert.equal((await shortener.fetch(new Request('https://fake.example/'+code),env)).status,404);
  assert.equal((await shortener.fetch(new Request('https://promoml.app/'+code,{method:'POST'}),env)).status,405);
  const root=await shortener.fetch(new Request('https://promoml.app/'),env);
  assert.equal(root.status,200);
  assert.match(await root.text(),/PromoML/);
 }finally{db.close();}
});
test('PromoML rejeita redirecionamento externo mesmo se alterarem o banco',async()=>{
 const {env,db}=setup();
 try{
  await ensureAffiliateStores(env);
  env.DB.prepare('INSERT INTO crj_affiliate_shortlinks(code,product_url,target_url,label,created_at) VALUES(?,?,?,?,?)')
   .bind(code,dest.split('?')[0],'https://example.com/steal','rykellmy_007',1794784490).run();
  assert.equal((await shortener.fetch(new Request('https://promoml.app/'+code),env)).status,410);
 }finally{db.close();}
});
