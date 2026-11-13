// Usa apenas metadados públicos da página do próprio produto. Não acessa contas nem contorna bloqueios.
const MAX_HTML_BYTES = 1_000_000;
const MAX_PHOTO_BYTES = 5_000_000;
const ALLOWED_PAGES = new Set(['meli.la', 'mercadolivre.com.br', 'www.mercadolivre.com.br']);
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
  return null;
}

async function readLimitedHtml(response) {
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_HTML_BYTES) return '';
  if (!response.body?.getReader) return (await response.text()).slice(0, MAX_HTML_BYTES);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = ''; let size = 0;
  try {
    while (size <= MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally { try { await reader.cancel(); } catch {} }
  return text;
}

// Quando o Mercado Livre expõe a mesma imagem em JPG, preferimos esse formato para sendPhoto.
async function acceptedPhoto(url, fetcher) {
  const candidates = /\.webp$/i.test(url) ? [url.replace(/\.webp$/i, '.jpg'), url] : [url];
  for (const candidate of candidates) {
    if (!trustedProductImage(candidate)) continue;
    try {
      const response = await fetcher(candidate, {
        method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(4500)
      });
      const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      const length = Number(response.headers.get('content-length') || 0);
      if (response.ok && (type === 'image/jpeg' || type === 'image/png') && (length === 0 || length <= MAX_PHOTO_BYTES)) {
        return candidate;
      }
    } catch { /* Resposta de imagem indisponível; tentar outro formato. */ }
  }
  // Algumas CDNs não aceitam HEAD embora atendam GET. O Telegram validará a foto por URL;
  // se a API recusar explicitamente (400), a oferta seguirá em texto sem duplicar mensagens.
  return candidates.find(trustedProductImage) || null;
}

export async function findProductImage(affiliateUrl, fetcher = fetch) {
  if (!trustedProductPage(affiliateUrl)) return null;
  let pageUrl = affiliateUrl;
  for (let i = 0; i < 4; i++) {
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
