// Apenas leitura: eventos já existentes continuam em suas tabelas originais.
export async function listActivity(env,limit=100){
  const max=Math.max(1,Math.min(200,Number(limit)||100));
  const sources=[
    {
      platform:'mercadolivre',network:'telegram',
      sql:"SELECT event,detail,created_at,offer_id,'Canal principal' AS destination FROM logs ORDER BY id DESC LIMIT 100"
    },
    {
      platform:'mercadolivre',network:'telegram',
      sql:"SELECT l.event,l.detail,l.created_at,l.offer_id,COALESCE(c.name,'Canal adicional') AS destination FROM channel_logs l LEFT JOIN telegram_channels c ON c.id=l.channel_id ORDER BY l.id DESC LIMIT 100"
    },
    {
      platform:'mercadolivre',network:'whatsapp',
      sql:"SELECT l.event,l.detail,l.created_at,l.offer_id,COALESCE(g.name,'Grupo WhatsApp') AS destination FROM whatsapp_group_logs l LEFT JOIN whatsapp_groups g ON g.id=l.group_id ORDER BY l.id DESC LIMIT 100"
    },
    {
      platform:'shopee',network:'telegram/whatsapp',
      sql:"SELECT l.event,l.detail,l.created_at,l.offer_id,'Destino Shopee #'||l.destination_id AS destination FROM shopee_logs l ORDER BY l.id DESC LIMIT 100"
    },
    {
      platform:'mercadolivre/shopee',network:'multicanal',
      sql:"SELECT status AS event,COALESCE(last_error,'Oferta distribuída para categoria configurada') AS detail,updated_at AS created_at,NULL AS offer_id,destination_scope||' / '||network||' #'||destination_id AS destination FROM affiliate_category_deliveries ORDER BY id DESC LIMIT 100"
    }
  ];
  const lists=await Promise.all(sources.map(async source=>{
    try{
      const rows=await env.DB.prepare(source.sql).all();
      return rows.results.map(item=>({...item,platform:source.platform,network:source.network}));
    }catch{return [];}
  }));
  return {events:lists.flat().sort((a,b)=>b.created_at-a.created_at).slice(0,max)};
}
