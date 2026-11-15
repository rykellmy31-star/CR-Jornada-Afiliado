// Consulta somente metadados públicos do anúncio oficial do Mercado Livre.
// Não utiliza sessão, navegador automatizado ou endpoints privados.
import {productId} from './link-batches.js';

const ALLOWED_HOSTS=new Set([
 'mercadolivre.com.br','www.mercadolivre.com.br',
 'produto.mercadolivre.com.br','m.mercadolivre.com.br'
]);
const MAX_HTML_BYTES=750000;
const MAX_PRICE_CENTS=99999999;

function officialUrl(value, expectedId) {
 try{
  const u=new URL(value);
  return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&
   ALLOWED_HOSTS.has(u.hostname.toLowerCase())&&productId(u.pathname)===expectedId;
 }catch{return false;}
}
function attr(tag,name){
 const re=new RegExp('(?:^|\\s)'+name+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i');
 const match=tag.match(re);return match?(match[1]??match[2]??match[3]):null;
}
function htmlUrl(html){
 for(const tag of html.match(/<link\b[^>]{0,2000}>/gi)||[]){
  if(/\bcanonical\b/i.test(attr(tag,'rel')||'')){
   return attr(tag,'href');
  }
 }
 for(const tag of html.match(/<meta\b[^>]{0,2000}>/gi)||[]){
  if((attr(tag,'property')||attr(tag,'name')||'').toLowerCase()==='og:url')return attr(tag,'content');
 }
 return null;
}
export function parseSiteMoney(value){
 if(typeof value==='number'){
  const cents=Math.round(value*100);
  return Number.isFinite(value)&&Number.isSafeInteger(cents)&&cents>0&&cents<=MAX_PRICE_CENTS?cents:null;
 }
 if(typeof value!=='string')return null;
 const s=value.trim().replace(/^R\$\s*/,'');
 if(!/^\d{1,6}(?:\.\d{3})*(?:,\d{1,2})?$/.test(s)&&
    !/^\d{1,6}(?:\.\d{1,2})?$/.test(s))return null;
 // O metadado de preço do site geralmente usa ponto decimal (91.10).
 const thousands=/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(s);
 const valueNumber=Number(thousands?s.replace(/\./g,'').replace(',','.'):s.replace(',','.'));
 return parseSiteMoney(valueNumber);
}
function typedProduct(item){
 const types=Array.isArray(item?.['@type'])?item['@type']:[item?.['@type']];
 return types.some(x=>typeof x==='string'&&/(?:^|\/)Product$/.test(x));
}
function priceFromOffers(product){
 const offers=Array.isArray(product.offers)?product.offers:[product.offers];
 const values=[];
 for(const offer of offers.slice(0,12)){
  if(!offer||typeof offer!=='object')continue;
  if((offer.priceCurrency||'').toUpperCase()!=='BRL')continue;
  const price=parseSiteMoney(offer.price);
  if(price)values.push(price);
 }
 return new Set(values).size===1?values[0]:null;
}
export function extractMercadoLivrePagePrice(html,sourceUrl){
 const expectedId=productId(new URL(sourceUrl).pathname);
 if(!expectedId||!officialUrl(sourceUrl,expectedId)||typeof html!=='string')return null;
 const canonical=htmlUrl(html);
 if(canonical&&!officialUrl(canonical,expectedId))return null;
 const products=[];
 for(const match of html.matchAll(/<script\b(?=[^>]*\btype\s*=\s*["']application\/ld\+json["'])[^>]{0,1000}>([\s\S]*?)<\/script\s*>/gi)){
  let payload;try{payload=JSON.parse(match[1]);}catch{continue;}
  const nodes=[payload];let count=0;
  while(nodes.length&&count++<70){
   const node=nodes.shift();
   if(Array.isArray(node)){nodes.push(...node.slice(0,30));continue;}
   if(!node||typeof node!=='object')continue;
   if(typedProduct(node))products.push(node);
   if(node['@graph'])nodes.push(node['@graph']);
  }
 }
 const matched=products.filter(x=>{
  const url=x.url||x.mainEntityOfPage;
  return typeof url==='string'&&officialUrl(url,expectedId);
 });
 // Sem URL no Product, usa o único Product da página com canonical comprovado.
 const candidates=matched.length?matched:canonical&&officialUrl(canonical,expectedId)&&products.length===1?products:[];
 const values=candidates.map(priceFromOffers).filter(x=>Number.isSafeInteger(x));
 if(new Set(values).size===1&&values.length)return {price_cents:values[0],source:'schema.org/Product'};
 if(values.length>1)return null;
 // Metadados globais só são aceitos com URL canônica validada.
 if(!canonical||!officialUrl(canonical,expectedId))return null;
 const metas={};
 for(const tag of html.match(/<meta\b[^>]{0,2000}>/gi)||[]){
  const name=(attr(tag,'property')||attr(tag,'name')||'').toLowerCase();
  if(['product:price:amount','product:price:currency'].includes(name))metas[name]=attr(tag,'content');
 }
 if((metas['product:price:currency']||'').toUpperCase()!=='BRL')return null;
 const cents=parseSiteMoney(metas['product:price:amount']);
 return cents?{price_cents:cents,source:'meta:product:price'}:null;
}
async function readLimited(response){
 if(!response.body?.getReader)return (await response.text()).slice(0,MAX_HTML_BYTES);
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let bytes=0,result='';
 try{
  while(bytes<MAX_HTML_BYTES){
   const {done,value}=await reader.read();
   if(done)return result+decoder.decode();
   const take=Math.min(value.byteLength,MAX_HTML_BYTES-bytes);
   result+=decoder.decode(value.subarray(0,take),{stream:true});bytes+=take;
   if(take<value.byteLength)break;
  }
 }finally{try{await reader.cancel();}catch{}}
 return result+decoder.decode();
}
export async function fetchMercadoLivrePrice(sourceUrl,fetcher=fetch){
 const id=productId(new URL(sourceUrl).pathname);
 if(!id||!officialUrl(sourceUrl,id))return null;
 let current=sourceUrl;
 for(let hop=0;hop<3;hop++){
  if(!officialUrl(current,id))return null;
  const res=await fetcher(current,{method:'GET',redirect:'manual',
   headers:{accept:'text/html'},signal:AbortSignal.timeout(6500)});
  if([301,302,303,307,308].includes(res.status)){
   const location=res.headers.get('location');
   if(!location)return null;
   current=new URL(location,current).href;continue;
  }
  if(!res.ok||!/^text\/html(?:;|$)/i.test(res.headers.get('content-type')||''))return null;
  return extractMercadoLivrePagePrice(await readLimited(res),current);
 }
 return null;
}
