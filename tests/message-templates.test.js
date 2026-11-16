import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {renderMessageTemplate,validateMessageTemplateBody,MESSAGE_DEFAULT_TEXT} from '../src/message-template-engine.js';
import {listMessageTemplates,saveMessageTemplate,saveMessageTemplateSettings,deleteMessageTemplate,withActiveMessageTemplate,previewMessageTemplate} from '../src/message-templates.js';
import {formatOfferMessage,telegramPayload} from '../src/logic.js';
import {renderPage,CLIENT_JS,CSS} from '../src/ui.js';
import worker from '../src/index.js';

function makeDb(){
 const db=new DatabaseSync(':memory:');
 const DB={prepare(sql){
  let args=[];
  return {bind(...values){args=values;return this;},
   first(){return db.prepare(sql).get(...args)||null;},
   all(){return {results:db.prepare(sql).all(...args)};},
   run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}}
 }};
 return {env:{DB},close:()=>db.close()};
}
function example(at=Math.floor(Date.now()/1000)){
 return {
  id:1,title:'Ferramentas para casa e oficina',
  affiliate_url:'https://promoml.app/AbCdEf123_-X',
  promo_captured_at:at,created_at:at,
  promo_terms_json:JSON.stringify({
   price_source:'mercadolivre',price_cents:3482,old_price_cents:4990,
   payment_mode:'unspecified',installments:3,installment_cents:1161,
   installments_no_interest:true,card_price_cents:null,coupon_required:false,coupon_code:null
  })
 };
}
test('modelo personalizado preenche os dados do anúncio, mas nunca muda link ou inventa parcelas',()=>{
 const at=Date.now(),input=example(Math.floor(at/1000));
 const wa=renderMessageTemplate(input,MESSAGE_DEFAULT_TEXT,{network:'whatsapp',now:at,random:()=>0});
 assert.match(wa,/Ferramentas para casa e oficina/);
 assert.match(wa,/R\$ 34,82/);
 assert.match(wa,/R\$ 49,90/);
 assert.match(wa,/3x de R\$ 11,61 sem juros/);
 assert.match(wa,/https:\/\/promoml.app\/AbCdEf123_-X/);
 assert.ok(!wa.includes('{CUPOM}'));
 assert.ok(!wa.includes('{PARCELAMENTO}'));
 assert.ok(!wa.includes('🎟️ '),'sem cupom não deve mostrar linha de cupom');
 assert.equal(input.affiliate_url,'https://promoml.app/AbCdEf123_-X');
 const out=renderMessageTemplate(input,MESSAGE_DEFAULT_TEXT,{network:'telegram',now:at});
 assert.match(out,/<b>Ferramentas para casa e oficina<\/b>/);
 assert.match(out,/<s>R\$ 49,90<\/s>/);
});
test('preço vencido, desconto não comprovado e parcelamento indefinido somem por completo',()=>{
 const t=Date.now(),p=example(Math.floor(t/1000)-7*3600);
 let msg=renderMessageTemplate(p,MESSAGE_DEFAULT_TEXT,{network:'whatsapp',now:t});
 assert.ok(!msg.includes('R$ 34,82'));
 assert.ok(!msg.includes('3x de'));
 assert.ok(!msg.includes('De:'));
 assert.ok(msg.includes('https://promoml.app/'));
 const current=example(Math.floor(t/1000));
 current.promo_terms_json=JSON.stringify({...JSON.parse(current.promo_terms_json),
  old_price_cents:null,installments:null,installment_cents:null,installments_no_interest:false});
 msg=renderMessageTemplate(current,MESSAGE_DEFAULT_TEXT,{network:'whatsapp',now:t});
 assert.match(msg,/R\$ 34,82/);
 assert.ok(!msg.includes('De:'));
 assert.ok(!msg.includes('Parcelamento'));
 assert.ok(!msg.includes('{PRECO_ANTIGO}'));
});
test('HTML de produto não escapa para Telegram, editor exige link e admite frases alternativas',()=>{
 const at=Date.now(),p=example(Math.floor(at/1000));
 p.title='<img src=x onerror=alert(1)> & Kit';
 const body='📣 Publicidade •\n{Achadinho do dia 🔥|Corre que baixou!}\n🛒 *{NOME_DO_PRODUTO}*\n🔥 {PRECO_NOVO}\n{LINK}';
 const tg=renderMessageTemplate(p,body,{network:'telegram',now:at,random:()=>0});
 assert.match(tg,/Achadinho do dia/);
 assert.match(tg,/&lt;img/);
 assert.ok(!tg.includes('<img'));
 assert.throws(()=>validateMessageTemplateBody('Oferta sem {LINK} com detalhes suficientes para venda.'),/\{LINK\}/);
 assert.throws(()=>validateMessageTemplateBody('Produto e preço {INVENTADO} + {LINK} estão aqui.'),/desconhecida/);
 assert.equal(renderMessageTemplate(p,body,{network:'whatsapp',now:at,maxLength:30}),null);
});
test('modelos são salvos por plataforma e não mudam os anúncios até a ativação expressa',async()=>{
 const {env,close}=makeDb();
 try{
  const list=await listMessageTemplates(env,'mercadolivre');
  assert.equal(list.enabled,false);
  assert.equal(list.templates.length,1);
  assert.equal((await listMessageTemplates(env,'shopee')).enabled,false);
  const p=example();
  assert.equal((await withActiveMessageTemplate(env,p)).message_template,undefined);
  const variant='📣 Publicidade •\n🔥 {NOME_DO_PRODUTO}\n💰 {PRECO_NOVO}\n➡️ {LINK}';
  const saved=await saveMessageTemplate(env,{platform:'mercadolivre',id:0,name:'Oferta padrão automática',body:variant});
  assert.equal(saved.templates.length,2);
  await saveMessageTemplateSettings(env,{platform:'mercadolivre',active_template_id:saved.id,enabled:true});
  const offer=await withActiveMessageTemplate(env,p);
  assert.equal(offer.message_template,variant);
  assert.ok(formatOfferMessage(offer,{network:'whatsapp',now:Date.now(),includeLink:true}).includes('➡️'));
  const button=telegramPayload(offer,'@test',Date.now(),{includeLink:true});
  assert.equal(button.reply_markup.inline_keyboard[0][0].url,p.affiliate_url);
  assert.ok(button.text.includes('Oferta')||button.text.includes('Ferramentas'));
  assert.equal((await withActiveMessageTemplate(env,p,'shopee')).message_template,undefined);
  await saveMessageTemplateSettings(env,{platform:'mercadolivre',active_template_id:saved.id,enabled:false});
  assert.equal((await withActiveMessageTemplate(env,p)).message_template,undefined);
  await deleteMessageTemplate(env,{platform:'mercadolivre',id:saved.id});
  assert.equal((await listMessageTemplates(env,'mercadolivre')).templates.length,1);
 }finally{close();}
});
test('tela MODELOS DE MENSAGENS integrada à navegação, prévia e API protegidas',async()=>{
 const html=renderPage();
 assert.match(html,/data-panel="templates"/);
 assert.match(html,/id="message-templates-page"/);
 assert.match(html,/id="mt-body"/);
 assert.match(html,/id="mt-platform"/);
 assert.match(CSS,/\.mt-preview/);
 assert.match(CLIENT_JS,/selectedPage==='templates'/);
 const preview=previewMessageTemplate({platform:'mercadolivre',body:MESSAGE_DEFAULT_TEXT});
 assert.match(preview.whatsapp,/R\$ 34,82/);
 assert.match(preview.whatsapp,/promoml.app/);
 const {env,close}=makeDb();
 try{
  const unauthorized=await worker.fetch(new Request('https://bot.crjornada.com/api/message-templates?platform=mercadolivre'),{...env,ADMIN_PASSWORD:'local test password',SESSION_SECRET:'test-secret'});
  assert.equal(unauthorized.status,401);
 }finally{close();}
});
