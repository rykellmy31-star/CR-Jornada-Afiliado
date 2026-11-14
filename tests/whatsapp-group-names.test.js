import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {listWhatsAppGroups,ensureWhatsAppTables} from '../src/whatsapp.js';
import {CLIENT_JS,renderPage} from '../src/ui.js';

const originalFetch=globalThis.fetch;
const base='https://evo.example.com';
const instance='cr-jornada-afiliados';
const saved='120363411339252305@g.us';
function makeDb(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  return {prepare(sql){
    let params=[];
    return {bind(...v){params=v;return this;},
      first(){return sqlite.prepare(sql).get(...params)||null;},
      all(){return {results:sqlite.prepare(sql).all(...params)};},
      run(){const r=sqlite.prepare(sql).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}};
  },close(){sqlite.close();}};
}
const envFor=DB=>({DB,EVOLUTION_API_URL:base,EVOLUTION_API_KEY:'test-secret'});
function fakeGroups(body){
  globalThis.fetch=async(url)=>{
    assert.equal(String(url),base+'/group/fetchAllGroups/'+instance+'?getParticipants=false');
    return Response.json(body);
  };
}
function helper(){
  const start=CLIENT_JS.indexOf('function renderWhatsAppGroupOptions(');
  const end=CLIENT_JS.indexOf('async function loadWhatsAppGroupNames(',start);
  assert.ok(start>0&&end>start,'helper de grupos ausente');
  const source=CLIENT_JS.slice(start,end);
  const doc={createElement:()=>({value:'',textContent:'',title:''})};
  return new Function('document','select','groups','selected',source+';return renderWhatsAppGroupOptions(select,groups,selected);').bind(null,doc);
}
class SelectMock{
  constructor(){this.options=[];this.current='';}
  set innerHTML(value){this.options=[];this.current='';}
  get innerHTML(){return this.options.map(o=>o.textContent).join(' ');}
  add(option){this.options.push(option);}
  set value(value){this.current=value;}
  get value(){return this.current;}
}

test('Evolution retorna nomes reais de grupos sem substituir IDs técnicos',async()=>{
  const DB=makeDb();
  try{
    fakeGroups([{id:saved,subject:'Achadinhos da Farmácia'},{id:'5511980000000@s.whatsapp.net',subject:'Contato privado'}]);
    const found=await listWhatsAppGroups(envFor(DB),instance);
    assert.deepEqual(found,[{id:saved,name:'Achadinhos da Farmácia'}]);
    await ensureWhatsAppTables(envFor(DB));
    DB.prepare('UPDATE whatsapp_settings SET group_jid=? WHERE id=1').bind(saved).run();
    const selected=DB.prepare('SELECT group_jid FROM whatsapp_settings WHERE id=1').first().group_jid;
    assert.equal(selected,saved);
  }finally{globalThis.fetch=originalFetch;DB.close();}
});

test('suporta nomes em resposta Evolution aninhada (data.groups e metadados)',async()=>{
  const DB=makeDb();
  try{
    fakeGroups({data:{groups:[{id:saved,groupMetadata:{subject:'Ofertas de Motos'}}]}});
    const groups=await listWhatsAppGroups(envFor(DB),instance);
    assert.deepEqual(groups,[{id:saved,name:'Ofertas de Motos'}]);
  }finally{globalThis.fetch=originalFetch;DB.close();}
});

test('painel mostra nome real no select e mantém ID somente como valor e título técnico',()=>{
  const render=helper(),select=new SelectMock();
  const found=render(select,[{id:saved,name:'Achadinhos da Farmácia'}],saved);
  assert.equal(found,true);
  assert.equal(select.value,saved);
  assert.ok(select.options.some(o=>o.value===saved&&o.textContent==='Achadinhos da Farmácia'));
  assert.ok(select.options.every(o=>!o.textContent.includes('@g.us')));
  assert.ok(select.options.some(o=>o.title===saved));
});

test('grupo não encontrado preserva o ID para evitar perda de configuração',()=>{
  const render=helper(),select=new SelectMock();
  const found=render(select,[{id:'120363000111222@g.us',name:'Outro grupo'}],saved);
  assert.equal(found,false);
  assert.equal(select.value,saved);
  assert.ok(select.options.some(o=>o.value===saved&&o.textContent.includes('nome indisponível')));
  assert.ok(select.options.every(o=>!o.textContent.includes('@g.us')));
});

test('painel consulta nomes automaticamente em Mercado Livre principal, multigrupos e Shopee',()=>{
  assert.doesNotThrow(()=>new Function(CLIENT_JS));
  const html=renderPage();
  assert.match(html,/id="wa-group"/);
  assert.match(html,/id="wa-multi-jid"/);
  assert.match(html,/id="shopee-wa-group"/);
  assert.match(CLIENT_JS,/if\(connection\?\.state==='open'&&selectedPlatform==='mercadolivre'&&selectedNetwork==='whatsapp'\)/);
  assert.match(CLIENT_JS,/Promise\.allSettled\(\[loadAdditionalGroupNames\(currentWaGroupId\),refreshManagedWhatsAppConnection\(false\)\]\)/);
  assert.match(CLIENT_JS,/Promise\.allSettled\(\[refreshShopeeWaConnection\(false\),loadShopeeGroupNames\(id\)\]\)/);
  assert.match(CLIENT_JS,/function renderWhatsAppGroupOptions\(/);
  assert.doesNotMatch(CLIENT_JS,/textContent='Grupo salvo: '\+/);
});
