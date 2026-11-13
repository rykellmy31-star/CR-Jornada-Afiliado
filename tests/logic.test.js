import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAffiliateUrl, normalizeOffer, parseOptionalBRL, shouldSend, localTimeParts, composeOfferMessage, telegramPayload } from '../src/logic.js';

test('aceita link curto real informado pelo proprietário', () => {
  assert.equal(validateAffiliateUrl('https://meli.la/2bsHW5y'), 'https://meli.la/2bsHW5y');
});
test('bloqueia links falsificados, comuns e sem HTTPS', () => {
  for (const link of [
    'https://meli.la.evil.com/2bsHW5y', 'http://meli.la/2bsHW5y',
    'https://mercadolivre.com.br/p/MLB123', 'https://example.com/offer',
    'https://meli.la@evil.com/2bsHW5y', 'https://meli.la:444/2bsHW5y'
  ]) assert.throws(() => validateAffiliateUrl(link), undefined, link);
});
test('só aceita oferta com confirmação do dono da conta', () => {
  const data = { title:'Base Bauleto GOW', affiliate_url:'https://meli.la/2bsHW5y', price:'54.90', old_price:'79.90', owner_confirmation:true };
  assert.equal(normalizeOffer(data).price_cents, 5490);
  assert.throws(() => normalizeOffer({...data,owner_confirmation:false}));
});
test('parsing de preços rejeita valores inválidos', () => {
  assert.equal(parseOptionalBRL('19.99'),1999);
  assert.equal(parseOptionalBRL(''),null);
  assert.throws(() => parseOptionalBRL('-1'));
  assert.throws(() => parseOptionalBRL('19.999'));
});
test('respeita botão de pausa, limites e intervalo',()=>{
  const s={automation_enabled:1,telegram_enabled:1,channel_registered:1,start_hour:0,end_hour:24,max_daily:12,interval_minutes:30};
  const now=new Date('2026-11-12T15:00:00Z');
  assert.equal(shouldSend(s,now,0,null),true);
  assert.equal(shouldSend({...s,automation_enabled:0},now,0,null),false);
  assert.equal(shouldSend(s,now,12,null),false);
  assert.equal(shouldSend(s,now,2,now.getTime()-5*60_000),false);
  assert.equal(shouldSend(s,now,2,now.getTime()-31*60_000),true);
  assert.equal(localTimeParts(now).hour,12);
});
test('mensagem contém aviso de publicidade e URL fica no botão, sem inventar preço atual',()=>{
  const offer={title:'Base Bauleto GOW 33 litros',affiliate_url:'https://meli.la/2bsHW5y',price_cents:5490,old_price_cents:7990,created_at:1000};
  const payload=telegramPayload(offer,'@achadinhosmlcr',Date.parse('2026-11-12T15:00:00Z'));
  assert.match(payload.text,/Publicidade/);
  assert.doesNotMatch(payload.text,/54,90/); // Preço informado há muito tempo não é tratado como atual
  assert.equal(payload.reply_markup.inline_keyboard[0][0].url,'https://meli.la/2bsHW5y');
  const recent=composeOfferMessage({...offer,created_at:1794495600},1794495600*1000);
  assert.match(recent,/54,90/);
});
