// Publica fotografia real do anúncio, nunca mensagem de texto/preview como substituta.
// Quando o Telegram não consegue baixar a URL da CDN, envia o próprio arquivo em multipart.
import {trustedProductImage} from './images.js';

const LIMIT=5_000_000;
const api=(token)=>'https://api.telegram.org/bot'+token+'/sendPhoto';

async function readImage(url,fetcher){
 if(!trustedProductImage(url))throw new Error('URL de foto não autorizada.');
 const response=await fetcher(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new Error('Imagem original indisponível na CDN (HTTP '+response.status+').');
 const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
 if(!['image/jpeg','image/png'].includes(mime))throw new Error('O servidor do produto não retornou JPEG/PNG.');
 const length=Number(response.headers.get('content-length')||0);
 if(!Number.isSafeInteger(length)||length>LIMIT)throw new Error('Foto original muito grande.');
 const reader=response.body?.getReader();
 if(!reader)throw new Error('Foto sem conteúdo.');
 const parts=[];let size=0;
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   size+=value.byteLength;
   if(size>LIMIT)throw new Error('Foto original ultrapassa 5 MB.');
   parts.push(value);
  }
 }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
 if(!size)throw new Error('Foto original vazia.');
 return {blob:new Blob(parts,{type:mime}),filename:mime==='image/png'?'produto.png':'produto.jpg'};
}
function checkTelegram(response,data){
 if(response.ok&&data?.ok&&data?.result?.message_id)return data.result;
 const error=new Error(String(data?.description||'Telegram HTTP '+response.status).slice(0,180));
 error.telegramStatus=response.status;
 throw error;
}
export async function sendTelegramProductPhoto(token,chat,imageUrl,payload,{fetcher=fetch}={}){
 if(!trustedProductImage(imageUrl))throw new Error('A imagem do anúncio não é confiável.');
 const request={chat_id:chat,photo:imageUrl,caption:payload.text,parse_mode:payload.parse_mode,reply_markup:payload.reply_markup};
 const endpoint=api(token);
 const response=await fetcher(endpoint,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(15000)
 });
 const json=await response.json().catch(()=>null);
 if(response.ok&&json?.ok&&json?.result?.message_id)return json.result;
 const description=String(json?.description||'');
 // Só tenta upload quando o Telegram recusou especificamente baixar/ler a foto.
 // Falhas ambíguas permanecem em revisão para não duplicar mensagens.
 if(response.status!==400||!/photo|image|file|http url|url content|wrong type|format/i.test(description))
  return checkTelegram(response,json);
 const {blob,filename}=await readImage(imageUrl,fetcher);
 const form=new FormData();
 form.set('chat_id',chat);
 form.set('photo',blob,filename);
 form.set('caption',payload.text);
 if(payload.parse_mode)form.set('parse_mode',payload.parse_mode);
 if(payload.reply_markup)form.set('reply_markup',JSON.stringify(payload.reply_markup));
 const uploaded=await fetcher(endpoint,{method:'POST',body:form,signal:AbortSignal.timeout(20000)});
 return checkTelegram(uploaded,await uploaded.json().catch(()=>null));
}
