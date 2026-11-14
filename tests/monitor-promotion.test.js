import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {extractPromotionTerms,promotionDescription,publishedPromotionLines,safePromotionTerms} from '../src/promotion-terms.js';
import {composeOfferMessage} from '../src/logic.js';
import {addMonitorGroup,saveMonitorSettings,ingestMonitorEvent,monitorState,prepareMonitorBatch} from '../src/whatsapp-link-monitor.js';
import {importLinkBatch} from '../src/link-batches.js';
const URL='https://www.mercadolivre.com.br/furadeira-de-impacto/p/MLB12345678';
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
   message:{extendedTextMessage:{text:'🔥 Furadeira de impacto '+text+' '+URL}}}};
}
test('preço antigo, Pix exclusivo e parcelamento preservados sem inventar juros',()=>{
 const t=extractPromotionTerms('De R$ 299,90 por R$ 199,90 somente no Pix. Ou 6x de R$ 40,00 no cartão');
 assert.equal(t.old_price_cents,29990);
 assert.equal(t.price_cents,19990);
 assert.equal(t.payment_mode,'pix_only');
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
