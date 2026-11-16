import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {extractPromotionTerms,promotionDescription,publishedPromotionLines,safePromotionTerms} from '../src/promotion-terms.js';
import {composeOfferMessage} from '../src/logic.js';
import {addMonitorGroup,saveMonitorSettings,ingestMonitorEvent,monitorState,prepareMonitorBatch,resolveMonitorShortlinks,recoverMissingMonitorPrices} from '../src/whatsapp-link-monitor.js';
import {importLinkBatch} from '../src/link-batches.js';
const PRODUCT_URL='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){let values=[];return {
    bind(...args){values=args;return this;},
    first(){return db.prepare(sql).get(...values)||null;},
    all(){return {results:db.prepare(sql).all(...values)};},
    run(){const r=db.prepare(sql).run(...values);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
   };},
   async batch(commands){db.exec('BEGIN');try{const result=commands.map(x=>x.run());db.exec('COMMIT');return result;}
    catch(e){db.exec('ROLLBACK');throw e;}},
   close(){db.close();}
 };
 return {env:{DB,MONITOR_WEBHOOK_TOKEN:'test-webhook-secret-1234567890'},DB};
}
function event(text,id='offer-1'){
 return {event:'messages.upsert',instance:'cr-jornada-afiliados',
   data:{key:{remoteJid:'120363000111222333@g.us',fromMe:false,id},
   message:{extendedTextMessage:{text:'🔥 Furadeira de impacto '+text+' '+PRODUCT_URL}}}};
}
test('preço antigo, Pix exclusivo e parcelamento preservados sem inventar juros',()=>{
 const t=extractPromotionTerms('De R$ 299,90 por R$ 199,90 somente no Pix. Ou 6x de R$ 40,00 no cartão');
 assert.equal(t.old_price_cents,29990);
 assert.equal(t.price_cents,19990);
 assert.equal(t.payment_mode,'pix_only');
 assert.equal(t.card_price_cents,null);
 assert.equal(t.installments,6);
 assert.equal(t.installment_cents,4000);
 assert.equal(t.installments_no_interest,false);
 const lines=promotionDescription(t).join('\n');
 assert.match(lines,/de R\$ 299,90 por R\$ 199,90/);
 assert.match(lines,/somente no Pix/);
 assert.match(lines,/6x de R\$ 40,00/);
 assert.doesNotMatch(lines,/sem juros/);
});
test('oferta em parcelas sem juros e preços distintos Pix/cartão',()=>{
 const a=extractPromotionTerms('R$ 179,90 no Pix ou R$ 199,90 no cartão em até 10x sem juros');
 assert.equal(a.price_cents,17990);
 assert.equal(a.card_price_cents,19990);
 assert.equal(a.installments,10);
 assert.equal(a.installment_cents,null);
 assert.equal(a.installments_no_interest,true);
 assert.match(promotionDescription(a).join(' '),/Preço anunciado no cartão: R\$ 199,90/);
 assert.match(promotionDescription(a).join(' '),/10x sem juros/);
 const b=extractPromotionTerms('Promoção: de R$ 400,00 por R$ 299,90 em 6x de R$ 49,98 no cartão');
 assert.equal(b.price_cents,29990);
 assert.equal(b.old_price_cents,40000);
 assert.equal(b.installments,6);
});
test('mensagens sem preço claro não geram oferta falsa nem confirmação de pagamento inexistente',()=>{
 assert.equal(extractPromotionTerms('Oferta por tempo limitado, aproveite!'),null);
 const terms=extractPromotionTerms('10x de R$ 29,90 sem juros no cartão');
 assert.equal(terms.price_cents,null);
 assert.equal(terms.installments,10);
 assert.equal(terms.installment_cents,2990);
 assert.equal(terms.installments_no_interest,true);
 assert.equal(safePromotionTerms('{"price_cents":-1}'),null);
 assert.equal(extractPromotionTerms('R$ 10,00 ou R$ 20,00'),null);
});
test('captura condições no monitor e mantém preço antigo mesmo se chegar outra mensagem antes da conversão',async()=>{
 const {env,DB}=fixture();
 try{
  await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',group_jid:'120363000111222333@g.us',group_name:'Grupo autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,event('de R$ 299,90 por R$ 199,90 somente no Pix. Ou 6x de R$ 40,00 no cartão'));
  const state=await monitorState(env);
  assert.equal(state.links[0].last_seen_price_cents,19990);
  assert.match(state.links[0].promotion.join(' '),/6x de R\$ 40,00/);
  const batch=await prepareMonitorBatch(env,{automatic:true});
  let data=DB.prepare('SELECT pending_deal_json,pending_captured_at FROM ml_monitor_product_meta').first();
  assert.equal(JSON.parse(data.pending_deal_json).price_cents,19990);
  assert.ok(data.pending_captured_at>0);
  await ingestMonitorEvent(env,event('Agora por R$ 159,90 somente no Pix','offer-2'));
  data=DB.prepare('SELECT last_seen_deal_json,pending_deal_json FROM ml_monitor_product_meta').first();
  assert.equal(JSON.parse(data.last_seen_deal_json).price_cents,15990);
  assert.equal(JSON.parse(data.pending_deal_json).price_cents,19990);
  await importLinkBatch(env,batch.batch.id,{owner_confirmation:true,pairing_confirmation:true,
   links:[{affiliate_url:'https://meli.la/PROMO1',category:batch.items[0].category}]});
  const offer=DB.prepare('SELECT * FROM offers').first();
  assert.equal(offer.price_cents,19990);
  assert.equal(offer.old_price_cents,29990);
  assert.ok(offer.promo_captured_at>0);
  const published=composeOfferMessage(offer);
  assert.match(published,/somente no Pix/);
  assert.match(published,/6x de R\$ 40,00/);
  assert.match(published,/Condições informadas por terceiros/);
  const old=composeOfferMessage({...offer,promo_captured_at:offer.promo_captured_at-8*60*60});
  assert.doesNotMatch(old,/199,90/);
  assert.doesNotMatch(old,/somente no Pix/);
  assert.equal(DB.prepare('SELECT pending_deal_json FROM ml_monitor_product_meta').first().pending_deal_json,null);
 }finally{DB.close();}
});

test('colchão do print: preço efetivo R$ 199,99 com cupom e não R$ 260,00',()=>{
 const text='COLCHÃO SOLTEIRO CONFORT MAX 188X88 CM LIBÉLULA MÓVEIS 🛏️\n'+
  'de R$260 por R$260\nCOM CUPOM 💥R$199,99💥\n🏷️ cupom: SEMPREOFERTAS\n'+
  '🏡 https://melila.me/MpuhFvqiqmsu • parceria';
 const terms=extractPromotionTerms(text);
 assert.equal(terms.price_cents,19999);
 assert.equal(terms.old_price_cents,26000);
 assert.equal(terms.coupon_required,true);
 assert.equal(terms.coupon_code,'SEMPREOFERTAS');
 const description=promotionDescription(terms).join(' | ');
 assert.match(description,/de R\$ 260,00 por R\$ 199,99/);
 assert.match(description,/condicionado ao uso de cupom/);
 assert.match(description,/SEMPREOFERTAS/);
});
test('preço comum não deve ser confundido com cupom e anúncio sem desconto explícito continua prudente',()=>{
 const regular=extractPromotionTerms('Camiseta Oversized: De R$ 109 por R$ 43');
 assert.equal(regular.price_cents,4300);
 assert.equal(regular.old_price_cents,10900);
 assert.equal(regular.coupon_required,false);
 assert.equal(extractPromotionTerms('de R$260 por R$260'),null);
 assert.equal(extractPromotionTerms('R$ 10,00 ou R$ 20,00'),null);
 const voucher=extractPromotionTerms('Oferta: COM CUPOM R$ 199,99');
 assert.equal(voucher.price_cents,19999);
 assert.equal(voucher.coupon_required,true);
 assert.equal(voucher.coupon_code,null);
});
test('link encurtado em foto longa mantém preço e cupom até resolver produto',async()=>{
 const {env,DB}=fixture();
 const oldFetch=globalThis.fetch;
 try{
  await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',
   group_jid:'120363000111222333@g.us',group_name:'ACHADINHOS DA INTERNET',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const longIntro='💖 Colchão solteiro confort max 188x88 CM Libélula Móveis — '+('aproveite hoje '.repeat(20));
  assert.ok(longIntro.length>180);
  const url='https://melila.me/MpuhFvqiqmsu';
  const caption=longIntro+' de R$260 por R$260 COM CUPOM 💥R$199,99💥 cupom: SEMPREOFERTAS '+url;
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
   data:{key:{remoteJid:'120363000111222333@g.us',fromMe:false,id:'LONG-CAPTION-001'},
   message:{imageMessage:{caption}}}});
  const saved=DB.prepare('SELECT message_hint FROM ml_monitor_shortlinks').first();
  assert.ok(saved.message_hint.length>180);
  assert.match(saved.message_hint,/SEMPREOFERTAS/);
  globalThis.fetch=async target=>{
   assert.equal(String(target),url);
   return new Response('',{status:302,headers:{location:PRODUCT_URL}});
  };
  const resolved=await resolveMonitorShortlinks(env);
  assert.equal(resolved.resolved,1);
  const state=await monitorState(env);
  assert.equal(state.links[0].last_seen_price_cents,19999);
  assert.match(state.links[0].promotion.join(' '),/SEMPREOFERTAS/);
  assert.equal(JSON.parse(DB.prepare('SELECT last_seen_deal_json FROM ml_monitor_product_meta').first().last_seen_deal_json).coupon_required,true);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});

test('Polly Pocket da captura: reconhece De: e Por: com emojis e preço antigo',()=>{
 const caption='🧸 Polly Pocket Conjunto Compacto Ursinhos | 🧸 MUNDO DE BOLSO | Mattel 💥'+
  '\n💰 De: R$ 149,99\n🔥 Por: R$ 91,10\n🛒 Link para Comprar: https://melila.me/AAJLUPqiqmsu'+
  '\n🚀 Participe do grupo: https://chat.whatsapp.com/DUTTeYM7qcvHatrqFklI4m';
 const offer=extractPromotionTerms(caption);
 assert.equal(offer.price_cents,9110);
 assert.equal(offer.old_price_cents,14999);
 assert.equal(offer.coupon_required,false);
 assert.match(promotionDescription(offer).join(' '),/de R\$ 149,99 por R\$ 91,10/);
});
test('corrige automaticamente preço faltando de produto já captado sem recadastrar',async()=>{
 const {env,DB}=fixture(),originalFetch=globalThis.fetch;
 const short='https://melila.me/AAJLUPqiqmsu',priceCaption='🧸 Polly Pocket\n💰 De: R$ 149,99\n🔥 Por: R$ 91,10\n'+short;
 try{
  await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',group_jid:'120363000111222333@g.us',group_name:'ACHADINHOS DA INTERNET',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',data:{
   key:{remoteJid:'120363000111222333@g.us',fromMe:false,id:'POLLY-PHOTO-01'},
   message:{imageMessage:{caption:priceCaption}}}});
  globalThis.fetch=async url=>{
   assert.equal(String(url),short);
   return new Response('',{status:302,headers:{location:PRODUCT_URL}});
  };
  assert.equal((await resolveMonitorShortlinks(env)).resolved,1);
  const before=await monitorState(env);
  assert.equal(before.links[0].last_seen_price_cents,9110);
  DB.prepare('UPDATE ml_monitor_product_meta SET last_seen_price_cents=NULL,last_seen_deal_json=NULL').run();
  const restored=await monitorState(env);
  assert.equal(restored.links[0].last_seen_price_cents,9110);
  assert.match(restored.links[0].promotion.join(' '),/de R\$ 149,99 por R\$ 91,10/);
  assert.equal(restored.links.length,1);
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
 }finally{globalThis.fetch=originalFetch;DB.close();}
});
test('preço ausente sem legenda salva: recupera somente mensagem original na Evolution',async()=>{
 const {env,DB}=fixture(),oldFetch=globalThis.fetch;
 const short='https://melila.me/AAJLUPqiqmsu',caption='Polly Pocket\nDe: R$149,99 🔥 Por: R$91,10\n'+short;
 env.EVOLUTION_API_URL='https://evolution.crjornada.com';
 env.EVOLUTION_API_KEY='test-key-example';
 try{
  await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',group_jid:'120363000111222333@g.us',group_name:'ACHADINHOS DA INTERNET',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',data:{
   key:{remoteJid:'120363000111222333@g.us',fromMe:false,id:'POLLY-RECOVER-01'},
   message:{imageMessage:{caption}}}});
  globalThis.fetch=async url=>new Response('',{status:302,headers:{location:PRODUCT_URL}});
  assert.equal((await resolveMonitorShortlinks(env)).resolved,1);
  DB.prepare("UPDATE ml_monitor_shortlinks SET message_hint='Polly Pocket'").run();
  DB.prepare("UPDATE ml_monitor_product_meta SET last_seen_price_cents=NULL,last_seen_deal_json=NULL").run();
  let calls=0;
  globalThis.fetch=async (url,options)=>{
   calls++;
   assert.match(String(url),/\/chat\/findMessages\/cr-jornada-afiliados$/);
   assert.equal(JSON.parse(options.body).where.key.id,'POLLY-RECOVER-01');
   return new Response(JSON.stringify({messages:{records:[{
    key:{remoteJid:'120363000111222333@g.us',id:'POLLY-RECOVER-01',fromMe:false},
    message:{imageMessage:{caption}}
   }]}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const result=await recoverMissingMonitorPrices(env,{allowEvolution:true});
  assert.equal(result.recovered,1);
  assert.equal(calls,0,'preço estruturado da mensagem já capturado evita uma nova chamada à Evolution');
  const state=await monitorState(env);
  assert.equal(state.links[0].last_seen_price_cents,9110);
  assert.match(state.links[0].promotion.join(' '),/de R\$ 149,99 por R\$ 91,10/);
  assert.equal(DB.prepare('SELECT COUNT(*) AS total FROM offers').first().total,0);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});


test('preço após 800 caracteres em foto de grupo é preservado até resolver o encurtador',async()=>{
 const {env,DB}=fixture(),oldFetch=globalThis.fetch;
 const short='https://melila.me/AAAFullPrice123';
 const intro='⭐ Oferta verificada pelo grupo. '+('descrição longa do produto '.repeat(53));
 assert.ok(intro.length>800);
 const caption=intro+short+'\nDE: R$ 149,90 🔥 POR: R$ 79,90\nCupom: OFERTA25';
 try{
  await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',
   group_jid:'120363000111222333@g.us',group_name:'Grupo autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const r=await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
   data:{key:{remoteJid:'120363000111222333@g.us',fromMe:false,id:'PRICE-IN-END-01'},
    message:{imageMessage:{caption}}}});
  assert.equal(r.pending,1);
  const stored=DB.prepare('SELECT price_cents,deal_json FROM ml_monitor_message_prices').first();
  assert.equal(stored.price_cents,7990);
  assert.equal(JSON.parse(stored.deal_json).old_price_cents,14990);
  assert.doesNotMatch(DB.prepare('SELECT message_hint FROM ml_monitor_shortlinks').first().message_hint,/79,90/,
   'o resumo histórico continua limitado, mas não deve perder o preço estruturado');
  globalThis.fetch=async url=>{
   assert.equal(String(url),short);
   return new Response(null,{status:302,headers:{location:PRODUCT_URL}});
  };
  assert.equal((await resolveMonitorShortlinks(env)).resolved,1);
  const product=DB.prepare('SELECT last_seen_price_cents,last_seen_deal_json FROM ml_monitor_product_meta').first();
  assert.equal(product.last_seen_price_cents,7990);
  assert.equal(JSON.parse(product.last_seen_deal_json).old_price_cents,14990);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});

test('busca em mensagem antiga da Evolution lê preço após o 800º caractere',async()=>{
 const {env,DB}=fixture(),oldFetch=globalThis.fetch;
 const longText='descrição muito extensa de oferta '.repeat(42);
 try{
  await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',
   group_jid:'120363000111222333@g.us',group_name:'Grupo autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
   data:{key:{remoteJid:'120363000111222333@g.us',fromMe:false,id:'PRICE-HISTORY-99'},
    message:{conversation:'Furadeira especial '+PRODUCT_URL}}});
  env.EVOLUTION_API_URL='https://evo.example.com';
  env.EVOLUTION_API_KEY='test-key';
  globalThis.fetch=async(url,opts)=>{
   assert.match(String(url),/\/chat\/findMessages\/cr-jornada-afiliados$/);
   assert.equal(JSON.parse(opts.body).where.key.id,'PRICE-HISTORY-99');
   return Response.json({messages:{records:[{
    key:{remoteJid:'120363000111222333@g.us',id:'PRICE-HISTORY-99',fromMe:false},
    message:{imageMessage:{caption:longText+PRODUCT_URL+'\nDe: R$ 159,90 🔥 Por: R$ 99,90'}}
   }]}});
  };
  const r=await recoverMissingMonitorPrices(env,{allowEvolution:true});
  assert.equal(r.recovered,1);
  const row=DB.prepare('SELECT last_seen_price_cents,last_seen_deal_json FROM ml_monitor_product_meta').first();
  assert.equal(row.last_seen_price_cents,9990);
  assert.equal(JSON.parse(row.last_seen_deal_json).old_price_cents,15990);
 }finally{globalThis.fetch=oldFetch;DB.close();}
});

test('mensagem com dois produtos não associa um preço a produto incorreto',async()=>{
 const {env,DB}=fixture();
 try{
  await addMonitorGroup(env,{instance_name:'cr-jornada-afiliados',
   group_jid:'120363000111222333@g.us',group_name:'Grupo autorizado',permission_confirmed:true});
  await saveMonitorSettings(env,{enabled:true});
  const another='https://www.mercadolivre.com.br/tenis-casual/p/MLB87654321';
  const r=await ingestMonitorEvent(env,{event:'messages.upsert',instance:'cr-jornada-afiliados',
   data:{key:{remoteJid:'120363000111222333@g.us',fromMe:false,id:'TWO-PRODUCT-PRICE'},
    message:{conversation:'Por R$ 39,90 '+PRODUCT_URL+' ou '+another}}});
  assert.equal(r.captured,2);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM ml_monitor_message_prices').first().n,0);
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM ml_monitor_product_meta WHERE last_seen_price_cents>0').first().n,0);
 }finally{DB.close();}
});

test('interpreta preços em formato internacional e BRL sem símbolo somente com marcador claro',()=>{
 assert.equal(extractPromotionTerms('Oferta do dia por R$ 49.90').price_cents,4990);
 assert.equal(extractPromotionTerms('DE: 129,90 🔥 POR: 79,90').price_cents,7990);
 assert.equal(extractPromotionTerms('Valor: 44,50').price_cents,4450);
 assert.equal(extractPromotionTerms('4x por: 19,90').price_cents,null);
 assert.equal(extractPromotionTerms('sem preço explícito, 3 produtos e 2 links'),null);
});
