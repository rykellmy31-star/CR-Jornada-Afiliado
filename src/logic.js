export const ALLOWED_CHATS = ['@achadinhosml1101'];
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
  if (offer.price_cents != null) {
    // Evita tratar um preço antigo como preço confirmado em tempo real.
    const recent = now - offer.created_at * 1000 <= 6 * 60 * 60 * 1000;
    if (recent) {
      if (offer.old_price_cents && offer.old_price_cents > offer.price_cents) {
        headline.push(`🏷️ De ${formatBRL(offer.old_price_cents)} por ${formatBRL(offer.price_cents)}`);
      } else headline.push(`💰 Preço informado: ${formatBRL(offer.price_cents)}`);
    }
  }
  headline.push('', '✅ Confira o valor e a disponibilidade antes de comprar.', '🔗 Link de afiliado:');
  return headline.join('\n');
}

export function telegramPayload(offer, chatId, now = Date.now()) {
  return {
    chat_id: chatId,
    text: composeOfferMessage(offer, now),
    disable_web_page_preview: false,
    reply_markup: { inline_keyboard: [[{ text: '🛒 Ver oferta no Mercado Livre', url: offer.affiliate_url }]] }
  };
}
