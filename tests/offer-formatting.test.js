import test from 'node:test';
import assert from 'node:assert/strict';
import {formatOfferMessage,telegramPayload,escapeTelegramHtml} from '../src/logic.js';
import {officialPriceOverlay} from '../src/automatic-price.js';

const NOW=Date.parse('2026-11-15T13:00:00Z');
const offer={
  id:8,title:'Sabonete Natura Tododia Alecrim e Sálvia 5 unidades de 90g',
  affiliate_url:'https://meli.la/Afiliado123',
  price_cents:2999,old_price_cents:3999,created_at:NOW/1000
};

test('WhatsApp entrega título em negrito, preço anterior riscado e link inteiro',()=>{
 const text=formatOfferMessage(offer,{network:'whatsapp',includeLink:true,now:NOW});
 assert.match(text,/\*Sabonete Natura/);
 assert.match(text,/❌ De: ~R\$\s*39,99~/);
 assert.match(text,/🔥 \*Por R\$\s*29,99\*/);
 assert.match(text,/Publicidade/);
 assert.ok(text.endsWith(offer.affiliate_url),'URL não pode ser cortada ou modificada');
 assert.doesNotMatch(text,/SÓ ATÉ HOJE|somente hoje/i);
});

test('Telegram usa tags HTML válidas, com botão original e escape do nome',()=>{
 const special={...offer,title:'Produto <bom> & melhor *leve*',affiliate_url:'https://mercadolivre.com.br/?ref=owner&a=2'};
 const data=telegramPayload(special,'@canal',NOW);
 assert.equal(data.parse_mode,'HTML');
 assert.match(data.text,/Produto &lt;bom&gt; &amp; melhor/);
 assert.match(data.text,/<s>R\$\s*39,99<\/s>/);
 assert.match(data.text,/<b>Por R\$\s*29,99<\/b>/);
 assert.equal(data.reply_markup.inline_keyboard[0][0].url,special.affiliate_url);
 assert.doesNotMatch(data.text,/<bom>/);
 const withLink=telegramPayload(special,'@canal',NOW,{includeLink:true});
 assert.match(withLink.text,/ref=owner&amp;a=2/);
 assert.equal(escapeTelegramHtml('A & B <3'),'A &amp; B &lt;3');
});

test('Preços antigos não são reciclados e mensagem não inventa escassez',()=>{
 const old={...offer,created_at:(NOW-7*3600_000)/1000};
 const wa=formatOfferMessage(old,{network:'whatsapp',now:NOW,includeLink:true});
 assert.doesNotMatch(wa,/29,99|39,99/);
 assert.match(wa,/Consulte o preço atualizado na loja/);
 assert.doesNotMatch(wa,/últimas unidades|só hoje|restam/i);
});

test('Fonte de grupos usa condição informada e acrescenta aviso de terceiros',()=>{
 const item={...offer,
  promo_terms_json:JSON.stringify({price_cents:2999,old_price_cents:3999,
    coupon_required:false,coupon_code:null,payment_mode:'unspecified',installments:null,
    installment_cents:null,installments_no_interest:false,card_price_cents:null}),
  promo_captured_at:NOW/1000};
 const text=formatOfferMessage(item,{network:'whatsapp',now:NOW,includeLink:true});
 assert.match(text,/~R\$\s*39,99~/);
 assert.match(text,/Por R\$\s*29,99/);
 assert.match(text,/terceiros/);
 const stale=formatOfferMessage({...item,promo_captured_at:(NOW-8*3600_000)/1000},
   {network:'whatsapp',now:NOW,includeLink:true});
 assert.doesNotMatch(stale,/29,99|39,99/);
});

test('Shopee mantém formatação e URL sem usar link de outra loja',()=>{
 const item={...offer,affiliate_url:'https://shopee.com.br/produto-afiliado'};
 const wa=formatOfferMessage(item,{platform:'shopee',network:'whatsapp',now:NOW,includeLink:true});
 const tg=formatOfferMessage(item,{platform:'shopee',network:'telegram',now:NOW,includeLink:true});
 assert.match(wa,/~R\$\s*39,99~/);
 assert.match(tg,/<s>R\$\s*39,99<\/s>/);
 assert.ok(wa.endsWith(item.affiliate_url));
 assert.ok(tg.endsWith(item.affiliate_url));
});

test('Legendas longas descartam detalhes opcionais sem quebrar markup obrigatório',()=>{
 const item={...offer,coupon_kind:'code',coupon_owner_confirmed:1,
  coupon_code:'NATURA10',coupon_discount_type:'percent',coupon_discount_value:10,
  coupon_min_cart_cents:0,coupon_max_discount_cents:1000,
  coupon_start_day:'2026-11-01',coupon_end_day:'2026-11-30'};
 const text=formatOfferMessage(item,{network:'telegram',now:NOW,maxLength:300});
 assert.ok(text.length<=300);
 assert.equal((text.match(/<b>/g)||[]).length,(text.match(/<\/b>/g)||[]).length);
 assert.equal((text.match(/<s>/g)||[]).length,(text.match(/<\/s>/g)||[]).length);
 assert.match(text,/Publicidade/);
 const withUrl=formatOfferMessage(item,{network:'whatsapp',now:NOW,includeLink:true,maxLength:300});
 assert.ok(withUrl.endsWith(item.affiliate_url));
});

test('mensagem padrão única usa preços do anúncio, parcelamento confirmado e link em ambas as redes',()=>{
 const item=officialPriceOverlay({...offer,title:'Tapete antiderrapante para banheiro'},
  {price_cents:3482,old_price_cents:4990,payment_mode:'card',
   installments:3,installment_cents:1161,installments_no_interest:true},NOW/1000);
 const wa=formatOfferMessage(item,{network:'whatsapp',includeLink:true,now:NOW});
 const tg=telegramPayload(item,'@canal',NOW,{includeLink:true});
 assert.ok(wa.startsWith('📣 Publicidade •\n\n*✨ CONFIRA ESTA OFERTA!*'));
 assert.ok(tg.text.startsWith('📣 Publicidade •\n\n<b>✨ CONFIRA ESTA OFERTA!</b>'));
 for(const text of [wa,tg.text]){
  assert.match(text,/Tapete antiderrapante para banheiro/);
  assert.match(text,/De: .*R\$\s*49,90/);
  assert.match(text,/Por R\$\s*34,82/);
  assert.match(text,/Parcelamento: 3x de R\$\s*11,61 sem juros/);
  assert.match(text,/✅ Confira preço, disponibilidade e condições antes de comprar/);
  assert.match(text,/Publicidade • link de afiliado/);
  assert.match(text,/Comprar pelo meu link:/);
  assert.match(text,/https:\/\/meli\.la\/Afiliado123/);
  assert.doesNotMatch(text,/Preço público consultado no Mercado Livre/);
 }
 assert.equal(tg.reply_markup.inline_keyboard[0][0].url,item.affiliate_url);
 assert.ok(tg.text.length<=1024);
});


test('nome com De/Por embutidos vira título limpo com preços destacados, sem contradição',()=>{
 const now=Date.parse('2026-11-15T20:45:00Z');
 const item={
  title:'Smart Tv Aoc Dled 32 Wi-fi Roku Tv Quad Core 32s5155/78g De: R$ 1.244,41 Por: R$ 959,90 (23% OFF) Compre Aqui:',
  affiliate_url:'https://meli.la/1xmGr6U',created_at:now/1000,price_cents:null,old_price_cents:null
 };
 const wa=formatOfferMessage(item,{network:'whatsapp',now,includeLink:true});
 const tg=telegramPayload(item,'@achadinhosmlcr',now,{includeLink:true});
 for(const txt of [wa,tg.text]){
  assert.match(txt,/Smart Tv Aoc Dled 32 Wi-fi Roku Tv Quad Core 32s5155\/78g/);
  assert.doesNotMatch(txt,/Compre Aqui:/);
  assert.doesNotMatch(txt,/Consulte o preço atualizado na loja/);
  assert.match(txt,/R\$\s*1\.244,41/);
  assert.match(txt,/R\$\s*959,90/);
  assert.match(txt,/Confira na loja/);
 }
 assert.match(wa,/~R\$\s*1\.244,41~/);
 assert.match(tg.text,/<s>R\$\s*1\.244,41<\/s>/);
 assert.ok(wa.endsWith('https://meli.la/1xmGr6U'));
 const stale=formatOfferMessage({...item,created_at:(now-8*3600_000)/1000},
  {network:'whatsapp',now,includeLink:true});
 assert.doesNotMatch(stale,/1\.244,41|959,90|Compre Aqui:/);
 assert.match(stale,/Consulte o preço atualizado na loja/);
});

