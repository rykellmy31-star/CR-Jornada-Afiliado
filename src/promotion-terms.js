// Extração conservadora de condições informadas por terceiros nos grupos de ofertas.
const AMOUNT='(?:\\d{1,6}(?:\\.\\d{3})*(?:,\\d{2})?|\\d{1,5}\\.\\d{2})';
const rPrice=new RegExp('R\\$\\s*('+AMOUNT+')(?![\\d,.])','gi');
const rDePor=new RegExp('\\bde\\s*[:=-]?\\s*[~*_]*\\s*R\\$\\s*[~*_]*\\s*('+AMOUNT+')\\s*[~*_]*[^\\p{L}\\d]{0,28}\\bpor\\s*[:=-]?\\s*[~*_]*\\s*R\\$\\s*[~*_]*\\s*('+AMOUNT+')','iu');
const rPor=new RegExp('\\b(?:por|agora|apenas|s[oó]\\s+hoje)\\s*(?:[:=-]\\s*)?[~*_]*\\s*R\\$\\s*[~*_]*\\s*('+AMOUNT+')','i');
// O preço condicionado a cupom prevalece sobre o preço normal anunciado.
const rWithCoupon=new RegExp('\\bcom\\s+(?:o\\s+)?cupom\\b[^\\dA-Za-z]{0,24}R\\$\\s*('+AMOUNT+')','i');
const rCouponAfter=new RegExp('R\\$\\s*('+AMOUNT+')\\s*(?:com\\s+(?:o\\s+)?cupom|usando\\s+(?:o\\s+)?cupom)\\b','i');
const rCouponCode=/\b(?:cupom|c[oó]digo)(?:\s+de\s+desconto)?\s*[:=\-]\s*([A-Za-z0-9][A-Za-z0-9_-]{3,31})\b/i;
const rPix=new RegExp('R\\$\\s*('+AMOUNT+')\\s*(?:somente|apenas|s[oó]|exclusiv[oa])?\\s*(?:no|via|pelo|para|em)\\s+pix','i');
const rCard=new RegExp('R\\$\\s*('+AMOUNT+')\\s*(?:no|pelo|via|em)\\s+(?:cart[aã]o|cr[eé]dito)','i');
const rInstallment=new RegExp('\\b(\\d{1,2})\\s*x\\s*(?:de\\s*)?R\\$\\s*('+AMOUNT+')','i');
const rOnlyInstallment=/\b(\d{1,2})\s*x\s*(?:sem\s+juros)?\b/i;
const rDePorNoSymbol=/\bde\s*[:=-]?\s*[~*_]*\s*(\d{1,5},\d{2})\s*[~*_]*[^\p{L}\d]{0,28}\bpor\s*[:=-]?\s*[~*_]*\s*(\d{1,5},\d{2})/iu;
const rByNoSymbol=/\b(?:pre[cç]o|valor|por|agora|apenas)\s*[:=]\s*[~*_]*\s*(\d{1,5},\d{2})(?![\d,.])/i;
export const MAX_AGE_MS=6*60*60*1000;
export function moneyCents(value){
 const str=String(value||'');
 if(!/^(?:\d{1,6}(?:\.\d{3})*(?:,\d{2})?|\d{1,5}\.\d{2})$/.test(str))return null;
 const decimalDot=/^\d{1,5}\.\d{2}$/.test(str)&&!str.includes(',');
 const n=Math.round(Number(decimalDot?str:str.replace(/\./g,'').replace(',','.'))*100);
 return Number.isSafeInteger(n)&&n>0&&n<=99999999?n:null;
}
const real=cents=>Number.isSafeInteger(cents)&&cents>0&&cents<=99999999;
const brl=value=>(value/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}).replace(/\u00a0/g,' ');
export function extractPromotionTerms(input){
 if(typeof input!=='string')return null;
 // A legenda pode ter preço ao final, depois de vários textos/links.
 const text=input.replace(/[＄﹩]/g,'$')
  .replace(/https:\/\/[^\s<>"']+/gi,' ').replace(/\s+/g,' ').slice(0,16000);
 if(!text.trim())return null;
 const pair=text.match(rDePor),pairNoSymbol=!pair?text.match(rDePorNoSymbol):null;
 const by=text.match(rPor),byNoSymbol=!by&&!pair&&!pairNoSymbol?text.match(rByNoSymbol):null;
 const pixPrice=text.match(rPix);
 const couponMatch=text.match(rWithCoupon)||text.match(rCouponAfter);
 const couponCents=couponMatch?moneyCents(couponMatch[1]):null;
 const couponCodeMatch=text.match(rCouponCode);
 const couponCode=couponCodeMatch?couponCodeMatch[1].toUpperCase():null;
 const installmentPrice=text.match(rInstallment);
 const rawCardPrice=text.match(rCard);
 // Não confunda o valor de uma parcela com o preço total no cartão.
 const cardPrice=rawCardPrice&&installmentPrice&&rawCardPrice.index>=installmentPrice.index&&rawCardPrice.index<installmentPrice.index+installmentPrice[0].length?null:rawCardPrice;
 const installment=installmentPrice||text.match(rOnlyInstallment);
 const times=installment?Number(installment[1]):null;
 const validTimes=Number.isInteger(times)&&times>=2&&times<=24?times:null;
 const partCents=installmentPrice&&validTimes?moneyCents(installmentPrice[2]):null;
 const offers=[...text.matchAll(rPrice)].filter(x=>!/\b\d{1,2}\s*x\s*(?:de\s*)?$/i.test(text.slice(Math.max(0,x.index-18),x.index))).map(x=>moneyCents(x[1])).filter(real);
 let price=null,old=null;
 if(real(couponCents)){
   price=couponCents;
   // O preço de referência só é seguro quando está explícito e é maior.
   const beforeCoupon=pair?moneyCents(pair[1]):null;
   if(real(beforeCoupon)&&beforeCoupon>price)old=beforeCoupon;
 }else if(pair||pairNoSymbol){
   const picked=pair||pairNoSymbol;
   old=moneyCents(picked[1]);price=moneyCents(picked[2]);
   if(!real(old)||!real(price)||old<=price){old=null;price=null;}
 } else if(by){price=moneyCents(by[1]);}
 else if(byNoSymbol){
   const left=text.slice(Math.max(0,byNoSymbol.index-12),byNoSymbol.index);
   if(!/\b\d{1,2}\s*x\s*$/i.test(left))price=moneyCents(byNoSymbol[1]);
 }
 else if(pixPrice){price=moneyCents(pixPrice[1]);}
 else if(cardPrice){price=moneyCents(cardPrice[1]);}
 else if(offers.length===1){price=offers[0];}
 const pix=/\bpix\b/i.test(text);
 const onlyPix=/(?:somente|apenas|s[oó]|exclusiv[oa])\s+(?:no|via|pelo|para|em)\s+pix/i.test(text)
   ||/\bpix\s+(?:somente|apenas)\b/i.test(text);
 const card=/(?:cart[aã]o|cr[eé]dito)/i.test(text);
 const interestFree=validTimes!==null&&/\bsem\s+juros\b/i.test(text);
 const paymentMode=onlyPix?'pix_only':pix?'pix':card?'card':'unspecified';
 const explicitCardPrice=cardPrice?moneyCents(cardPrice[1]):null;
 const cardPriceCents=(pix&&real(explicitCardPrice)&&explicitCardPrice!==price)?explicitCardPrice:null;
 if(!real(price)&&!validTimes&&!real(cardPriceCents))return null;
 return {price_cents:real(price)?price:null,old_price_cents:real(old)?old:null,
   coupon_required:real(couponCents),coupon_code:real(couponCents)?couponCode:null,
   payment_mode:paymentMode,installments:validTimes,installment_cents:real(partCents)?partCents:null,
   installments_no_interest:interestFree,card_price_cents:real(cardPriceCents)?cardPriceCents:null};
}
export function safePromotionTerms(value){
 let t;try{t=typeof value==='string'?JSON.parse(value):value;}catch{return null;}
 if(!t||typeof t!=='object'||Array.isArray(t))return null;
 const numeric=k=>t[k]===null||real(t[k]);
 const inRange=t.installments===null||(Number.isInteger(t.installments)&&t.installments>=2&&t.installments<=24);
 if(!numeric('price_cents')||!numeric('old_price_cents')||!numeric('installment_cents')||
    !numeric('card_price_cents')||!inRange||
    !['unspecified','pix','pix_only','card'].includes(t.payment_mode)||
    typeof t.installments_no_interest!=='boolean'||
    (t.coupon_required!==undefined&&typeof t.coupon_required!=='boolean')||
    (t.coupon_code!==undefined&&t.coupon_code!==null&&!/^[A-Za-z0-9][A-Za-z0-9_-]{3,31}$/.test(t.coupon_code))||
    (t.price_source!==undefined&&!['mercadolivre','grupo'].includes(t.price_source)))return null;
 return t;
}
export function promotionDescription(value){
 const t=safePromotionTerms(value);
 if(!t)return [];
 const out=[];
 if(real(t.price_cents)){
  if(t.price_source==='mercadolivre')out.push('🏬 Preço público consultado no Mercado Livre: '+brl(t.price_cents));
  else if(real(t.old_price_cents)&&t.old_price_cents>t.price_cents)
   out.push('🏷️ Oferta anunciada no grupo: de '+brl(t.old_price_cents)+' por '+brl(t.price_cents));
  else out.push('💰 Preço anunciado no grupo: '+brl(t.price_cents));
 }
 if(t.coupon_required===true){
  out.push('🎟️ Preço anunciado condicionado ao uso de cupom');
  if(t.coupon_code)out.push('🏷️ Cupom informado: '+t.coupon_code);
 }
 if(t.payment_mode==='pix_only')out.push('💠 Condição anunciada: somente no Pix');
 else if(t.payment_mode==='pix')out.push('💠 Condição anunciada: no Pix');
 else if(t.payment_mode==='card'&&t.installments===null)out.push('💳 Condição anunciada: no cartão');
 if(real(t.card_price_cents))out.push('💳 Preço anunciado no cartão: '+brl(t.card_price_cents));
 if(t.installments!==null){
   out.push('💳 Parcelamento anunciado: '+t.installments+'x'+(real(t.installment_cents)?' de '+brl(t.installment_cents):'')+
     (t.installments_no_interest?' sem juros':'')+' no cartão');
 }
 return out;
}
export function publishedPromotionLines(offer,now=Date.now()){
 const captured=Number(offer?.promo_captured_at);
 if(!Number.isSafeInteger(captured)||captured<=0||now-captured*1000<0||now-captured*1000>MAX_AGE_MS)return null;
 const terms=safePromotionTerms(offer?.promo_terms_json);
 const lines=promotionDescription(terms);
 const note=terms?.price_source==='mercadolivre'
  ?'ℹ️ Valor público consultado no Mercado Livre; cupom, frete ou Pix podem mudar o preço. Confirme na loja.'
  :'ℹ️ Condições informadas por terceiros. Confirme preço e disponibilidade na loja.';
 return lines.length?[...lines,note]:null;
}
