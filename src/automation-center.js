import { sendPlatformTelegramText } from './multichannel.js';
import { sendPlatformWhatsAppText } from './whatsapp-groups.js';
import { sendShopeeOwnText } from './shopee-destinations.js';
import { localTimeParts } from './logic.js';

// Camada ADITIVA: nunca substitui as tabelas, filas, autorizações ou credenciais existentes.
const SCHEMA=[
  "CREATE TABLE IF NOT EXISTS automation_master (id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS affiliate_group_categories (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE COLLATE NOCASE,keywords TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS affiliate_product_categories (id INTEGER PRIMARY KEY AUTOINCREMENT,platform TEXT NOT NULL CHECK(platform IN ('mercadolivre','shopee')),affiliate_url TEXT NOT NULL,title TEXT NOT NULL,group_category_id INTEGER REFERENCES affiliate_group_categories(id),subcategory TEXT,classification TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(platform,affiliate_url))",
  "CREATE TABLE IF NOT EXISTS affiliate_category_routes (id INTEGER PRIMARY KEY AUTOINCREMENT,group_category_id INTEGER NOT NULL REFERENCES affiliate_group_categories(id),destination_scope TEXT NOT NULL CHECK(destination_scope IN ('mercadolivre','shopee')),network TEXT NOT NULL CHECK(network IN ('telegram','whatsapp')),destination_id INTEGER NOT NULL,allow_mercadolivre INTEGER NOT NULL DEFAULT 0,allow_shopee INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(group_category_id,destination_scope,network,destination_id))",
  "CREATE TABLE IF NOT EXISTS affiliate_category_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT,platform TEXT NOT NULL,affiliate_url TEXT NOT NULL,destination_scope TEXT NOT NULL,network TEXT NOT NULL,destination_id INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('sending','sent','needs_review')),message_id TEXT,last_error TEXT,updated_at INTEGER NOT NULL,UNIQUE(platform,affiliate_url,destination_scope,network,destination_id))",
  "CREATE TABLE IF NOT EXISTS affiliate_category_pacing (destination_scope TEXT NOT NULL,network TEXT NOT NULL,destination_id INTEGER NOT NULL,last_attempt_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(destination_scope,network,destination_id))"
];
const timestamp=()=>Math.floor(Date.now()/1000);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
async function safeFirst(env,sql,...args){try{return await env.DB.prepare(sql).bind(...args).first();}catch{return null;}}
// Categorias iniciais solicitadas; nunca substituem palavras-chave personalizadas nem criam rotas de envio.
// Snapshot do preset anterior: migrar apenas o texto inicial intacto no D1, preservando edições manuais.
const LEGACY_AUTOMOTIVE_KEYWORDS="chave de fenda, chave de boca, chave catraca, jogo de soquetes, kit ferramentas, furadeira, parafusadeira, serra tico tico, lixadeira, esmerilhadeira, compressor de ar, macaco hidráulico, calibrador de pneus, tapete automotivo, palheta limpador, retrovisor moto, capacete moto, bateria automotiva, lâmpada automotiva, óleo motor";
export const STARTER_GROUP_CATEGORIES=[
  {
    "name": "Casa e Utilidades",
    "keywords": "organizador de cozinha, organizador de gaveta, organizador de armário, pote hermético, kit potes, jogo de panelas, frigideira, jogo de cama, lençol, travesseiro, toalha de banho, tapete de banheiro, luminária, varal, mop giratório, escorredor de louça, garrafa térmica, dispenser de detergente"
  },
  {
    "name": "Beleza e Cuidados Pessoais",
    "keywords": "perfume feminino, perfume masculino, body splash, hidratante corporal, protetor solar, sérum facial, vitamina c facial, shampoo, condicionador, máscara capilar, óleo capilar, secador de cabelo, chapinha, escova secadora, barbeador elétrico, aparador de pelos, kit maquiagem, batom, esmalte, cílios postiços"
  },
  {
    "name": "Moda e Acessórios",
    "keywords": "vestido feminino, blusa feminina, camiseta masculina, calça jeans, legging, roupa fitness, conjunto feminino, moletom, jaqueta, tênis feminino, tênis masculino, sandália feminina, chinelo, bolsa feminina, mochila, carteira masculina, relógio feminino, óculos de sol, boné, roupa infantil, lingerie"
  },
  {
    "name": "Eletrônicos e Eletrodomésticos",
    "keywords": "fone bluetooth, fone de ouvido, caixa de som, smartwatch, relógio inteligente, carregador rápido, cabo usb, power bank, suporte para celular, teclado gamer, mouse gamer, webcam, monitor gamer, roteador wifi, câmera de segurança, lâmpada inteligente, air fryer, cafeteira, liquidificador, aspirador robô"
  },
  {
    "name": "Ferramentas e Peças Automotivas",
    "keywords": "chave de fenda, chave de boca, chave catraca, jogo de soquetes, kit ferramentas, furadeira, parafusadeira, serra tico tico, lixadeira, esmerilhadeira, compressor de ar, macaco hidráulico, calibrador de pneus, tapete automotivo, palheta limpador, retrovisor moto, capacete moto, bateria automotiva, lâmpada automotiva, óleo motor, lavadora de alta pressão, lavadora wap, lava jato automotivo, shampoo automotivo, cera automotiva, limpa pneus, desengraxante automotivo, snow foam, canhão de espuma, pistola de lavagem, pano microfibra automotivo, aspirador automotivo, politriz automotiva, kit lavagem automotiva"
  }
];
const STARTER_CATEGORY_NAMES=new Set(STARTER_GROUP_CATEGORIES.map(c=>c.name.toLocaleLowerCase('pt-BR')));
async function seedStarterGroupCategories(env){
  const names=STARTER_GROUP_CATEGORIES.map(c=>c.name);
  const rows=await env.DB.prepare('SELECT name,keywords FROM affiliate_group_categories WHERE name IN (?,?,?,?,?)').bind(...names).all();
  const existing=new Map(rows.results.map(r=>[r.name.toLocaleLowerCase('pt-BR'),r]));
  const now=timestamp();
  for(const c of STARTER_GROUP_CATEGORIES){
    const current=existing.get(c.name.toLocaleLowerCase('pt-BR'));
    if(!current){
      await env.DB.prepare('INSERT OR IGNORE INTO affiliate_group_categories(name,keywords,created_at,updated_at) VALUES(?,?,?,?)').bind(c.name,c.keywords,now,now).run();
    }else if(!String(current.keywords||'').trim()){
      await env.DB.prepare("UPDATE affiliate_group_categories SET keywords=?,updated_at=? WHERE name=? AND trim(keywords)=''").bind(c.keywords,now,current.name).run();
    }
    else if(c.name==='Ferramentas e Peças Automotivas'&&current.keywords===LEGACY_AUTOMOTIVE_KEYWORDS){
      // Atualiza apenas o preset intocado anterior; nunca troca palavras-chave escolhidas pelo usuário.
      await env.DB.prepare('UPDATE affiliate_group_categories SET keywords=?,updated_at=? WHERE name=? AND keywords=?')
        .bind(c.keywords,now,current.name,LEGACY_AUTOMOTIVE_KEYWORDS).run();
    }
  }
}
export async function ensureAutomationCenter(env){
  for(const stmt of SCHEMA)await env.DB.prepare(stmt).run();
  await seedStarterGroupCategories(env);
}
export async function masterState(env){
  await ensureAutomationCenter(env);
  const row=await env.DB.prepare('SELECT enabled,updated_at FROM automation_master WHERE id=1').first();
  return {enabled:row?!!row.enabled:null,updated_at:row?.updated_at||null};
}
export async function setMasterState(env,enabled){
  if(typeof enabled!=='boolean')throw fail('Escolha ligar ou desligar o robô.');
  await ensureAutomationCenter(env);
  const t=timestamp();
  await env.DB.prepare('INSERT INTO automation_master(id,enabled,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at')
    .bind(+enabled,t).run();
  return {enabled,updated_at:t};
}
function normalize(v){return String(v||'').toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
function keywordsOf(c){
  return [...new Set([c.name,...String(c.keywords||'').split(/[,;\n]/)].map(x=>normalize(x)).filter(x=>x.length>=3))];
}
function includesPhrase(text,phrase){return (' '+text+' ').includes(' '+phrase+' ');}
function categoryId(v){const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null;}
const SUBCATEGORY_RULES=[
  [/chav(e|es) de fenda/,'Chaves de fenda'],
  [/chav(e|es) de boca/,'Chaves de boca'],
  [/chav(e|es) de impacto/,'Chaves de impacto'],
  [/furadeira/,'Furadeiras'],
  [/parafusadeira/,'Parafusadeiras'],
  [/broca/,'Brocas'],
  [/pneu/,'Pneus'],
  [/capacete/,'Capacetes'],
  [/fralda/,'Fraldas'],
  [/lenco umedecido/,'Lenços umedecidos'],
  [/vitamina/,'Vitaminas'],
  [/mouse/,'Mouses'],
  [/teclado/,'Teclados']
];
export function inferSubcategory(title){
  const t=normalize(title);
  return SUBCATEGORY_RULES.find(([re])=>re.test(t))?.[1]||null;
}
export function classifyProduct(title,sourceCategory,categories){
  const t=normalize(title),cat=normalize(sourceCategory);
  if(!t)return {category:null,subcategory:null,classification:'needs_review'};
  // "Geral" não é classificação de produto: primeiro tenta reconhecer a categoria real por palavras-chave.
  const bySelected=cat&&cat!=='geral'?categories.find(c=>normalize(c.name)===cat&&c.enabled):null;
  if(bySelected)return {category:bySelected,subcategory:inferSubcategory(title),classification:'selected'};
  const matches=categories.filter(c=>c.enabled&&keywordsOf(c).some(k=>includesPhrase(t,k)));
  if(matches.length===1)return {category:matches[0],subcategory:inferSubcategory(title),classification:'keywords'};
  // Uma categoria personalizada mais específica prevalece sobre o modelo inicial, evitando ambiguidade.
  const custom=matches.filter(c=>!STARTER_CATEGORY_NAMES.has(String(c.name).toLocaleLowerCase('pt-BR')));
  if(custom.length===1)return {category:custom[0],subcategory:inferSubcategory(title),classification:'keywords'};
  // Em termos compartilhados como "shampoo", prevalece a frase mais específica
  // ("shampoo automotivo") quando há uma única categoria vencedora.
  const scored=matches.map(category=>({
    category,
    specificity:Math.max(...keywordsOf(category).filter(k=>includesPhrase(t,k)).map(k=>k.length))
  }));
  if(scored.length){
    const best=Math.max(...scored.map(item=>item.specificity));
    const winners=scored.filter(item=>item.specificity===best);
    if(winners.length===1)return {category:winners[0].category,subcategory:inferSubcategory(title),classification:'keywords'};
  }
  return {category:null,subcategory:null,classification:'needs_review'};
}
export async function upsertProductCategory(env,platform,offer,categoriesGiven=null){
  if(!['mercadolivre','shopee'].includes(platform))return null;
  if(!offer?.affiliate_url||!offer?.title)return null;
  if(!categoriesGiven)await ensureAutomationCenter(env);
  const categories=categoriesGiven||(await env.DB.prepare('SELECT * FROM affiliate_group_categories WHERE enabled=1 ORDER BY id').all()).results;
  const c=classifyProduct(offer.title,offer.category,categories);
  const t=timestamp();
  await env.DB.prepare(
    'INSERT INTO affiliate_product_categories(platform,affiliate_url,title,group_category_id,subcategory,classification,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) '+
    'ON CONFLICT(platform,affiliate_url) DO UPDATE SET title=excluded.title,group_category_id=excluded.group_category_id,subcategory=excluded.subcategory,classification=excluded.classification,updated_at=excluded.updated_at'
  ).bind(platform,offer.affiliate_url,offer.title,c.category?.id||null,c.subcategory,c.classification,t,t).run();
  return c;
}
export async function listCategories(env){
  await ensureAutomationCenter(env);
  // Adota as categorias antigas de grupos sem sobrescrever nada no banco existente.
  const legacyQueries=[
    'SELECT category FROM primary_channel_category',
    'SELECT category FROM whatsapp_primary_category',
    'SELECT category FROM telegram_channels',
    'SELECT category FROM whatsapp_groups',
    'SELECT category FROM shopee_telegram_channels',
    'SELECT category FROM shopee_whatsapp_groups'
  ];
  const found=new Set(['Geral']);
  for(const sql of legacyQueries){
    try{
      const rows=await env.DB.prepare(sql).all();
      for(const item of rows.results){
        const value=String(item.category||'').trim();
        if(value.length>=3&&value.length<=60&&/^[\\p{L}\\p{N} &/()\\-]+$/u.test(value))found.add(value);
      }
    }catch{/* A tabela de outro módulo pode ainda não existir. */}
  }
  const now=timestamp();
  for(const name of found)await env.DB.prepare('INSERT OR IGNORE INTO affiliate_group_categories(name,created_at,updated_at) VALUES(?,?,?)').bind(name,now,now).run();
  const [groups,products,routes]=await Promise.all([
    env.DB.prepare('SELECT * FROM affiliate_group_categories ORDER BY name').all(),
    env.DB.prepare('SELECT p.*,g.name AS group_category FROM affiliate_product_categories p LEFT JOIN affiliate_group_categories g ON g.id=p.group_category_id ORDER BY p.updated_at DESC LIMIT 150').all(),
    env.DB.prepare('SELECT * FROM affiliate_category_routes ORDER BY group_category_id,destination_scope,network,destination_id').all()
  ]);
  return {groups:groups.results,products:products.results,routes:routes.results};
}
export async function createGroupCategory(env,data){
  await ensureAutomationCenter(env);
  const name=String(data?.name||'').trim(),keywords=String(data?.keywords||'').trim();
  if(name.length<3||name.length>60||keywords.length>800)throw fail('Informe um nome de 3 a 60 caracteres e até 800 caracteres de palavras-chave.');
  if(!/^[\p{L}\p{N} &/()\-]+$/u.test(name))throw fail('Categoria contém caracteres não permitidos.');
  try{
    const t=timestamp();
    const result=await env.DB.prepare('INSERT INTO affiliate_group_categories(name,keywords,created_at,updated_at) VALUES(?,?,?,?)')
      .bind(name,keywords,t,t).run();
    return {ok:true,id:Number(result.meta?.last_row_id),name};
  }catch(error){
    if(/UNIQUE/i.test(error.message||''))throw fail('Esta categoria de grupo já existe.',409);
    throw error;
  }
}
export async function updateGroupCategory(env,id,data){
  await ensureAutomationCenter(env);
  const n=categoryId(id);if(!n)throw fail('Categoria inválida.');
  const old=await env.DB.prepare('SELECT * FROM affiliate_group_categories WHERE id=?').bind(n).first();
  if(!old)throw fail('Categoria não encontrada.',404);
  const keywords=String(data?.keywords??old.keywords).trim();
  const enabled=data?.enabled??!!old.enabled;
  if(keywords.length>800||typeof enabled!=='boolean')throw fail('Configuração de categoria inválida.');
  await env.DB.prepare('UPDATE affiliate_group_categories SET keywords=?,enabled=?,updated_at=? WHERE id=?')
    .bind(keywords,+enabled,timestamp(),n).run();
  return {ok:true};
}
export async function listCategoryDestinations(env){
  await ensureAutomationCenter(env);
  // Alguns módulos antigos só criam suas tabelas quando o administrador os configura.
  const safeAll=async sql=>{try{return await env.DB.prepare(sql).all();}catch{return {results:[]};}};
  const safeFirst=async sql=>{try{return await env.DB.prepare(sql).first();}catch{return null;}};
  const raw=await Promise.all([
    safeAll('SELECT id,name,telegram_chat_id,telegram_enabled,channel_registered FROM telegram_channels ORDER BY id'),
    safeAll('SELECT id,name,group_jid,enabled,public_registered FROM whatsapp_groups ORDER BY id'),
    safeAll('SELECT id,name,telegram_chat_id,enabled,channel_registered FROM shopee_telegram_channels ORDER BY id'),
    safeAll('SELECT id,name,group_jid,enabled,public_registered FROM shopee_whatsapp_groups ORDER BY id'),
    env.DB.prepare('SELECT telegram_chat_id,telegram_enabled,channel_registered FROM settings WHERE id=1').first(),
    safeFirst('SELECT group_jid,enabled,public_registered FROM whatsapp_settings WHERE id=1')
  ]);
  const [tele,wa,st,sw,primaryTelegram,primaryWhatsapp]=raw;
  const destinations=[];
  const add=(scope,network,id,name,active)=>destinations.push({scope,network,id,name,active:!!active});
  add('mercadolivre','telegram',1,primaryTelegram?.telegram_chat_id||'Canal principal',primaryTelegram?.telegram_enabled&&primaryTelegram?.channel_registered);
  if(primaryWhatsapp?.group_jid)add('mercadolivre','whatsapp',1,'WhatsApp principal',primaryWhatsapp.enabled&&primaryWhatsapp.public_registered);
  for(const x of tele.results)add('mercadolivre','telegram',x.id,x.name,x.telegram_enabled&&x.channel_registered);
  for(const x of wa.results)if(x.group_jid)add('mercadolivre','whatsapp',x.id,x.name,x.enabled&&x.public_registered);
  for(const x of st.results)add('shopee','telegram',x.id,x.name,x.enabled&&x.channel_registered);
  for(const x of sw.results)if(x.group_jid)add('shopee','whatsapp',x.id,x.name,x.enabled&&x.public_registered);
  return destinations;
}
export async function saveCategoryRoutes(env,id,data){
  await ensureAutomationCenter(env);
  const n=categoryId(id);if(!n)throw fail('Categoria inválida.');
  const category=await env.DB.prepare('SELECT * FROM affiliate_group_categories WHERE id=?').bind(n).first();
  if(!category)throw fail('Categoria não encontrada.',404);
  if(!Array.isArray(data?.routes)||data.routes.length>100)throw fail('Envie até 100 destinos para esta categoria.');
  const allowed=await listCategoryDestinations(env);
  const unique=new Set(),routes=[];
  for(const r of data.routes){
    const scope=r?.scope,network=r?.network,destinationId=categoryId(r?.id);
    const key=[scope,network,destinationId].join(':');
    if(!destinationId||unique.has(key)||!allowed.some(d=>d.scope===scope&&d.network===network&&d.id===destinationId))
      throw fail('Seleção duplicada ou destino não cadastrado: '+key);
    if(typeof r.mercadolivre!=='boolean'||typeof r.shopee!=='boolean')throw fail('Selecione as plataformas autorizadas.');
    if(!r.mercadolivre&&!r.shopee)continue;
    unique.add(key);routes.push({scope,network,id:destinationId,ml:r.mercadolivre,sh:r.shopee});
  }
  // Salva sem recriar tabelas de grupo; cada categoria pode ter vários destinos.
  await env.DB.prepare('DELETE FROM affiliate_category_routes WHERE group_category_id=?').bind(n).run();
  for(const r of routes)await env.DB.prepare('INSERT INTO affiliate_category_routes(group_category_id,destination_scope,network,destination_id,allow_mercadolivre,allow_shopee,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(n,r.scope,r.network,r.id,+r.ml,+r.sh,timestamp()).run();
  return {ok:true,count:routes.length};
}
function offerText(platform,offer,category,subcategory){
  const heading=platform==='shopee'?'Shopee':'Mercado Livre';
  const lines=['📣 Publicidade • Oferta '+heading,'','🛍️ '+offer.title];
  if(offer.price_cents!=null)lines.push('💰 Preço informado: '+(offer.price_cents/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}));
  lines.push('','📁 '+category+(subcategory?' • '+subcategory:''),'✅ Confira o valor e a disponibilidade antes de comprar.','🔗 Comprar aqui:',offer.affiliate_url);
  return lines.join('\n');
}
async function routePolicy(env,r){
  const enabled=await listCategoryDestinations(env);
  const dest=enabled.find(x=>x.scope===r.destination_scope&&x.network===r.network&&x.id===r.destination_id);
  if(!dest?.active)return null;
  let interval=60,limit=12;
  if(r.destination_scope==='mercadolivre'){
    if(r.network==='telegram'){
      const item=r.destination_id===1
        ?await env.DB.prepare('SELECT interval_minutes,max_daily FROM settings WHERE id=1').first()
        :await env.DB.prepare('SELECT interval_minutes,max_daily FROM telegram_channels WHERE id=?').bind(r.destination_id).first();
      interval=item?.interval_minutes||60;limit=item?.max_daily||12;
    }else{
      const item=r.destination_id===1
        ?await env.DB.prepare('SELECT interval_minutes FROM whatsapp_schedule_custom WHERE id=1').first()
        :await env.DB.prepare('SELECT interval_minutes,max_daily FROM whatsapp_groups WHERE id=?').bind(r.destination_id).first();
      interval=item?.interval_minutes||60;limit=item?.max_daily||12;
    }
  }else{
    const item=await env.DB.prepare('SELECT interval_minutes,max_daily FROM shopee_targets WHERE network=? AND target_id=?').bind(r.network,r.destination_id).first();
    interval=item?.interval_minutes||60;limit=item?.max_daily||12;
  }
  return {interval:Math.max(1,Math.min(1440,interval)),limit:Math.max(1,Math.min(48,limit))};
}
async function alreadySentByOriginal(env,platform,offer,r){
  if(platform==='mercadolivre'){
    if(r.destination_scope==='mercadolivre'&&r.network==='telegram'&&r.destination_id===1)return true;
    if(r.destination_scope==='mercadolivre'&&r.network==='whatsapp'&&r.destination_id===1){
      const directMode=await safeFirst(env,'SELECT delivery_mode FROM offer_delivery_routing WHERE offer_id=?',offer.id);
      if(!directMode||directMode.delivery_mode==='both')return true;
      const sent=await safeFirst(env,"SELECT 1 AS found FROM whatsapp_deliveries WHERE offer_id=? AND status IN ('sent','sending','needs_review')",offer.id);
      if(sent)return true;
    }
  }else if(platform==='shopee'&&r.destination_scope==='shopee'){
    const own=await env.DB.prepare('SELECT network,target_id FROM shopee_targets WHERE id=?').bind(offer.destination_id).first();
    if(own?.network===r.network&&own.target_id===r.destination_id)return true;
  }
  return false;
}
export async function runCategoryRoutingScheduled(env){
  if(!env?.DB||env.MASTER_SCHEDULE_ENABLED!==true)return {skipped:'master_off'};
  await ensureAutomationCenter(env);
  const routesFound=await env.DB.prepare('SELECT COUNT(*) AS total FROM affiliate_category_routes r JOIN affiliate_group_categories g ON g.id=r.group_category_id WHERE g.enabled=1').first();
  if(!routesFound?.total)return {skipped:'no_category_routes'};
  const categories=(await env.DB.prepare('SELECT * FROM affiliate_group_categories WHERE enabled=1').all()).results;
  const cutoff=timestamp()-2*86400;
  const [ml,sh]=await Promise.all([
    env.DB.prepare("SELECT * FROM offers WHERE status='published' AND published_at>? ORDER BY published_at DESC LIMIT 30").bind(cutoff).all(),
    (async()=>{try{return await env.DB.prepare("SELECT * FROM shopee_offers WHERE status='published' AND published_at>? ORDER BY published_at DESC LIMIT 30").bind(cutoff).all();}catch{return {results:[]};}})()
  ]);
  const out=[];
  for(const [platform,offers] of [['mercadolivre',ml.results],['shopee',sh.results]]){
    for(const offer of offers){
      // Ofertas antigas são classificadas quando entram no radar, sem modificar seu cadastro original.
      const classification=await upsertProductCategory(env,platform,offer,categories);
      const category=classification?.category;
      if(!category)continue;
      const routes=await env.DB.prepare('SELECT * FROM affiliate_category_routes WHERE group_category_id=? AND '+(platform==='shopee'?'allow_shopee=1':'allow_mercadolivre=1')+' ORDER BY id LIMIT 40').bind(category.id).all();
      for(const route of routes.results){
        if(out.length>=10)return {results:out,remaining:true};
        // Nunca redistribui automaticamente uma oferta antiga quando o administrador cria uma rota nova.
        if((offer.published_at||0)<route.created_at)continue;
        if(await alreadySentByOriginal(env,platform,offer,route))continue;
        const prior=await env.DB.prepare('SELECT status FROM affiliate_category_deliveries WHERE platform=? AND affiliate_url=? AND destination_scope=? AND network=? AND destination_id=?')
          .bind(platform,offer.affiliate_url,route.destination_scope,route.network,route.destination_id).first();
        if(prior)continue;
        const policy=await routePolicy(env,route);
        if(!policy)continue;
        const dayStart=Math.floor(new Date(localTimeParts(new Date()).day+'T00:00:00-03:00').getTime()/1000);
        const daily=await env.DB.prepare("SELECT COUNT(*) AS total FROM affiliate_category_deliveries WHERE destination_scope=? AND network=? AND destination_id=? AND status IN ('sent','sending','needs_review') AND updated_at>=?")
          .bind(route.destination_scope,route.network,route.destination_id,dayStart).first();
        if((daily?.total||0)>=policy.limit)continue;
        const now=timestamp(),interval=policy.interval*60;
        await env.DB.prepare('INSERT OR IGNORE INTO affiliate_category_pacing(destination_scope,network,destination_id,last_attempt_at) VALUES(?,?,?,0)').bind(route.destination_scope,route.network,route.destination_id).run();
        const pace=await env.DB.prepare('UPDATE affiliate_category_pacing SET last_attempt_at=? WHERE destination_scope=? AND network=? AND destination_id=? AND (last_attempt_at=0 OR last_attempt_at<=?)')
          .bind(now,route.destination_scope,route.network,route.destination_id,now-interval).run();
        if(pace.meta?.changes!==1)continue;
        const claim=await env.DB.prepare("INSERT OR IGNORE INTO affiliate_category_deliveries(platform,affiliate_url,destination_scope,network,destination_id,status,updated_at) VALUES(?,?,?,?,?,'sending',?)")
          .bind(platform,offer.affiliate_url,route.destination_scope,route.network,route.destination_id,now).run();
        if(claim.meta?.changes!==1)continue;
        try{
          const message=offerText(platform,offer,category.name,classification.subcategory);
          const sent=route.destination_scope==='mercadolivre'
            ?await (route.network==='telegram'
              ?sendPlatformTelegramText(env,route.destination_id,message)
              :sendPlatformWhatsAppText(env,route.destination_id,message))
            :await sendShopeeOwnText(env,route.network,route.destination_id,message);
          await env.DB.prepare("UPDATE affiliate_category_deliveries SET status='sent',message_id=?,updated_at=? WHERE platform=? AND affiliate_url=? AND destination_scope=? AND network=? AND destination_id=?")
            .bind(String(sent.message_id),timestamp(),platform,offer.affiliate_url,route.destination_scope,route.network,route.destination_id).run();
          out.push({platform,destination:route.destination_id,status:'sent'});
        }catch(error){
          // Falha ambígua não pode ser repetida automaticamente: poderia duplicar anúncio no grupo.
          await env.DB.prepare("UPDATE affiliate_category_deliveries SET status='needs_review',last_error=?,updated_at=? WHERE platform=? AND affiliate_url=? AND destination_scope=? AND network=? AND destination_id=?")
            .bind(String(error?.message||error).slice(0,220),timestamp(),platform,offer.affiliate_url,route.destination_scope,route.network,route.destination_id).run();
          out.push({platform,destination:route.destination_id,status:'needs_review'});
        }
      }
    }
  }
  return {results:out};
}
