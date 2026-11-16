// Cadastro de lojas: reconhecer etiqueta exclusivamente a partir de links oficiais meli.la.
// A configuração não altera as filas, não comprova comissão e não usa credenciais de login.
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const ML_HOSTS=new Set(['www.mercadolivre.com.br','mercadolivre.com.br']);
const ML_PRODUCT_HOSTS=new Set([...ML_HOSTS,'produto.mercadolivre.com.br']);
// Listagens clássicas usam produto.mercadolivre.com.br/MLB-1234-...-_JM,
// enquanto o catálogo usa /p/MLB... e /up/MLBU.... Aceitar somente
// caminhos de anúncios, nunca buscas, vitrines ou redirecionadores externos.
function productPath(pathname){
  if(typeof pathname!=='string'||pathname.length>420)return false;
  return /\/(?:p\/MLB\d{6,}|up\/MLBU\d{6,})\/?$/i.test(pathname)||
    /^\/MLB-\d{6,}(?:-[A-Za-z0-9_-]{1,260})?\/?$/i.test(pathname);
}
const CREATE_STORE="CREATE TABLE IF NOT EXISTS crj_affiliate_store_ml (id INTEGER PRIMARY KEY CHECK(id=1), label TEXT NOT NULL, tool_id TEXT NOT NULL, official_url TEXT NOT NULL, connected_at INTEGER NOT NULL)";
const CREATE_LINKS="CREATE TABLE IF NOT EXISTS crj_affiliate_shortlinks (code TEXT PRIMARY KEY, product_url TEXT NOT NULL, target_url TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL)";
const now=()=>Math.floor(Date.now()/1000);
export async function ensureAffiliateStores(env){
  await env.DB.prepare(CREATE_STORE).run();
  await env.DB.prepare(CREATE_LINKS).run();
}
function safeUrl(value){
  if(typeof value!=='string'||value.length>2000)throw error('Informe uma URL válida com até 2000 caracteres.');
  let u;
  try{u=new URL(value.trim());}catch{throw error('Informe uma URL https válida.');}
  if(u.protocol!=='https:'||u.username||u.password||u.port)throw error('Somente links HTTPS públicos, sem credenciais nem portas adicionais.');
  return u;
}
function officialUrl(value){
  const u=safeUrl(value);
  if(u.hostname!=='meli.la'||!/^\/[A-Za-z0-9]{5,18}\/?$/.test(u.pathname))
    throw error('Cole um link meli.la gerado pela sua conta no Gerador Oficial do Mercado Livre.');
  if(u.search||u.hash)throw error('Cole o link curto oficial sem parâmetros adicionais.');
  return u;
}
export function parseAffiliateIdentity(url){
  const u=safeUrl(url);
  if(!ML_HOSTS.has(u.hostname)||!u.pathname.startsWith('/social/'))
    throw error('O link oficial não direcionou para uma vitrine de afiliado do Mercado Livre.');
  const label=u.searchParams.get('matt_word');
  const tool=u.searchParams.get('matt_tool');
  const pathLabel=u.pathname.split('/')[2];
  if(!label||!/^[A-Za-z0-9_-]{3,64}$/.test(label)||label!==pathLabel||!tool||!/^\d{5,16}$/.test(tool))
    throw error('Não foi possível reconhecer a etiqueta e o identificador neste link oficial.');
  return {label,tool_id:tool};
}
export async function identifyFromOfficialLink(value,fetcher=fetch){
  let current=officialUrl(value);
  for(let i=0;i<6;i++){
    if(current.hostname!=='meli.la'&&!ML_HOSTS.has(current.hostname))
      throw error('O link redirecionou para um site não autorizado.');
    if(current.hostname!=='meli.la'&&current.pathname.startsWith('/social/'))
      return parseAffiliateIdentity(current.toString());
    // Nunca seguir redirects automáticos para outros hosts.
    let response;
    try{
      response=await fetcher(current.toString(),{
        method:'GET',redirect:'manual',headers:{accept:'text/html'},
        signal:AbortSignal.timeout(12000)
      });
    }catch{throw error('Não foi possível verificar o link oficial agora. Tente novamente.');}
    if(response.status===429)throw error('O Mercado Livre limitou temporariamente a consulta. Tente mais tarde.',429);
    if(![301,302,303,307,308].includes(response.status))
      throw error('Não foi possível ler o redirecionamento oficial do link. Nenhuma etiqueta foi salva.');
    const location=response.headers.get('location');
    if(!location)throw error('O link oficial não retornou um destino verificável.');
    current=safeUrl(new URL(location,current).toString());
  }
  throw error('Redirecionamentos demais ao consultar o link oficial.');
}
export async function affiliateStoreState(env){
  await ensureAffiliateStores(env);
  const row=await env.DB.prepare('SELECT label,tool_id,official_url,connected_at FROM crj_affiliate_store_ml WHERE id=1').first();
  return {mercadolivre:row?{configured:true,label:row.label,tool_id:row.tool_id,official_url:row.official_url,connected_at:row.connected_at,commission_verified:false}:{configured:false,commission_verified:false}};
}
export async function connectAffiliateStore(env,payload,fetcher=fetch){
  const u=officialUrl(payload?.official_url);
  const info=await identifyFromOfficialLink(u.toString(),fetcher);
  await ensureAffiliateStores(env);
  await env.DB.prepare('INSERT INTO crj_affiliate_store_ml(id,label,tool_id,official_url,connected_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,tool_id=excluded.tool_id,official_url=excluded.official_url,connected_at=excluded.connected_at')
    .bind(info.label,info.tool_id,u.toString(),now()).run();
  return {ok:true,...await affiliateStoreState(env)};
}
export function parseMercadoLivreProduct(value){
  const u=safeUrl(value);
  if(!ML_PRODUCT_HOSTS.has(u.hostname))throw error('Aceitamos somente URLs de produtos do Mercado Livre Brasil.');
  if(!productPath(u.pathname))
    throw error('O endereço não identifica um anúncio: use /p/MLB..., /up/MLBU... ou /MLB-...-...-_JM.');
  // Preserve o host e o caminho oficiais: mudar produto.mercadolivre.com.br/MLB-...-_JM
  // para /p/MLB... poderia apontar para outro tipo de anúncio.
  // Sempre exclua rastreamento, etiquetas de terceiros, query e hash.
  return u.origin+u.pathname.replace(/\/$/,'');
}
export async function previewAffiliateLink(env,payload){
  await ensureAffiliateStores(env);
  const account=await env.DB.prepare('SELECT label,tool_id FROM crj_affiliate_store_ml WHERE id=1').first();
  if(!account)throw error('Cadastre primeiro seu link oficial em LOJAS.');
  const product_url=parseMercadoLivreProduct(payload?.product_url);
  const target=new URL(product_url);
  target.searchParams.set('forceInApp','true');
  target.searchParams.set('matt_tool',account.tool_id);
  target.searchParams.set('matt_word',account.label);
  return {product_url,target_url:target.toString(),label:account.label,tool_id:account.tool_id,commission_verified:false};
}
export async function createAffiliateShortlink(env,payload,origin){
  const preview=await previewAffiliateLink(env,payload);
  // Criar o código não autoriza qualquer envio automático.
  for(let attempt=0;attempt<4;attempt++){
    const bytes=crypto.getRandomValues(new Uint8Array(9));
    const code=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
    try{
      await env.DB.prepare('INSERT INTO crj_affiliate_shortlinks(code,product_url,target_url,label,created_at) VALUES(?,?,?,?,?)')
        .bind(code,preview.product_url,preview.target_url,preview.label,now()).run();
      return {ok:true,short_url:'https://promoml.app/'+code,...preview};
    }catch(e){if(!/unique|constraint/i.test(String(e?.message||'')))throw e;}
  }
  throw error('Não foi possível reservar um código curto. Tente novamente.',503);
}
export async function followAffiliateShortlink(env,code){
  if(!/^[A-Za-z0-9_-]{12}$/.test(code))return new Response('Link não encontrado.',{status:404});
  await ensureAffiliateStores(env);
  const row=await env.DB.prepare('SELECT target_url FROM crj_affiliate_shortlinks WHERE code=?').bind(code).first();
  if(!row)return new Response('Link não encontrado.',{status:404});
  // Não permitir que um valor manipulado no banco converta o encurtador em open redirect.
  let url;
  try{
    url=safeUrl(row.target_url);
    // Usa EXATAMENTE o mesmo validador usado na criação do encurtamento.
    parseMercadoLivreProduct(url.toString());
  }catch{return new Response('Destino não autorizado.',{status:410});}
  return new Response(null,{status:302,headers:{location:url.toString(),'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
}
