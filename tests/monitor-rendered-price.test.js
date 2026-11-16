import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureMonitor,refreshMonitorSitePrices} from '../src/whatsapp-link-monitor.js';
import {fetchRenderedMonitorPrice} from '../src/monitor-rendered-price.js';

const PRODUCT='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
const OTHER='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB87654321';

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){
    let args=[];return {bind(...values){args=values;return this;},
      first(){return db.prepare(sql).get(...args)||null;},
      all(){return {results:db.prepare(sql).all(...args)};},
      run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}
    };
  },async batch(ops){
    db.exec('BEGIN');try{const out=ops.map(x=>x.run());db.exec('COMMIT');return out;}
    catch(error){db.exec('ROLLBACK');throw error;}
  }};
  return {env:{DB},db};
}
function officialHTML(url=PRODUCT){
  return '<link rel="canonical" href="'+url+'">'+
    '<script type="application/ld+json">'+JSON.stringify({
      '@context':'https://schema.org','@type':'Product',
      url,offers:{'@type':'Offer',price:'34.82',priceCurrency:'BRL'}
    })+'</script>';
}
async function seed(env){
  await ensureMonitor(env);
  env.DB.prepare("INSERT INTO ml_monitor_groups(instance_name,group_jid,group_name,enabled,authorized,created_at) VALUES('cr-jornada-afiliados','120363000111222333@g.us','Grupo autorizado',1,1,1000)").run();
  env.DB.prepare("INSERT INTO ml_monitor_links(group_id,product_id,source_url,title,category,classification,status,created_at) VALUES(1,'MLB12345678',?,'Furadeira de impacto','Ferramentas','keywords','available',1000)").bind(PRODUCT).run();
}
const unavailable=async()=>new Response('bloqueado',{status:403});

test('monitor consulta navegador oficial quando HTML e API não mostram preço',async()=>{
  const {env,db}=fixture();
  try{
    await seed(env);
    let calls=0;
    env.BROWSER={quickAction:async(action,opts)=>{
      calls++;assert.equal(action,'content');assert.equal(opts.url,PRODUCT);
      return {ok:true,text:async()=>officialHTML()};
    }};
    const result=await refreshMonitorSitePrices(env,{fetcher:unavailable});
    assert.deepEqual(result,{checked:1,found:1});
    assert.equal(calls,1);
    const saved=env.DB.prepare("SELECT price_cents,status,method FROM ml_monitor_site_prices WHERE product_id='MLB12345678'").first();
    assert.deepEqual({...saved},{price_cents:3482,status:'ok',method:'navegador do anuncio oficial'});
  }finally{db.close();}
});

test('navegador ignora outro produto e não inventa valor',async()=>{
  const {env,db}=fixture();
  try{
    await seed(env);
    env.BROWSER={quickAction:async()=>({ok:true,text:async()=>officialHTML(OTHER)})};
    const result=await refreshMonitorSitePrices(env,{fetcher:unavailable});
    assert.deepEqual(result,{checked:1,found:0});
    const saved=env.DB.prepare("SELECT price_cents,status FROM ml_monitor_site_prices WHERE product_id='MLB12345678'").first();
    assert.deepEqual({...saved},{price_cents:null,status:'unavailable'});
  }finally{db.close();}
});

test('navegador só acessa URL oficial com produto identificável',async()=>{
  const {env,db}=fixture();
  try{
    let calls=0;
    env.BROWSER={quickAction:async()=>{calls++;return {ok:true,text:async()=>officialHTML()};}};
    assert.equal(await fetchRenderedMonitorPrice(env,'https://example.com/p/MLB12345678'),null);
    assert.equal(await fetchRenderedMonitorPrice(env,'https://mercadolivre.com.br@evil.com/p/MLB12345678'),null);
    assert.equal(calls,0);
    const first=await fetchRenderedMonitorPrice(env,PRODUCT,{at:2000000000});
    assert.equal(first.price_cents,3482);
    const second=await fetchRenderedMonitorPrice(env,PRODUCT,{at:2000000001});
    assert.equal(second,null);
    assert.equal(calls,1);
  }finally{db.close();}
});
