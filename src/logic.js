import { couponDescription } from './coupons.js';
import {publishedPromotionLines, safePromotionTerms, promotionDescription, moneyCents, MAX_AGE_MS} from './promotion-terms.js';
export const BRAZIL_TIMEZONE = 'America/Bahia';

export function validateAffiliateUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Link de afiliado inválido.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Informe uma URL válida.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('O link deve ser HTTPS, sem credenciais ou porta personalizada.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'meli.la') {
    if (!/^\/[A-Za-z0-9_-]{5,50}\/?$/.test(url.pathname)) throw new Error('Link meli.la fora do padrão esperado.');
    return url.href;
  }
  if (host === 'mercadolivre.com.br' || host === 'www.mercadolivre.com.br') {
    // A presença de marcadores não garante comissão: exige atestado manual do proprietário.
    if (!url.searchParams.has('matt_tool') && !url.searchParams.has('matt_word') && !url.searchParams.has('ref')) {
      throw new Error('Não parece um link gerado pelo Portal de Afiliados. Use o link oficial, não a URL comum do produto.');
    }
    return url.href;
  }
  throw new Error('Aceitamos apenas links oficiais meli.la ou mercadolivre.com.br.');
}

export function normalizeOffer(data) {
  const title = String(data.title || '').trim();
  if (title.length < 5 || title.length > 180) throw new Error('Nome do produto: entre 5 e 180 caracteres.');
  if (data.owner_confirmation !== true) throw new Error('Confirme que gerou o link dentro da sua Central de Afiliados.');
  const affiliate_url = validateAffiliateUrl(data.affiliate_url);
  const category = String(data.category || 'Geral').trim().slice(0, 60) || 'Geral';
  const price_cents = parseOptionalBRL(data.price);
  const old_price_cents = parseOptionalBRL(data.old_price);
  if (old_price_cents != null && price_cents != null && old_price_cents <= price_cents) {
    throw new Error('Preço anterior deve ser maior que preço atual.');
  }
  return { title, affiliate_url, category, price_cents, old_price_cents };
}

export function parseOptionalBRL(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000 || !/^\d+(\.\d{1,2})?$/.test(String(value))) {
    throw new Error('Preço inválido: use 79.90, com até 2 casas decimais.');
  }
  return Math.round(n * 100);
}

export function localTimeParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: BRAZIL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23', minute: '2-digit'
  }).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

export function shouldSend(settings, now, publishedCount, lastSentMs = null) {
  if (!settings.automation_enabled || !settings.telegram_enabled || !settings.channel_registered) return false;
  const local = localTimeParts(now);
  if (local.hour < settings.start_hour || local.hour >= settings.end_hour) return false;
  if (publishedCount >= settings.max_daily) return false;
  if (lastSentMs !== null && now.getTime() - lastSentMs < settings.interval_minutes * 60_000) return false;
  return true;
}

export function formatBRL(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function composeOfferMessage(offer, now = Date.now()) {
  const date = new Date(now);
  const headline = ['📣 Publicidade • Oferta Mercado Livre', '', `🛍️ ${offer.title}`];
  // Ofertas capturadas em grupos trazem a origem e a data reais da mensagem.
  // Após 6h não reaproveite valores antigos só porque o link foi convertido agora.
  const sourced=offer.promo_terms_json?publishedPromotionLines(offer,now):null;
  if(offer.promo_terms_json){if(sourced)headline.push(...sourced);}
  else if(offer.price_cents != null){
    const recent=now-offer.created_at*1000<=6*60*60*1000;
    if(recent){
      if(offer.old_price_cents&&offer.old_price_cents>offer.price_cents)
        headline.push(`🏷️ De ${formatBRL(offer.old_price_cents)} por ${formatBRL(offer.price_cents)}`);
      else headline.push(`💰 Preço informado: ${formatBRL(offer.price_cents)}`);
    }
  }
  const couponDay = localTimeParts(date).day;
  const couponLines = couponDescription(offer, couponDay);
  if (couponLines.length) headline.push('', ...couponLines);
  headline.push('', '✅ Confira o valor e a disponibilidade antes de comprar.', '🔗 Link de afiliado:');
  return headline.join('\n');
}


// Modelos compartilhados entre WhatsApp e Telegram: não alteram o preço,
// a URL de comissão nem o estado das filas. As chamadas são comerciais,
// mas não inventam datas-limite ou disponibilidade.
const OFFER_HEADLINE='✨ CONFIRA ESTA OFERTA!';
// Alguns anúncios capturados trazem todo o texto "De / Por / Compre aqui"
// dentro do TÍTULO. Separamos apenas um padrão estrito, sem alterar o link.
export function cleanOfferTitleWithPrices(value){
  const original=String(value??'').trim();
  const match=original.match(/\s+De\s*:?\s*R\$\s*(\d{1,6}(?:\.\d{3})*(?:,\d{2})?)\s+Por\s*:?\s*R\$\s*(\d{1,6}(?:\.\d{3})*(?:,\d{2})?)(?:\s*\(\s*\d{1,2}%\s*OFF\s*\))?(?:\s*Compre\s+Aqui\s*:?)?\s*$/i);
  if(!match)return {title:original,old:null,price:null};
  const title=original.slice(0,match.index).trim();
  const old=moneyCents(match[1]),price=moneyCents(match[2]);
  if(title.length<5||!old||!price||old<=price)return {title:original,old:null,price:null};
  return {title,old,price};
}
const safeHtml=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const safeWa=value=>String(value??'').replace(/[*_~\x60]/g,'').replace(/[\u0000-\u001f]/g,' ').trim();
export function escapeTelegramHtml(value){return safeHtml(value);}
export function formatOfferMessage(offer,{platform='mercadolivre',network='whatsapp',now=Date.now(),includeLink=false,maxLength}={}){
  if(!['mercadolivre','shopee'].includes(platform))throw new Error('Plataforma inválida.');
  if(!['whatsapp','telegram'].includes(network))throw new Error('Canal inválido.');
  const tg=network==='telegram';
  const clean=value=>tg?safeHtml(value):safeWa(value);
  const bold=value=>tg?'<b>'+clean(value)+'</b>':'*'+clean(value)+'*';
  const strike=value=>tg?'<s>'+clean(value)+'</s>':'~'+clean(value)+'~';
  const emphasis=value=>tg?'<i>'+clean(value)+'</i>':clean(value);
  const embedded=cleanOfferTitleWithPrices(offer.title);
  const main=[
    '📣 Publicidade •',
    '',
    bold(OFFER_HEADLINE),
    '',
    '🛒 '+bold(embedded.title)
  ];
  const info=[];
  let old=null,price=null,provenance=null;
  const validMoney=value=>Number.isSafeInteger(value)&&value>0;
  // Não ressuscitar informações de preço expiradas ou não verificadas.
  if(offer.promo_terms_json){
    const published=publishedPromotionLines(offer,now);
    const terms=published?safePromotionTerms(offer.promo_terms_json):null;
    if(terms){
      if(validMoney(terms.price_cents)){
        price=terms.price_cents;
        if(validMoney(terms.old_price_cents)&&terms.old_price_cents>price)
          old=terms.old_price_cents;
        provenance=terms.price_source==='mercadolivre'
          ?'Preço público consultado no Mercado Livre'
          :'Preço anunciado em grupo de ofertas';
      }
      // Modelo fixo oficial: sem duplicar preço, pagamentos e observações.
      if(terms.price_source!=='mercadolivre'){
        const conditions=promotionDescription(terms).slice(validMoney(terms.price_cents)?1:0);
        for(const condition of conditions)info.push(clean(condition));
        if(published.length)info.push(emphasis(published[published.length-1]));
      }
    }
  }else if(validMoney(offer.price_cents)&&Number.isFinite(Number(offer.created_at))&&
    Number(offer.created_at)>0&&now-Number(offer.created_at)*1000>=0&&
    now-Number(offer.created_at)*1000<=MAX_AGE_MS){
    price=offer.price_cents;
    if(validMoney(offer.old_price_cents)&&offer.old_price_cents>price)old=offer.old_price_cents;
    provenance='Preço informado no cadastro da oferta';
  }
  if(price===null&&!offer.promo_terms_json&&platform==='mercadolivre'&&
     embedded.price&&embedded.old&&Number.isSafeInteger(Number(offer.created_at))&&
     now-Number(offer.created_at)*1000>=0&&now-Number(offer.created_at)*1000<=MAX_AGE_MS){
    // Valor explícito na mensagem original do grupo. Não afirmar verificação
    // oficial do site, nem mostrar números retirados de anúncio antigo.
    price=embedded.price;old=embedded.old;
    provenance='Preço anunciado no texto original';
  }
  if(price!==null){
    main.push('');
    main.push('❌ De: '+(old!==null?strike(formatBRL(old)):'não informado no anúncio'));
    main.push('🔥 '+bold('Por '+formatBRL(price)));
    if(offer.promo_terms_json){
      const terms=safePromotionTerms(offer.promo_terms_json);
      if(terms&&terms.price_source==='mercadolivre'){
        if(terms.payment_mode==='pix_only')info.push(
          validMoney(terms.card_price_cents)?'💠 Preço destacado no Pix':'💠 Pagamento: somente Pix');
        else if(terms.payment_mode==='pix')info.push('💠 Pagamento: Pix');
        else if(terms.payment_mode==='card')info.push('💳 Pagamento: cartão');
        if(validMoney(terms.card_price_cents)&&terms.card_price_cents!==price)
          info.push('💳 Preço no cartão: '+formatBRL(terms.card_price_cents));
        if(terms.installments!==null&&Number.isInteger(terms.installments)){
          info.push('💳 Parcelamento: '+terms.installments+'x'+
            (validMoney(terms.installment_cents)?' de '+formatBRL(terms.installment_cents):'')+
            (terms.installments_no_interest?' sem juros':''));
        }
      }
    }
    if(provenance==='Preço anunciado em grupo de ofertas'||provenance==='Preço anunciado no texto original')
      info.unshift(emphasis('ℹ️ '+provenance+'. Confira na loja.'));
  }else{
    main.push('',emphasis('💡 Consulte o preço atualizado na loja.'));
  }
  const coupons=couponDescription(offer,localTimeParts(new Date(now)).day);
  if(coupons.length)info.push('',...coupons.map((line,i)=>i===0?'🎟️ '+bold(line.replace(/^🎟️\s*/,'') ):clean(line)));
  const link=String(offer.affiliate_url||'');
  const footer=[
    '',
    '✅ Confira preço, disponibilidade e condições antes de comprar.',
    '📣 '+emphasis('Publicidade • link de afiliado')
  ];
  if(includeLink)footer.push('', '🔗 '+bold('Comprar pelo meu link:'),tg?safeHtml(link):link);
  // Caption do Telegram: nunca cortar um HTML <b>/<s> ou uma entidade no meio.
  // WhatsApp: nunca cortar o link completo para caber numa legenda.
  const limit=maxLength??(tg?(includeLink?1024:1000):1024);
  const build=()=>[...main,...(info.length?['',...info]:[]),...footer].join('\n');
  let output=build();
  while(output.length>limit&&info.length) {
    info.pop();
    while(info.at(-1)==='')info.pop();
    output=build();
  }
  // A legenda ainda pode exceder o limite se o link original for muito grande.
  // Nesse caso preserve a URL (não altere o destino de comissão).
  return output;
}

export function telegramPayload(offer, chatId, now = Date.now(),{includeLink=false}={}) {
  return {
    chat_id: chatId,
    text: formatOfferMessage(offer,{platform:'mercadolivre',network:'telegram',now,includeLink}),
    parse_mode:'HTML',
    disable_web_page_preview: false,
    reply_markup: { inline_keyboard: [[{ text: '🛒 Ver oferta no Mercado Livre', url: offer.affiliate_url }]] }
  };
}
