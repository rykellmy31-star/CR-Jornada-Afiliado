// Renderizador de modelos para WhatsApp / Telegram.
// Usa SOMENTE dados existentes e recentes; nunca inventa preço, cupom ou parcelamento.
import {MAX_AGE_MS,publishedPromotionLines,safePromotionTerms,moneyCents} from './promotion-terms.js';
import {couponDescription} from './coupons.js';

export const MESSAGE_FIELDS=['NOME_DO_PRODUTO','PRECO_ANTIGO','PRECO_NOVO','DESCONTO','CUPOM','LINK','LINK1','LINKS','PARCELAMENTO','TEXTO_ORIGINAL'];
export const MESSAGE_DEFAULT_TEXT=[
 '📣 Publicidade •','','✨ CONFIRA ESTA OFERTA!','','🛒 *{NOME_DO_PRODUTO}*','',
 '❌ De: ~{PRECO_ANTIGO}~','🔥 Por: *{PRECO_NOVO}*',
 '💳 Parcelamento: {PARCELAMENTO}','🎟️ {CUPOM}','',
 '✅ Confira preço, disponibilidade e condições antes de comprar.','',
 '📣 Publicidade • link de afiliado','','🔗 *Comprar pelo meu link:*','{LINK}'
].join('\n');
const real=v=>Number.isSafeInteger(v)&&v>0&&v<100_000_000;
const money=v=>(v/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}).replace(/\u00a0/g,' ');
const escaped=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const clean=v=>String(v??'').replace(/[\u0000-\u001f]/g,' ').trim();
const defaultTime=()=>Date.now();
function localDay(now){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bahia',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
 const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
 return p.year+'-'+p.month+'-'+p.day;
}
export function validateMessageTemplateBody(value){
 if(typeof value!=='string'||value.trim().length<30||value.length>1800)
  throw Object.assign(new Error('O modelo precisa ter entre 30 e 1.800 caracteres.'),{status:400});
 if(!/\{(?:LINK|LINK1|LINKS)\}/.test(value))
  throw Object.assign(new Error('Inclua {LINK} no modelo para que cada comprador receba o link da oferta.'),{status:400});
 for(const match of value.matchAll(/\{([^{}\r\n]{1,150})\}/g)){
  const token=match[1];
  if(MESSAGE_FIELDS.includes(token))continue;
  const options=token.split('|').map(x=>x.trim());
  if(options.length>=2&&options.length<=8&&options.every(x=>x.length>=2&&x.length<=80&&/^[^{}<>]+$/.test(x)))continue;
  throw Object.assign(new Error('Variável desconhecida: {'+token.slice(0,60)+'}. Confira a lista de campos disponíveis.'),{status:400});
 }
 if(/[\u0000-\u0008\u000b\u000e-\u001f]/.test(value))
  throw Object.assign(new Error('O modelo contém caracteres de controle não permitidos.'),{status:400});
 return value.trim().replace(/\r\n/g,'\n');
}
function priceData(offer,now){
 let price=null,old=null,terms=null;
 if(offer?.promo_terms_json){
  if(publishedPromotionLines(offer,now)){
   terms=safePromotionTerms(offer.promo_terms_json);
   if(real(terms?.price_cents)){
    price=terms.price_cents;
    if(real(terms.old_price_cents)&&terms.old_price_cents>price)old=terms.old_price_cents;
   }
  }
 }else if(real(offer?.price_cents)&&Number.isFinite(Number(offer?.created_at))&&
  now-Number(offer.created_at)*1000>=0&&now-Number(offer.created_at)*1000<=MAX_AGE_MS){
  price=offer.price_cents;
  if(real(offer.old_price_cents)&&offer.old_price_cents>price)old=offer.old_price_cents;
 }
 // Alguns grupos incluem "De R$ X Por R$ Y" no título, sem coluna de preço.
 let title=String(offer?.title||'').trim();
 const embedded=title.match(/\s+De\s*:?\s*R\$\s*(\d{1,6}(?:\.\d{3})*(?:,\d{2})?)\s+Por\s*:?\s*R\$\s*(\d{1,6}(?:\.\d{3})*(?:,\d{2})?)(?:\s*\(\s*\d{1,2}%\s*OFF\s*\))?(?:\s*Compre\s+Aqui\s*:?)?\s*$/i);
 if(embedded){
  const a=moneyCents(embedded[1]),b=moneyCents(embedded[2]);
  if(real(a)&&real(b)&&a>b){
   title=title.slice(0,embedded.index).trim();
   if(price===null&&!offer?.promo_terms_json&&Number.isFinite(Number(offer?.created_at))&&
     now-Number(offer.created_at)*1000>=0&&now-Number(offer.created_at)*1000<=MAX_AGE_MS){price=b;old=a;}
  }
 }
 return {title,price,old,terms};
}
function dataForTemplate(offer,now){
 const {title,price,old,terms}=priceData(offer,now);
 const link=String(offer?.public_url||offer?.affiliate_url||'');
 let coupon='';
 const messages=couponDescription(offer,localDay(now));
 if(messages.length)coupon=messages[0].replace(/^🎟️\s*/,'');
 else if(terms?.coupon_required){
  const source=terms.price_source==='grupo'?'Cupom informado no grupo':'Cupom informado';
  coupon=source+(terms.coupon_code?': '+terms.coupon_code:' — código não confirmado')+
   ' (confirme as condições no anúncio)';
 }
 let installments='';
 if(terms?.price_source==='mercadolivre'&&real(price)&&Number.isInteger(terms.installments)&&
  terms.installments>=2&&terms.installments<=24&&real(terms.installment_cents)){
  installments=terms.installments+'x de '+money(terms.installment_cents)+(terms.installments_no_interest?' sem juros':'');
 }
 return {
  NOME_DO_PRODUTO:clean(title), PRECO_ANTIGO:old?money(old):'',PRECO_NOVO:price?money(price):'',
  DESCONTO:old&&price?Math.round((1-price/old)*100)+'%':'',CUPOM:clean(coupon),
  LINK:link,LINK1:link,LINKS:link,PARCELAMENTO:installments,
  TEXTO_ORIGINAL:typeof offer?.original_message==='string'?clean(offer.original_message.slice(0,350)):''
 };
}
const marker=/\{([^{}\n]{1,150})\}/g;
export function renderMessageTemplate(offer,template,{network='whatsapp',now=defaultTime(),maxLength=1024,random=Math.random}={}){
 if(!['whatsapp','telegram'].includes(network)||typeof template!=='string')return null;
 let body;try{body=validateMessageTemplateBody(template);}catch{return null;}
 const values=dataForTemplate(offer,now);
 if(!values.LINK)return null;
 const result=[];
 for(const raw of body.split('\n')){
  const matches=[...raw.matchAll(marker)];
  if(matches.some(m=>MESSAGE_FIELDS.includes(m[1])&&!values[m[1]]))continue; // Campo indisponível: remover linha inteira.
  let line=raw.replace(marker,(_all,key)=>{
    if(MESSAGE_FIELDS.includes(key))return values[key];
    const options=key.split('|').map(x=>x.trim());
    const v=Number(random()); const i=Number.isFinite(v)?Math.min(options.length-1,Math.max(0,Math.floor(v*options.length))):0;
    return options[i];
  });
  result.push(line);
 }
 let output=result.join('\n').replace(/\n{3,}/g,'\n\n').trim();
 if(!/(^|\n)\s*📣\s*Publicidade\b/i.test(output))output='📣 Publicidade •\n\n'+output;
 if(!values.PRECO_NOVO&&body.includes('{PRECO_NOVO}'))
  output=output.replace(/(🛒[^\n]*\n)/,'$1\n💡 Consulte o preço atualizado na loja.\n');
 // Se a legenda ultrapassar o limite, o remetente usará o formato padrão seguro.
 if(output.length>maxLength||!output.includes(values.LINK))return null;
 if(network==='telegram'){
  output=escaped(output).replace(/\*([^*\n]+)\*/g,'<b>$1</b>').replace(/~([^~\n]+)~/g,'<s>$1</s>');
 }else{
  output=output.replace(/~/g,'~');
 }
 return output;
}
