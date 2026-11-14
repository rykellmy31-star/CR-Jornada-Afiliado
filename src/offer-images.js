import { trustedProductImage, trustedProductPage } from './images.js';

// A URL é a chave porque a mesma oferta pode ser divulgada em canais diferentes.
// Só guarda a URL pública da foto, nunca dados do comprador ou credenciais.
const CREATE_CACHE = `CREATE TABLE IF NOT EXISTS affiliate_product_images (
  affiliate_url TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;
const CACHE_LIFETIME = 7 * 24 * 60 * 60;

export async function cachedProductImage(env, affiliateUrl) {
  if (!env?.DB || !trustedProductPage(affiliateUrl)) return null;
  await env.DB.prepare(CREATE_CACHE).run();
  const row = await env.DB.prepare(
    'SELECT image_url FROM affiliate_product_images WHERE affiliate_url=? AND updated_at>=?'
  ).bind(affiliateUrl, Math.floor(Date.now() / 1000) - CACHE_LIFETIME).first();
  return trustedProductImage(row?.image_url) ? row.image_url : null;
}

export async function rememberProductImage(env, affiliateUrl, imageUrl) {
  if (!env?.DB || !trustedProductPage(affiliateUrl) || !trustedProductImage(imageUrl)) return false;
  await env.DB.prepare(CREATE_CACHE).run();
  await env.DB.prepare(
    'INSERT INTO affiliate_product_images(affiliate_url,image_url,updated_at) VALUES(?,?,?) ' +
    'ON CONFLICT(affiliate_url) DO UPDATE SET image_url=excluded.image_url,updated_at=excluded.updated_at'
  ).bind(affiliateUrl, imageUrl, Math.floor(Date.now() / 1000)).run();
  return true;
}

export async function resolveProductImage(env, affiliateUrl, lookup) {
  let cached = null;
  try { cached = await cachedProductImage(env, affiliateUrl); }
  catch (error) { console.warn('Cache da foto indisponível:', String(error?.message || error).slice(0, 100)); }
  if (cached) return cached;
  const image = await lookup(affiliateUrl);
  if (image && trustedProductImage(image)) {
    try { await rememberProductImage(env, affiliateUrl, image); }
    catch (error) { console.warn('Não foi possível memorizar a foto:', String(error?.message || error).slice(0, 100)); }
    return image;
  }
  return null;
}
