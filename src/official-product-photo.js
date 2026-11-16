// Recupera SOMENTE a imagem do mesmo anúncio na API pública oficial.
// Não utiliza cookies, preços de terceiros, recomendações nem foto genérica.
import {productId} from './link-batches.js';
import {trustedProductImage,validatedProductPhoto} from './images.js';

const PAGE_HOSTS=new Set(['mercadolivre.com.br','www.mercadolivre.com.br',
  'produto.mercadolivre.com.br','m.mercadolivre.com.br']);
const MAX_JSON_BYTES=900000;

function productForSource(sourceUrl){
  try{
    const u=new URL(sourceUrl);
    if(u.protocol!=='https:'||u.username||u.password||u.port||
      !PAGE_HOSTS.has(u.hostname.toLowerCase()))return null;
    return productId(u.pathname)||null;
  }catch{return null;}
}
function normalizedPhoto(input){
  if(typeof input!=='string')return null;
  let u;
  try{u=new URL(input);}catch{return null;}
  // A API do próprio Mercado Livre ainda retorna URLs http em alguns itens.
  // O upgrade só é permitido no domínio literal da CDN, nunca em outro host.
  if(u.protocol==='http:'&&u.hostname.toLowerCase()==='http2.mlstatic.com'&&
     !u.username&&!u.password&&!u.port)u.protocol='https:';
  return trustedProductImage(u.href)?u.href:null;
}
function officialPhotos(data){
  const sources=[data?.pictures,data?.images, data?.main_picture,
    data?.picture, data?.secure_thumbnail, data?.thumbnail];
  const pictures=[];
  for(const source of sources){
    const items=Array.isArray(source)?source.slice(0,12):[source];
    for(const obj of items){
      const candidates=typeof obj==='string'?[obj]:
        [obj?.secure_url,obj?.url,obj?.secureUrl,obj?.src];
      for(const candidate of candidates){
        const photo=normalizedPhoto(candidate);
        if(photo&&!pictures.includes(photo))pictures.push(photo);
        if(pictures.length>=14)return pictures;
      }
    }
  }
  return pictures;
}
export async function fetchOfficialProductPhoto(sourceUrl,{fetcher=fetch}={}){
  const id=productForSource(sourceUrl);
  if(!id)return null;
  for(const type of ['items','products']){
    const url='https://api.mercadolibre.com/'+type+'/'+encodeURIComponent(id);
    try{
      const res=await fetcher(url,{method:'GET',redirect:'manual',
        headers:{accept:'application/json'},signal:AbortSignal.timeout(5500)});
      if(!res?.ok||!/^application\/json\b/i.test(res.headers.get('content-type')||'')||
        Number(res.headers.get('content-length')||0)>MAX_JSON_BYTES)continue;
      const text=await res.text();
      if(text.length>MAX_JSON_BYTES)continue;
      let data;try{data=JSON.parse(text);}catch{continue;}
      if(String(data?.id||'').toUpperCase()!==id)continue;
      for(const photo of officialPhotos(data)){
        // A mesma verificação de CDN/MIME/tamanho do publicador manual.
        const confirmed=await validatedProductPhoto(photo,fetcher);
        if(confirmed)return confirmed;
      }
    }catch(error){
      // Falhas públicas (403/429/timeout) não geram foto falsa.
    }
  }
  return null;
}
