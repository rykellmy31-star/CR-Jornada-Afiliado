// Usa apenas metadados públicos da página do próprio produto. Não acessa contas nem contorna bloqueios.
const MAX_HTML_BYTES = 1_000_000;
const MAX_PHOTO_BYTES = 5_000_000;
// Redirecionamentos oficiais do meli.la podem atravessar /sec/ e a página do anúncio.
const ALLOWED_PAGES = new Set([
  'meli.la', 'meli.promo', 'mercadolivre.com', 'www.mercadolivre.com',
  'mercadolivre.com.br', 'www.mercadolivre.com.br',
  'produto.mercadolivre.com.br', 'm.mercadolivre.com.br'
]);
const ALLOWED_IMAGES = new Set(['http2.mlstatic.com']);

export function trustedProductPage(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && ALLOWED_PAGES.has(u.hostname.toLowerCase());
  } catch { return false; }
}

export function trustedProductImage(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && ALLOWED_IMAGES.has(u.hostname.toLowerCase())
      && /^\/D_[A-Za-z0-9_\-./]+\.(?:jpe?g|png|webp)$/i.test(u.pathname);
  } catch { return false; }
}

function decodeEntities(s) {
  return String(s).replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([0-9a-f]+));/gi, (full, decimal, hex) => {
    if (decimal || hex) {
      const n = decimal ? Number(decimal) : parseInt(hex, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : full;
    }
    return ({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'})[full.toLowerCase()] || full;
  });
}

export function extractProductImage(html) {
  const tags = String(html).match(/<meta\b[^>]{0,3000}>/gi) || [];
  for (const kind of ['og:image:secure_url', 'og:image', 'twitter:image']) {
    for (const tag of tags) {
      const attrs = {};
      for (const match of tag.matchAll(/\b([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
      }
      if ((attrs.property || attrs.name || '').toLowerCase() === kind && trustedProductImage(attrs.content)) {
        return attrs.content;
      }
    }
  }
  // Algumas páginas oficiais trazem a foto somente em JSON-LD (schema.org/Product).
  // Nunca usa fotos de recomendações ou URLs fora da CDN aprovada.
  for (const script of String(html).matchAll(/<script\b(?=[^>]*\btype\s*=\s*["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let data;
    try { data = JSON.parse(script[1]); } catch { continue; }
    const queue = [data];
    while (queue.length) {
      const item = queue.shift();
      if (Array.isArray(item)) { queue.push(...item.slice(0, 30)); continue; }
      if (!item || typeof item !== 'object') continue;
      const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
      if (types.includes('Product')) {
        const photos = Array.isArray(item.image) ? item.image : [item.image];
        for (const photo of photos) {
          const url = typeof photo === 'string' ? photo : photo?.url || photo?.contentUrl;
          if (trustedProductImage(url)) return url;
        }
      }
      if (item['@graph']) queue.push(item['@graph']);
    }
  }
  return null;
}

async function readLimitedHtml(response) {
  // O HTML do anúncio pode superar 1 MB, mas o og:image costuma vir no <head>.
  // Lê só o início da resposta em vez de descartar a página pelo Content-Length total.
  if (!response.body?.getReader) return (await response.text()).slice(0, MAX_HTML_BYTES);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = ''; let size = 0;
  try {
    while (size < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      const take = Math.min(value.byteLength, MAX_HTML_BYTES - size);
      text += decoder.decode(value.subarray(0, take), { stream: true });
      size += take;
      if (take < value.byteLength) break;
    }
  } finally { try { await reader.cancel(); } catch {} }
  return text + decoder.decode();
}

// A CDN do Mercado Livre documenta -F como variante de maior resolução.
// Priorizamos uma foto grande da MESMA identificação, nunca ampliamos o thumbnail
// e nunca assumimos que basta alterar o sufixo: cada variante é verificada na CDN.
export function highQualityPhotoCandidates(value) {
  if (!trustedProductImage(value)) return [];
  const original = new URL(value);
  const candidates = [];
  const seen = new Set();
  function add(path, keepQuery = false) {
    const u = new URL(original.href);
    u.pathname = path;
    if (!keepQuery) u.search = '';
    if (trustedProductImage(u.href) && !seen.has(u.href)) {
      seen.add(u.href);
      candidates.push(u.href);
    }
  }

  // Mantém o ID real da foto; D_Q é a versão com preenchimento, D_NQ sem.
  // O prefixo 2X pertence apenas à miniatura e não é reutilizado.
  const match = /^\/D_(?:NQ|Q)_NP_(?:2X_)?([A-Za-z0-9]+-ML[A-Za-z0-9_]+)-[A-Z]{1,2}\.(?:jpe?g|png|webp)$/i.exec(original.pathname);
  if (match) {
    const base = '/D_NQ_NP_' + match[1];
    for (const size of ['F', 'OO', 'O']) add(base + '-' + size + '.jpg');
  }
  if (/\.webp$/i.test(original.pathname)) add(original.pathname.replace(/\.webp$/i, '.jpg'), true);
  if (/\.(?:jpe?g|png)$/i.test(original.pathname)) add(original.pathname, true);
  return candidates;
}

function acceptableImageResponse(response, ranged = false, allowWebp = false) {
  if (!response.ok) return false;
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'image/jpeg' && type !== 'image/png' && !(allowWebp && type === 'image/webp')) return false;
  const rangeTotal = ranged ? /\/(\d+)$/.exec(response.headers.get('content-range') || '') : null;
  const length = Number(rangeTotal?.[1] || response.headers.get('content-length') || 0);
  return Number.isFinite(length) && (length === 0 || length <= MAX_PHOTO_BYTES);
}

async function candidateExists(url, fetcher, allowWebp = false) {
  try {
    const head = await fetcher(url, {
      method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(4500)
    });
    if (acceptableImageResponse(head, false, allowWebp)) return true;
    // Alguns servidores de mídia não implementam HEAD. Verificamos MIME e tamanho
    // com GET parcial, sem baixar o arquivo inteiro no Worker.
    // Algumas CDNs negam HEAD (403) embora aceitem GET com Range.
    // A CDN pode bloquear HEAD mesmo quando GET parcial serve um JPEG válido.
    // Consulta o conteúdo apenas nas respostas ambíguas, sempre limitando bytes e MIME.
    if (![400, 403, 404, 405, 406, 501].includes(head.status) &&
        !(head.ok && !(head.headers.get('content-type')||'').startsWith('image/jpeg')) &&
        !(head.ok && !head.headers.get('content-type'))) return false;
    const probe = await fetcher(url, {
      method: 'GET', headers: { range: 'bytes=0-1023' },
      redirect: 'manual', signal: AbortSignal.timeout(4500)
    });
    const good = acceptableImageResponse(probe, true, allowWebp);
    try { await probe.body?.cancel(); } catch {}
    return good;
  } catch { return false; }
}

export async function validatedProductPhoto(url,fetcher=fetch){
  return acceptedPhoto(url,fetcher);
}
async function acceptedPhoto(url, fetcher) {
  for (const candidate of highQualityPhotoCandidates(url)) {
    if (await candidateExists(candidate, fetcher)) return candidate;
  }
  // A foto original do destaque pode existir apenas em WebP (-V.webp).
  // É o arquivo REAL servido pela vitrine do ML, não uma prévia do link.
  // Aceite somente se o CDN confirmar MIME e tamanho; na publicação o
  // WebP será convertido em JPEG para envio de mídia ao destinatário.
  if (/\.webp(?:\?|$)/i.test(url) && trustedProductImage(url) &&
      await candidateExists(url,fetcher,true)) return url;
  return null;
}

export async function findProductImage(affiliateUrl, fetcher = fetch) {
  if (!trustedProductPage(affiliateUrl)) return null;
  let pageUrl = affiliateUrl;
  for (let i = 0; i < 8; i++) {
    const response = await fetcher(pageUrl, {
      redirect: 'manual', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(7000)
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      const redirected = new URL(location, pageUrl).href;
      if (!trustedProductPage(redirected)) return null;
      pageUrl = redirected;
      continue;
    }
    if (!response.ok || !(response.headers.get('content-type') || '').toLowerCase().includes('text/html')) return null;
    const image = extractProductImage(await readLimitedHtml(response));
    return image ? acceptedPhoto(image, fetcher) : null;
  }
  return null;
}
