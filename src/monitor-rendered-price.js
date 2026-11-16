// Confirma preços de anúncios oficiais no navegador renderizado quando a API e
// o HTML público não os disponibilizam. Nunca usa preços de grupos nem de terceiros.
import {productId} from './link-batches.js';
import {extractMercadoLivrePagePrice} from './mercado-livre-price.js';

const HOSTS=new Set(['mercadolivre.com.br','www.mercadolivre.com.br',
  'produto.mercadolivre.com.br','m.mercadolivre.com.br']);
const LIMIT=96;
const COOLDOWN=8;
const TABLE="CREATE TABLE IF NOT EXISTS affiliate_price_browser_budget ("+
  "id INTEGER PRIMARY KEY CHECK(id=1),day_key TEXT NOT NULL DEFAULT '',"+
  "daily_count INTEGER NOT NULL DEFAULT 0,last_at INTEGER NOT NULL DEFAULT 0)";
const nowSeconds=()=>Math.floor(Date.now()/1000);

function checkedSource(sourceUrl){
  try{
    const url=new URL(sourceUrl);
    if(url.protocol!=='https:'||url.username||url.password||url.port||
      !HOSTS.has(url.hostname.toLowerCase()))return false;
    return !!productId(url.pathname);
  }catch{return false;}
}

// Compartilha a mesma cota do navegador já usada no envio automático.
// A reserva atômica impede múltiplos Crons de excederem o limite.
async function claimBrowser(env,at){
  const day=new Date(at*1000).toISOString().slice(0,10);
  await env.DB.prepare(TABLE).run();
  await env.DB.prepare("INSERT OR IGNORE INTO affiliate_price_browser_budget(id) VALUES(1)").run();
  const result=await env.DB.prepare(
    "UPDATE affiliate_price_browser_budget SET "+
    "daily_count=CASE WHEN day_key=? THEN daily_count+1 ELSE 1 END,"+
    "day_key=?,last_at=? WHERE id=1 AND (day_key<>? OR daily_count<"+LIMIT+") "+
    "AND last_at<=?"
  ).bind(day,day,at,day,at-COOLDOWN).run();
  return result.meta?.changes===1;
}
export async function fetchRenderedMonitorPrice(env,sourceUrl,{at=nowSeconds()}={}){
  if(!env?.DB||typeof env?.BROWSER?.quickAction!=='function'||
    !checkedSource(sourceUrl))return null;
  const stamp=Number.isSafeInteger(at)&&at>0?at:nowSeconds();
  if(!await claimBrowser(env,stamp))return null;
  try{
    const page=await env.BROWSER.quickAction('content',{
      url:sourceUrl,
      gotoOptions:{waitUntil:'networkidle2',timeout:20000},
      rejectResourceTypes:['image','font','media']
    });
    if(!page?.ok||typeof page.text!=='function')return null;
    const details=extractMercadoLivrePagePrice(
      (await page.text()).slice(0,750000),sourceUrl);
    return Number.isSafeInteger(details?.price_cents)&&details.price_cents>0
      ?{...details,source:'navegador do anuncio oficial'}:null;
  }catch(error){
    console.warn('Preço renderizado do monitor indisponível:',
      String(error?.message||error).slice(0,110));
    return null;
  }
}
