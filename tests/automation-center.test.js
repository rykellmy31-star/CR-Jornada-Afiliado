import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { ensureWhatsAppTables } from '../src/whatsapp.js';
import {
  ensureAutomationCenter,masterState,setMasterState,listCategories,createGroupCategory,
  saveCategoryRoutes,upsertProductCategory,classifyProduct,runCategoryRoutingScheduled
} from '../src/automation-center.js';
import { renderPage,CLIENT_JS } from '../src/ui.js';

function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){let params=[];return{
    bind(...values){params=values;return this;},
    first(){return db.prepare(sql).get(...params)||null;},
    all(){return {results:db.prepare(sql).all(...params)};},
    run(){const r=db.prepare(sql).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
  };},close(){db.close();}};
  return {DB,db,env:{DB,ADMIN_PASSWORD:'fake_password_for_tests',SESSION_SECRET:'fake_testing_secret_2026_very_long'}};
}

test('controle geral começa legado e permite ligar/desligar sem apagar dados',async()=>{
  const {env,DB}=setup();
  try{
    assert.equal((await masterState(env)).enabled,null);
    assert.equal((await setMasterState(env,true)).enabled,true);
    assert.equal((await masterState(env)).enabled,true);
    assert.equal((await setMasterState(env,false)).enabled,false);
    assert.equal((await masterState(env)).enabled,false);
    assert.equal((await runCategoryRoutingScheduled({...env,MASTER_SCHEDULE_ENABLED:false})).skipped,'master_off');
    assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
  }finally{DB.close();}
});

test('categoria de grupo registra palavras-chave e classifica produtos e subcategorias automaticamente',async()=>{
  const {env,DB}=setup();
  try{
    const cat=await createGroupCategory(env,{name:'Ferramentas',keywords:'chave de fenda, chave de boca, furadeira'});
    assert.ok(cat.id>0);
    const categories=await listCategories(env);
    assert.ok(categories.groups.some(c=>c.name==='Geral'));
    assert.ok(categories.groups.some(c=>c.name==='Ferramentas'));
    await assert.rejects(createGroupCategory(env,{name:'Ferramentas',keywords:''}),/já existe/);
    const match=classifyProduct('Chave de fenda com ponta magnética','',categories.groups);
    assert.equal(match.category.name,'Ferramentas');
    assert.equal(match.subcategory,'Chaves de fenda');
    const inserted=await upsertProductCategory(env,'mercadolivre',{
      title:'Chave de boca tamanho 10',affiliate_url:'https://meli.la/EXAMPLE1',category:'Ferramentas'
    });
    assert.equal(inserted.category.id,cat.id);
    assert.equal(inserted.subcategory,'Chaves de boca');
    const state=await listCategories(env);
    assert.equal(state.products[0].group_category,'Ferramentas');
    assert.equal(state.products[0].subcategory,'Chaves de boca');
    const unmatched=await upsertProductCategory(env,'shopee',{
      title:'Item sem correspondência reconhecida',affiliate_url:'https://s.shopee.com.br/EXAMPLE2',category:''
    });
    assert.equal(unmatched.classification,'needs_review');
    assert.equal(unmatched.category,null);
  }finally{DB.close();}
});

test('mesma categoria permite publicar Mercado Livre e Shopee no mesmo grupo WhatsApp autorizado',async()=>{
  const {env,DB}=setup();
  try{
    await ensureAutomationCenter(env);
    await ensureWhatsAppTables(env);
    const cat=await createGroupCategory(env,{name:'Peças de motos',keywords:'pneu, capacete'});
    DB.prepare("UPDATE whatsapp_settings SET instance_name='afiliados',group_jid='120363888999777@g.us',enabled=1,public_registered=1 WHERE id=1").run();
    const result=await saveCategoryRoutes(env,cat.id,{routes:[
      {scope:'mercadolivre',network:'whatsapp',id:1,mercadolivre:true,shopee:true}
    ]});
    assert.equal(result.count,1);
    const routes=(await listCategories(env)).routes;
    assert.equal(routes.length,1);
    assert.equal(routes[0].allow_mercadolivre,1);
    assert.equal(routes[0].allow_shopee,1);
    await assert.rejects(saveCategoryRoutes(env,cat.id,{routes:[
      {scope:'mercadolivre',network:'whatsapp',id:991,mercadolivre:true,shopee:true}
    ]}),/destino não cadastrado/);
    assert.equal((await listCategories(env)).routes.length,1);
  }finally{DB.close();}
});

test('interface tem botão mestre, navegação lateral e categoria em dropdown',()=>{
  const html=renderPage();
  for(const item of ['id="master-toggle"','data-panel="categories"','data-panel="activity"',
    'id="categories-page"','id="activity-page"','id="category-group-select"',
    'id="category-products"','data-category-selector']){
    assert.ok(html.includes(item),'Controle ausente: '+item);
  }
  assert.doesNotMatch(html,/<input id="wa-category"/);
  assert.match(CLIENT_JS,/function refreshCategories/);
  assert.match(CLIENT_JS,/function refreshActivity/);
  const from=CLIENT_JS.slice(CLIENT_JS.indexOf('async function refresh(){'),CLIENT_JS.indexOf('for(let h=0;h<=24;h++)'));
  assert.ok(from.indexOf('view(true);')<from.indexOf('refreshWhatsApp()'),'Painel não deve aguardar Evolution no F5');
  assert.match(CLIENT_JS,/Destino '\+type\+': '\+dest/);
});

test('API mestre exige login; agendador desligado mantém cinco filas intactas',async()=>{
  const {env,DB}=setup();
  try{
    const unauth=await worker.fetch(new Request('https://afiliados.test/api/master'),env);
    assert.equal(unauth.status,401);
    await setMasterState(env,false);
    let calls=[];
    const original=globalThis.fetch;
    globalThis.fetch=async url=>{calls.push(String(url));throw Error('Scheduler desativado não envia');};
    try{
      const tasks=[];
      await worker.scheduled({},env,{waitUntil:p=>tasks.push(p)});
      assert.equal(tasks.length,5);
      await Promise.all(tasks);
      assert.equal(calls.length,0);
    }finally{globalThis.fetch=original;}
  }finally{DB.close();}
});
