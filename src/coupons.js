export const CREATE_COUPON_TABLE = "CREATE TABLE IF NOT EXISTS offer_coupons (offer_id INTEGER PRIMARY KEY REFERENCES offers(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('code','activation')),code TEXT,discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),discount_value INTEGER NOT NULL,min_cart_cents INTEGER NOT NULL DEFAULT 0,max_discount_cents INTEGER,start_day TEXT NOT NULL,end_day TEXT NOT NULL,source_url TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',owner_confirmed INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)";
export async function ensureCouponTable(env) { await env.DB.prepare(CREATE_COUPON_TABLE).run(); }
function cents(value) {
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>100000||!/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw new Error('Valor do cupom inválido; use 15.00.');
  return Math.round(n*100);
}
function validDay(day) {
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d=new Date(day+'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===day;
}
function officialSource(value,platform='mercadolivre') {
  try {
    const u=new URL(value);
    const hosts=platform==='shopee'
      ? ['shopee.com.br','www.shopee.com.br','s.shopee.com.br','affiliate.shopee.com.br','shp.ee','br.shp.ee']
      : ['mercadolivre.com.br','www.mercadolivre.com.br','meli.la'];
    return u.protocol==='https:' && !u.username && !u.password && !u.port && hosts.includes(u.hostname.toLowerCase());
  }catch{return false;}
}
export function normalizeCoupon(data,platform='mercadolivre') {
  if(data?.owner_confirmation!==true) throw new Error('Confirme a origem oficial e as condições do cupom.');
  const offer_id=Number(data.offer_id);
  if(!Number.isSafeInteger(offer_id)||offer_id<1) throw new Error('Selecione uma oferta da fila.');
  if(!['code','activation'].includes(data.kind)) throw new Error('Selecione um tipo de cupom.');
  const kind=data.kind;
  const code=kind==='code'?String(data.code||'').trim().toUpperCase():null;
  if(kind==='code'&&!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new Error('Código de cupom inválido.');
  const discount_type=data.discount_type;
  if(!['percent','fixed'].includes(discount_type)) throw new Error('Tipo de desconto inválido.');
  const discount_value=discount_type==='percent'?Number(data.discount_value):cents(data.discount_value);
  if(discount_type==='percent'&&(!Number.isInteger(discount_value)||discount_value<1||discount_value>95)) throw new Error('Porcentagem deve ser de 1 a 95%.');
  if(discount_type==='fixed'&&discount_value<1) throw new Error('Valor do desconto precisa ser positivo.');
  const min_cart_cents=data.min_cart===''||data.min_cart==null?0:cents(data.min_cart);
  const max_discount_cents=data.max_discount===''||data.max_discount==null?null:cents(data.max_discount);
  if(max_discount_cents===0) throw new Error('Teto do desconto deve ser positivo.');
  const start_day=data.start_day, end_day=data.end_day;
  if(!validDay(start_day)||!validDay(end_day)||end_day<start_day||end_day<'2020-01-01'||end_day>'2100-12-31') throw new Error('Informe datas de início e fim válidas.');
  const source_url=String(data.source_url||'').trim();
  if(source_url.length>1200||!officialSource(source_url,platform)) throw new Error('Informe uma página oficial '+(platform==='shopee'?'da Shopee':'do Mercado Livre')+' sobre o cupom.');
  const notes=String(data.notes||'').trim().slice(0,220);
  return {offer_id,kind,code,discount_type,discount_value,min_cart_cents,max_discount_cents,start_day,end_day,source_url,notes};
}
export function couponDescription(offer,day) {
  if(!offer||!offer.coupon_kind||(offer.coupon_owner_confirmed!==1&&offer.coupon_owner_confirmed!==true)) return [];
  if(!validDay(day)||day<offer.coupon_start_day||day>offer.coupon_end_day) return [];
  const fmt=v=>(v/100).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const discount=offer.coupon_discount_type==='percent'?offer.coupon_discount_value+'% OFF':'R$ '+fmt(offer.coupon_discount_value)+' OFF';
  const lines=[offer.coupon_kind==='code'?'🎟️ Cupom informado: '+offer.coupon_code+' ('+discount+')':'🎟️ Cupom de ativação informado ('+discount+')'];
  if(offer.coupon_min_cart_cents>0) lines.push('Compra mínima: R$ '+fmt(offer.coupon_min_cart_cents));
  if(offer.coupon_max_discount_cents!=null) lines.push('Teto informado: R$ '+fmt(offer.coupon_max_discount_cents));
  lines.push('Validade informada: até '+offer.coupon_end_day.split('-').reverse().join('/'));
  lines.push('⚠️ Aplicação depende das condições e da conta do comprador; confira no carrinho.');
  return lines;
}
