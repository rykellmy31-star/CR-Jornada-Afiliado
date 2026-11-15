import {trustedProductImage} from './images.js';

// A Evolution aceita link JPEG público ou JPEG em base64. A foto real da vitrine
// às vezes é WebP; convertemos o MESMO arquivo para JPEG no Worker, sem usar preview.
const MAX_BYTES=5_000_000;
function encodeBase64(bytes){
 let result='';
 // Cada bloco, exceto o último, é múltiplo de três (sem '=' intermediário).
 for(let offset=0;offset<bytes.length;offset+=24576){
  const slice=bytes.subarray(offset,offset+24576);
  result+=btoa(String.fromCharCode(...slice));
 }
 return result;
}
export async function photoForWhatsApp(url,{fetcher=fetch}={}){
 if(!trustedProductImage(url))throw new Error('Foto do produto fora da CDN oficial.');
 if(!/\.webp(?:\?|$)/i.test(url))
  return {media:url,mimetype:/\.png(?:\?|$)/i.test(url)?'image/png':'image/jpeg',filename:'produto.jpg'};
 const response=await fetcher(url,{method:'GET',redirect:'manual',
  cf:{image:{format:'jpeg',fit:'scale-down',width:1200,quality:90}},
  signal:AbortSignal.timeout(14000)});
 if(!response.ok||(response.headers.get('content-type')||'').split(';')[0].toLowerCase()!=='image/jpeg')
  throw new Error('Não foi possível converter a foto WebP da vitrine em JPEG na Cloudflare.');
 const limit=Number(response.headers.get('content-length')||0);
 if(limit>MAX_BYTES)throw new Error('Imagem convertida muito grande.');
 const buffer=new Uint8Array(await response.arrayBuffer());
 if(!buffer.length||buffer.length>MAX_BYTES)throw new Error('Foto convertida vazia ou muito grande.');
 return {media:'data:image/jpeg;base64,'+encodeBase64(buffer),mimetype:'image/jpeg',filename:'produto.jpg'};
}
