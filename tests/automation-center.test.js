import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { ensureWhatsAppTables } from '../src/whatsapp.js';
import { ensureShopeeTables } from '../src/shopee.js';
import {
  ensureAutomationCenter,masterState,setMasterState,listCategories,createGroupCategory,STARTER_GROUP_CATEGORIES,
  saveCategoryRoutes,listCategoryDestinations,upsertProductCategory,classifyProduct,runCategoryRoutingScheduled
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

test('cinco categorias iniciais são cadastradas sem duplicar nem sobrescrever configurações',async()=>{
  const {env,DB}=setup();
  try{
    await ensureAutomationCenter(env);
    const first=await listCategories(env);
    assert.equal(STARTER_GROUP_CATEGORIES.length,5);
    for(const preset of STARTER_GROUP_CATEGORIES){
      assert.ok(preset.keywords.length>40&&preset.keywords.length<=800);
      const row=first.groups.find(g=>g.name===preset.name);
      assert.ok(row,'Categoria inicial ausente: '+preset.name);
      assert.equal(row.keywords,preset.keywords);
      assert.equal(row.enabled,1);
    }
    assert.equal(first.routes.length,0,'Criar categorias não autoriza envio a destinos');
    assert.equal((await masterState(env)).enabled,null,'Não liga os robôs automaticamente');
    const custom=first.groups.find(g=>g.name==='Casa e Utilidades');
    DB.prepare('UPDATE affiliate_group_categories SET keywords=?,enabled=0 WHERE id=?').bind('palavra personalizada',custom.id).run();
    const empty=first.groups.find(g=>g.name==='Moda e Acessórios');
    DB.prepare('UPDATE affiliate_group_categories SET keywords=? WHERE id=?').bind('',empty.id).run();
    const automotive=first.groups.find(g=>g.name==='Ferramentas e Peças Automotivas');
    DB.prepare('UPDATE affiliate_group_categories SET keywords=? WHERE id=?')
      .bind(STARTER_GROUP_CATEGORIES.find(p=>p.name===automotive.name).keywords.split(', lavadora de alta pressão')[0],automotive.id).run();
    await ensureAutomationCenter(env);
    const second=await listCategories(env);
    assert.equal(second.groups.filter(g=>STARTER_GROUP_CATEGORIES.some(p=>p.name===g.name)).length,5);
    assert.equal(second.groups.find(g=>g.name===custom.name).keywords,'palavra personalizada');
    assert.equal(second.groups.find(g=>g.name===custom.name).enabled,0);
    assert.equal(second.groups.find(g=>g.name===empty.name).keywords,STARTER_GROUP_CATEGORIES.find(p=>p.name===empty.name).keywords);
    const selected=classifyProduct('Furadeira parafusadeira 20v','Geral',second.groups);
    assert.equal(selected.category.name,'Ferramentas e Peças Automotivas');
    assert.equal(second.groups.find(g=>g.name===automotive.name).keywords,STARTER_GROUP_CATEGORIES.find(p=>p.name===automotive.name).keywords,'Preset antigo deve incorporar lavagem sem duplicação');
    for(const title of ['Lavadora de alta pressão WAP 2000', 'Cera automotiva premium','Shampoo automotivo concentrado']){
      const found=classifyProduct(title,'Geral',second.groups);
      assert.equal(found.category?.name,'Ferramentas e Peças Automotivas',title);
    }
  }finally{DB.close();}
});

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
    const match=classifyProduct('Chave de fenda com ponta magnética','Geral',categories.groups);
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


test('distribuição real simulada permite ML e Shopee no mesmo grupo sem duplicar links',async()=>{
  const {env,DB}=setup();
  const originalFetch=globalThis.fetch;
  const sent=[];
  try{
    await ensureWhatsAppTables(env);
    await ensureShopeeTables(env);
    await ensureAutomationCenter(env);
    const cat=await createGroupCategory(env,{name:'Ferramentas',keywords:'chave de fenda, chave de boca'});
    DB.prepare("UPDATE whatsapp_settings SET instance_name='afiliados',group_jid='120363888999777@g.us',enabled=1,public_registered=1 WHERE id=1").run();
    await saveCategoryRoutes(env,cat.id,{routes:[{
      scope:'mercadolivre',network:'whatsapp',id:1,mercadolivre:true,shopee:true
    }]});
    const now=Math.floor(Date.now()/1000);
    // Duas ofertas novas, originadas de plataformas distintas, publicadas após a autorização.
    const ml=DB.prepare("INSERT INTO offers(title,affiliate_url,category,created_at,status,published_at) VALUES(?,?,?,?,'published',?)")
      .bind('Chave de fenda profissional','https://meli.la/MLCAT1','Ferramentas',now,now+1).run();
    DB.prepare("INSERT INTO offer_delivery_routing(offer_id,delivery_mode) VALUES(?,'telegram')").bind(ml.meta.last_row_id).run();
    DB.prepare("INSERT INTO shopee_targets(network,target_id,category,enabled,permission_confirmed,created_at,updated_at) VALUES('whatsapp',1000,'Ferramentas',1,1,?,?)").bind(now,now).run();
    const sh=DB.prepare("SELECT id FROM shopee_targets WHERE target_id=1000").first();
    DB.prepare("INSERT INTO shopee_offers(destination_id,title,affiliate_url,category,created_at,status,published_at) VALUES(?,?,?,?,?,'published',?)")
      .bind(sh.id,'Chave de boca profissional','https://s.shopee.com.br/SHOCAT1','Ferramentas',now,now+1).run();
    globalThis.fetch=async(url,opts={})=>{
      const u=String(url);
      if(u==='https://evo.example.com/group/fetchAllGroups/afiliados?getParticipants=false')
        return Response.json([{id:'120363888999777@g.us',subject:'Ferramentas'}]);
      if(u==='https://evo.example.com/message/sendText/afiliados'){
        sent.push(JSON.parse(opts.body));
        return Response.json({key:{id:'WA_CAT_'+sent.length}});
      }
      throw Error('URL externa não prevista: '+u);
    };
    env.EVOLUTION_API_URL='https://evo.example.com';
    env.EVOLUTION_API_KEY='TEST_ONLY_KEY';
    const first=await runCategoryRoutingScheduled({...env,MASTER_SCHEDULE_ENABLED:true});
    assert.equal(first.results.length,1);
    assert.equal(sent.length,1);
    assert.match(sent[0].text,/Ferramentas/);
    DB.prepare("UPDATE affiliate_category_pacing SET last_attempt_at=0").run();
    const second=await runCategoryRoutingScheduled({...env,MASTER_SCHEDULE_ENABLED:true});
    assert.equal(second.results.length,1);
    assert.equal(sent.length,2);
    assert.ok(sent.some(x=>x.text.includes('https://meli.la/MLCAT1')));
    assert.ok(sent.some(x=>x.text.includes('https://s.shopee.com.br/SHOCAT1')));
    const third=await runCategoryRoutingScheduled({...env,MASTER_SCHEDULE_ENABLED:true});
    assert.equal(third.results.length,0);
    assert.equal(DB.prepare("SELECT COUNT(*) AS total FROM affiliate_category_deliveries WHERE status='sent'").first().total,2);
  }finally{globalThis.fetch=originalFetch;DB.close();}
});

test('rotas por categoria respeitam a pausa individual do Telegram mesmo com robô geral ligado',async()=>{
  const {env,DB}=setup();
  try{
    await ensureAutomationCenter(env);
    DB.prepare("UPDATE settings SET telegram_chat_id='@canalativo',channel_registered=1,telegram_enabled=1,automation_enabled=0 WHERE id=1").run();
    let destinations=await listCategoryDestinations(env);
    assert.equal(destinations.find(x=>x.scope==='mercadolivre'&&x.network==='telegram'&&x.id===1).active,false,
      'Um canal pausado nunca pode ser reativado pelo botão geral ou por rotas de categoria');
    DB.prepare("UPDATE settings SET automation_enabled=1 WHERE id=1").run();
    destinations=await listCategoryDestinations(env);
    assert.equal(destinations.find(x=>x.scope==='mercadolivre'&&x.network==='telegram'&&x.id===1).active,true);
    DB.prepare("UPDATE settings SET telegram_enabled=0 WHERE id=1").run();
    destinations=await listCategoryDestinations(env);
    assert.equal(destinations.find(x=>x.scope==='mercadolivre'&&x.network==='telegram'&&x.id===1).active,false);
  }finally{DB.close();}
});
