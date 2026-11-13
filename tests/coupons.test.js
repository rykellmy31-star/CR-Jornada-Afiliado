import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCoupon,couponDescription} from '../src/coupons.js';
import {composeOfferMessage} from '../src/logic.js';
const base={offer_id:'3',kind:'code',code:'SUPER10',discount_type:'percent',discount_value:'10',min_cart:'100.00',max_discount:'25.00',start_day:'2026-11-01',end_day:'2026-11-30',source_url:'https://www.mercadolivre.com.br/ofertas/cupons',owner_confirmation:true};
test('cupons somente com fonte oficial e dados validados',()=>{
 const c=normalizeCoupon(base);
 assert.equal(c.offer_id,3);assert.equal(c.discount_value,10);assert.equal(c.min_cart_cents,10000);assert.equal(c.max_discount_cents,2500);
 for(const source_url of ['https://evil.com/x','http://mercadolivre.com.br/cupons','https://mercadolivre.com.br.evil.com/a']) assert.throws(()=>normalizeCoupon({...base,source_url}));
 assert.throws(()=>normalizeCoupon({...base,owner_confirmation:false}));
 assert.throws(()=>normalizeCoupon({...base,end_day:'2026-10-31'}));
 assert.throws(()=>normalizeCoupon({...base,start_day:'2026-02-30'}));
 assert.throws(()=>normalizeCoupon({...base,discount_value:99}));
});
test('cupom entra na mensagem dentro da vigência, desaparece ao expirar',()=>{
 const o={title:'Produto teste',created_at:1794495600,coupon_kind:'code',coupon_code:'SUPER10',coupon_discount_type:'percent',coupon_discount_value:10,coupon_start_day:'2026-11-01',coupon_end_day:'2026-11-30',coupon_min_cart_cents:10000,coupon_max_discount_cents:2500,coupon_owner_confirmed:1};
 assert.deepEqual(couponDescription(o,'2026-10-31'),[]);
 assert.deepEqual(couponDescription(o,'2026-12-01'),[]);
 assert.match(couponDescription(o,'2026-11-12').join(' '),/Compra mínima/);
 assert.match(composeOfferMessage(o,Date.parse('2026-11-12T13:00:00Z')),/SUPER10/);
 assert.doesNotMatch(composeOfferMessage(o,Date.parse('2026-12-01T13:00:00Z')),/SUPER10/);
});
test('cupom por ativação não inventa um código',()=>{
 const c=normalizeCoupon({...base,kind:'activation',code:'',discount_type:'fixed',discount_value:'12.50'});
 assert.equal(c.code,null);assert.equal(c.discount_value,1250);
 assert.match(couponDescription({coupon_kind:'activation',coupon_discount_type:'fixed',coupon_discount_value:1250,coupon_start_day:c.start_day,coupon_end_day:c.end_day,coupon_min_cart_cents:0,coupon_owner_confirmed:1},'2026-11-12').join(' '),/ativação/);
});
