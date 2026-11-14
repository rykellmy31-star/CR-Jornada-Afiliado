import { renderPage, CSS, CLIENT_JS } from './ui.js';
import { listActivity } from './activity.js';
import { findProductImage } from './images.js';
import { resolveProductImage } from './offer-images.js';
import { ensureCouponTable, normalizeCoupon } from './coupons.js';
import { normalizeOffer, localTimeParts, shouldSend, telegramPayload } from './logic.js';
import { masterState,setMasterState,listCategories,createGroupCategory,updateGroupCategory,listCategoryDestinations,saveCategoryRoutes,upsertProductCategory,runCategoryRoutingScheduled } from './automation-center.js';
import { getWhatsAppState, listWhatsAppGroups, updateWhatsAppSettings, testWhatsApp, runWhatsAppScheduled, retryWhatsAppDelivery, getAffiliateWhatsAppConnection, connectAffiliateWhatsApp, ensureWhatsAppTables, setOfferDeliveryMode, addDirectWhatsAppOffer, retryDirectWhatsAppOffer, publishDirectWhatsAppOffer } from './whatsapp.js';
import { ensureMultiChannelTables, listTelegramChannels, createTelegramChannel, channelState, updateTelegramChannel, testTelegramChannel, addChannelOffer, saveChannelCoupon, publishChannelOffer, requeueChannelOffer, runMultiChannelScheduled, getPrimaryCategory, savePrimaryCategory,categoryMatches } from './multichannel.js';
import {
 listManagedWhatsAppGroups,createManagedWhatsAppGroup,getManagedWhatsAppGroupState,
 saveManagedWhatsAppGroup,addManagedWhatsAppOffer,saveManagedWhatsAppCoupon,
 requeueManagedWhatsAppOffer,managedWhatsAppConnection,listManagedWhatsAppGroupOptions,
 testManagedWhatsAppGroup,publishManagedWhatsAppOffer,runManagedWhatsAppScheduled
} from './whatsapp-groups.js';
import {shopeeDestinations,shopeeState,saveShopeeTarget,addShopeeOffer,saveShopeeCoupon,requeueShopeeOffer,publishShopeeOffer,runShopeeScheduled} from './shopee.js';
import {getShopeeAccount,saveShopeeProfile,saveShopeeCredentials,clearShopeeCredentials,verifyShopeeApi} from './shopee-account.js';
import {
 createShopeeOwnDestination,saveShopeeOwnTelegram,saveShopeeOwnWhatsApp,
 shopeeWhatsAppConnection,shopeeWhatsAppOptions,testShopeeOwnDestination
} from './shopee-destinations.js';

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
async function readSettings(env) {
  // Migração única e segura do grupo antigo para o novo canal informado pelo proprietário.
  // Não altera outros canais configurados nem reativa disparos sem nova confirmação.
  const updated = await env.DB.prepare("UPDATE settings SET telegram_chat_id='@achadinhosmlcr', automation_enabled=0, telegram_enabled=0, channel_registered=0, updated_at=unixepoch() WHERE id=1 AND telegram_chat_id='@achadinhosml1101'").run();
  if (updated.meta?.changes === 1) await log(env, 'channel_migrated', 'Destino alterado para @achadinhosmlcr; envios pausados para validação.');
  const [settings,category]=await Promise.all([
    env.DB.prepare('SELECT * FROM settings WHERE id=1').first(),getPrimaryCategory(env)
  ]);
  return {...settings,category};
}
function requireConfigured(env) {
  if (!env.DB || !env.ADMIN_PASSWORD || !env.SESSION_SECRET) throw Object.assign(new Error('Configure DB, ADMIN_PASSWORD e SESSION_SECRET na Cloudflare.'), { status: 503 });
}
function requireTelegram(env) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Configure o segredo TELEGRAM_BOT_TOKEN na Cloudflare.');
}
function normalizeChannelHandle(input) {
  let value = String(input || '').trim();
  if (/^https:\/\/t\.me\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname.toLowerCase() !== 't.me' || url.username || url.password || url.port) throw new Error();
      value = '@' + url.pathname.replace(/^\/+|\/+$/g, '');
    } catch { throw new Error('Use o endereço público do canal, como https://t.me/seucanal.'); }
  }
  if (!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) throw new Error('Informe o @usuário público do canal ou o link https://t.me/seucanal.');
  return value;
}
async function validateChannel(env, settings) {
  requireTelegram(env);
  const handle = normalizeChannelHandle(settings.telegram_chat_id);
  const api = 'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/getChat?chat_id=' + encodeURIComponent(handle);
  const response = await fetch(api, { signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw Object.assign(new Error('Canal não encontrado pelo bot. Verifique o endereço e adicione @Crjornadabot como administrador.'), { status: 400 });
  }
  if (data.result?.type !== 'channel') throw Object.assign(new Error('O destino informado ainda é um grupo, não um canal do Telegram.'), { status: 400 });
  return handle;
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
    imageUrl = await resolveProductImage(env, offer.affiliate_url, findProductImage);
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
  await validateChannel(env, settings);
  if (!settings.channel_registered || !settings.telegram_enabled) throw new Error('Canal Telegram não está habilitado e confirmado.');
  if(!categoryMatches(offer.category,settings.category))throw new Error('Esta oferta não pertence à categoria permitida neste canal.');
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
  if(env.MASTER_SCHEDULE_ENABLED===false)return;
  // O controle geral não ignora a pausa ou a autorização individual do destino.
  const effective=settings;
  if (!shouldSend(effective, now, total, latest?.published_at ? latest.published_at * 1000 : null)) return;
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await ensureCouponTable(env);
  const offer = await env.DB.prepare(OFFER_WITH_COUPON + " WHERE o.status='ready' AND (?='Geral' OR lower(o.category)=lower(?)) ORDER BY o.created_at ASC, o.id ASC LIMIT 1").bind(settings.category,settings.category).first();
  if (!offer) return;
  await sendOffer(env, offer, effective);
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
  // Verifica a sessão sem consultar o D1: a interface pode abrir antes dos dados secundários.
  if(u.pathname==='/api/session'&&method==='GET')return json({authenticated:true});
  if(u.pathname==='/api/master'&&method==='GET')return json(await masterState(env));
  if(u.pathname==='/api/master'&&method==='POST')return json(await setMasterState(env,(await getBody(request)).enabled));
  if(u.pathname==='/api/categories'&&method==='GET')return json(await listCategories(env));
  if(u.pathname==='/api/activity'&&method==='GET')return json(await listActivity(env,100));
  if(u.pathname==='/api/categories/destinations'&&method==='GET')return json({destinations:await listCategoryDestinations(env)});
  if(u.pathname==='/api/categories/groups'&&method==='POST')return json(await createGroupCategory(env,await getBody(request)),201);
  const categoryUpdate=u.pathname.match(/^\/api\/categories\/groups\/(\d+)$/);
  if(categoryUpdate&&method==='POST')return json(await updateGroupCategory(env,categoryUpdate[1],await getBody(request)));
  const categoryRouting=u.pathname.match(/^\/api\/categories\/groups\/(\d+)\/routes$/);
  if(categoryRouting&&method==='POST')return json(await saveCategoryRoutes(env,categoryRouting[1],await getBody(request)));
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
  // Conta e credenciais Shopee independentes: não usar o perfil Mercado Livre.
  if(u.pathname==='/api/shopee/account'&&method==='GET')
    return json(await getShopeeAccount(env));
  if(u.pathname==='/api/shopee/account/profile'&&method==='POST')
    return json(await saveShopeeProfile(env,await getBody(request)));
  if(u.pathname==='/api/shopee/account/credentials'&&method==='POST')
    return json(await saveShopeeCredentials(env,await getBody(request)));
  if(u.pathname==='/api/shopee/account/credentials/verify'&&method==='POST')
    return json(await verifyShopeeApi(env));
  if(u.pathname==='/api/shopee/account/credentials/clear'&&method==='POST')
    return json(await clearShopeeCredentials(env));
  // Shopee: apenas links oficiais já gerados pelo próprio afiliado, sem consulta
  // a API/credenciais Shopee; destinos/filas/agendamentos são isolados do Mercado Livre.
  if(u.pathname==='/api/shopee/destinations/create'&&method==='POST')
    return json(await createShopeeOwnDestination(env,await getBody(request)),201);
  if(u.pathname==='/api/shopee/telegram/configure'&&method==='POST'){
    const data=await getBody(request);
    return json(await saveShopeeOwnTelegram(env,data.target_id,data));
  }
  if(u.pathname==='/api/shopee/whatsapp/configure'&&method==='POST'){
    const data=await getBody(request);
    return json(await saveShopeeOwnWhatsApp(env,data.target_id,data));
  }
  if(u.pathname==='/api/shopee/whatsapp/connection'&&(method==='GET'||method==='POST')){
    const data=method==='GET'?u.searchParams:await getBody(request);
    return json(await shopeeWhatsAppConnection(env,
      method==='GET'?data.get('target_id'):data.target_id,method==='POST'));
  }
  if(u.pathname==='/api/shopee/whatsapp/groups'&&method==='GET')
    return json(await shopeeWhatsAppOptions(env,u.searchParams.get('target_id')));
  if(u.pathname==='/api/shopee/destinations/test'&&method==='POST'){
    const data=await getBody(request);
    return json(await testShopeeOwnDestination(env,data.network,data.target_id));
  }
  if(u.pathname==='/api/shopee/destinations'&&method==='GET')
    return json(await shopeeDestinations(env));
  if(u.pathname==='/api/shopee/state'&&method==='GET')
    return json(await shopeeState(env,u.searchParams.get('network'),u.searchParams.get('target_id')));
  if(u.pathname==='/api/shopee/settings'&&method==='POST')
    return json(await saveShopeeTarget(env,await getBody(request)));
  if(u.pathname==='/api/shopee/offers'&&method==='POST'){
    const payload=await getBody(request);
    const result=await addShopeeOffer(env,payload);
    await upsertProductCategory(env,'shopee',payload);
    return json(result,201);
  }
  if(u.pathname==='/api/shopee/coupons'&&method==='POST')
    return json(await saveShopeeCoupon(env,await getBody(request)),201);
  const shopeeAction=u.pathname.match(/^\/api\/shopee\/offers\/(\d+)\/(publish|requeue)$/);
  if(shopeeAction&&method==='POST'){
    const data=await getBody(request);
    const result=shopeeAction[2]==='publish'
      ?await publishShopeeOffer(env,data.network,data.target_id,shopeeAction[1])
      :await requeueShopeeOffer(env,data.network,data.target_id,shopeeAction[1]);
    return json(result,result.status==='needs_review'?409:200);
  }
  // Todos os endpoints multicanal exigem a mesma sessão administrativa e origem.
  // Central de grupos WhatsApp; o grupo principal usa a integração legada.
  if(u.pathname==='/api/wa-groups'&&method==='GET')
    return json({groups:await listManagedWhatsAppGroups(env)});
  if(u.pathname==='/api/wa-groups'&&method==='POST')
    return json(await createManagedWhatsAppGroup(env,await getBody(request)),201);
  const waState=u.pathname.match(/^\/api\/wa-groups\/(\d+)\/state$/);
  if(waState&&method==='GET')return json(await getManagedWhatsAppGroupState(env,waState[1]));
  const waSettings=u.pathname.match(/^\/api\/wa-groups\/(\d+)\/settings$/);
  if(waSettings&&method==='POST')return json(await saveManagedWhatsAppGroup(env,waSettings[1],await getBody(request)));
  const waOptions=u.pathname.match(/^\/api\/wa-groups\/(\d+)\/options$/);
  if(waOptions&&method==='GET')return json(await listManagedWhatsAppGroupOptions(env,waOptions[1]));
  const waConnection=u.pathname.match(/^\/api\/wa-groups\/(\d+)\/connection$/);
  if(waConnection&&method==='GET')return json(await managedWhatsAppConnection(env,waConnection[1],false));
  if(waConnection&&method==='POST')return json(await managedWhatsAppConnection(env,waConnection[1],true));
  const waTest=u.pathname.match(/^\/api\/wa-groups\/(\d+)\/test$/);
  if(waTest&&method==='POST')return json(await testManagedWhatsAppGroup(env,waTest[1]));
  const waAddOffer=u.pathname.match(/^\/api\/wa-groups\/(\d+)\/offers$/);
  if(waAddOffer&&method==='POST')return json(await addManagedWhatsAppOffer(env,waAddOffer[1],await getBody(request)),201);
  const waCoupon=u.pathname.match(/^\/api\/wa-groups\/(\d+)\/coupons$/);
  if(waCoupon&&method==='POST')return json(await saveManagedWhatsAppCoupon(env,waCoupon[1],await getBody(request)),201);
  const waOfferAction=u.pathname.match(/^\/api\/wa-groups\/(\d+)\/offers\/(\d+)\/(publish|requeue)$/);
  if(waOfferAction&&method==='POST'){
    const result=waOfferAction[3]==='publish'
      ?await publishManagedWhatsAppOffer(env,waOfferAction[1],waOfferAction[2])
      :await requeueManagedWhatsAppOffer(env,waOfferAction[1],waOfferAction[2]);
    return json(result,result.status==='needs_review'?409:200);
  }
  if(u.pathname==='/api/channels'&&method==='GET')
    return json({channels:await listTelegramChannels(env)});
  if(u.pathname==='/api/channels'&&method==='POST')
    return json(await createTelegramChannel(env,await getBody(request)),201);
  const channelStateMatch=u.pathname.match(/^\/api\/channels\/(\d+)\/state$/);
  if(channelStateMatch&&method==='GET')
    return json(await channelState(env,channelStateMatch[1]));
  const channelSettingsMatch=u.pathname.match(/^\/api\/channels\/(\d+)\/settings$/);
  if(channelSettingsMatch&&method==='POST')
    return json(await updateTelegramChannel(env,channelSettingsMatch[1],await getBody(request)));
  const channelTestMatch=u.pathname.match(/^\/api\/channels\/(\d+)\/test$/);
  if(channelTestMatch&&method==='POST')
    return json(await testTelegramChannel(env,channelTestMatch[1]));
  const channelAddOfferMatch=u.pathname.match(/^\/api\/channels\/(\d+)\/offers$/);
  if(channelAddOfferMatch&&method==='POST')
    return json(await addChannelOffer(env,channelAddOfferMatch[1],await getBody(request)),201);
  const channelCouponMatch=u.pathname.match(/^\/api\/channels\/(\d+)\/coupons$/);
  if(channelCouponMatch&&method==='POST')
    return json(await saveChannelCoupon(env,channelCouponMatch[1],await getBody(request)),201);
  const channelOfferAction=u.pathname.match(/^\/api\/channels\/(\d+)\/offers\/(\d+)\/(publish|requeue)$/);
  if(channelOfferAction&&method==='POST'){
    const result=channelOfferAction[3]==='publish'
      ?await publishChannelOffer(env,channelOfferAction[1],channelOfferAction[2])
      :await requeueChannelOffer(env,channelOfferAction[1],channelOfferAction[2]);
    return json(result,result.status==='needs_review'?409:200);
  }
  if (u.pathname === '/api/whatsapp/state' && method === 'GET') {
    return json(await getWhatsAppState(env));
  }
  if (u.pathname === '/api/whatsapp/connection' && method === 'GET') {
    try { return json(await getAffiliateWhatsAppConnection(env)); }
    catch(error){return fail(String(error.message||error),503);}
  }
  if (u.pathname === '/api/whatsapp/auto-connect' && method === 'POST') {
    try { return json(await connectAffiliateWhatsApp(env)); }
    catch(error){return fail(String(error.message||error),503);}
  }
  if (u.pathname === '/api/whatsapp/groups' && method === 'GET') {
    try {
      const instance=u.searchParams.get('instance');
      return json({groups:await listWhatsAppGroups(env,instance)});
    }catch(error){return fail(String(error.message||error));}
  }
  if (u.pathname === '/api/whatsapp/settings' && method === 'POST') {
    try{return json(await updateWhatsAppSettings(env,await getBody(request)));}
    catch(error){return fail(String(error.message||error));}
  }
  if (u.pathname === '/api/whatsapp/test' && method === 'POST') {
    try{return json(await testWhatsApp(env));}
    catch(error){return fail(String(error.message||error));}
  }
  if (u.pathname === '/api/whatsapp/retry' && method === 'POST') {
    try{return json(await retryWhatsAppDelivery(env,(await getBody(request)).offer_id));}
    catch(error){return fail(String(error.message||error));}
  }
  if ((u.pathname === '/api/offers' || u.pathname === '/api/whatsapp/offers') && method === 'POST') {
    const body=await getBody(request);
    const mode=body.delivery_mode===undefined
      ?(u.pathname==='/api/whatsapp/offers'?'whatsapp':'both')
      :body.delivery_mode;
    if(!['telegram','whatsapp','both'].includes(mode))
      return fail('Escolha Telegram, WhatsApp ou ambos como destino da oferta.',400);
    if(u.pathname==='/api/whatsapp/offers'&&body.delivery_mode===undefined)
      body.delivery_mode='whatsapp';
    let data;
    try { data = normalizeOffer(body); }
    catch (error) { return fail(error.message, 400); }
    await ensureWhatsAppTables(env);
    await ensureMultiChannelTables(env);
    const waConfig=await env.DB.prepare('SELECT * FROM whatsapp_settings WHERE id=1').first();
    // Requisições antigas sem delivery_mode preservam o fluxo preexistente:
    // elas continuam podendo registrar ofertas antes de ativar o WhatsApp.
    const explicit=body.delivery_mode!==undefined;
    if(mode!=='telegram'&&(explicit||u.pathname==='/api/whatsapp/offers')){
      if(!waConfig?.group_jid||!waConfig?.instance_name)
        return fail('Escolha e salve primeiro o grupo principal do WhatsApp.',400);
      const waCategory=(await env.DB.prepare('SELECT category FROM whatsapp_primary_category WHERE id=1').first()).category;
      if(!categoryMatches(data.category,waCategory))
        return fail('O WhatsApp principal só aceita ofertas da categoria '+waCategory+'.',400);
      if(mode==='both'&&(!waConfig.enabled||!waConfig.public_registered))
        return fail('Ative e autorize o WhatsApp principal antes de selecionar os dois destinos.',400);
    }
    if(mode!=='whatsapp'){
      const telegramCategory=await getPrimaryCategory(env);
      if(!categoryMatches(data.category,telegramCategory))
        return fail('O Telegram principal só aceita ofertas da categoria '+telegramCategory+'.',400);
    }
    const extra=await env.DB.prepare('SELECT channel_id FROM channel_offers WHERE affiliate_url=?').bind(data.affiliate_url).first();
    if(extra)return fail('Este link já pertence a outro canal. Use ofertas diferentes em cada canal.',409);
    if(mode==='whatsapp'){
      const existing=await env.DB.prepare('SELECT id FROM offers WHERE affiliate_url=?').bind(data.affiliate_url).first();
      if(existing)return fail('Este link já está no Telegram. Para publicar nos dois destinos, escolha "Telegram e WhatsApp" no cadastro de uma nova oferta.',409);
      try{
        const result=await addDirectWhatsAppOffer(env,body);
        await upsertProductCategory(env,'mercadolivre',data);
        return json(result,201);
      }catch(error){return fail(error.message,error.status||400);}
    }
    const direct=await env.DB.prepare('SELECT id FROM whatsapp_direct_offers WHERE affiliate_url=?').bind(data.affiliate_url).first();
    if(direct)return fail('Este link já pertence à fila exclusiva do WhatsApp principal.',409);
    const now = Math.floor(Date.now()/1000);
    let id;
    try {
      // Cria primeiro em revisão: se a gravação do destino falhar, nunca
      // publica por engano no Telegram nem espelha no WhatsApp.
      const result=await env.DB.prepare("INSERT INTO offers (title,affiliate_url,category,price_cents,old_price_cents,created_at,status) VALUES (?,?,?,?,?,?,'needs_review')")
        .bind(data.title,data.affiliate_url,data.category,data.price_cents,data.old_price_cents,now).run();
      id=Number(result.meta?.last_row_id);
      await setOfferDeliveryMode(env,id,mode);
      await env.DB.prepare("UPDATE offers SET status='ready' WHERE id=? AND status='needs_review'").bind(id).run();
      await log(env,'offer_added',data.title+' • '+(mode==='both'?'Telegram e WhatsApp':'Somente Telegram'),id);
    } catch (error) {
      if(/UNIQUE/i.test(error.message||''))return fail('Este link já está cadastrado.',409);
      throw error;
    }
    await upsertProductCategory(env,'mercadolivre',data);
    return json({ok:true,delivery_mode:mode,offer_id:id},201);
  }
  const directAction=u.pathname.match(/^\/api\/whatsapp\/offers\/(\d+)\/(publish|requeue)$/);
  if(directAction&&method==='POST'){
    try{
      const result=directAction[2]==='publish'
        ?await publishDirectWhatsAppOffer(env,Number(directAction[1]))
        :await retryDirectWhatsAppOffer(env,Number(directAction[1]));
      return json(result,result.skipped||result.status==='needs_review'?409:200);
    }catch(error){return fail(error.message,error.status||400);}
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
    const interval = Number(b.interval_minutes), limit = Number(b.max_daily), start = Number(b.start_hour), end = Number(b.end_hour);
    if (b.interval_minutes === '' || !Number.isInteger(interval) || interval < 1 || interval > 1440 || !Number.isInteger(limit) || limit < 1 || limit > 48 ||
        !Number.isInteger(start) || start < 0 || start > 23 || !Number.isInteger(end) || end < 1 || end > 24 || start >= end) {
      return fail('Configuração inválida.');
    }
    if ([b.channel_registered, b.telegram_enabled, b.automation_enabled].some(x => typeof x !== 'boolean')) return fail('Seleções inválidas.');
    let chat;
    try { chat = normalizeChannelHandle(b.telegram_chat_id); }
    catch (error) { return fail(error.message); }
    const existing = await readSettings(env);
    const category=b.category===undefined?existing.category:String(b.category||'').trim();
    if(!category||category.length>60)return fail('Informe uma categoria válida (até 60 caracteres).');
    const changed = chat !== existing.telegram_chat_id;
    // O novo endereço não herda a autorização anterior; pause toda a automação.
    if (changed) {
      await validateChannel(env, { telegram_chat_id: chat });
    } else if (b.channel_registered && b.telegram_enabled) {
      await validateChannel(env, { telegram_chat_id: chat });
    }
    const enabled = changed ? false : b.telegram_enabled;
    const registered = changed ? false : b.channel_registered;
    const automation = changed ? false : b.automation_enabled;
    if ((enabled || automation) && !registered) return fail('Confirme primeiro que o canal está cadastrado e permitido no Mercado Livre.');
    if (automation && !enabled) return fail('Ative o Telegram antes de iniciar a automação.');
    await savePrimaryCategory(env,category);
    await env.DB.prepare('UPDATE settings SET telegram_chat_id=?, automation_enabled=?, telegram_enabled=?, channel_registered=?, interval_minutes=?, max_daily=?, start_hour=?, end_hour=?, updated_at=? WHERE id=1')
      .bind(chat, +automation, +enabled, +registered, interval, limit, start, end, Math.floor(Date.now() / 1000)).run();
    await log(env, 'settings_updated', changed ? 'Canal alterado; automação e envio pausados para confirmação.' : `Automação ${automation ? 'ligada' : 'desligada'}`);
    return json({ ok: true, channel_changed: changed });
  }
  if (u.pathname === '/api/test-telegram' && method === 'POST') {
    const s = await readSettings(env); await validateChannel(env, s);
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
  async scheduled(_controller, env, ctx) {
    const master=env.DB?masterState(env):Promise.resolve({enabled:null});
    function start(fn,label,route=false){
      ctx.waitUntil((async()=>{
        const state=await master;
        if(state.enabled===false)return;
        const configured={...env,MASTER_SCHEDULE_ENABLED:state.enabled};
        await fn(configured);
        if(route&&state.enabled===true)await runCategoryRoutingScheduled(configured);
      })().catch(error=>console.error(label+':',error?.message)));
    }
    start(runScheduled,'Telegram');
    start(runWhatsAppScheduled,'WhatsApp');
    start(runMultiChannelScheduled,'Telegram multicanal');
    start(runManagedWhatsAppScheduled,'WhatsApp multigrupos');
    start(runShopeeScheduled,'Shopee e categorias',true);
  }
};
export { runScheduled, router };
