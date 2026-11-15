import test from 'node:test';
import assert from 'node:assert/strict';
import {formatOfferMessage,telegramPayload,escapeTelegramHtml} from '../src/logic.js';

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
