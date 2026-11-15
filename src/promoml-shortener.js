// Worker público e isolado do painel administrativo CR Jornada.
// Somente redirecionamentos curtos para links Mercado Livre salvos em D1.
// Não recebe credenciais de login, não possui API de administração ou publicação.
import {followAffiliateShortlink} from './affiliate-stores.js';

const LANDING = "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>PromoML • Ofertas</title><style>:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f8fb;color:#19334d;font-family:system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}main{width:min(440px,calc(100% - 36px));background:white;padding:32px;border:1px solid #e5edf3;border-radius:16px;box-shadow:0 14px 40px #17365412;text-align:center}strong{color:#0b8d82;font-size:26px}h1{font-size:22px}p{line-height:1.6;color:#637589;font-size:14px}</style></head><body><main><strong>PromoML</strong><h1>Links de ofertas</h1><p>Este domínio disponibiliza links de divulgação da CR Jornada. Para consultar o preço atualizado e a disponibilidade, confira o anúncio no Mercado Livre.</p></main></body></html>";
const htmlHeaders={
  'content-type':'text/html; charset=utf-8',
  'cache-control':'no-store',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy':'no-referrer',
  'x-content-type-options':'nosniff'
};
export default {
 async fetch(request,env){
  if(request.method!=='GET'&&request.method!=='HEAD')
    return new Response('Método não permitido.',{status:405,headers:{allow:'GET, HEAD','cache-control':'no-store'}});
  const url=new URL(request.url);
  if(url.hostname!=='promoml.app')return new Response('Não encontrado.',{status:404});
  if(url.pathname==='/')
    return new Response(request.method==='HEAD'?null:LANDING,{status:200,headers:htmlHeaders});
  const match=url.pathname.match(/^\/(?:s\/|l\/)?([A-Za-z0-9_-]{12})$/);
  if(!match)return new Response('Link não encontrado.',{status:404,headers:{'cache-control':'no-store'}});
  if(!env.DB)return new Response('Encurtador temporariamente indisponível.',{status:503,headers:{'cache-control':'no-store'}});
  try{
    const destination=await followAffiliateShortlink(env,match[1]);
    return request.method==='HEAD'?new Response(null,{status:destination.status,headers:destination.headers}):destination;
  }catch(error){
    console.error('PromoML: falha ao consultar link.',error?.name||'Error');
    return new Response('Encurtador temporariamente indisponível.',{status:503,headers:{'cache-control':'no-store'}});
  }
 }
};
