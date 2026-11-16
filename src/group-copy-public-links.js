// Na cópia automática, a foto e a verificação continuam usando a URL original
// do produto. Somente o link mostrado ao comprador usa o encurtador PromoML.
// Caso a tabela de cópias ainda não exista, a publicação antiga fica intacta.
const PUBLIC_HOST='promoml.app';
export function trustedGroupCopyPublicLink(input){
 try{
  const u=new URL(input);
  return u.protocol==='https:' && u.hostname===PUBLIC_HOST &&
   !u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&
   /^\/[A-Za-z0-9_-]{12}$/.test(u.pathname)?u.href:null;
 }catch{return null;}
}
export async function withGroupCopyPublicLink(env,offer){
 if(!offer?.affiliate_url || !env?.DB)return offer;
 try{
  const record=await env.DB.prepare(
   'SELECT short_url,target_url FROM ml_group_copy_auto_history WHERE target_url=? ORDER BY queued_at DESC LIMIT 1'
  ).bind(offer.affiliate_url).first();
  const publicUrl=record?.target_url===offer.affiliate_url?trustedGroupCopyPublicLink(record.short_url):null;
  return publicUrl?{...offer,public_url:publicUrl}:offer;
 }catch(error){
  // Não impedir publicações existentes caso esta funcionalidade esteja indisponível.
  return offer;
 }
}
