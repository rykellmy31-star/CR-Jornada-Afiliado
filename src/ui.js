export function renderPage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0b1b35"><title>CR Jornada • Afiliados</title><link rel="stylesheet" href="/styles.css"><script src="/app.js" defer></script></head><body>
  <header><div class="brand"><div class="logo">CR</div><div><strong>CR Jornada</strong><small>AFILIADOS • MERCADO LIVRE</small></div></div><div class="header-end"><span id="top-status" class="pill">Aguardando conexão</span><button id="logout" class="ghost hidden" type="button">Sair</button></div></header>
  <main>
    <section id="login" class="login card"><span class="eyebrow">ACESSO RESTRITO</span><h1>Painel de ofertas</h1><p>Entre com a senha administrativa configurada como segredo na Cloudflare.</p><form id="login-form"><label>Senha de administrador<input id="password" type="password" minlength="8" required autocomplete="current-password" placeholder="••••••••••"></label><button class="primary" type="submit">Entrar no painel</button></form><div id="login-error" class="feedback" role="status"></div></section>
    <section id="dashboard" class="hidden">
      <div class="intro"><div><span class="eyebrow">CENTRAL DE AUTOMAÇÃO</span><h1>Suas ofertas, no ritmo certo.</h1><p>Cadastre links oficiais, programe envios e acompanhe o Telegram em um único lugar.</p></div><div class="profile"><span>Perfil afiliado</span><b>rykellmy_007</b><span id="channel-label">Destino Telegram: @achadinhosmlcr</span></div></div>
      <div id="notice" class="feedback" role="status"></div>
      <div class="metric-grid"><div class="metric card"><span>Prontas para publicar</span><strong id="count-ready">0</strong></div><div class="metric card"><span>Publicadas</span><strong id="count-published">0</strong></div><div class="metric card"><span>Em revisão</span><strong id="count-needs_review">0</strong></div><div class="metric card"><span>Total cadastrado</span><strong id="count-total">0</strong></div></div>
      <div class="main-grid">
        <section class="card settings"><div class="section-header"><div><h2>Automação</h2><p>O envio automático começa desligado por segurança.</p></div><div class="symbol">⚙</div></div>
          <form id="settings-form">
            <label>Canal público do Telegram<input type="text" id="telegram_chat_id" name="telegram_chat_id" placeholder="https://t.me/seucanal" required autocomplete="off"></label>
            <p class="hint">Cole o link público do NOVO canal. O bot @Crjornadabot precisa ser administrador com permissão para publicar. Ao trocar de destino, a automação será pausada até nova confirmação.</p>
            <label class="check-row"><input type="checkbox" id="channel_registered"><span><b>Canal registrado e permitido</b><small>Confirmo que este canal público está cadastrado na Central de Afiliados e atende às regras de divulgação.</small></span></label>
            <label class="check-row"><input type="checkbox" id="telegram_enabled"><span><b>Habilitar publicação no Telegram</b><small>Exige token do BotFather configurado como segredo.</small></span></label>
            <label class="check-row"><input type="checkbox" id="automation_enabled"><span><b>Iniciar automação</b><small>Usará apenas os links oficiais previamente cadastrados.</small></span></label>
            <div class="field-grid"><label>Intervalo entre publicações<select id="interval_minutes"><option value="15">15 minutos</option><option value="30">30 minutos</option><option value="60">60 minutos</option><option value="120">120 minutos</option></select></label><label>Máximo diário (1 a 48)<input type="number" min="1" max="48" id="max_daily"></label><label>Começar às (Bahia)<select id="start_hour"></select></label><label>Parar às (Bahia)<select id="end_hour"></select></label></div>
            <p class="hint">Janela de publicação: horário de Bahia (UTC−3). O robô não publicará fora desse horário.</p>
            <div class="actions"><button class="primary" type="submit">Salvar configurações</button><button class="outline" type="button" id="test-telegram">Testar Telegram</button></div>
            <p id="token-state" class="hint"></p>
            <p id="telegram-test-feedback" class="feedback" role="status" aria-live="polite"></p>
          </form>
        </section>
        <section class="card add-offer"><div class="section-header"><div><h2>Adicionar oferta</h2><p>Somente links gerados na sua conta do Mercado Livre.</p></div><div class="symbol">＋</div></div>
          <form id="offer-form"><label>Nome do produto<input name="title" required minlength="5" maxlength="180" placeholder="Ex.: Base Bauleto Gow 33 e 47 litros"></label><label>Link oficial do afiliado<input name="affiliate_url" type="url" required placeholder="https://meli.la/..."></label><div class="field-grid"><label>Categoria<input name="category" placeholder="Ex.: Automotivo"></label><label>Preço atual (opcional)<input name="price" type="number" min="0.01" step="0.01" placeholder="79.90"></label><label>Preço anterior (opcional)<input name="old_price" type="number" min="0.01" step="0.01" placeholder="99.90"></label></div>
          <label class="check-row owner"><input name="owner_confirmation" type="checkbox" required><span><b>Confirmo que o link foi criado pelo Gerador/Barra de Afiliados</b><small>O sistema não consegue comprovar automaticamente que a comissão pertence à sua conta.</small></span></label>
          <button class="primary full" type="submit">Cadastrar na fila</button></form><p class="hint">Ao publicar, o robô tenta localizar a foto oficial do produto; se indisponível, envia o link com prévia. Preços informados manualmente não são verificados em tempo real.</p></section>
      </div>
      <section class="card whatsapp-panel" id="whatsapp">
        <div class="section-header"><div><h2>🟢 WhatsApp • Evolution API</h2><p>Compartilhe no seu grupo as ofertas já publicadas no Telegram, sem recadastrar os links.</p></div><span id="whatsapp-badge" class="tag">Desligado</span></div>
        <p class="hint">Use a Evolution API instalada na sua própria VPS. O WhatsApp não oficial pode sofrer bloqueios; não permite disparos privados ou importação de contatos. O grupo deve ser público, aberto e cadastrado como mídia na Central de Afiliados.</p>
        <p class="hint" id="whatsapp-server-status">Verificando configuração do servidor...</p>
        <form id="whatsapp-form" class="whatsapp-form">
          <label>Nome da instância Evolution API<input id="wa-instance" maxlength="80" placeholder="cr-jornada-afiliados" autocomplete="off" required></label>
          <div class="field-grid">
            <label>Grupo conectado à instância<select id="wa-group" required><option value="">Clique em Buscar meus grupos</option></select></label>
            <div class="actions" style="align-items:end"><button type="button" class="outline" id="wa-groups">Buscar meus grupos</button></div>
          </div>
          <p class="hint">O link de convite do grupo não é seu ID técnico. O botão consulta apenas os grupos que o número conectado na Evolution já participa.</p>
          <label class="check-row"><input type="checkbox" id="wa-registered"><span><b>Confirmo que é um grupo público e aberto</b><small>Também confirmo que cadastrei esse grupo na Central de Afiliados do Mercado Livre e tenho permissão para publicar.</small></span></label>
          <label class="check-row"><input type="checkbox" id="wa-enabled"><span><b>Ativar publicações no WhatsApp</b><small>Espelha somente novas ofertas publicadas no Telegram após a ativação. Uma oferta por ciclo, sem reenvios automáticos quando houver dúvida.</small></span></label>
          <div class="actions"><button class="primary" type="submit">Salvar WhatsApp</button><button class="outline" id="wa-test" type="button">Enviar teste ao grupo</button></div>
          <p class="feedback" id="wa-feedback" role="status" aria-live="polite"></p>
        </form>
        <div class="section-header" style="margin-top:14px"><div><h2>Últimos envios no WhatsApp</h2></div></div>
        <div id="wa-deliveries" class="whatsapp-results">Ainda não há envios.</div>
      </section>
      <section class="card coupon-panel">
        <div class="section-header"><div><h2>🎟️ Cupons vinculados às ofertas</h2><p>O robô inclui o cupom na publicação automaticamente quando estiver dentro da validade informada.</p></div></div>
        <p class="hint">Este painel não pesquisa contas de compradores e não testa cupons no checkout. Cadastre apenas cupons e condições que você conferiu na fonte oficial.</p>
        <form id="coupon-form">
          <div class="field-grid">
            <label>Oferta ainda na fila<select id="coupon-offer" name="offer_id" required><option value="">Cadastre uma oferta na fila primeiro</option></select></label>
            <label>Tipo de cupom<select id="coupon-kind" name="kind"><option value="code">Código de cupom</option><option value="activation">Cupom que exige ativação</option></select></label>
            <label>Código de cupom<input id="coupon-code" name="code" maxlength="40" placeholder="Ex.: OFERTA10"></label>
            <label>Modalidade<select id="coupon-discount-type" name="discount_type"><option value="percent">Porcentagem (%)</option><option value="fixed">Valor fixo (R$)</option></select></label>
            <label>Valor do desconto<input id="coupon-discount-value" name="discount_value" type="number" min="1" step="1" required placeholder="Ex.: 10"></label>
            <label>Compra mínima (R$)<input name="min_cart" type="number" min="0" step="0.01" placeholder="Ex.: 100.00"></label>
            <label>Teto de desconto (R$), se houver<input name="max_discount" type="number" min="0.01" step="0.01" placeholder="Ex.: 25.00"></label>
            <label>Início<input name="start_day" type="date" required></label>
            <label>Vencimento<input name="end_day" type="date" required></label>
            <label>Fonte oficial<input name="source_url" type="url" required placeholder="https://www.mercadolivre.com.br/..."></label>
          </div>
          <label>Restrições (opcional)<input name="notes" maxlength="220" placeholder="Ex.: somente produtos selecionados"></label>
          <label class="check-row"><input type="checkbox" name="owner_confirmation" required><span><b>Confirmo que conferi a fonte oficial e as condições</b><small>A validade informada não garante que o cupom funcione para todas as pessoas.</small></span></label>
          <button class="primary" type="submit">Salvar cupom para a oferta</button>
          <p id="coupon-feedback" class="feedback" role="status" aria-live="polite"></p>
        </form>
      </section>
      <section class="card list-panel"><div class="section-header"><div><h2>Fila de ofertas</h2><p>Histórico e status de até 100 ofertas recentes.</p></div><button id="refresh" class="outline" type="button">Atualizar</button></div><div class="table-scroll"><table><thead><tr><th>Produto</th><th>Status</th><th>Cadastro</th><th>Ação</th></tr></thead><tbody id="offers-rows"><tr><td colspan="4">Nenhuma oferta cadastrada.</td></tr></tbody></table></div></section>
      <section class="card history"><div class="section-header"><div><h2>Atividade recente</h2><p>Registros de tentativas, publicações e mudanças.</p></div></div><div id="log-list" class="logs">Ainda não há eventos.</div></section>
      <footer>Desenvolvido por Carlos Rykellmy Santos Correia • CR Jornada<br>Telegram: configurável • WhatsApp e geração automática de links: ainda não integrados.</footer>
    </section>
  </main></body></html>`;
}

export const CSS = `
:root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17233b;background:#f5f7fb;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}h1,h2,p{margin:0}h1{font-size:clamp(26px,3vw,39px);letter-spacing:-1px;line-height:1.18}h2{font-size:18px;letter-spacing:-.3px}p{color:#68748b;line-height:1.6}header{background:#0b1b35;color:#fff;padding:17px max(22px,calc((100% - 1160px)/2));display:flex;align-items:center;justify-content:space-between;gap:12px}.brand{display:flex;align-items:center;gap:12px}.logo{width:43px;height:43px;border-radius:12px;background:linear-gradient(135deg,#18b4a1,#1784be);display:grid;place-items:center;font-weight:900;letter-spacing:-1px}.brand strong{font-size:16px;display:block}.brand small{font-size:10px;letter-spacing:1.2px;color:#a0b4cc}.header-end{display:flex;align-items:center;gap:8px}.pill{border:1px solid #37516f;color:#cbd9eb;border-radius:25px;padding:7px 12px;font-size:12px;white-space:nowrap}main{max-width:1200px;margin:0 auto;padding:28px 20px 40px}.hidden{display:none!important}.card{background:#fff;border:1px solid #e8edf5;border-radius:17px;box-shadow:0 10px 25px #112b5510}.login{max-width:480px;margin:60px auto;padding:36px}.login h1{margin:10px 0}.login p{margin-bottom:25px}.eyebrow{font-size:11px;letter-spacing:1.4px;font-weight:800;color:#258b9e}.intro{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:12px 4px 25px}.intro h1{margin:10px 0}.intro p{max-width:650px}.profile{background:#eaf3fb;padding:12px 18px;border-radius:13px;display:flex;flex-direction:column;gap:2px;min-width:210px;color:#506780;font-size:12px}.profile b{color:#10253e;font-size:18px}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin-bottom:16px}.metric{padding:19px 20px}.metric span{display:block;font-size:12px;color:#79849b}.metric strong{display:block;font-size:30px;margin-top:6px;letter-spacing:-1px;color:#182f4d}.main-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.main-grid>.card,.list-panel,.history{padding:22px}.section-header{display:flex;justify-content:space-between;gap:15px;align-items:flex-start;margin-bottom:19px}.section-header p{font-size:12px;margin-top:5px}.symbol{background:#e5f5f3;color:#087e71;border-radius:11px;width:32px;height:32px;display:grid;place-items:center;font-size:20px;font-weight:800}.settings form,.add-offer form,#login-form{display:flex;flex-direction:column;gap:15px}label{font-size:13px;font-weight:600;color:#34425a;display:flex;flex-direction:column;gap:8px}input:not([type=checkbox]),select{width:100%;padding:12px 13px;border-radius:9px;border:1px solid #d9e1ef;background:#fbfcfe;color:#182c47;font-size:15px;outline:none;min-height:44px}input:focus,select:focus{border-color:#1696ab;box-shadow:0 0 0 3px #14aaa21d}.check-row{flex-direction:row;gap:12px;align-items:flex-start;padding:11px;border:1px solid #e9edf3;border-radius:11px;background:#fcfdff;cursor:pointer}.check-row input{width:18px;height:18px;flex:0 0 18px;margin:2px 0 0;accent-color:#119d8d}.check-row span{display:flex;flex-direction:column;gap:5px}.check-row small{font-size:11.5px;color:#748095;line-height:1.5;font-weight:400}.owner{margin-top:3px}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.actions{display:flex;gap:10px;flex-wrap:wrap}.hint{font-size:11px;margin-top:0}.primary,.outline,.ghost{border:0;cursor:pointer;border-radius:10px;padding:12px 17px;min-height:41px;font-size:13px;font-weight:700}.primary{background:#0e867f;color:#fff}.primary:hover{background:#09726c}.outline{background:#fff;border:1px solid #cbd8e5;color:#1a5772}.outline:hover{background:#eff8fb}.ghost{background:#1d3454;color:#fff;padding:8px 12px}.full{width:100%}.feedback{font-size:13px;margin-bottom:12px;min-height:0}.feedback:not(:empty){padding:12px 14px;border-radius:10px;background:#e7f5ef;color:#17654d}.feedback.error:not(:empty){background:#fff0f0;color:#a82828}.list-panel,.history,.coupon-panel,.whatsapp-panel{margin-top:16px}.coupon-panel,.whatsapp-panel{padding:22px}.coupon-panel form,.whatsapp-panel form{display:flex;flex-direction:column;gap:13px;margin-top:16px}.whatsapp-panel select{min-width:0}.whatsapp-panel .tag{flex-shrink:0}.whatsapp-delivery{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #edf1f6;padding:11px 0}.whatsapp-delivery small{display:block;color:#748095}.whatsapp-panel .hint{margin:9px 0}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}th{font-size:11px;color:#7e8ba1;text-transform:uppercase;letter-spacing:.8px;background:#f7f9fc}td,th{padding:12px 14px;border-bottom:1px solid #edf1f7;vertical-align:middle}td:first-child{min-width:240px}td a{font-weight:700;color:#0a7e95;text-decoration:none}td small{display:block;color:#718099;font-size:11px;margin-top:3px}.tag{border-radius:16px;padding:5px 9px;background:#edf4f8;color:#517086;font-size:11px;font-weight:700;white-space:nowrap}.tag.ready{background:#e4f8ef;color:#197348}.tag.published{background:#e8effb;color:#2558a2}.tag.needs_review{background:#fff1dd;color:#9b6a10}.tag.sending{background:#f2e8fd;color:#6a39a1}.mini{border:1px solid #d5e1eb;border-radius:9px;padding:7px 10px;background:#fff;color:#245b75;font-weight:700;cursor:pointer;white-space:nowrap}.logs{display:flex;flex-direction:column;gap:9px;color:#526477;font-size:12px}.logs>div{display:flex;justify-content:space-between;gap:15px;padding:9px 0;border-bottom:1px solid #edf1f6}.logs time{white-space:nowrap;color:#94a0b0}footer{font-size:11px;color:#97a2b4;text-align:center;margin-top:30px;line-height:1.8}
@media(max-width:850px){.main-grid{grid-template-columns:1fr}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.intro{flex-direction:column;align-items:stretch}.profile{width:100%}}@media(max-width:520px){main{padding:16px 12px 34px}header{padding:14px 12px}.header-end .pill{display:none}.main-grid>.card,.list-panel,.history,.coupon-panel,.whatsapp-panel{padding:17px}.field-grid{grid-template-columns:1fr}.metric-grid{gap:9px}.metric{padding:15px}.metric strong{font-size:26px}.login{margin:35px 0;padding:22px}.actions button{flex:1}.section-header{margin-bottom:14px}}
`;

export const CLIENT_JS = `
'use strict';
const $ = id => document.getElementById(id);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toDate = s => s ? new Date(s*1000).toLocaleString('pt-BR') : '—';
function notice(text, isError=false, target='notice') { $(target).textContent = text; $(target).classList.toggle('error', isError); }
async function call(path, opts={}) {
  const init = {...opts, credentials: 'same-origin'};
  if(opts.body) init.headers = {'content-type':'application/json'};
  const r=await fetch(path,init);
  const data=await r.json().catch(()=>({error:'Resposta inválida do servidor'}));
  if(!r.ok) throw new Error(data.error || 'Falha na requisição');
  return data;
}
function view(auth) { $('dashboard').classList.toggle('hidden', !auth); $('login').classList.toggle('hidden', auth); $('logout').classList.toggle('hidden', !auth); }
function statusLabel(s){return ({ready:'Na fila',sending:'Enviando',published:'Publicado',needs_review:'Revisar'})[s]||s;}
async function refreshWhatsApp(){
  try{
    const d=await call('/api/whatsapp/state');
    $('wa-instance').value=d.config.instance_name||'cr-jornada-afiliados';
    const jid=d.config.group_jid||'';
    const list=$('wa-group');
    if(jid&&!Array.from(list.options).some(o=>o.value===jid)){
      const option=document.createElement('option');option.value=jid;option.textContent='Grupo salvo: '+jid;list.add(option);
    }
    list.value=jid;
    $('wa-registered').checked=!!d.config.public_registered;
    $('wa-enabled').checked=!!d.config.enabled;
    $('whatsapp-badge').textContent=d.config.enabled?'WhatsApp ligado':'WhatsApp desligado';
    $('whatsapp-server-status').textContent=d.server_configured?'✅ Segredos Evolution configurados no servidor.':'⚠ Configure somente EVOLUTION_API_KEY nos Secrets da Cloudflare. O endereço da Evolution já está definido.';
    $('wa-test').disabled=!d.config.public_registered||!d.server_configured;
    if(d.config.last_error)notice(d.config.last_error,true,'wa-feedback');
    $('wa-deliveries').innerHTML=d.deliveries.length?d.deliveries.map(x=>
      '<div class="whatsapp-delivery"><div><strong>'+escape(x.title)+'</strong><small>'+escape(x.status==='sent'?'Enviado':x.status==='needs_review'?'Revisar antes de reenviar':'Enviando')+' • '+toDate(x.updated_at)+'</small>'+
      (x.last_error?'<small>'+escape(x.last_error)+'</small>':'')+'</div>'+
      (x.status==='needs_review'?'<button class="mini" data-wa-retry="'+Number(x.offer_id)+'">Reenfileirar</button>':'')+'</div>'
    ).join(''):'<p class="hint">Nenhuma oferta enviada pelo WhatsApp nesta configuração.</p>';
  }catch(error){notice('WhatsApp: '+error.message,true,'wa-feedback');}
}
async function refresh(){
  try{
    const data=await call('/api/state');view(true);
    const s=data.settings;
    $('telegram_chat_id').value=s.telegram_chat_id||'';
    $('channel-label').textContent='Destino Telegram: '+(s.telegram_chat_id||'não configurado');
    for(const k of ['channel_registered','telegram_enabled','automation_enabled']) $(k).checked=!!s[k];
    for(const k of ['interval_minutes','max_daily','start_hour','end_hour']) $(k).value=s[k];
    $('top-status').textContent=s.automation_enabled?'Robô ligado':'Robô desligado';
    $('token-state').textContent=data.telegram_token_configured?'✓ Segredo do BotFather configurado no servidor.':'⚠ Falta configurar TELEGRAM_BOT_TOKEN no servidor.';
    const counts=Object.fromEntries(data.counts.map(x=>[x.status,x.total]));
    for(const k of ['ready','published','needs_review']) $('count-'+k).textContent=counts[k]||0;
    $('count-total').textContent=Object.values(counts).reduce((a,b)=>a+b,0);
    const couponSelect=$('coupon-offer');
    const oldSelection=couponSelect.value;
    const readyOffers=data.offers.filter(o=>o.status==='ready');
    couponSelect.innerHTML='<option value="">Selecione a oferta...</option>'+readyOffers.map(o=>'<option value="'+o.id+'">'+escape(o.title)+'</option>').join('');
    if(readyOffers.some(o=>String(o.id)===oldSelection)) couponSelect.value=oldSelection;
    couponSelect.disabled=!readyOffers.length;
    $('offers-rows').innerHTML=data.offers.length?data.offers.map(o=>{
      const action=o.status==='ready'?'<button class="mini" data-action="publish" data-id="'+o.id+'">Publicar</button>':o.status==='needs_review'?'<button class="mini" data-action="requeue" data-id="'+o.id+'">Reenfileirar</button>':'—';
      return '<tr><td><a rel="noopener noreferrer" target="_blank" href="'+escape(o.affiliate_url)+'">'+escape(o.title)+'</a><small>'+escape(o.category)+'</small>'+(o.coupon_kind?'<small>🎟️ Cupom informado: '+escape(o.coupon_code||'ativação no app')+' • até '+escape(o.coupon_end_day)+' (sujeito às condições)</small>':'')+ (o.last_error?'<small>Erro: '+escape(o.last_error)+'</small>':'')+'</td><td><span class="tag '+escape(o.status)+'">'+statusLabel(o.status)+'</span></td><td>'+toDate(o.created_at)+'</td><td>'+action+'</td></tr>';
    }).join(''):'<tr><td colspan="4">Nenhuma oferta cadastrada.</td></tr>';
    $('log-list').innerHTML=data.logs.length?data.logs.map(l=>'<div><span><b>'+escape(l.event)+'</b> '+escape(l.detail||'')+'</span><time>'+toDate(l.created_at)+'</time></div>').join(''):'Ainda não há eventos.';
    await refreshWhatsApp();
  }catch(e){ if(e.message.includes('login')){view(false);$('top-status').textContent='Aguardando login';}else notice(e.message,true); }
}
for(let h=0;h<=24;h++){
  const label=String(h).padStart(2,'0')+':00';
  if(h<24) $('start_hour').insertAdjacentHTML('beforeend','<option value="'+h+'">'+label+'</option>');
  if(h>0) $('end_hour').insertAdjacentHTML('beforeend','<option value="'+h+'">'+label+'</option>');
}
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();notice('',false,'login-error');
  try{ await call('/api/login',{method:'POST',body:JSON.stringify({password:$('password').value})});$('password').value='';await refresh();}
  catch(err){notice(err.message,true,'login-error');}
});
$('logout').addEventListener('click',async()=>{try{await call('/api/logout',{method:'POST',body:'{}'})}catch{}view(false);});
$('settings-form').addEventListener('submit',async e=>{
  e.preventDefault();const body={telegram_chat_id:$('telegram_chat_id').value};for(const k of ['channel_registered','telegram_enabled','automation_enabled']) body[k]=$(k).checked;
  for(const k of ['interval_minutes','max_daily','start_hour','end_hour']) body[k]=Number($(k).value);
  try{const saved=await call('/api/settings',{method:'POST',body:JSON.stringify(body)});notice(saved.channel_changed?'Novo canal salvo e validado. Publicações pausadas: confirme o cadastro do canal no Mercado Livre, marque Canal registrado e permitido, habilite Telegram e salve novamente.':'Configurações salvas.');await refresh();}
  catch(err){notice(err.message,true);}
});
$('offer-form').addEventListener('submit',async e=>{
  e.preventDefault();const data=Object.fromEntries(new FormData(e.target));data.owner_confirmation=$('offer-form').elements.owner_confirmation.checked;
  try{await call('/api/offers',{method:'POST',body:JSON.stringify(data)});e.target.reset();notice('Link oficial cadastrado na fila.');await refresh();}
  catch(err){notice(err.message,true);}
});
$('wa-groups').addEventListener('click',async()=>{
  const b=$('wa-groups');b.disabled=true;b.textContent='Consultando...';
  try{
    const name=$('wa-instance').value.trim();
    if(!name)throw new Error('Informe o nome da instância primeiro.');
    const data=await call('/api/whatsapp/groups?instance='+encodeURIComponent(name));
    const list=$('wa-group'),selected=list.value;
    list.innerHTML='<option value="">Selecione um grupo...</option>'+data.groups.map(g=>'<option value="'+escape(g.id)+'">'+escape(g.name)+'</option>').join('');
    if(data.groups.some(g=>g.id===selected))list.value=selected;
    notice(data.groups.length+' grupo(s) localizado(s). Selecione o grupo público cadastrado no Mercado Livre.',false,'wa-feedback');
  }catch(error){notice(error.message,true,'wa-feedback');}
  finally{b.disabled=false;b.textContent='Buscar meus grupos';}
});
$('whatsapp-form').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const data=await call('/api/whatsapp/settings',{method:'POST',body:JSON.stringify({
      instance_name:$('wa-instance').value,group_jid:$('wa-group').value,
      public_registered:$('wa-registered').checked,enabled:$('wa-enabled').checked
    })});
    await refreshWhatsApp();
    notice(data.group_changed?'Grupo salvo. Por segurança, confirme e ative novamente antes de publicar.':'Configurações do WhatsApp salvas.',false,'wa-feedback');
  }catch(error){notice(error.message,true,'wa-feedback');}
});
$('wa-test').addEventListener('click',async()=>{
  if(!confirm('Enviar AGORA uma mensagem de teste real no grupo de WhatsApp selecionado?'))return;
  const b=$('wa-test');b.disabled=true;
  try{
    const result=await call('/api/whatsapp/test',{method:'POST',body:'{}'});
    notice('Teste enviado ao grupo! ID: '+result.message_id,false,'wa-feedback');
  }catch(error){notice(error.message,true,'wa-feedback');}
  finally{b.disabled=false;}
});
$('wa-deliveries').addEventListener('click',async e=>{
  const b=e.target.closest('[data-wa-retry]');if(!b)return;
  if(!confirm('Confira primeiro no grupo se a oferta NÃO foi enviada. Reenfileirar pode duplicar uma mensagem que já chegou. Deseja continuar?'))return;
  try{await call('/api/whatsapp/retry',{method:'POST',body:JSON.stringify({offer_id:Number(b.dataset.waRetry)})});notice('Oferta liberada para nova tentativa no próximo ciclo.',false,'wa-feedback');await refreshWhatsApp();}
  catch(error){notice(error.message,true,'wa-feedback');}
});
$('coupon-kind').addEventListener('change',()=>{
  const isCode=$('coupon-kind').value==='code';
  $('coupon-code').required=isCode;
  $('coupon-code').disabled=!isCode;
});
$('coupon-kind').dispatchEvent(new Event('change'));
$('coupon-discount-type').addEventListener('change',()=>{
  const fixed=$('coupon-discount-type').value==='fixed';
  $('coupon-discount-value').step=fixed?'0.01':'1';
  $('coupon-discount-value').min=fixed?'0.01':'1';
});
$('coupon-discount-type').dispatchEvent(new Event('change'));
$('coupon-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target));
  body.owner_confirmation=e.target.elements.owner_confirmation.checked;
  try{
    await call('/api/coupons',{method:'POST',body:JSON.stringify(body)});
    notice('Cupom salvo. A validade será verificada automaticamente antes da publicação; a elegibilidade deve ser conferida no carrinho.',false,'coupon-feedback');
    await refresh();
  }catch(error){notice(error.message,true,'coupon-feedback');}
});
$('test-telegram').addEventListener('click',async()=>{
  if(!confirm('Enviar uma mensagem de TESTE ao canal Telegram configurado agora?'))return;
  const btn=$('test-telegram');
  btn.disabled=true;
  btn.textContent='Testando conexão...';
  notice('Verificando envio para '+$('telegram_chat_id').value+'...',false,'telegram-test-feedback');
  try{
    const result=await call('/api/test-telegram',{method:'POST',body:'{}'});
    notice('✅ Mensagem enviada ao canal! ID do Telegram: '+result.message_id,false,'telegram-test-feedback');
  }catch(err){
    const msg=String(err.message||'Falha desconhecida');
    const lower=msg.toLowerCase();
    let help='';
    if(lower.includes('unauthorized')||lower.includes('401')) help=' Confira o TELEGRAM_BOT_TOKEN salvo como Secret na Cloudflare.';
    else if(lower.includes('chat not found')||lower.includes('not found')) help=' Confira o endereço do novo canal e se @Crjornadabot é administrador.';
    else if(lower.includes('bot is not a member')||lower.includes('not enough rights')||lower.includes('forbidden')) help=' Confira se @Crjornadabot tem permissão de publicar no canal.';
    else if(lower.includes('canal')||lower.includes('grupo público')) help=' Confirme o canal público cadastrado na sua Central de Afiliados, salve e tente novamente.';
    else if(lower.includes('configure o segredo')) help=' Adicione TELEGRAM_BOT_TOKEN como Secret de produção no Worker.';
    notice('❌ Teste não enviado: '+msg+help,true,'telegram-test-feedback');
  }finally{
    btn.disabled=false;
    btn.textContent='Testar Telegram';
  }
});
$('offers-rows').addEventListener('click',async e=>{
  const btn=e.target.closest('button[data-action]');if(!btn)return;
  const id=Number(btn.dataset.id);const type=btn.dataset.action;
  const msg=type==='publish'?'Publicar este link de afiliado AGORA no canal Telegram configurado?':'Revise no canal se a oferta não saiu antes de reenfileirá-la. Confirma?';
  if(!confirm(msg))return;
  try{const result=await call('/api/offers/'+id+'/'+type,{method:'POST',body:'{}'});notice(type==='publish'?(result.format==='photo'?'Oferta publicada com FOTO no Telegram.':'Oferta publicada em texto: foto indisponível ou não aceita pelo Telegram.'):'Oferta reenfileirada.');await refresh();}
  catch(err){notice(err.message,true);await refresh();}
});
$('refresh').addEventListener('click',refresh);
refresh();
`;
