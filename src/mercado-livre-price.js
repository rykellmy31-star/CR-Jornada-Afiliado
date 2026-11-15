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
function detailsFromOffer(offer,product){
 if(!offer||typeof offer!=='object'||(offer.priceCurrency||'').toUpperCase()!=='BRL')return null;
 const current=parseSiteMoney(offer.price);
 if(!current)return null;
 // Só exibe "De" quando é explicitamente um preço antigo DO MESMO anúncio.
 const specs=[...(Array.isArray(offer.priceSpecification)?offer.priceSpecification:[offer.priceSpecification])]
  .filter(s=>s&&typeof s==='object');
 const oldCandidates=[];
 for(const spec of specs){
  if(spec.priceCurrency&&String(spec.priceCurrency).toUpperCase()!=='BRL')continue;
  const kind=String(spec.priceType||'').split('/').at(-1).toLowerCase();
  if(!['strikethroughprice','listprice','regularprice','originalprice','wasprice'].includes(kind))continue;
  const previous=parseSiteMoney(spec.price);
  if(previous&&previous>current)oldCandidates.push(previous);
 }
 for(const candidate of [offer.originalPrice,offer.oldPrice,offer.listPrice,product?.originalPrice,product?.oldPrice]){
  const previous=parseSiteMoney(candidate);
  if(previous&&previous>current)oldCandidates.push(previous);
 }
 const old=oldCandidates.length&&new Set(oldCandidates).size===1?oldCandidates[0]:null;
 // Só imprime formas de pagamento anunciadas no Offer do produto correto.
 const methods=Array.isArray(offer.paymentMethod)?offer.paymentMethod:[offer.paymentMethod];
 const normalized=methods.filter(x=>typeof x==='string').map(x=>x.toLowerCase());
 const pix=normalized.some(x=>/\\bpix\\b/.test(x));
 const card=normalized.some(x=>/creditcard|cart[aã]o|cr[eé]dito/.test(x));
 const payment_mode=pix&&!card?'pix':card&&!pix?'card':'unspecified';
 const plan=offer.installmentPlan||offer.installments||null;
 const installments=Number(typeof plan==='object'&&plan!==null?(plan.numberOfPayments??plan.installments):plan);
 const count=Number.isInteger(installments)&&installments>=2&&installments<=24?installments:null;
 const installment_cents=count&&plan&&typeof plan==='object'
  ?parseSiteMoney(plan.paymentAmount??plan.installmentAmount):null;
 const installments_no_interest=!!(count&&plan&&typeof plan==='object'&&plan.interestFree===true);
 return {price_cents:current,old_price_cents:old,payment_mode,installments:count,
  installment_cents,installments_no_interest};
}
function priceFromOffers(product){
 const offers=Array.isArray(product.offers)?product.offers:[product.offers];
 const found=offers.slice(0,12).map(o=>detailsFromOffer(o,product)).filter(Boolean);
 if(!found.length||new Set(found.map(x=>x.price_cents)).size!==1)return null;
 const old=[...new Set(found.map(x=>x.old_price_cents).filter(Boolean))];
 const payments=[...new Set(found.map(x=>x.payment_mode).filter(x=>x!=='unspecified'))];
 const base=found[0];
 return {...base,old_price_cents:old.length===1?old[0]:null,
  payment_mode:payments.length===1?payments[0]:'unspecified',
  installments:found.length===1?base.installments:null,
  installment_cents:found.length===1?base.installment_cents:null,
  installments_no_interest:found.length===1?base.installments_no_interest:false};
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
 const values=candidates.map(priceFromOffers).filter(Boolean);
 if(values.length&&new Set(values.map(x=>x.price_cents)).size===1){
  const old=[...new Set(values.map(x=>x.old_price_cents).filter(Boolean))];
  return {...values[0],old_price_cents:old.length===1?old[0]:null,source:'schema.org/Product'};
 }
 if(values.length>1)return null;
 // Metadados globais só são aceitos com URL canônica validada.
 if(!canonical||!officialUrl(canonical,expectedId))return null;
 const metas={};
 for(const tag of html.match(/<meta\b[^>]{0,2000}>/gi)||[]){
  const name=(attr(tag,'property')||attr(tag,'name')||'').toLowerCase();
  if(['product:price:amount','product:price:currency','product:original_price:amount','product:original_price:currency'].includes(name))
   metas[name]=attr(tag,'content');
 }
 if((metas['product:price:currency']||'').toUpperCase()!=='BRL')return null;
 const cents=parseSiteMoney(metas['product:price:amount']);
 const prior=(metas['product:original_price:currency']||'').toUpperCase()==='BRL'
  ?parseSiteMoney(metas['product:original_price:amount']):null;
 return cents?{price_cents:cents,old_price_cents:prior&&prior>cents?prior:null,
  payment_mode:'unspecified',installments:null,installment_cents:null,installments_no_interest:false,
  source:'meta:product:price'}:null;
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

// Consulta alternativa somente à API PÚBLICA oficial, sem token do afiliado.
// Confere o ID do anúncio/catálogo e BRL antes de aceitar qualquer preço.
// Falhas, respostas privadas e produtos divergentes nunca viram ofertas.
export async function fetchMercadoLivrePublicPrice(sourceUrl,fetcher=fetch){
 let id;
 try{id=productId(new URL(sourceUrl).pathname);}catch{return null;}
 if(!id||!officialUrl(sourceUrl,id))return null;
 const endpoints=[
  'https://api.mercadolibre.com/items/'+encodeURIComponent(id),
  'https://api.mercadolibre.com/products/'+encodeURIComponent(id)
 ];
 for(const endpoint of endpoints){
  try{
   const res=await fetcher(endpoint,{method:'GET',redirect:'manual',
    headers:{accept:'application/json'},signal:AbortSignal.timeout(4500)});
   if(!res?.ok||!/\bapplication\/json\b/i.test(res.headers.get('content-type')||''))continue;
   const body=await res.json();
   if(!body||String(body.id||'').toUpperCase()!==id)continue;
   const entry=body.buy_box_winner&&typeof body.buy_box_winner==='object'
    ?body.buy_box_winner:body;
   if(String(entry.currency_id||body.currency_id||'').toUpperCase()!=='BRL')continue;
   const price=parseSiteMoney(entry.price);
   if(!price)continue;
   const original=parseSiteMoney(entry.original_price);
   return {price_cents:price,old_price_cents:original&&original>price?original:null,
    payment_mode:'unspecified',installments:null,installment_cents:null,
    installments_no_interest:false,source:'api.mercadolibre.com'};
  }catch{/* A API pública pode exigir autorização ou limitar acesso. */}
 }
 return null;
}

// A vitrine /social é uma página oficial do ML. Aceitar SOMENTE o cartão
// destacado com o mesmo MLB/MLBU do anúncio já confirmado. Nunca ler preços
// da lista de recomendações abaixo dele.
export function extractFeaturedShowcasePrice(html,expectedProductId){
 if(typeof html!=='string'||html.length>5500000||
  !/^MLBU?\d{6,}$/.test(String(expectedProductId||'')))return null;
 const start=html.search(/<(?:div|section)\b[^>]{0,1200}class=["'][^"']*\brl-card-featured-wrapper\b[^"']*["'][^>]*>/i);
 if(start<0)return null;
 let scope=html.slice(start,start+180000);
 const boundary=scope.search(/rl-card-recommendations|affiliate-profile-recommendations|Quem viu este produto tamb/i);
 if(boundary>=0)scope=scope.slice(0,boundary);
 const ids=new Set();
 for(const tag of scope.match(/<a\b[^>]{0,6500}>/gi)||[]){
  if(!/\bpoly-component__title\b/i.test(attr(tag,'class')||''))continue;
  let path;try{const u=new URL((attr(tag,'href')||'').replace(/&amp;/gi,'&'));
   if(!ALLOWED_HOSTS.has(u.hostname.toLowerCase()))continue;
   path=u.pathname;
  }catch{continue;}
  const id=productId(path);
  if(id)ids.add(id);
 }
 if(ids.size!==1||!ids.has(expectedProductId))return null;
 const begin=scope.search(/<div\b[^>]*class=["'][^"']*\bpoly-component__price\b[^"']*["'][^>]*>/i);
 if(begin<0)return null;
 const block=scope.slice(begin,begin+9000);
 const current=block.indexOf('poly-price__current');
 if(current<0)return null;
 const parseAmount=fragment=>{
  if(!fragment.includes('andes-money-amount__currency-symbol')||!fragment.includes('R$'))return null;
  const fraction=fragment.match(/andes-money-amount__fraction[^>]*>\s*([\d.]+)\s*</i)?.[1];
  if(!fraction)return null;
  const cents=fragment.match(/andes-money-amount__cents(?:\s|["'][^>]*|--[^>]*)>\s*(\d{1,2})\s*</i)?.[1]||'00';
  const whole=fraction.replace(/\./g,'');
  return /^\d{1,6}$/.test(whole)?parseSiteMoney(Number(whole+'.'+cents.padStart(2,'0'))):null;
 };
 const currentChunk=block.slice(current,current+1400);
 const price=parseAmount(currentChunk);
 if(!price)return null;
 const oldAt=block.search(/<s\b[^>]*class=["'][^"']*\bpoly-price__previous\b/i);
 const old=oldAt>=0&&oldAt<current?parseAmount(block.slice(oldAt,oldAt+850)):null;
 const discount=block.slice(current,current+1900);
 const pixOnly=/\bOFF\s+no\s+Pix\b|(?:somente|apenas)\s+(?:no\s+)?Pix/i.test(discount.replace(/<[^>]*>/g,' '));
 let installments=null,installment_cents=null,card_price_cents=null,installments_no_interest=false;
 const instAt=block.indexOf('poly-price__installments');
 if(instAt>=0){
  const inst=block.slice(instAt,instAt+4200);
  const plain=inst.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
  const count=Number(plain.match(/\b(\d{1,2})\s*x\b/i)?.[1]);
  if(Number.isInteger(count)&&count>=2&&count<=24){
   const tags=[...inst.matchAll(/<span\b[^>]*class=["'][^"']*andes-money-amount[^"']*\bpolylabel-price\b[^"']*["'][^>]*>/gi)];
   const amounts=tags.slice(0,3).map(x=>parseAmount(inst.slice(x.index,x.index+750))).filter(Boolean);
   const part=amounts.length>=2?amounts[1]:amounts[0]||null;
   if(part){
    installments=count;
    installment_cents=part;
    installments_no_interest=/\bsem\s+juros\b/i.test(plain);
    if(pixOnly&&amounts.length>=2&&amounts[0]>price)
     card_price_cents=amounts[0];
   }
  }
 }
 return {price_cents:price,old_price_cents:old&&old>price?old:null,
  payment_mode:pixOnly?'pix_only':'unspecified',installments,installment_cents,
  installments_no_interest,card_price_cents,source:'vitrine oficial do produto principal'};
}
