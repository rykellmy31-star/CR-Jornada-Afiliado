// Radar de catálogo do Mercado Livre: somente API documentada com OAuth autorizado.
// A API de catálogo NÃO gera links de afiliado e NÃO confirma preços ou promoções.
const API = 'https://api.mercadolibre.com';
const SEARCH_URL = API + '/products/search';
const te = new TextEncoder();
const td = new TextDecoder();

function utcNow() { return Math.floor(Date.now() / 1000); }
function bytesTo64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function from64(text) { return Uint8Array.from(atob(text), c => c.charCodeAt(0)); }
async function aesKey(env) {
  if (!env.MELI_TOKEN_KEY) throw new Error('Configure MELI_TOKEN_KEY (32 bytes em Base64) na Cloudflare.');
  let raw;
  try { raw = from64(env.MELI_TOKEN_KEY.trim()); } catch { throw new Error('MELI_TOKEN_KEY inválido.'); }
  if (raw.length !== 32) throw new Error('MELI_TOKEN_KEY precisa ter exatamente 32 bytes em Base64.');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encryptTokens(env, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = te.encode(JSON.stringify(data));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv },await aesKey(env),encoded));
  return bytesTo64(iv) + '.' + bytesTo64(cipher);
}
async function decryptTokens(env, blob) {
  const [ivText,cipherText] = String(blob).split('.');
  if (!ivText || !cipherText) throw new Error('Credenciais criptografadas inválidas.');
  const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv:from64(ivText) },await aesKey(env),from64(cipherText));
  return JSON.parse(td.decode(plain));
}
function appReady(env) { return !!(env.MELI_APP_ID && env.MELI_APP_SECRET && env.MELI_TOKEN_KEY); }
function redirectUri(origin) { return origin + '/api/discovery/callback'; }
const CREATE_SETTINGS = "CREATE TABLE IF NOT EXISTS discovery_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, keywords TEXT NOT NULL DEFAULT 'fone bluetooth, ferramentas, air fryer', interval_minutes INTEGER NOT NULL DEFAULT 120, last_run_at INTEGER, last_error TEXT, keyword_cursor INTEGER NOT NULL DEFAULT 0)";
const CREATE_PRODUCTS = "CREATE TABLE IF NOT EXISTS discovered_products (product_id TEXT PRIMARY KEY, title TEXT NOT NULL, keyword TEXT NOT NULL, source_url TEXT NOT NULL, image_url TEXT, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','dismissed')))";
const CREATE_AUTH = "CREATE TABLE IF NOT EXISTS discovery_oauth (id INTEGER PRIMARY KEY CHECK(id=1), token_cipher TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)";
const CREATE_STATES = "CREATE TABLE IF NOT EXISTS discovery_oauth_states (state_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)";
export async function ensureDiscoveryTables(env) {
  await env.DB.prepare(CREATE_SETTINGS).run();
  await env.DB.prepare("INSERT OR IGNORE INTO discovery_settings(id) VALUES (1)").run();
  await env.DB.prepare(CREATE_PRODUCTS).run();
  await env.DB.prepare(CREATE_AUTH).run();
  await env.DB.prepare(CREATE_STATES).run();
}
export function parseKeywords(input) {
  const parts=String(input||'').split(/[\n,;]/).map(x=>x.trim().replace(/\s+/g,' ')).filter(Boolean);
  if(!parts.length||parts.length>12 || parts.some(x=>x.length<3||x.length>65)) {
    throw new Error('Informe de 1 a 12 termos de pesquisa, com 3 a 65 caracteres cada.');
  }
  return [...new Set(parts.map(x=>x.toLocaleLowerCase('pt-BR')))];
}
export function normalizeCatalogResult(product, keyword) {
  const id=String(product?.id||'');
  const title=String(product?.name||product?.title||'').trim().slice(0,170);
  if(!/^MLB\d{4,18}$/.test(id)||title.length<5||product.status==='inactive') return null;
  // URL para consulta manual, nunca para publicação automática como afiliado.
  const source_url = 'https://www.mercadolivre.com.br/p/' + id;
  let image_url=null;
  const candidate=String(product?.pictures?.[0]?.url||product?.pictures?.[0]?.secure_url||'');
  try {const u=new URL(candidate);if(u.protocol==='https:'&&u.hostname==='http2.mlstatic.com'&&!u.username&&!u.password)image_url=u.href;}catch{}
  return {product_id:id,title,keyword,source_url,image_url};
}
async function tokenEndpoint(env,params) {
  const response=await fetch(API+'/oauth/token',{
    method:'POST', headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},
    body:new URLSearchParams(params),signal:AbortSignal.timeout(14000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token||!data.refresh_token) throw new Error('Falha ao autorizar/renovar acesso no Mercado Livre. Verifique a conta e o aplicativo.');
  return { access_token:String(data.access_token),refresh_token:String(data.refresh_token),expires_at:utcNow()+Math.min(21600,Number(data.expires_in)||21600) };
}
async function storeTokens(env,tokens,previous=null) {
  const cipher=await encryptTokens(env,tokens);
  const time=utcNow();
  if(previous!==null){
    const changed=await env.DB.prepare('UPDATE discovery_oauth SET token_cipher=?,expires_at=?,updated_at=? WHERE id=1 AND token_cipher=?').bind(cipher,tokens.expires_at,time,previous).run();
    return changed.meta?.changes===1;
  }
  await env.DB.prepare('INSERT INTO discovery_oauth(id,token_cipher,expires_at,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET token_cipher=excluded.token_cipher,expires_at=excluded.expires_at,updated_at=excluded.updated_at').bind(cipher,tokens.expires_at,time).run();
  return true;
}
async function sha256(text) {
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',te.encode(text)));
  return Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
}
export async function createOAuthUrl(env,origin) {
  await ensureDiscoveryTables(env);
  if(!appReady(env)) throw new Error('Configure MELI_APP_ID, MELI_APP_SECRET e MELI_TOKEN_KEY como Secrets no Worker.');
  await aesKey(env);
  const state=bytesTo64(crypto.getRandomValues(new Uint8Array(32))).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
  await env.DB.prepare('DELETE FROM discovery_oauth_states WHERE expires_at<?').bind(utcNow()).run();
  await env.DB.prepare('INSERT INTO discovery_oauth_states(state_hash,expires_at) VALUES(?,?)').bind(await sha256(state),utcNow()+600).run();
  const auth=new URL('https://auth.mercadolivre.com.br/authorization');
  auth.searchParams.set('response_type','code');
  auth.searchParams.set('client_id',env.MELI_APP_ID);
  auth.searchParams.set('redirect_uri',redirectUri(origin));
  auth.searchParams.set('state',state);
  return auth.href;
}
export async function completeOAuth(env,origin,code,state) {
  await ensureDiscoveryTables(env);
  if(!appReady(env)) throw new Error('Aplicativo Mercado Livre não configurado.');
  if(!/^[A-Za-z0-9._~-]{12,200}$/.test(String(state))||!code||String(code).length>1024) throw new Error('Autorização inválida.');
  const deleted=await env.DB.prepare('DELETE FROM discovery_oauth_states WHERE state_hash=? AND expires_at>=?').bind(await sha256(state),utcNow()).run();
  if(deleted.meta?.changes!==1) throw new Error('Autorização expirada ou já utilizada.');
  const data=await tokenEndpoint(env,{
    grant_type:'authorization_code',client_id:env.MELI_APP_ID,
    client_secret:env.MELI_APP_SECRET,code:String(code),redirect_uri:redirectUri(origin)
  });
  await storeTokens(env,data);
}
async function validAccessToken(env) {
  let row=await env.DB.prepare('SELECT token_cipher,expires_at FROM discovery_oauth WHERE id=1').first();
  if(!row) throw new Error('Conecte uma conta autorizada do Mercado Livre no Radar.');
  if(row.expires_at>utcNow()+180) return (await decryptTokens(env,row.token_cipher)).access_token;
  const stored=await decryptTokens(env,row.token_cipher);
  let refreshed;
  try {
    refreshed=await tokenEndpoint(env,{
      grant_type:'refresh_token',client_id:env.MELI_APP_ID,
      client_secret:env.MELI_APP_SECRET,refresh_token:stored.refresh_token
    });
  }catch(error){
    const newer=await env.DB.prepare('SELECT token_cipher,expires_at FROM discovery_oauth WHERE id=1').first();
    if(newer?.token_cipher!==row.token_cipher && newer.expires_at>utcNow()+180) return (await decryptTokens(env,newer.token_cipher)).access_token;
    throw error;
  }
  if(await storeTokens(env,refreshed,row.token_cipher)) return refreshed.access_token;
  row=await env.DB.prepare('SELECT token_cipher FROM discovery_oauth WHERE id=1').first();
  return (await decryptTokens(env,row.token_cipher)).access_token;
}
export async function getDiscoveryState(env) {
  await ensureDiscoveryTables(env);
  const [settings,auth,products]=await Promise.all([
    env.DB.prepare('SELECT * FROM discovery_settings WHERE id=1').first(),
    env.DB.prepare('SELECT expires_at FROM discovery_oauth WHERE id=1').first(),
    env.DB.prepare("SELECT * FROM discovered_products WHERE status='new' ORDER BY first_seen_at DESC LIMIT 40").all()
  ]);
  return {settings,app_configured:appReady(env),connected:!!auth,products:products.results};
}
export async function setDiscoveryConfig(env,body) {
  await ensureDiscoveryTables(env);
  const keywords=parseKeywords(body.keywords);
  const interval=Number(body.interval_minutes);
  if(![60,120,240,360].includes(interval)||typeof body.enabled!=='boolean') throw new Error('Configuração do Radar inválida.');
  if(body.enabled){
    if(!appReady(env)) throw new Error('Configure as credenciais do aplicativo Mercado Livre na Cloudflare.');
    const linked=await env.DB.prepare('SELECT id FROM discovery_oauth WHERE id=1').first();
    if(!linked) throw new Error('Conecte o Mercado Livre pelo botão do Radar antes de ativar.');
  }
  await env.DB.prepare('UPDATE discovery_settings SET keywords=?,interval_minutes=?,enabled=?,last_error=NULL WHERE id=1').bind(keywords.join(', '),interval,Number(body.enabled)).run();
  return {ok:true};
}
export async function dismissDiscovery(env,id) {
  await ensureDiscoveryTables(env);
  if(!/^MLB\d{4,18}$/.test(String(id))) throw new Error('Produto inválido.');
  const r=await env.DB.prepare("UPDATE discovered_products SET status='dismissed' WHERE product_id=?").bind(id).run();
  return {ok: r.meta?.changes===1};
}
export async function disconnectDiscovery(env) {
  await ensureDiscoveryTables(env);
  await env.DB.prepare('DELETE FROM discovery_oauth WHERE id=1').run();
  await env.DB.prepare('UPDATE discovery_settings SET enabled=0,last_error=NULL WHERE id=1').run();
}
export async function searchCatalog(env,{force=false}={}) {
  await ensureDiscoveryTables(env);
  const cfg=await env.DB.prepare('SELECT * FROM discovery_settings WHERE id=1').first();
  const keywords=parseKeywords(cfg.keywords);
  const now=utcNow();
  if(!force && !cfg.enabled) return {skipped:'disabled'};
  const minInterval=force?60:cfg.interval_minutes*60;
  const claim=await env.DB.prepare('UPDATE discovery_settings SET last_run_at=?,last_error=NULL WHERE id=1 AND (last_run_at IS NULL OR last_run_at<=?)').bind(now,now-minInterval).run();
  if(claim.meta?.changes!==1) return {skipped:'interval'};
  try{
    if(!appReady(env)) throw new Error('Configure as credenciais de aplicativo do Mercado Livre.');
    const token=await validAccessToken(env);
    const keyword=keywords[(cfg.keyword_cursor||0)%keywords.length];
    const uri=new URL(SEARCH_URL);
    for(const [k,v] of Object.entries({status:'active',site_id:'MLB',q:keyword,limit:'10'}))uri.searchParams.set(k,v);
    const response=await fetch(uri.href,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    if(response.status===401||response.status===403) throw new Error('A API negou acesso ao catálogo. Verifique a autorização e as permissões do aplicativo.');
    if(response.status===429) throw new Error('Limite de pesquisas da API atingido; tente novamente mais tarde.');
    if(!response.ok) throw new Error('A pesquisa oficial do Mercado Livre retornou HTTP '+response.status+'.');
    const body=await response.json();
    if(!Array.isArray(body.results)) throw new Error('Resposta do catálogo sem resultados válidos.');
    let added=0;
    for(const raw of body.results.slice(0,10)){
      const p=normalizeCatalogResult(raw,keyword);
      if(!p) continue;
      const insert=await env.DB.prepare("INSERT OR IGNORE INTO discovered_products(product_id,title,keyword,source_url,image_url,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?)")
        .bind(p.product_id,p.title,p.keyword,p.source_url,p.image_url,now,now).run();
      if(insert.meta?.changes===1) added++;
      else await env.DB.prepare('UPDATE discovered_products SET last_seen_at=? WHERE product_id=?').bind(now,p.product_id).run();
    }
    await env.DB.prepare('UPDATE discovery_settings SET keyword_cursor=keyword_cursor+1,last_error=NULL WHERE id=1').run();
    return {keyword,added};
  }catch(error){
    const message=String(error?.message||error).slice(0,250);
    // Em erro de permissão, pausar para evitar solicitações repetidas sem autorização.
    const denied=/negou acesso|Conecte uma conta|credenciais de aplicativo/i.test(message);
    await env.DB.prepare('UPDATE discovery_settings SET last_error=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END WHERE id=1').bind(message,Number(denied)).run();
    return {error:message};
  }
}
