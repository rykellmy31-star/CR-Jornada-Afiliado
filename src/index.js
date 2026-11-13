import { renderPage, CSS, CLIENT_JS } from './ui.js';
import { findProductImage } from './images.js';
import { ensureCouponTable, normalizeCoupon } from './coupons.js';
import { normalizeOffer, localTimeParts, shouldSend, telegramPayload, ALLOWED_CHATS } from './logic.js';

const COOKIE = 'crj_auth';
const SEC = 12 * 60 * 60;
const OFFER_WITH_COUPON = "SELECT o.*, c.kind AS coupon_kind, c.code AS coupon_code, c.discount_type AS coupon_discount_type, c.discount_value AS coupon_discount_value, c.min_cart_cents AS coupon_min_cart_cents, c.max_discount_cents AS coupon_max_discount_cents, c.start_day AS coupon_start_day, c.end_day AS coupon_end_day, c.source_url AS coupon_source_url, c.notes AS coupon_notes, c.owner_confirmed AS coupon_owner_confirmed FROM offers o LEFT JOIN offer_coupons c ON c.offer_id=o.id";
const encoder = new TextEncoder();

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
function fail(message, status = 400) { return json({ error: message }, status); }
function html(body) { return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } }); }
function base64url(arr) { return btoa(String.fromCharCode(...new Uint8Array(arr))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function bytesFromBase64url(str) { const s = str.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s.padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0)); }
async function signingKey(secret) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function issueSession(env) {
  const payload = base64url(encoder.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SEC, ver: 1 })));
  const signature = base64url(await crypto.subtle.sign('HMAC', await signingKey(env.SESSION_SECRET), encoder.encode(payload)));
  return `${payload}.${signature}`;
}
async function verifySession(req, env) {
  if (!env.SESSION_SECRET) return false;
  const cookie = req.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)crj_auth=([A-Za-z0-9._-]+)/);
  if (!match) return false;
  const parts = match[1].split('.');
  if (parts.length !== 2) return false;
  try {
    const good = await crypto.subtle.verify('HMAC', await signingKey(env.SESSION_SECRET), bytesFromBase64url(parts[1]), encoder.encode(parts[0]));
    if (!good) return false;
    const p = JSON.parse(new TextDecoder().decode(bytesFromBase64url(parts[0])));
    return p.ver === 1 && p.exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
async function secureEqual(a, b) {
  // Comparação por hashes com tamanho fixo.
  const hash = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(s))));
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  let mismatch = 0; for (let i = 0; i < x.length; i++) mismatch |= x[i] ^ y[i];
  return mismatch === 0;
}
async function getBody(req) {
  if (Number(req.headers.get('content-length') || 0) > 20_000) throw new Error('Requisição grande demais.');
  const text = await req.text();
  if (text.length > 20_000) throw new Error('Requisição grande demais.');
  try { return JSON.parse(text); } catch { throw new Error('JSON inválido.'); }
}
async function log(env, event, detail = '', offerId = null) {
  await env.DB.prepare('INSERT INTO logs (offer_id,event,detail,created_at) VALUES (?,?,?,?)')
    .bind(offerId, event, String(detail).slice(0, 400), Math.floor(Date.now() / 1000)).run();
}
async function readSettings(env) { return env.DB.prepare('SELECT * FROM settings WHERE id=1').first(); }
function requireConfigured(env) {
  if (!env.DB || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) throw Object.assign(new Error('Configure DB, ADMIN_PASSWORD e SESSION_SECRET na Cloudflare.'), { status: 503 });
}
function requireTelegram(env) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Configure o segredo TELEGRAM_BOT_TOKEN na Cloudflare.');
}
function validateChannel(s) {
  if (!ALLOWED_CHATS.includes(s.telegram_chat_id)) throw new Error('Grupo Telegram não autorizado nesta instalação.');
}
async function telegramSend(env, chat, payload, endpoint = 'sendMessage') {
  requireTelegram(env);
  const result = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, ...payload }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok || !data.ok) {
    const description = typeof data.description === 'string' ? data.description.slice(0, 180) : 'Telegram HTTP ' + result.status;
    const error = new Error(description);
    error.telegramStatus = result.status;
    throw error;
  }
  return data.result;
}

async function sendOfferWithImage(env, chat, offer) {
  const payload = telegramPayload(offer, chat);
  let imageUrl = null;
  try {
    imageUrl = await findProductImage(offer.affiliate_url);
  } catch (error) {
    // Metadados indisponíveis não devem impedir a publicação do link validado.
    console.warn('Imagem indisponível para a oferta:', offer.id, String(error?.message || error).slice(0, 100));
  }
  if (imageUrl) {
    try {
      const message = await telegramSend(env, chat, {
        photo: imageUrl, caption: payload.text.slice(0, 1024), reply_markup: payload.reply_markup
      }, 'sendPhoto');
      return { message, format: 'photo' };
    } catch (error) {
      // Só cai para texto após recusa EXPLÍCITA da foto (400); falha de rede é ambígua.
      if (error.telegramStatus !== 400 || !/photo|image|file|http url|url content|wrong type|format/i.test(error.message)) throw error;
      console.warn('Telegram recusou a imagem; enviando oferta em texto:', offer.id);
    }
  }
  // Quando não há foto, URL visível permite que o Telegram gere uma prévia quando disponível.
  const message = await telegramSend(env, chat, {
    ...payload, text: payload.text + '\n' + offer.affiliate_url
  });
  return { message, format: imageUrl ? 'text_photo_rejected' : 'text_no_image' };
}

async function sendOffer(env, offer, settings) {
  validateChannel(settings);
  if (!settings.channel_registered || !settings.telegram_enabled) throw new Error('Canal Telegram não está habilitado e confirmado.');
  const claim = await env.DB.prepare("UPDATE offers SET status='sending', last_error=NULL WHERE id=? AND status='ready'").bind(offer.id).run();
  if (claim.meta?.changes !== 1) return { status: 'already_claimed' };
  try {
    const { message, format } = await sendOfferWithImage(env, settings.telegram_chat_id, offer);
    const timestamp = Math.floor(Date.now() / 1000);
    const localDay = localTimeParts(new Date()).day;
    await env.DB.prepare("UPDATE offers SET status='published', published_at=?, published_day=?, telegram_message_id=? WHERE id=? AND status='sending'")
      .bind(timestamp, localDay, message.message_id, offer.id).run();
    await log(env, 'published', `Telegram ${message.message_id} • ${format}`, offer.id);
    return { status: 'published', message_id: message.message_id, format };
  } catch (error) {
    // Falhas ambíguas não são repetidas automaticamente para evitar publicação duplicada.
    await env.DB.prepare("UPDATE offers SET status='needs_review', last_error=? WHERE id=? AND status='sending'")
      .bind(String(error.message || error).slice(0, 250), offer.id).run();
    await log(env, 'needs_review', String(error.message || error), offer.id);
    return { status: 'needs_review', error: String(error.message || error) };
  }
}
async function runScheduled(env) {
  if (!env.DB) return;
  const settings = await readSettings(env);
  if (!settings) return;
  const now = new Date();
  const day = localTimeParts(now).day;
  const [{ total }, latest] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM offers WHERE status='published' AND published_day=?").bind(day).first(),
    env.DB.prepare("SELECT MAX(published_at) AS published_at FROM offers WHERE status='published'").first()
  ]);
  if (!shouldSend(settings, now, total, latest?.published_at ? latest.published_at * 1000 : null)) return;
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await ensureCouponTable(env);
  const offer = await env.DB.prepare(OFFER_WITH_COUPON + " WHERE o.status='ready' ORDER BY o.created_at ASC, o.id ASC LIMIT 1").first();
  if (!offer) return;
  await sendOffer(env, offer, settings);
}

async function router(request, env) {
  const u = new URL(request.url);
  const method = request.method;
  if (method === 'GET' && u.pathname === '/') return html(renderPage());
  if (method === 'GET' && u.pathname === '/app.js') return new Response(CLIENT_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
  if (method === 'GET' && u.pathname === '/styles.css') return new Response(CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
  if (!u.pathname.startsWith('/api/')) return fail('Não encontrado.', 404);
  requireConfigured(env);
  if (method !== 'GET' && method !== 'HEAD') {
    if (request.headers.get('origin') !== u.origin) return fail('Origem não autorizada.', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return fail('Envie JSON.', 415);
  }
  if (u.pathname === '/api/login' && method === 'POST') {
    const data = await getBody(request);
    if (typeof data.password !== 'string' || !data.password || !await secureEqual(data.password, env.ADMIN_PASSWORD)) return fail('Senha incorreta.', 401);
    const token = await issueSession(env);
    const secure = u.protocol === 'https:' ? '; Secure' : '';
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SEC}${secure}` });
  }
  if (!await verifySession(request, env)) return fail('Faça login para acessar o painel.', 401);
  if (u.pathname === '/api/logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  if (u.pathname === '/api/state' && method === 'GET') {
    await ensureCouponTable(env);
    const [settings, offers, counts, logs] = await Promise.all([
      readSettings(env),
      env.DB.prepare(OFFER_WITH_COUPON + ' ORDER BY o.created_at DESC, o.id DESC LIMIT 100').all(),
      env.DB.prepare('SELECT status, COUNT(*) AS total FROM offers GROUP BY status').all(),
      env.DB.prepare('SELECT event,detail,created_at,offer_id FROM logs ORDER BY id DESC LIMIT 20').all()
    ]);
    return json({ settings, offers: offers.results, counts: counts.results, logs: logs.results, telegram_token_configured: !!env.TELEGRAM_BOT_TOKEN });
  }
  if (u.pathname === '/api/offers' && method === 'POST') {
    let data;
    try { data = normalizeOffer(await getBody(request)); }
    catch (error) { return fail(error.message, 400); }
    const now = Math.floor(Date.now() / 1000);
    try {
      const result = await env.DB.prepare('INSERT INTO offers (title,affiliate_url,category,price_cents,old_price_cents,created_at) VALUES (?,?,?,?,?,?)')
        .bind(data.title, data.affiliate_url, data.category, data.price_cents, data.old_price_cents, now).run();
      await log(env, 'offer_added', data.title, result.meta?.last_row_id || null);
    } catch (err) {
      if (/UNIQUE/i.test(err.message || '')) return fail('Este link já está cadastrado.', 409);
      throw err;
    }
    return json({ ok: true }, 201);
  }
  if (u.pathname === '/api/coupons' && method === 'POST') {
    let coupon;
    try { coupon = normalizeCoupon(await getBody(request)); }
    catch (error) { return fail(error.message, 400); }
    await ensureCouponTable(env);
    const offer = await env.DB.prepare('SELECT status FROM offers WHERE id=?').bind(coupon.offer_id).first();
    if (!offer) return fail('Oferta não encontrada.', 404);
    if (offer.status !== 'ready') return fail('Só é possível vincular cupom a ofertas ainda não publicadas.', 409);
    const sql = "INSERT INTO offer_coupons (offer_id,kind,code,discount_type,discount_value,min_cart_cents,max_discount_cents,start_day,end_day,source_url,notes,owner_confirmed,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(offer_id) DO UPDATE SET kind=excluded.kind,code=excluded.code,discount_type=excluded.discount_type,discount_value=excluded.discount_value,min_cart_cents=excluded.min_cart_cents,max_discount_cents=excluded.max_discount_cents,start_day=excluded.start_day,end_day=excluded.end_day,source_url=excluded.source_url,notes=excluded.notes,owner_confirmed=1,updated_at=excluded.updated_at";
    await env.DB.prepare(sql)
      .bind(coupon.offer_id,coupon.kind,coupon.code,coupon.discount_type,coupon.discount_value,
        coupon.min_cart_cents,coupon.max_discount_cents,coupon.start_day,coupon.end_day,
        coupon.source_url,coupon.notes,Math.floor(Date.now()/1000)).run();
    await log(env,'coupon_saved','Informações de cupom cadastradas; elegibilidade no checkout não verificada.',coupon.offer_id);
    return json({ok:true},201);
  }
  if (u.pathname === '/api/settings' && method === 'POST') {
    const b = await getBody(request);
    const allowedIntervals = [15, 30, 60, 120];
    const interval = Number(b.interval_minutes), limit = Number(b.max_daily), start = Number(b.start_hour), end = Number(b.end_hour);
    if (!allowedIntervals.includes(interval) || !Number.isInteger(limit) || limit < 1 || limit > 48 ||
        !Number.isInteger(start) || start < 0 || start > 23 || !Number.isInteger(end) || end < 1 || end > 24 || start >= end) {
      return fail('Configuração inválida.');
    }
    if ([b.channel_registered, b.telegram_enabled, b.automation_enabled].some(x => typeof x !== 'boolean')) return fail('Seleções inválidas.');
    if ((b.telegram_enabled || b.automation_enabled) && !b.channel_registered) return fail('Confirme primeiro que o grupo está cadastrado e permitido no Mercado Livre.');
    if (b.automation_enabled && !b.telegram_enabled) return fail('Ative o Telegram antes de iniciar a automação.');
    await env.DB.prepare('UPDATE settings SET automation_enabled=?, telegram_enabled=?, channel_registered=?, interval_minutes=?, max_daily=?, start_hour=?, end_hour=?, updated_at=? WHERE id=1')
      .bind(+b.automation_enabled, +b.telegram_enabled, +b.channel_registered, interval, limit, start, end, Math.floor(Date.now() / 1000)).run();
    await log(env, 'settings_updated', `Automação ${b.automation_enabled ? 'ligada' : 'desligada'}`);
    return json({ ok: true });
  }
  if (u.pathname === '/api/test-telegram' && method === 'POST') {
    const s = await readSettings(env); validateChannel(s);
    if (!s.channel_registered) return fail('Confirme antes que o grupo público está cadastrado na sua conta de afiliado.');
    const result = await telegramSend(env, s.telegram_chat_id, { text: '✅ Teste de integração — CR Jornada Afiliados. Nenhuma oferta foi publicada.\n\nBot conectado com sucesso.' });
    await log(env, 'telegram_test', `Mensagem ${result.message_id}`);
    return json({ ok: true, message_id: result.message_id });
  }
  const requeue = u.pathname.match(/^\/api\/offers\/(\d+)\/requeue$/);
  if (requeue && method === 'POST') {
    const result = await env.DB.prepare("UPDATE offers SET status='ready', last_error=NULL WHERE id=? AND status='needs_review'").bind(Number(requeue[1])).run();
    if (result.meta?.changes !== 1) return fail('Somente ofertas com erro podem ser reenfileiradas. Verifique antes se já foram publicadas.', 409);
    await log(env, 'requeued_after_manual_check', '', Number(requeue[1]));
    return json({ ok: true });
  }
  const publish = u.pathname.match(/^\/api\/offers\/(\d+)\/publish$/);
  if (publish && method === 'POST') {
    await ensureCouponTable(env);
    const [settings, offer] = await Promise.all([readSettings(env), env.DB.prepare(OFFER_WITH_COUPON + ' WHERE o.id=?').bind(Number(publish[1])).first()]);
    if (!offer) return fail('Oferta não encontrada.', 404);
    if (offer.status !== 'ready') return fail('Oferta já enviada ou em revisão.', 409);
    const result = await sendOffer(env, offer, settings);
    return json(result, result.status === 'published' ? 200 : 409);
  }
  return fail('Rota inexistente.', 404);
}

export default {
  async fetch(request, env) {
    try { return await router(request, env); }
    catch (error) { console.error('CR Jornada Afiliados:', error?.message); return fail(error?.message || 'Falha interna.', error?.status || (error instanceof SyntaxError ? 400 : 500)); }
  },
  async scheduled(_controller, env, ctx) { ctx.waitUntil(runScheduled(env).catch(error => console.error('Cron:', error?.message))); }
};
export { runScheduled, router };
