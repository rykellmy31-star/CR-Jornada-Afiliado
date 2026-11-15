import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/index.js';
import {parseSelection,validateSourceUrl,validatePairs,createLinkBatch,importLinkBatch,readLinkBatch,listLinkBatches,isIneligibleWarning} from '../src/link-batches.js';
import {runInNewContext} from 'node:vm';
import {renderPage,CSS,CLIENT_JS} from '../src/ui.js';

const URL1='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
const URL2='https://www.mercadolivre.com.br/fone-bluetooth/p/MLB99887766';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={
   prepare(sql){
     let values=[];
     return {
       bind(...args){values=args;return this;},
       first(){return db.prepare(sql).get(...values)||null;},
       all(){return {results:db.prepare(sql).all(...values)};},
       run(){
         const r=db.prepare(sql).run(...values);
         return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};
       }
     };
   },
   async batch(ops){
     db.exec('BEGIN');
     try{const r=ops.map(x=>x.run());db.exec('COMMIT');return r;}
     catch(error){db.exec('ROLLBACK');throw error;}
   },
   close(){db.close();}
 };
 return {DB,env:{DB,ADMIN_PASSWORD:'password used only for tests',SESSION_SECRET:'session key only for automated tests 123456'}};
}
const demo='Furadeira de impacto Bosch | '+URL1+' | Ferramentas e Peças Automotivas\nFone Bluetooth sem fio | '+URL2+' | Eletrônicos e Eletrodomésticos';
test('URLs comuns são aceitas; buscas e sites externos são recusados',()=>{
 assert.equal(parseSelection(demo).length,2);
 assert.equal(parseSelection(URL1)[0].title,'furadeira de impacto');
 assert.throws(()=>validateSourceUrl('https://www.mercadolivre.com.br/ofertas'),/identifica um produto/);
 assert.throws(()=>validateSourceUrl('https://not-mercadolivre.com.br/p/MLB12345678'),/somente/);
 assert.throws(()=>parseSelection(URL1+'\n'+URL1),/repetido/);
});
test('não associa link que indica código de outro produto',()=>{
 assert.throws(()=>validatePairs([{source_url:URL1}],[{affiliate_url:'https://www.mercadolivre.com.br/fone/p/MLB99887766?matt_tool=123'}]),/outro produto/);
 assert.deepEqual(validatePairs([{source_url:URL1}],[{affiliate_url:'https://meli.la/ABCDEF12'}]).map(x=>x.affiliate_url),['https://meli.la/ABCDEF12']);
});
test('lote fica aguardando conversão até confirmação explícita e importa atomicamente',async()=>{
 const {DB,env}=fixture();
 try{
   const created=await createLinkBatch(env,{text:demo});
   assert.equal(created.items.length,2);
   assert.equal(created.batch.status,'awaiting_links');
   assert.equal(created.items[0].category,'Ferramentas e Peças Automotivas');
   assert.equal(created.items[1].category,'Eletrônicos e Eletrodomésticos');
   assert.equal(DB.prepare('SELECT count(*) AS n FROM offers').first().n,0);
   const links=[{affiliate_url:'https://meli.la/ABCDEF12',category:created.items[0].category},
                {affiliate_url:'https://meli.la/ZYXWVU98',category:created.items[1].category}];
   await assert.rejects(importLinkBatch(env,created.batch.id,{links,owner_confirmation:true,pairing_confirmation:false}),/Confirme/);
   assert.equal(DB.prepare('SELECT count(*) AS n FROM offers').first().n,0);
   const imported=await importLinkBatch(env,created.batch.id,{links,owner_confirmation:true,pairing_confirmation:true});
   assert.equal(imported.queued,2);
   assert.equal(DB.prepare("SELECT count(*) AS n FROM offers WHERE status='ready'").first().n,2);
   const stored=await readLinkBatch(env,created.batch.id);
   assert.equal(stored.batch.status,'imported');
   assert.equal(stored.items[0].affiliate_url,'https://meli.la/ABCDEF12');
   assert.equal(stored.items[0].status,'queued');
   assert.equal((await listLinkBatches(env)).current,null);
   await assert.rejects(importLinkBatch(env,created.batch.id,{links,owner_confirmation:true,pairing_confirmation:true}),/já foi importado/);
 }finally{DB.close();}
});
test('rejeita duplicação sem publicar nem importar parcialmente',async()=>{
 const {DB,env}=fixture();
 try{
   const batch=await createLinkBatch(env,{text:demo});
   const same=[{affiliate_url:'https://meli.la/ABCDEF12'},{affiliate_url:'https://meli.la/ABCDEF12'}];
   await assert.rejects(importLinkBatch(env,batch.batch.id,{links:same,owner_confirmation:true,pairing_confirmation:true}),/mesmo link/);
   assert.equal(DB.prepare('SELECT count(*) AS n FROM offers').first().n,0);
   assert.equal((await readLinkBatch(env,batch.batch.id)).batch.status,'awaiting_links');
 }finally{DB.close();}
});
test('endpoints do lote exigem login administrativo',async()=>{
 const {DB,env}=fixture();
 try{
   const base='https://afiliados.example.test';
   const anonymous=await worker.fetch(new Request(base+'/api/link-batches'),env);
   assert.equal(anonymous.status,401);
   const login=await worker.fetch(new Request(base+'/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:env.ADMIN_PASSWORD})}),env);
   assert.equal(login.status,200);
   const cookie=login.headers.get('set-cookie').split(';')[0];
   const create=await worker.fetch(new Request(base+'/api/link-batches',{method:'POST',headers:{origin:base,'content-type':'application/json',cookie},body:JSON.stringify({text:'Furadeira de impacto Bosch | '+URL1})}),env);
   assert.equal(create.status,201);
   const data=await create.json();
   assert.equal(data.items.length,1);
   const read=await worker.fetch(new Request(base+'/api/link-batches/'+data.batch.id,{headers:{cookie}}),env);
   assert.equal(read.status,200);
 }finally{DB.close();}
});
test('interface apresenta as quatro etapas sem misturar nomes nos links copiados',()=>{
 const html=renderPage();
 for(const id of ['ml-link-batches','ml-batch-prepare','ml-batch-copy','ml-batch-step2','ml-batch-converted',
   'ml-batch-preview','ml-batch-pair-confirmation','ml-batch-import'])
   assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(CSS,/data-view="linkbatches"/);
 assert.match(CLIENT_JS,/navigator.clipboard.writeText/);
 assert.match(CLIENT_JS,/ml-batch-import/);
 assert.match(CLIENT_JS,/refreshMLLinkBatches/);

 assert.match(html,/Etapa 1 • Produtos identificados e classificados/);
 assert.match(html,/Etapa 2 • Somente links para copiar/);
 assert.match(html,/Etapa 3 • Cole os links convertidos/);
 assert.match(html,/Etapa 4 • Colocar cada link na categoria e na fila correta/);
 assert.match(html,/id="ml-batch-links-only" readonly/);
 assert.match(html,/class="ml-batch-phase hidden" id="ml-batch-final-step"/);
 assert.match(CLIENT_JS,/\$\('ml-batch-links-only'\)\.value=mlBatchUrlList\(\)/);
 assert.match(CLIENT_JS,/const text=\$\('ml-batch-links-only'\)\.value/);
 assert.match(CLIENT_JS,/\$\('ml-batch-final-step'\)\.classList\.remove\('hidden'\)/);
 assert.match(CLIENT_JS,/item\.id==='ml-link-batches'/);
 assert.match(CLIENT_JS,/selectedPage!=='linkbatches'/);
 assert.match(html,/data-panel="linkbatches"/);
 assert.match(html,/Conversão de Link em Lote/);
 assert.match(CLIENT_JS,/selectedPage==='linkbatches'\)tasks.push\(refreshMLLinkBatches\(\)\)/);
 assert.doesNotMatch(CSS,/#dashboard:not\(\[data-view="mercadolivre-automation"\]\) > #ml-link-batches/);
});


test('a advertência oficial do Mercado Livre ocupa uma posição, sem consumir link',()=>{
 assert.equal(isIneligibleWarning('⚠️ Este produto não cumpre com os requisitos do Programa.'),true);
 assert.equal(isIneligibleWarning('Este produto não cumpre com os requisitos do Programa.'),true);
 assert.equal(isIneligibleWarning('⚠️ Este produto não cumpre com os requisitos do Programa'),true);
 assert.equal(isIneligibleWarning('Um produto diferente foi recusado'),false);
});

test('entrada idêntica à exportação: 29 posições, 27 links, avisos nas linhas 17 e 19',()=>{
 const converted=Array.from({length:29},(_,i)=>
  i===16||i===18?'⚠️ Este produto não cumpre com os requisitos do Programa.':
  'https://meli.la/'+('000000'+(i+1)).slice(-6)+'AB');
 const code=CLIENT_JS.slice(CLIENT_JS.indexOf('function mlBatchReadConverted('),
  CLIENT_JS.indexOf('\nfunction mlBatchShow(',CLIENT_JS.indexOf('function mlBatchReadConverted(')));
 const result=runInNewContext(code+';\nmlBatchReadConverted(input)',{input:converted.join('\n')});
 assert.equal(result.length,29);
 assert.equal(result.filter(x=>!x.ineligible).length,27);
 assert.equal(result[16].ineligible,true);
 assert.equal(result[18].ineligible,true);
 assert.equal(result[17].affiliate_url,converted[17]);
 assert.equal(result[19].affiliate_url,converted[19]);
});

test('importação de lote de 29 produtos mantém links certos e registra apenas 2 inelegíveis',async()=>{
 const {DB,env}=fixture();
 try{
  const urls=Array.from({length:29},(_,i)=>
   'https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB'+String(12345000+i));
  const text=urls.map((u,i)=>'Furadeira de impacto Bosch '+(i+1)+' | '+u+' | Ferramentas e Peças Automotivas').join('\n');
  const batch=await createLinkBatch(env,{text});
  assert.equal(batch.items.length,29);
  const links=batch.items.map((item,i)=>i===16||i===18
   ?{ineligible:true,reason:'program_ineligible'}
   :{affiliate_url:'https://meli.la/CONVERT'+String(i+1).padStart(2,'0'),category:item.category});
  const imported=await importLinkBatch(env,batch.batch.id,{
   links,owner_confirmation:true,pairing_confirmation:true
  });
  assert.deepEqual({queued:imported.queued,ineligible:imported.ineligible},{queued:27,ineligible:2});
  assert.equal(DB.prepare("SELECT COUNT(*) AS n FROM offers WHERE status='ready'").first().n,27);
  assert.equal(DB.prepare("SELECT COUNT(*) AS n FROM ml_link_batch_ineligible WHERE batch_id=?").bind(batch.batch.id).first().n,2);
  const saved=await readLinkBatch(env,batch.batch.id);
  assert.equal(saved.batch.status,'imported');
  assert.equal(saved.items[16].position,17);
  assert.equal(saved.items[16].status,'ineligible');
  assert.equal(saved.items[18].position,19);
  assert.equal(saved.items[18].status,'ineligible');
  assert.equal(saved.items[17].affiliate_url,'https://meli.la/CONVERT18');
  assert.equal(saved.items[19].affiliate_url,'https://meli.la/CONVERT20');
  assert.equal(saved.items[16].affiliate_url,null);
  assert.equal(saved.items[18].affiliate_url,null);
  assert.equal(DB.prepare("SELECT COUNT(*) AS n FROM offers WHERE affiliate_url='https://meli.la/CONVERT20'").first().n,1);
  assert.equal((await listLinkBatches(env)).current,null);
 }finally{DB.close();}
});

test('ignorar duas posições não autoriza apagar essas linhas ou duplicar links',async()=>{
 const {DB,env}=fixture();
 try{
  const batch=await createLinkBatch(env,{text:demo});
  await assert.rejects(importLinkBatch(env,batch.batch.id,{
   links:[{ineligible:true,reason:'program_ineligible'},{affiliate_url:'https://meli.la/ABCDEF12'}],
   owner_confirmation:true,pairing_confirmation:false
  }),/Confirme/);
  await assert.rejects(importLinkBatch(env,batch.batch.id,{
   links:[{affiliate_url:'https://meli.la/ABCDEF12'}],
   owner_confirmation:true,pairing_confirmation:true
  }),/uma linha para CADA produto/);
  await assert.rejects(importLinkBatch(env,batch.batch.id,{
   links:[{ineligible:true,reason:'ineligible'},{affiliate_url:'https://meli.la/ABCDEF12'}],
   owner_confirmation:true,pairing_confirmation:true
  }),/justificativa/);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM offers').first().n,0);
  assert.equal((await readLinkBatch(env,batch.batch.id)).batch.status,'awaiting_links');
 }finally{DB.close();}
});
