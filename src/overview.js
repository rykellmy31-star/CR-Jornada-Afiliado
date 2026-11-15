// Visão Geral: consultas somente de leitura, sem migrações nem alterações em filas.
const OFFER_TABLES = ['offers','channel_offers','whatsapp_direct_offers','whatsapp_group_offers','shopee_offers'];
const count = value => Number(value) || 0;
const read = async (env,sql) => {
  try { return await env.DB.prepare(sql).first(); }
  catch { return null; } // Algumas instalações ainda não possuem tabelas opcionais.
};
const rows = async (env,sql) => {
  try { return (await env.DB.prepare(sql).all()).results || []; }
  catch { return []; }
};
const total = async (env,sql) => count((await read(env,sql))?.total);

export async function overviewState(env) {
  // Nomes de tabela são constantes internas, nunca parâmetros de requisição.
  const present = new Set((await rows(env,
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('offers','channel_offers','whatsapp_direct_offers','whatsapp_group_offers','shopee_offers','ml_monitor_links','ml_monitor_shortlinks','ml_monitor_groups','ml_monitor_settings','ml_monitor_diagnostics','settings','telegram_channels','whatsapp_settings','whatsapp_groups','shopee_telegram_channels','shopee_whatsapp_groups','logs')"
  )).map(item => item.name));
  const exists = name => present.has(name);
  const statusGroups = await Promise.all(OFFER_TABLES.map(async table =>
    exists(table) ? rows(env,'SELECT status,COUNT(*) AS total FROM '+table+' GROUP BY status') : []
  ));
  const totals = {queued:0,published:0,review:0};
  for (const group of statusGroups) for (const entry of group) {
    if (entry.status === 'ready') totals.queued += count(entry.total);
    if (entry.status === 'published' || entry.status === 'sent') totals.published += count(entry.total);
    if (entry.status === 'needs_review') totals.review += count(entry.total);
  }

  const [capture,shortReviews,groups,monitor,diagnostics,telegramMain,telegramExtras,
    whatsappMain,whatsappExtras,shopeeTelegram,shopeeWhatsapp,events] = await Promise.all([
    exists('ml_monitor_links') ? total(env,'SELECT COUNT(*) AS total FROM ml_monitor_links') : 0,
    exists('ml_monitor_shortlinks') ? total(env,"SELECT COUNT(*) AS total FROM ml_monitor_shortlinks WHERE status='review'") : 0,
    exists('ml_monitor_groups') ? total(env,'SELECT COUNT(*) AS total FROM ml_monitor_groups WHERE enabled=1 AND authorized=1') : 0,
    exists('ml_monitor_settings') ? read(env,'SELECT enabled FROM ml_monitor_settings WHERE id=1') : null,
    exists('ml_monitor_diagnostics') ? read(env,'SELECT last_event_at,last_link_at FROM ml_monitor_diagnostics WHERE id=1') : null,
    exists('settings') ? read(env,'SELECT telegram_enabled,channel_registered,automation_enabled FROM settings WHERE id=1') : null,
    exists('telegram_channels') ? total(env,'SELECT COUNT(*) AS total FROM telegram_channels WHERE telegram_enabled=1 AND channel_registered=1 AND automation_enabled=1') : 0,
    exists('whatsapp_settings') ? read(env,'SELECT enabled,public_registered FROM whatsapp_settings WHERE id=1') : null,
    exists('whatsapp_groups') ? total(env,'SELECT COUNT(*) AS total FROM whatsapp_groups WHERE enabled=1 AND public_registered=1') : 0,
    exists('shopee_telegram_channels') ? total(env,'SELECT COUNT(*) AS total FROM shopee_telegram_channels WHERE enabled=1 AND channel_registered=1') : 0,
    exists('shopee_whatsapp_groups') ? total(env,'SELECT COUNT(*) AS total FROM shopee_whatsapp_groups WHERE enabled=1 AND public_registered=1') : 0,
    exists('logs') ? rows(env,'SELECT event,created_at FROM logs ORDER BY id DESC LIMIT 6') : []
  ]);
  totals.review += shortReviews;
  const telegramActive = (telegramMain?.telegram_enabled && telegramMain?.channel_registered && telegramMain?.automation_enabled ? 1 : 0) + telegramExtras + shopeeTelegram;
  const whatsappActive = (whatsappMain?.enabled && whatsappMain?.public_registered ? 1 : 0) + whatsappExtras + shopeeWhatsapp;
  return {
    counts:{captured:capture,queued:totals.queued,published:totals.published,review:totals.review},
    monitor:{enabled:!!monitor?.enabled,authorized_groups:groups,last_event_at:diagnostics?.last_event_at||null,last_link_at:diagnostics?.last_link_at||null},
    destinations:{telegram_active:telegramActive,whatsapp_active:whatsappActive,connection_verified:false},
    events:events.map(x=>({event:String(x.event||'Evento').slice(0,80),created_at:count(x.created_at)}))
  };
}
