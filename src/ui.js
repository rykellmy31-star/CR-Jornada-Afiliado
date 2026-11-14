export function renderPage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#0b1b35"><title>CR Jornada • Afiliados</title><link rel="stylesheet" href="/styles.css"><script src="/app.js" defer></script></head><body>
  <header><div class="brand"><div class="logo">CR</div><div><strong>CR Jornada</strong><small>AFILIADOS • MULTIPLATAFORMA</small></div></div><div class="header-end"><span id="top-status" class="pill">Aguardando conexão</span><button id="logout" class="ghost hidden" type="button">Sair</button></div></header>
  <main>
    <section id="login" class="login card"><span class="eyebrow">ACESSO RESTRITO</span><h1>Painel de ofertas</h1><p>Entre com a senha administrativa configurada como segredo na Cloudflare.</p><form id="login-form"><label>Senha de administrador<input id="password" type="password" minlength="8" required autocomplete="current-password" placeholder="••••••••••"></label><button class="primary" type="submit">Entrar no painel</button></form><div id="login-error" class="feedback" role="status"></div></section>
    <section id="dashboard" class="hidden">
      <aside class="platform-sidebar" id="platform-sidebar" aria-label="Menu de plataformas">
        <div class="platform-nav-heading">PLATAFORMAS</div>
        <button class="platform-nav-item active" type="button" data-platform="mercadolivre"><span>🛍️</span> Mercado Livre</button>
        <button class="platform-nav-item" type="button" data-platform="shopee"><span>🧡</span> Shopee</button>
        <div class="platform-side-divider"></div>
        <p class="platform-side-note">Cada plataforma possui suas próprias filas e configurações de divulgação.</p>
      </aside>
      <section class="platform-context card" id="platform-context">
        <div class="platform-context-head">
          <div>
            <span class="eyebrow">PLATAFORMA SELECIONADA</span>
            <h2 id="platform-heading">Mercado Livre</h2>
            <p class="hint" id="platform-description">Administre canais, grupos e ofertas do Mercado Livre.</p>
          </div>
          <div class="platform-network-tabs" role="group" aria-label="Escolher canal de divulgação">
            <button type="button" class="platform-network-button active" data-network="telegram">✈️ Telegram</button>
            <button type="button" class="platform-network-button" data-network="whatsapp">🟢 WhatsApp</button>
          </div>
        </div>
        <label class="platform-target-label">Selecionar canal ou grupo para configurar
          <select id="platform-target-select" aria-label="Canal ou grupo da plataforma"></select>
        </label>
      </section>
      <div class="intro"><div><span class="eyebrow">CENTRAL DE AUTOMAÇÃO</span><h1>Suas ofertas, no ritmo certo.</h1><p>Cadastre links oficiais, programe envios e acompanhe o Telegram em um único lugar.</p></div><div class="profile"><span>Perfil afiliado</span><b>rykellmy_007</b><span id="channel-label">Destino Telegram: @achadinhosmlcr</span></div></div>
      <div id="notice" class="feedback" role="status"></div>
      <section class="card channels-panel" id="channels-panel">
        <div class="section-header"><div><h2>📣 Central multicanal do Telegram</h2>
          <p>Gerencie vários canais com filas, categorias, bots, horários e históricos separados. Seu canal atual está preservado como canal principal.</p></div>
          <button id="channel-create-toggle" class="outline" type="button">+ Adicionar canal</button>
        </div>
        <label>Canal que deseja administrar
          <select id="channel-select" aria-label="Selecione um canal do Telegram"><option value="1">Canal principal</option></select>
        </label>
        <div id="channel-creation" class="channel-create hidden">
          <h2>Adicionar canal do Telegram</h2>
          <p class="hint">Cria um canal independente, desligado por padrão. O bot precisa ser administrador com permissão de publicar.</p>
          <form id="channel-create-form">
            <div class="field-grid">
              <label>Nome para identificar<input name="name" required maxlength="80" placeholder="Ex.: Achadinhos Eletrônicos"></label>
              <label>Canal público<input name="telegram_chat_id" required placeholder="https://t.me/seucanal"></label>
              <label>Categoria do canal<input name="category" required maxlength="60" value="Geral" placeholder="Ex.: Eletrônicos"></label>
              <label>Qual bot usar?
                <select name="bot_mode" id="new-channel-bot-mode">
                  <option value="shared">Usar bot principal</option>
                  <option value="dedicated">Bot exclusivo deste canal</option>
                </select>
              </label>
            </div>
            <label id="new-channel-bot-wrap" class="hidden">Token do bot exclusivo (BotFather)
              <input name="bot_token" type="password" autocomplete="new-password" placeholder="Cole o token do novo bot, se já tiver">
            </label>
            <p class="hint">Não envie tokens pelo chat. Tokens exclusivos são criptografados no banco e nunca exibidos de volta. O canal novo não compartilha ofertas com os outros.</p>
            <div class="actions"><button class="primary" type="submit">Criar canal desativado</button><button class="outline" id="channel-create-cancel" type="button">Cancelar</button></div>
            <p id="channel-create-feedback" class="feedback" role="status"></p>
          </form>
        </div>
      </section>
      <div class="metric-grid"><div class="metric card"><span>Prontas para publicar</span><strong id="count-ready">0</strong></div><div class="metric card"><span>Publicadas</span><strong id="count-published">0</strong></div><div class="metric card"><span>Em revisão</span><strong id="count-needs_review">0</strong></div><div class="metric card"><span>Total cadastrado</span><strong id="count-total">0</strong></div></div>
      <div class="main-grid">
        <section class="card settings"><div class="section-header"><div><h2>Automação</h2><p>O envio automático começa desligado por segurança.</p></div><div class="symbol">⚙</div></div>
          <form id="settings-form">
            <div id="channel-primary-category">
              <label>Categoria permitida neste canal
                <input id="primary-channel-category" maxlength="60" value="Geral" placeholder="Ex.: Motos, Feminino, Masculino, Infantil, Peças">
              </label>
              <p class="hint">Geral aceita todas as categorias. Se escolher uma categoria específica, somente ofertas correspondentes serão cadastradas ou publicadas aqui.</p>
            </div>
            <div id="channel-extra-settings" class="channel-extra-settings hidden">
              <h2>Configurações exclusivas deste canal</h2>
              <div class="field-grid">
                <label>Nome do canal<input id="channel-name" maxlength="80" placeholder="Nome no painel"></label>
                <label>Categoria das ofertas<input id="channel-category" maxlength="60" placeholder="Ex.: Eletrônicos"></label>
                <label>Bot responsável
                  <select id="channel-bot-mode">
                    <option value="shared">Usar bot principal</option>
                    <option value="dedicated">Bot exclusivo</option>
                  </select>
                </label>
                <label id="channel-bot-token-wrap" class="hidden">Novo token do BotFather
                  <input id="channel-bot-token" type="password" autocomplete="new-password" placeholder="Vazio mantém o token salvo">
                </label>
              </div>
              <p class="hint">Se alterar o bot ou destino, a automação será pausada para nova autorização. Tokens exclusivos ficam criptografados, sem aparecer na tela.</p>
            </div>
            <label>Canal público do Telegram<input type="text" id="telegram_chat_id" name="telegram_chat_id" placeholder="https://t.me/seucanal" required autocomplete="off"></label>
            <p class="hint">Cole o link público do canal. O bot selecionado deve ser administrador com permissão para publicar. Ao trocar de destino, a automação será pausada até nova confirmação.</p>
            <label class="check-row"><input type="checkbox" id="channel_registered"><span><b>Canal registrado e permitido</b><small>Confirmo que este canal público está cadastrado na Central de Afiliados e atende às regras de divulgação.</small></span></label>
            <label class="check-row"><input type="checkbox" id="telegram_enabled"><span><b>Habilitar publicação no Telegram</b><small>Exige token do BotFather configurado como segredo.</small></span></label>
            <label class="check-row"><input type="checkbox" id="automation_enabled"><span><b>Iniciar automação</b><small>Usará apenas os links oficiais previamente cadastrados.</small></span></label>
            <div class="field-grid"><label>Intervalo entre publicações no Telegram (minutos)<input id="interval_minutes" type="number" inputmode="numeric" min="1" max="1440" step="1" placeholder="Ex.: 20" required></label><label>Máximo diário (1 a 48)<input type="number" min="1" max="48" id="max_daily"></label><label>Começar às (Bahia)<select id="start_hour"></select></label><label>Parar às (Bahia)<select id="end_hour"></select></label></div>
            <p class="hint">Digite qualquer intervalo inteiro entre 1 e 1440 minutos. Janela de publicação no horário da Bahia (UTC−3).</p>
            <div class="actions"><button class="primary" type="submit">Salvar configurações</button><button class="outline" type="button" id="test-telegram">Testar Telegram</button></div>
            <p id="token-state" class="hint"></p>
            <p id="telegram-test-feedback" class="feedback" role="status" aria-live="polite"></p>
          </form>
        </section>
        <section class="card add-offer"><div class="section-header"><div><h2>Adicionar oferta</h2><p>Somente links gerados na sua conta do Mercado Livre. A oferta entra exclusivamente na fila do canal selecionado.</p></div><div class="symbol">＋</div></div>
          <form id="offer-form"><label>Nome do produto<input name="title" required minlength="5" maxlength="180" placeholder="Ex.: Base Bauleto Gow 33 e 47 litros"></label><label>Link oficial do afiliado<input name="affiliate_url" type="url" required placeholder="https://meli.la/..."></label><div class="field-grid"><label>Categoria<input name="category" placeholder="Ex.: Automotivo"></label><label>Preço atual (opcional)<input name="price" type="number" min="0.01" step="0.01" placeholder="79.90"></label><label>Preço anterior (opcional)<input name="old_price" type="number" min="0.01" step="0.01" placeholder="99.90"></label></div>
          <label class="check-row owner"><input name="owner_confirmation" type="checkbox" required><span><b>Confirmo que o link foi criado pelo Gerador/Barra de Afiliados</b><small>O sistema não consegue comprovar automaticamente que a comissão pertence à sua conta.</small></span></label>
          <button class="primary full" type="submit">Cadastrar na fila</button></form><p class="hint">Ao publicar, o robô tenta localizar a foto oficial do produto; se indisponível, envia o link com prévia. Preços informados manualmente não são verificados em tempo real.</p></section>
      </div>
      <section class="card whatsapp-panel" id="whatsapp">
        <div class="section-header"><div><h2>🟢 WhatsApp • Evolution API</h2><p>Compartilhe no seu grupo as ofertas já publicadas no canal principal do Telegram, sem recadastrar os links.</p></div><span id="whatsapp-badge" class="tag">Desligado</span></div>
        <p class="hint">Use a Evolution API instalada na sua própria VPS. O WhatsApp não oficial pode sofrer bloqueios; não permite disparos privados ou importação de contatos. O grupo deve ser público, aberto e cadastrado como mídia na Central de Afiliados.</p>
        <p class="hint" id="whatsapp-server-status">Verificando configuração do servidor...</p>
        <form id="whatsapp-form" class="whatsapp-form">
          <div class="wa-connect-box">
            <p><b>Instância exclusiva:</b> <code>cr-jornada-afiliados</code></p>
            <input id="wa-instance" type="hidden" value="cr-jornada-afiliados">
            <p class="hint" id="wa-connection-state">Verificando conexão...</p>
            <div class="actions"><button type="button" class="primary" id="wa-auto-connect">Conectar WhatsApp • Gerar QR Code</button></div>
            <div id="wa-qr-wrap" class="wa-qr-wrap hidden">
              <img id="wa-qr-image" alt="QR Code de conexão da instância CR Jornada Afiliados" width="260" height="260">
              <p>Abra o WhatsApp do número exclusivo → <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b> e leia o QR Code. Se expirar, clique em Gerar QR novamente.</p>
            </div>
          </div>
          <div class="field-grid">
            <label>Grupo conectado à instância<select id="wa-group" required><option value="">Clique em Buscar meus grupos</option></select></label>
            <div class="actions" style="align-items:end"><button type="button" class="outline" id="wa-groups">Buscar meus grupos</button></div>
          </div>
          <p class="hint">O link de convite do grupo não é seu ID técnico. O botão consulta apenas os grupos que o número conectado na Evolution já participa.</p>
          <label>Categoria permitida no grupo principal
            <input id="wa-category" maxlength="60" placeholder="Geral, Motos, Feminino, Masculino, Infantil, Peças" value="Geral" required>
          </label>
          <p class="hint">Geral espelha todas as categorias. Outra categoria filtra as ofertas já publicadas no Telegram principal.</p>
          <label>Intervalo entre publicações no WhatsApp (minutos)
            <input id="wa-interval" type="number" inputmode="numeric" min="1" max="1440" step="1" placeholder="Ex.: 20" required>
          </label>
          <p class="hint">Digite os minutos que preferir (de 1 a 1440). O WhatsApp tem intervalo próprio e só compartilha ofertas após a publicação no Telegram. Intervalos muito curtos aumentam o risco de restrições no WhatsApp.</p>
          <label class="check-row"><input type="checkbox" id="wa-registered"><span><b>Confirmo que é um grupo público e aberto</b><small>Também confirmo que cadastrei esse grupo na Central de Afiliados do Mercado Livre e tenho permissão para publicar.</small></span></label>
          <label class="check-row"><input type="checkbox" id="wa-enabled"><span><b>Ativar publicações no WhatsApp</b><small>Espelha somente novas ofertas publicadas no Telegram após a ativação. Uma oferta por ciclo, sem reenvios automáticos quando houver dúvida.</small></span></label>
          <div class="actions"><button class="primary" type="submit">Salvar WhatsApp</button><button class="outline" id="wa-test" type="button">Enviar teste ao grupo</button></div>
          <p class="feedback" id="wa-feedback" role="status" aria-live="polite"></p>
        </form>
        <div class="section-header" style="margin-top:14px"><div><h2>Últimos envios no WhatsApp</h2></div></div>
        <div id="wa-deliveries" class="whatsapp-results">Ainda não há envios.</div>
      </section>
      <section class="card wa-multichannel" id="wa-multichannel">
        <div class="section-header">
          <div><h2>🟢 Central multigrupos do WhatsApp</h2>
            <p>Crie grupos independentes por categoria, com horários, filas e números próprios. O grupo principal continua funcionando como antes.</p></div>
          <button type="button" class="outline" id="wa-multi-create-toggle">+ Adicionar grupo</button>
        </div>
        <label>Grupo para administrar
          <select id="wa-multi-select"><option value="1">WhatsApp principal (existente)</option></select>
        </label>
        <div class="channel-create hidden" id="wa-multi-create">
          <form id="wa-multi-create-form">
            <div class="field-grid">
              <label>Nome do grupo no painel<input name="name" required minlength="3" maxlength="80" placeholder="Ex.: Ofertas para motociclistas"></label>
              <label>Categoria permitida<input name="category" required maxlength="60" value="Motos" placeholder="Motos, Feminino, Masculino, Infantil, Peças"></label>
              <label>Número do WhatsApp
                <select name="instance_mode">
                  <option value="shared">Usar o número Evolution já conectado</option>
                  <option value="dedicated">Conectar número exclusivo por QR Code</option>
                </select>
              </label>
            </div>
            <div class="actions"><button type="submit" class="primary">Criar grupo desligado</button><button type="button" id="wa-multi-create-cancel" class="outline">Cancelar</button></div>
          </form>
        </div>
        <div id="wa-multi-extra" class="hidden" style="margin-top:17px">
          <div class="wa-connect-box">
            <p><strong id="wa-multi-instance">Instância Evolution</strong></p>
            <p id="wa-multi-connection-state" class="hint">Verifique a conexão antes de buscar grupos.</p>
            <button type="button" id="wa-multi-connect" class="outline">Verificar / Gerar QR Code</button>
            <div id="wa-multi-qr-wrap" class="wa-qr-wrap hidden">
              <img id="wa-multi-qr-image" width="260" height="260" alt="QR Code para conectar WhatsApp exclusivo do grupo">
              <p>WhatsApp → Aparelhos conectados → Conectar um aparelho → leia o QR Code</p>
            </div>
          </div>
          <form id="wa-multi-settings-form" class="wa-multi-form">
            <div class="field-grid">
              <label>Nome do grupo<input id="wa-multi-name" maxlength="80" required></label>
              <label>Categoria permitida<input id="wa-multi-category" maxlength="60" placeholder="Ex.: Infantil" required></label>
              <label>Grupo da Evolution
                <select id="wa-multi-jid"><option value="">Buscar grupos para selecionar</option></select>
              </label>
              <div class="actions" style="align-items:end"><button type="button" class="outline" id="wa-multi-groups">Buscar meus grupos</button></div>
              <label>Intervalo entre publicações (minutos)<input id="wa-multi-interval" type="number" inputmode="numeric" min="1" max="1440" step="1" required></label>
              <label>Máximo diário (1 a 48)<input id="wa-multi-daily" type="number" inputmode="numeric" min="1" max="48" step="1" required></label>
              <label>Começar às (Bahia)<select id="wa-multi-start"></select></label>
              <label>Parar às (Bahia)<select id="wa-multi-end"></select></label>
            </div>
            <label class="check-row"><input type="checkbox" id="wa-multi-registered"><span><b>Grupo público cadastrado no Mercado Livre</b><small>Confirmo que é público, aberto e informado como mídia na Central de Afiliados.</small></span></label>
            <label class="check-row"><input type="checkbox" id="wa-multi-enabled"><span><b>Ativar publicação automática deste grupo</b><small>Somente ofertas da categoria escolhida e da fila exclusiva deste grupo.</small></span></label>
            <div class="actions"><button type="submit" class="primary">Salvar grupo WhatsApp</button><button type="button" id="wa-multi-test" class="outline">Enviar teste ao grupo</button></div>
          </form>
          <div class="divider-wa"></div>
          <div class="section-header"><div><h2>Ofertas exclusivas deste grupo</h2><p>Use os links oficiais de afiliado. Cada grupo recebe somente a categoria que você definiu.</p></div></div>
          <form id="wa-multi-offer-form" class="wa-multi-form">
            <label>Produto<input name="title" minlength="5" maxlength="180" required placeholder="Ex.: Capacete para moto"></label>
            <label>Link de afiliado<input name="affiliate_url" type="url" required placeholder="https://meli.la/..."></label>
            <div class="field-grid">
              <label>Categoria<input name="category" id="wa-multi-offer-category" required></label>
              <label>Preço atual (opcional)<input name="price" type="number" min="0.01" step="0.01"></label>
              <label>Preço antigo (opcional)<input name="old_price" type="number" min="0.01" step="0.01"></label>
            </div>
            <label class="check-row"><input type="checkbox" name="owner_confirmation" required><span><b>Link criado pela minha Central de Afiliados</b></span></label>
            <button type="submit" class="primary">Adicionar à fila deste grupo</button>
          </form>
          <div class="section-header" style="margin-top:21px"><div><h2>Cupom opcional da oferta</h2></div></div>
          <form id="wa-multi-coupon-form" class="wa-multi-form">
            <div class="field-grid">
              <label>Oferta na fila<select name="offer_id" id="wa-multi-coupon-offer" required></select></label>
              <label>Tipo<select name="kind" id="wa-multi-coupon-kind"><option value="code">Código</option><option value="activation">Ativação</option></select></label>
              <label>Código<input name="code" id="wa-multi-coupon-code"></label>
              <label>Desconto<select name="discount_type"><option value="percent">Porcentagem</option><option value="fixed">Valor fixo (R$)</option></select></label>
              <label>Valor<input name="discount_value" type="number" min="1" step="1" required></label>
              <label>Compra mínima (R$)<input name="min_cart" type="number" min="0" step="0.01"></label>
              <label>Teto desconto (R$)<input name="max_discount" type="number" min="0.01" step="0.01"></label>
              <label>Início<input name="start_day" type="date" required></label>
              <label>Fim<input name="end_day" type="date" required></label>
              <label>Fonte oficial do cupom<input name="source_url" type="url" required placeholder="https://www.mercadolivre.com.br/..."></label>
            </div>
            <label>Restrições<input name="notes" maxlength="220"></label>
            <label class="check-row"><input type="checkbox" name="owner_confirmation" required><span><b>Conferi a origem e as condições do cupom</b></span></label>
            <button class="outline" type="submit">Salvar cupom</button>
          </form>
          <div class="section-header" style="margin-top:21px"><div><h2>Fila e histórico do grupo</h2></div></div>
          <div class="table-scroll"><table><thead><tr><th>Oferta</th><th>Estado</th><th>Ação</th></tr></thead><tbody id="wa-multi-offers"><tr><td colspan="3">Sem ofertas.</td></tr></tbody></table></div>
          <div id="wa-multi-logs" class="logs"></div>
        </div>
        <p class="feedback" id="wa-multi-feedback" role="status" aria-live="polite"></p>
        <p class="hint">A Evolution API usa uma integração WhatsApp não oficial. Não publique em grupos privados, nem em grupos que não autorizaram a divulgação. A busca automática e os links de comissão ainda dependem da API oficial do Mercado Livre.</p>
      </section>
      <section class="card shopee-panel hidden" id="shopee-panel">
        <div class="section-header">
          <div>
            <h2>🧡 Shopee • Central de afiliados</h2>
            <p id="shopee-target-title">Selecione um canal do Telegram ou grupo do WhatsApp acima.</p>
          </div>
          <span class="tag" id="shopee-status">Desligado</span>
        </div>
        <p class="hint">Use links que você gerou no Portal de Afiliados da Shopee. Esta integração publica links cadastrados manualmente; a busca automática e a criação de links via API ainda não estão habilitadas.</p>
        <div id="shopee-feedback" class="feedback" role="status" aria-live="polite"></div>
        <div class="main-grid shopee-grid">
          <section class="shopee-inner">
            <h2>Configurações deste destino</h2>
            <p id="shopee-base-status" class="hint">Carregando permissões do canal ou grupo...</p>
            <form id="shopee-settings-form" class="shopee-form">
              <label>Categoria das ofertas
                <input id="shopee-category" type="text" required maxlength="60" placeholder="Ex.: Motos, Feminino, Infantil">
              </label>
              <div class="field-grid">
                <label>Intervalo (minutos)
                  <input id="shopee-interval" type="number" inputmode="numeric" min="1" max="1440" step="1" required>
                </label>
                <label>Máximo diário (1 a 48)
                  <input id="shopee-max-daily" type="number" min="1" max="48" step="1" required>
                </label>
                <label>Começar às (Bahia)<select id="shopee-start"></select></label>
                <label>Parar às (Bahia)<select id="shopee-end"></select></label>
              </div>
              <label class="check-row">
                <input id="shopee-permission" type="checkbox">
                <span><b>Destino autorizado para receber ofertas da Shopee</b>
                  <small>Confirmo que administro o canal/grupo, tenho permissão para divulgar e que ele atende às condições do programa de afiliados.</small></span>
              </label>
              <label class="check-row">
                <input id="shopee-enabled" type="checkbox">
                <span><b>Ativar publicações da Shopee neste destino</b>
                  <small>Este controle é independente das publicações do Mercado Livre.</small></span>
              </label>
              <button type="submit" class="primary">Salvar configuração Shopee</button>
            </form>
          </section>
          <section class="shopee-inner">
            <h2>Adicionar oferta da Shopee</h2>
            <form id="shopee-offer-form" class="shopee-form">
              <label>Produto
                <input name="title" required minlength="5" maxlength="180" placeholder="Ex.: Kit de roupas infantis">
              </label>
              <label>Meu link de afiliado da Shopee
                <input name="affiliate_url" type="url" required placeholder="https://s.shopee.com.br/...">
              </label>
              <label>Categoria do produto
                <input name="category" id="shopee-offer-category" required maxlength="60" placeholder="Ex.: Infantil">
              </label>
              <div class="field-grid">
                <label>Preço atual (opcional)
                  <input name="price" type="number" min="0.01" step="0.01" placeholder="59.90">
                </label>
                <label>Preço anterior (opcional)
                  <input name="old_price" type="number" min="0.01" step="0.01" placeholder="79.90">
                </label>
              </div>
              <label class="check-row">
                <input name="owner_confirmation" type="checkbox" required>
                <span><b>Este link foi gerado na minha conta de afiliado da Shopee</b>
                  <small>O robô não pode comprovar sua comissão; use somente links oficiais da sua conta.</small></span>
              </label>
              <button type="submit" class="primary">Adicionar à fila Shopee</button>
            </form>
          </section>
        </div>
        <div class="section-header" style="margin-top:22px">
          <div><h2>Fila de ofertas Shopee</h2><p>Histórico exclusivo deste canal ou grupo.</p></div>
          <button id="shopee-refresh" type="button" class="outline">Atualizar</button>
        </div>
        <div class="table-scroll">
          <table><thead><tr><th>Produto</th><th>Categoria</th><th>Status</th><th>Ação</th></tr></thead>
          <tbody id="shopee-offers-rows"><tr><td colspan="4">Nenhuma oferta cadastrada.</td></tr></tbody></table>
        </div>
        <div id="shopee-logs" class="logs"></div>
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
      <footer>Desenvolvido por Carlos Rykellmy Santos Correia • CR Jornada<br>Telegram multicanal • WhatsApp com Evolution API • Busca e links automáticos aguardam integração oficial.</footer>
    </section>
  </main></body></html>`;
}

export const CSS = `
:root{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17233b;background:#f5f7fb;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}h1,h2,p{margin:0}h1{font-size:clamp(26px,3vw,39px);letter-spacing:-1px;line-height:1.18}h2{font-size:18px;letter-spacing:-.3px}p{color:#68748b;line-height:1.6}header{background:#0b1b35;color:#fff;padding:17px max(22px,calc((100% - 1160px)/2));display:flex;align-items:center;justify-content:space-between;gap:12px}.brand{display:flex;align-items:center;gap:12px}.logo{width:43px;height:43px;border-radius:12px;background:linear-gradient(135deg,#18b4a1,#1784be);display:grid;place-items:center;font-weight:900;letter-spacing:-1px}.brand strong{font-size:16px;display:block}.brand small{font-size:10px;letter-spacing:1.2px;color:#a0b4cc}.header-end{display:flex;align-items:center;gap:8px}.pill{border:1px solid #37516f;color:#cbd9eb;border-radius:25px;padding:7px 12px;font-size:12px;white-space:nowrap}main{max-width:1200px;margin:0 auto;padding:28px 20px 40px}.hidden{display:none!important}.card{background:#fff;border:1px solid #e8edf5;border-radius:17px;box-shadow:0 10px 25px #112b5510}.login{max-width:480px;margin:60px auto;padding:36px}.login h1{margin:10px 0}.login p{margin-bottom:25px}.eyebrow{font-size:11px;letter-spacing:1.4px;font-weight:800;color:#258b9e}.intro{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;padding:12px 4px 25px}.intro h1{margin:10px 0}.intro p{max-width:650px}.profile{background:#eaf3fb;padding:12px 18px;border-radius:13px;display:flex;flex-direction:column;gap:2px;min-width:210px;color:#506780;font-size:12px}.profile b{color:#10253e;font-size:18px}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;margin-bottom:16px}.metric{padding:19px 20px}.metric span{display:block;font-size:12px;color:#79849b}.metric strong{display:block;font-size:30px;margin-top:6px;letter-spacing:-1px;color:#182f4d}.main-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.main-grid>.card,.list-panel,.history{padding:22px}.section-header{display:flex;justify-content:space-between;gap:15px;align-items:flex-start;margin-bottom:19px}.section-header p{font-size:12px;margin-top:5px}.symbol{background:#e5f5f3;color:#087e71;border-radius:11px;width:32px;height:32px;display:grid;place-items:center;font-size:20px;font-weight:800}.settings form,.add-offer form,#login-form{display:flex;flex-direction:column;gap:15px}label{font-size:13px;font-weight:600;color:#34425a;display:flex;flex-direction:column;gap:8px}input:not([type=checkbox]),select{width:100%;padding:12px 13px;border-radius:9px;border:1px solid #d9e1ef;background:#fbfcfe;color:#182c47;font-size:15px;outline:none;min-height:44px}input:focus,select:focus{border-color:#1696ab;box-shadow:0 0 0 3px #14aaa21d}.check-row{flex-direction:row;gap:12px;align-items:flex-start;padding:11px;border:1px solid #e9edf3;border-radius:11px;background:#fcfdff;cursor:pointer}.check-row input{width:18px;height:18px;flex:0 0 18px;margin:2px 0 0;accent-color:#119d8d}.check-row span{display:flex;flex-direction:column;gap:5px}.check-row small{font-size:11.5px;color:#748095;line-height:1.5;font-weight:400}.owner{margin-top:3px}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.actions{display:flex;gap:10px;flex-wrap:wrap}.hint{font-size:11px;margin-top:0}.primary,.outline,.ghost{border:0;cursor:pointer;border-radius:10px;padding:12px 17px;min-height:41px;font-size:13px;font-weight:700}.primary{background:#0e867f;color:#fff}.primary:hover{background:#09726c}.outline{background:#fff;border:1px solid #cbd8e5;color:#1a5772}.outline:hover{background:#eff8fb}.ghost{background:#1d3454;color:#fff;padding:8px 12px}.full{width:100%}.feedback{font-size:13px;margin-bottom:12px;min-height:0}.feedback:not(:empty){padding:12px 14px;border-radius:10px;background:#e7f5ef;color:#17654d}.feedback.error:not(:empty){background:#fff0f0;color:#a82828}.list-panel,.history,.coupon-panel,.whatsapp-panel{margin-top:16px}.platform-sidebar{position:fixed;left:12px;top:82px;width:205px;z-index:5;background:#112747;color:#ecf5fb;border-radius:16px;padding:18px;box-shadow:0 10px 30px #0b1b3520;display:flex;flex-direction:column;gap:9px}.platform-nav-heading{font-size:11px;font-weight:900;letter-spacing:1.2px;color:#91aecb;margin-bottom:9px}.platform-nav-item{display:flex;align-items:center;gap:10px;text-align:left;background:transparent;border:1px solid transparent;color:#e0e9f4;padding:12px;border-radius:10px;font-weight:750;cursor:pointer}.platform-nav-item.active{background:#1e4c65;border-color:#35c4b7;color:#fff}.platform-side-divider{height:1px;background:#35516c;margin:10px 0}.platform-side-note{font-size:11px;color:#abc0d4}.app-has-sidebar main{margin-left:225px;max-width:none}.platform-context{padding:20px 22px;margin-bottom:16px}.platform-context-head{display:flex;justify-content:space-between;align-items:center;gap:16px}.platform-context h2{font-size:22px;margin:5px 0}.platform-network-tabs{display:flex;gap:5px;padding:5px;border-radius:13px;background:#eaf0f5}.platform-network-button{padding:9px 15px;border:0;border-radius:9px;background:transparent;color:#475c76;cursor:pointer;font-size:13px;font-weight:700}.platform-network-button.active{background:white;color:#0f7d8a;box-shadow:0 1px 4px #153e5920}.platform-target-label{margin-top:13px;max-width:650px}.shopee-panel{padding:22px;margin-top:16px}.shopee-grid{margin-top:18px}.shopee-inner{background:#f8fafc;padding:18px;border-radius:13px;border:1px solid #e3eaf2}.shopee-inner h2{margin-bottom:12px}.shopee-form{display:flex;flex-direction:column;gap:12px}.shopee-panel .logs{margin-top:15px}@media(max-width:950px){.app-has-sidebar main{margin-left:0}.platform-sidebar{position:static;left:auto;top:auto;width:auto;flex-direction:row;align-items:center;flex-wrap:wrap;margin-bottom:16px;padding:10px 12px}.platform-nav-heading,.platform-side-divider,.platform-side-note{display:none}.platform-nav-item{padding:10px 12px}.platform-context-head{flex-direction:column;align-items:stretch}}@media(max-width:520px){.platform-network-tabs{width:100%;justify-content:space-evenly}.platform-network-button{flex:1}.platform-context,.shopee-panel{padding:15px}}.channels-panel{padding:22px;margin-bottom:16px}.wa-multichannel{padding:22px;margin-top:16px}.wa-multichannel>label{max-width:560px}.wa-multi-form{display:flex;flex-direction:column;gap:12px;margin-top:15px}.wa-multichannel .hint{margin:8px 0}.divider-wa{border-top:1px solid #e6edf5;margin:21px 0}.wa-multichannel .wa-connect-box{margin-bottom:14px}.channels-panel>label{max-width:560px}.channels-panel .section-header{align-items:center}.channel-create{margin-top:15px;padding:18px;border:1px solid #d9e4ec;border-radius:13px;background:#f8fafc}.channel-create form{display:flex;flex-direction:column;gap:13px;margin-top:13px}.channel-create h2{margin-bottom:7px}.channel-extra-settings{background:#f8fafc;padding:16px;border-radius:12px;border:1px solid #e4ebf3;margin-bottom:8px}.channel-extra-settings h2{margin-bottom:13px}.coupon-panel,.whatsapp-panel{padding:22px}.coupon-panel form,.whatsapp-panel form{display:flex;flex-direction:column;gap:13px;margin-top:16px}.whatsapp-panel select{min-width:0}.whatsapp-panel .tag{flex-shrink:0}.whatsapp-delivery{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #edf1f6;padding:11px 0}.whatsapp-delivery small{display:block;color:#748095}.whatsapp-panel .hint{margin:9px 0}.wa-connect-box{border:1px solid #d9e8e7;background:#f4fbfa;border-radius:13px;padding:16px}.wa-connect-box p{margin-bottom:11px}.wa-connect-box code{color:#135a55;font-weight:800}.wa-qr-wrap{display:flex;flex-direction:column;align-items:center;margin-top:16px;gap:10px}.wa-qr-wrap img{display:block;width:min(260px,100%);height:auto;aspect-ratio:1;background:white;border:9px solid white;border-radius:10px;image-rendering:pixelated;box-shadow:0 2px 13px #15354320}.wa-qr-wrap p{max-width:340px;text-align:center;font-size:12px}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px;text-align:left}th{font-size:11px;color:#7e8ba1;text-transform:uppercase;letter-spacing:.8px;background:#f7f9fc}td,th{padding:12px 14px;border-bottom:1px solid #edf1f7;vertical-align:middle}td:first-child{min-width:240px}td a{font-weight:700;color:#0a7e95;text-decoration:none}td small{display:block;color:#718099;font-size:11px;margin-top:3px}.tag{border-radius:16px;padding:5px 9px;background:#edf4f8;color:#517086;font-size:11px;font-weight:700;white-space:nowrap}.tag.ready{background:#e4f8ef;color:#197348}.tag.published{background:#e8effb;color:#2558a2}.tag.needs_review{background:#fff1dd;color:#9b6a10}.tag.sending{background:#f2e8fd;color:#6a39a1}.mini{border:1px solid #d5e1eb;border-radius:9px;padding:7px 10px;background:#fff;color:#245b75;font-weight:700;cursor:pointer;white-space:nowrap}.logs{display:flex;flex-direction:column;gap:9px;color:#526477;font-size:12px}.logs>div{display:flex;justify-content:space-between;gap:15px;padding:9px 0;border-bottom:1px solid #edf1f6}.logs time{white-space:nowrap;color:#94a0b0}footer{font-size:11px;color:#97a2b4;text-align:center;margin-top:30px;line-height:1.8}
@media(max-width:850px){.main-grid{grid-template-columns:1fr}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.intro{flex-direction:column;align-items:stretch}.profile{width:100%}}@media(max-width:520px){main{padding:16px 12px 34px}header{padding:14px 12px}.header-end .pill{display:none}.main-grid>.card,.list-panel,.history,.coupon-panel,.whatsapp-panel,.channels-panel,.wa-multichannel{padding:17px}.field-grid{grid-template-columns:1fr}.metric-grid{gap:9px}.metric{padding:15px}.metric strong{font-size:26px}.login{margin:35px 0;padding:22px}.actions button{flex:1}.section-header{margin-bottom:14px}}
`;

export const CLIENT_JS = `
'use strict';
const $ = id => document.getElementById(id);
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toDate = s => s ? new Date(s*1000).toLocaleString('pt-BR') : '—';
let currentChannelId=1;
let currentWaGroupId=1;
let selectedPlatform='mercadolivre';
let selectedNetwork='telegram';
const lastNetwork={mercadolivre:'telegram',shopee:'telegram'};
const shopeeTarget={telegram:1,whatsapp:1};
function notice(text, isError=false, target='notice') { $(target).textContent = text; $(target).classList.toggle('error', isError); }
async function call(path, opts={}) {
  const init = {...opts, credentials: 'same-origin'};
  if(opts.body) init.headers = {'content-type':'application/json'};
  const r=await fetch(path,init);
  const data=await r.json().catch(()=>({error:'Resposta inválida do servidor'}));
  if(!r.ok) throw new Error(data.error || 'Falha na requisição');
  return data;
}
function view(auth) { $('dashboard').classList.toggle('hidden', !auth); $('login').classList.toggle('hidden', auth); $('logout').classList.toggle('hidden', !auth); document.body.classList.toggle('app-has-sidebar',auth); }
function statusLabel(s){return ({ready:'Na fila',sending:'Enviando',published:'Publicado',needs_review:'Revisar'})[s]||s;}

function applyPlatformView(){
  const isML=selectedPlatform==='mercadolivre',telegram=selectedNetwork==='telegram';
  const groups=['channels-panel','shopee-panel'];
  $('channels-panel').classList.toggle('hidden',!isML||!telegram);
  $('shopee-panel').classList.toggle('hidden',isML);
  document.querySelector('#dashboard > .metric-grid').classList.toggle('hidden',!isML||!telegram);
  document.querySelector('#dashboard > .main-grid').classList.toggle('hidden',!isML||!telegram);
  for(const cls of ['coupon-panel','list-panel','history']){
    document.querySelector('#dashboard > .'+cls).classList.toggle('hidden',!isML||!telegram);
  }
  $('wa-multichannel').classList.toggle('hidden',!isML||telegram);
  $('whatsapp').classList.toggle('hidden',!isML||telegram||currentWaGroupId!==1);
  for(const el of document.querySelectorAll('[data-platform]'))
    el.classList.toggle('active',el.dataset.platform===selectedPlatform);
  for(const el of document.querySelectorAll('[data-network]'))
    el.classList.toggle('active',el.dataset.network===selectedNetwork);
  $('platform-heading').textContent=isML?'Mercado Livre':'Shopee';
  $('platform-description').textContent=isML
    ?'Configure as publicações do Mercado Livre em cada canal ou grupo.'
    :'Escolha Telegram ou WhatsApp e configure onde serão publicadas as ofertas da Shopee.';
}
async function refreshPlatformTargets(){
  let entries=[],selected;
  if(selectedPlatform==='mercadolivre'){
    if(selectedNetwork==='telegram'){
      const data=await call('/api/channels');
      entries=data.channels.map(c=>({id:c.id,name:c.name,category:c.category||'Geral'}));
      selected=currentChannelId;
    }else{
      const data=await call('/api/wa-groups');
      entries=data.groups.map(g=>({id:g.id,name:g.name,category:g.category||'Geral'}));
      selected=currentWaGroupId;
    }
  }else{
    const data=await call('/api/shopee/destinations');
    entries=data.destinations.filter(x=>x.network===selectedNetwork)
      .map(x=>({id:x.target_id,name:x.name,category:x.category,
        configured:x.configured,shopee_enabled:x.shopee_enabled}));
    selected=shopeeTarget[selectedNetwork];
  }
  const select=$('platform-target-select');
  select.innerHTML=entries.map(e=>
    '<option value="'+Number(e.id)+'">'+escape(e.name)+' • '+escape(e.category)+
      (selectedPlatform==='shopee'?(e.shopee_enabled?' • Shopee ativo':e.configured?' • Shopee configurado':' • Novo destino'):'')+
      '</option>').join('');
  if(!entries.some(e=>e.id===selected)){
    selected=entries[0]?.id||1;
    if(selectedPlatform==='shopee')shopeeTarget[selectedNetwork]=selected;
    else if(selectedNetwork==='telegram')currentChannelId=selected;
    else currentWaGroupId=selected;
  }
  select.value=String(selected);
  return entries;
}
async function refreshShopee(){
  if(selectedPlatform!=='shopee')return;
  try{
    const id=shopeeTarget[selectedNetwork];
    const result=await call('/api/shopee/state?network='+encodeURIComponent(selectedNetwork)+'&target_id='+id);
    const base=result.base,settings=result.config;
    $('shopee-target-title').textContent=(selectedNetwork==='telegram'?'Canal Telegram: ':'Grupo WhatsApp: ')+base.name;
    $('channel-label').textContent='Destino Shopee: '+base.name;
    $('shopee-category').value=settings.category||base.category||'Geral';
    $('shopee-interval').value=String(settings.interval_minutes||60);
    $('shopee-max-daily').value=String(settings.max_daily||12);
    $('shopee-start').value=String(settings.start_hour??8);
    $('shopee-end').value=String(settings.end_hour??21);
    $('shopee-permission').checked=!!settings.permission_confirmed;
    $('shopee-enabled').checked=!!settings.enabled;
    $('shopee-status').textContent=settings.enabled?'Shopee ligada':'Shopee desligada';
    $('shopee-base-status').textContent=base.base_enabled&&base.base_registered
      ?'✅ Canal/grupo de origem ativo e autorizado. A publicação Shopee tem um controle separado.'
      :'⚠ Ative e confirme antes o canal/grupo na área Mercado Livre (Telegram ou WhatsApp).';
    const offerCategory=$('shopee-offer-category');
    offerCategory.readOnly=(settings.category||'Geral').toLowerCase()!=='geral';
    offerCategory.value=offerCategory.readOnly?settings.category:'';
    const counts=Object.fromEntries(result.counts.map(x=>[x.status,x.total]));
    $('shopee-offers-rows').innerHTML=result.offers.length?result.offers.map(o=>{
      const action=o.status==='ready'
        ?'<button type="button" class="mini" data-shopee-action="publish" data-id="'+Number(o.id)+'">Publicar</button>'
        :o.status==='needs_review'
          ?'<button type="button" class="mini" data-shopee-action="requeue" data-id="'+Number(o.id)+'">Reenfileirar</button>':'—';
      return '<tr><td><a target="_blank" rel="noopener noreferrer" href="'+escape(o.affiliate_url)+'">'+escape(o.title)+
        '</a>'+(o.last_error?'<small>Revisar: '+escape(o.last_error)+'</small>':'')+
        '</td><td>'+escape(o.category)+'</td><td><span class="tag '+escape(o.status)+'">'+statusLabel(o.status)+
        '</span></td><td>'+action+'</td></tr>';
    }).join(''):'<tr><td colspan="4">Nenhuma oferta Shopee cadastrada para este destino.</td></tr>';
    $('shopee-logs').innerHTML=result.logs.map(x=>'<div><span>'+escape(x.event)+' • '+escape(x.detail||'')+
      '</span><time>'+toDate(x.created_at)+'</time></div>').join('');
  }catch(error){notice('Shopee: '+error.message,true,'shopee-feedback');}
}
async function switchPlatform(platform,network){
  if(platform!=='mercadolivre'&&platform!=='shopee')return;
  selectedPlatform=platform;
  selectedNetwork=network||lastNetwork[platform]||'telegram';
  lastNetwork[platform]=selectedNetwork;
  applyPlatformView();
  try{
    await refreshPlatformTargets();
    if(selectedPlatform==='shopee')await refreshShopee();
  }catch(error){notice('Destinos: '+error.message,true);}
}
async function refreshWhatsAppConnection(showErrors=false){
  try{
    const data=await call('/api/whatsapp/connection');
    const states={
      open:'✅ Número conectado ao WhatsApp.',
      connecting:'Aguardando leitura do QR Code no celular.',
      close:'Instância desconectada. Gere um QR Code para conectar.',
      refused:'Conexão recusada. Gere um novo QR Code.',
      not_created:'Instância ainda não criada. Clique em Conectar WhatsApp.'
    };
    $('wa-connection-state').textContent=states[data.state]||'Configure a Evolution API para começar.';
    $('wa-auto-connect').textContent=data.state==='open'?'WhatsApp conectado':data.exists?'Gerar novo QR Code':'Conectar WhatsApp • Gerar QR Code';
    $('wa-auto-connect').disabled=data.state==='open';
    if(data.state==='open'){
      $('wa-qr-wrap').classList.add('hidden');
      $('wa-qr-image').removeAttribute('src');
    }
    return data;
  }catch(error){
    if(showErrors)notice('Conexão WhatsApp: '+error.message,true,'wa-feedback');
    $('wa-connection-state').textContent='Não foi possível consultar a conexão. '+error.message;
    $('wa-auto-connect').textContent='Tentar conectar novamente';
    $('wa-auto-connect').disabled=false;
    return null;
  }
}
async function refreshWhatsApp(){
  try{
    const d=await call('/api/whatsapp/state');
    $('wa-instance').value='cr-jornada-afiliados';
    $('wa-auto-connect').disabled=!d.server_configured;
    const jid=d.config.group_jid||'';
    const list=$('wa-group');
    if(jid&&!Array.from(list.options).some(o=>o.value===jid)){
      const option=document.createElement('option');option.value=jid;option.textContent='Grupo salvo: '+jid;list.add(option);
    }
    list.value=jid;
    $('wa-registered').checked=!!d.config.public_registered;
    $('wa-enabled').checked=!!d.config.enabled;
    $('wa-interval').value=String(d.schedule?.interval_minutes||60);
    $('wa-category').value=d.category||'Geral';
    $('whatsapp-badge').textContent=d.config.enabled?'WhatsApp ligado':'WhatsApp desligado';
    $('whatsapp-server-status').textContent=d.server_configured?'✅ Endereço e chave Evolution presentes no servidor (autenticação ainda não confirmada).':'⚠ Configure somente EVOLUTION_API_KEY nos Secrets da Cloudflare. O endereço da Evolution já está definido.';
    if(d.server_configured)await refreshWhatsAppConnection();
    else $('wa-connection-state').textContent='⚠ Falta cadastrar o Secret EVOLUTION_API_KEY na Cloudflare.';
    $('wa-test').disabled=!d.config.public_registered||!d.server_configured;
    if(d.config.last_error)notice(d.config.last_error,true,'wa-feedback');
    $('wa-deliveries').innerHTML=d.deliveries.length?d.deliveries.map(x=>
      '<div class="whatsapp-delivery"><div><strong>'+escape(x.title)+'</strong><small>'+escape(x.status==='sent'?'Enviado':x.status==='needs_review'?'Revisar antes de reenviar':'Enviando')+' • '+toDate(x.updated_at)+'</small>'+
      (x.last_error?'<small>'+escape(x.last_error)+'</small>':'')+'</div>'+
      (x.status==='needs_review'?'<button class="mini" data-wa-retry="'+Number(x.offer_id)+'">Reenfileirar</button>':'')+'</div>'
    ).join(''):'<p class="hint">Nenhuma oferta enviada pelo WhatsApp nesta configuração.</p>';
  }catch(error){notice('WhatsApp: '+error.message,true,'wa-feedback');}
}
async function refreshManagedWhatsApp(){
  try{
    const result=await call('/api/wa-groups');
    const list=result.groups||[];
    if(!list.some(x=>x.id===currentWaGroupId))currentWaGroupId=1;
    const selector=$('wa-multi-select');
    selector.innerHTML=list.map(g=>'<option value="'+Number(g.id)+'">'+escape(g.name)+' • '+escape(g.category)+(g.id===1?' (atual)':'')+'</option>').join('');
    selector.value=String(currentWaGroupId);
    const extra=currentWaGroupId!==1;
    $('wa-multi-extra').classList.toggle('hidden',!extra);
    $('whatsapp').classList.toggle('hidden',extra);
    if(!extra)return;
    const result2=await call('/api/wa-groups/'+currentWaGroupId+'/state');
    const g=result2.group;
    $('wa-multi-instance').textContent=(g.instance_mode==='shared'?'Número Evolution principal: ':'Número exclusivo: ')+g.instance_name;
    $('wa-multi-name').value=g.name;
    $('wa-multi-category').value=g.category;
    $('wa-multi-interval').value=String(g.interval_minutes);
    $('wa-multi-daily').value=String(g.max_daily);
    $('wa-multi-start').value=String(g.start_hour);
    $('wa-multi-end').value=String(g.end_hour);
    $('wa-multi-registered').checked=!!g.public_registered;
    $('wa-multi-enabled').checked=!!g.enabled;
    const groupSelect=$('wa-multi-jid');
    if(!Array.from(groupSelect.options).some(o=>o.value===g.group_jid)&&g.group_jid){
      const option=document.createElement('option');
      option.value=g.group_jid;option.textContent='Grupo salvo: '+g.group_jid;
      groupSelect.add(option);
    }
    groupSelect.value=g.group_jid||'';
    const cat=$('wa-multi-offer-category');
    cat.value=g.category==='Geral'?'':g.category;
    cat.readOnly=g.category!=='Geral';
    $('wa-multi-test').disabled=!g.public_registered;
    const coupons=$('wa-multi-coupon-offer');
    coupons.innerHTML='<option value="">Selecione uma oferta...</option>'+result2.offers.filter(o=>o.status==='ready')
      .map(o=>'<option value="'+Number(o.id)+'">'+escape(o.title)+'</option>').join('');
    $('wa-multi-offers').innerHTML=result2.offers.length?result2.offers.map(o=>
      '<tr><td><a target="_blank" rel="noopener noreferrer" href="'+escape(o.affiliate_url)+'">'+escape(o.title)+'</a><small>'+escape(o.category)+'</small>'+
      (o.coupon_code?'<small>Cupom: '+escape(o.coupon_code)+'</small>':'')+
      (o.last_error?'<small>Erro: '+escape(o.last_error)+'</small>':'')+'</td><td>'+escape(statusLabel(o.status))+'</td><td>'+
      (o.status==='ready'?'<button class="mini" type="button" data-wa-group-action="publish" data-id="'+Number(o.id)+'">Publicar</button>':
       o.status==='needs_review'?'<button class="mini" type="button" data-wa-group-action="requeue" data-id="'+Number(o.id)+'">Reenfileirar</button>':'—')+
      '</td></tr>').join(''):'<tr><td colspan="3">Nenhuma oferta cadastrada neste grupo.</td></tr>';
    $('wa-multi-logs').innerHTML=result2.logs.map(x=>'<div><span>'+escape(x.event)+' • '+escape(x.detail||'')+'</span><time>'+toDate(x.created_at)+'</time></div>').join('');
    await refreshManagedWhatsAppConnection(false);
  }catch(err){notice('Grupos WhatsApp: '+err.message,true,'wa-multi-feedback');}
}
async function refreshManagedWhatsAppConnection(showErrors=true){
  if(currentWaGroupId===1)return;
  try{
    const res=await call('/api/wa-groups/'+currentWaGroupId+'/connection');
    const names={open:'✅ WhatsApp conectado.',close:'Número desconectado. Gere o QR Code.',
      connecting:'Aguardando leitura do QR Code.',not_created:'Instância ainda não criada.',refused:'Conexão recusada.'};
    $('wa-multi-connection-state').textContent=names[res.state]||'Verifique a conexão.';
    if(res.state==='open'){
      $('wa-multi-qr-wrap').classList.add('hidden');
      $('wa-multi-qr-image').removeAttribute('src');
    }
    return res;
  }catch(error){
    $('wa-multi-connection-state').textContent='Falha ao consultar conexão: '+error.message;
    if(showErrors)notice(error.message,true,'wa-multi-feedback');
    return null;
  }
}
async function refresh(){
  try{
    const channelList=await call('/api/channels');
    const channels=channelList.channels||[];
    if(!channels.some(c=>c.id===currentChannelId))currentChannelId=1;
    const options=$('channel-select');
    options.innerHTML=channels.map(c=>'<option value="'+Number(c.id)+'">'+escape(c.name)+' • '+escape(c.telegram_chat_id)+(c.id===1?' (atual)':'')+'</option>').join('');
    options.value=String(currentChannelId);
    const data=await call(currentChannelId===1?'/api/state':'/api/channels/'+currentChannelId+'/state');
    view(true);
    const s=data.settings;
    $('telegram_chat_id').value=s.telegram_chat_id||'';
    const isExtra=currentChannelId!==1;
    $('channel-extra-settings').classList.toggle('hidden',!isExtra);
    $('channel-primary-category').classList.toggle('hidden',isExtra);
    if(!isExtra)$('primary-channel-category').value=s.category||'Geral';
    if(isExtra){
      $('channel-name').value=s.name||'';
      $('channel-category').value=s.category||'Geral';
      $('channel-bot-mode').value=s.bot_mode||'shared';
      $('channel-bot-token-wrap').classList.toggle('hidden',s.bot_mode!=='dedicated');
      $('channel-bot-token').value='';
    }
    const categoryInput=$('offer-form').elements.category;
    if(s.category&&s.category.toLowerCase()!=='geral'){
      categoryInput.value=s.category;
      categoryInput.readOnly=true;
    }else{
      categoryInput.readOnly=false;
      if(categoryInput.value&&isExtra)categoryInput.value='';
    }
    $('channel-label').textContent='Destino Telegram: '+(s.telegram_chat_id||'não configurado');
    for(const k of ['channel_registered','telegram_enabled','automation_enabled']) $(k).checked=!!s[k];
    for(const k of ['interval_minutes','max_daily','start_hour','end_hour']) $(k).value=s[k];
    $('top-status').textContent=s.automation_enabled?'Robô ligado':'Robô desligado';
    $('token-state').textContent=currentChannelId===1
      ?(data.telegram_token_configured?'✓ Bot principal configurado no servidor.':'⚠ Falta configurar TELEGRAM_BOT_TOKEN no servidor.')
      :(s.bot_mode==='shared'
        ?(data.telegram_token_configured?'✓ Usando o bot principal.':'⚠ O bot principal ainda não tem token.')
        :(data.telegram_token_configured?'✓ Token exclusivo criptografado e disponível.':'⚠ Cadastre o token exclusivo do BotFather.'));
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
    await refreshManagedWhatsApp();
    await refreshPlatformTargets();
    applyPlatformView();
    if(selectedPlatform==='shopee')await refreshShopee();
  }catch(e){ if(e.message.includes('login')){view(false);$('top-status').textContent='Aguardando login';}else notice(e.message,true); }
}
for(let h=0;h<=24;h++){
  const label=String(h).padStart(2,'0')+':00';
  if(h<24) $('start_hour').insertAdjacentHTML('beforeend','<option value="'+h+'">'+label+'</option>');
  if(h>0) $('end_hour').insertAdjacentHTML('beforeend','<option value="'+h+'">'+label+'</option>');
}
for(let h=0;h<=24;h++){
 const label=String(h).padStart(2,'0')+':00';
 if(h<24)$('wa-multi-start').insertAdjacentHTML('beforeend','<option value="'+h+'">'+label+'</option>');
 if(h>0)$('wa-multi-end').insertAdjacentHTML('beforeend','<option value="'+h+'">'+label+'</option>');
}
for(let h=0;h<=24;h++){
 const label=String(h).padStart(2,'0')+':00';
 if(h<24)$('shopee-start').insertAdjacentHTML('beforeend','<option value="'+h+'">'+label+'</option>');
 if(h>0)$('shopee-end').insertAdjacentHTML('beforeend','<option value="'+h+'">'+label+'</option>');
}
$('wa-multi-select').addEventListener('change',async()=>{
 currentWaGroupId=Number($('wa-multi-select').value)||1;
 notice('',false,'wa-multi-feedback');
 await refreshManagedWhatsApp();
});
$('wa-multi-create-toggle').addEventListener('click',()=>{
 $('wa-multi-create').classList.toggle('hidden');
});
$('wa-multi-create-cancel').addEventListener('click',()=>{
 $('wa-multi-create').classList.add('hidden');
});
$('wa-multi-create-form').addEventListener('submit',async e=>{
 e.preventDefault();
 const body=Object.fromEntries(new FormData(e.target));
 try{
   const result=await call('/api/wa-groups',{method:'POST',body:JSON.stringify(body)});
   currentWaGroupId=result.id;
   $('wa-multi-create').classList.add('hidden');
   e.target.reset();
   await refreshManagedWhatsApp();
   notice('Grupo criado desligado! Conecte o número, escolha o grupo e confirme a autorização.',false,'wa-multi-feedback');
 }catch(error){notice(error.message,true,'wa-multi-feedback');}
});
$('wa-multi-connect').addEventListener('click',async()=>{
 if(currentWaGroupId===1)return;
 const btn=$('wa-multi-connect');btn.disabled=true;btn.textContent='Verificando...';
 try{
   const res=await call('/api/wa-groups/'+currentWaGroupId+'/connection',{method:'POST',body:'{}'});
   if(res.qr_image){
     $('wa-multi-qr-image').src=res.qr_image;
     $('wa-multi-qr-wrap').classList.remove('hidden');
     notice('QR Code pronto. Conecte seu número exclusivo.',false,'wa-multi-feedback');
   }else if(res.state==='open'){
     $('wa-multi-qr-wrap').classList.add('hidden');
     notice('Número já conectado à Evolution.',false,'wa-multi-feedback');
   }else notice('Instância preparada. Se o QR não aparecer, clique novamente.',true,'wa-multi-feedback');
   await refreshManagedWhatsAppConnection();
 }catch(error){notice(error.message,true,'wa-multi-feedback');}
 finally{btn.disabled=false;btn.textContent='Verificar / Gerar QR Code';}
});
$('wa-multi-groups').addEventListener('click',async()=>{
 if(currentWaGroupId===1)return;
 const btn=$('wa-multi-groups');btn.disabled=true;
 try{
   const result=await call('/api/wa-groups/'+currentWaGroupId+'/options');
   const current=$('wa-multi-jid').value;
   const sel=$('wa-multi-jid');
   sel.innerHTML='<option value="">Selecione um grupo público...</option>'+result.groups.map(g=>
      '<option value="'+escape(g.id)+'">'+escape(g.name)+'</option>').join('');
   if(result.groups.some(g=>g.id===current))sel.value=current;
   notice(result.groups.length+' grupos encontrados. Escolha um grupo autorizado.',false,'wa-multi-feedback');
 }catch(err){notice(err.message,true,'wa-multi-feedback');}
 finally{btn.disabled=false;}
});
$('wa-multi-settings-form').addEventListener('submit',async e=>{
 e.preventDefault();if(currentWaGroupId===1)return;
 const body={
   name:$('wa-multi-name').value,category:$('wa-multi-category').value,
   group_jid:$('wa-multi-jid').value,interval_minutes:Number($('wa-multi-interval').value),
   max_daily:Number($('wa-multi-daily').value),start_hour:Number($('wa-multi-start').value),
   end_hour:Number($('wa-multi-end').value),enabled:$('wa-multi-enabled').checked,
   public_registered:$('wa-multi-registered').checked
 };
 try{
   const result=await call('/api/wa-groups/'+currentWaGroupId+'/settings',{method:'POST',body:JSON.stringify(body)});
   await refreshManagedWhatsApp();
   notice(result.group_changed?'Grupo selecionado. Por segurança, confirme o cadastro público e ative novamente.':'Configurações exclusivas do grupo salvas.',false,'wa-multi-feedback');
 }catch(error){notice(error.message,true,'wa-multi-feedback');}
});
$('wa-multi-test').addEventListener('click',async()=>{
 if(currentWaGroupId===1||!confirm('Enviar AGORA uma mensagem de teste para este grupo de WhatsApp?'))return;
 try{
   await call('/api/wa-groups/'+currentWaGroupId+'/test',{method:'POST',body:'{}'});
   notice('Teste enviado ao grupo.',false,'wa-multi-feedback');
 }catch(error){notice(error.message,true,'wa-multi-feedback');}
});
$('wa-multi-offer-form').addEventListener('submit',async e=>{
 e.preventDefault();if(currentWaGroupId===1)return;
 const body=Object.fromEntries(new FormData(e.target));
 body.owner_confirmation=e.target.elements.owner_confirmation.checked;
 try{
   await call('/api/wa-groups/'+currentWaGroupId+'/offers',{method:'POST',body:JSON.stringify(body)});
   e.target.reset();
   await refreshManagedWhatsApp();
   notice('Oferta adicionada à fila somente deste grupo.',false,'wa-multi-feedback');
 }catch(error){notice(error.message,true,'wa-multi-feedback');}
});
$('wa-multi-coupon-kind').addEventListener('change',()=>{
 const isCode=$('wa-multi-coupon-kind').value==='code';
 $('wa-multi-coupon-code').required=isCode;
 $('wa-multi-coupon-code').disabled=!isCode;
});
$('wa-multi-coupon-kind').dispatchEvent(new Event('change'));
$('wa-multi-coupon-form').elements.discount_type.addEventListener('change',()=>{
 const v=$('wa-multi-coupon-form').elements.discount_type.value==='fixed';
 const input=$('wa-multi-coupon-form').elements.discount_value;
 input.step=v?'0.01':'1';input.min=v?'0.01':'1';
});
$('wa-multi-coupon-form').addEventListener('submit',async e=>{
 e.preventDefault();if(currentWaGroupId===1)return;
 const body=Object.fromEntries(new FormData(e.target));
 body.owner_confirmation=e.target.elements.owner_confirmation.checked;
 try{
   await call('/api/wa-groups/'+currentWaGroupId+'/coupons',{method:'POST',body:JSON.stringify(body)});
   await refreshManagedWhatsApp();
   notice('Cupom vinculado à oferta deste grupo.',false,'wa-multi-feedback');
 }catch(error){notice(error.message,true,'wa-multi-feedback');}
});
$('wa-multi-offers').addEventListener('click',async e=>{
 const button=e.target.closest('button[data-wa-group-action]');if(!button||currentWaGroupId===1)return;
 const action=button.dataset.waGroupAction,id=Number(button.dataset.id);
 const prompt=action==='publish'?'Publicar esta oferta AGORA somente no grupo selecionado?':'Verifique antes se a oferta não foi recebida no grupo. Reenfileirar pode duplicá-la. Continuar?';
 if(!confirm(prompt))return;
 try{
   const result=await call('/api/wa-groups/'+currentWaGroupId+'/offers/'+id+'/'+action,{method:'POST',body:'{}'});
   await refreshManagedWhatsApp();
   notice(action==='publish'?'Oferta publicada neste grupo.':'Oferta liberada para o próximo ciclo.',false,'wa-multi-feedback');
 }catch(error){notice(error.message,true,'wa-multi-feedback');}
});
setInterval(()=>{
 if(!$('dashboard').classList.contains('hidden')&&currentWaGroupId!==1&&!$('wa-multi-qr-wrap').classList.contains('hidden'))
   refreshManagedWhatsAppConnection(false);
},12000);

for(const button of document.querySelectorAll('[data-platform]')){
  button.addEventListener('click',()=>switchPlatform(button.dataset.platform));
}
for(const button of document.querySelectorAll('[data-network]')){
  button.addEventListener('click',()=>switchPlatform(selectedPlatform,button.dataset.network));
}
$('platform-target-select').addEventListener('change',async()=>{
  const id=Number($('platform-target-select').value)||1;
  if(selectedPlatform==='shopee'){
    shopeeTarget[selectedNetwork]=id;
    await refreshShopee();
  }else if(selectedNetwork==='telegram'){
    currentChannelId=id;
    await refresh();
  }else{
    currentWaGroupId=id;
    await refreshManagedWhatsApp();
    applyPlatformView();
  }
});
$('shopee-settings-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const body={network:selectedNetwork,target_id:shopeeTarget[selectedNetwork],
    category:$('shopee-category').value.trim(),interval_minutes:Number($('shopee-interval').value),
    max_daily:Number($('shopee-max-daily').value),start_hour:Number($('shopee-start').value),
    end_hour:Number($('shopee-end').value),permission_confirmed:$('shopee-permission').checked,
    enabled:$('shopee-enabled').checked};
  try{
    await call('/api/shopee/settings',{method:'POST',body:JSON.stringify(body)});
    notice('Configuração Shopee deste destino salva. O Mercado Livre não foi alterado.',false,'shopee-feedback');
    await refreshShopee();
    await refreshPlatformTargets();
  }catch(error){notice(error.message,true,'shopee-feedback');}
});
$('shopee-offer-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target));
  body.owner_confirmation=e.target.elements.owner_confirmation.checked;
  body.network=selectedNetwork;
  body.target_id=shopeeTarget[selectedNetwork];
  try{
    await call('/api/shopee/offers',{method:'POST',body:JSON.stringify(body)});
    e.target.reset();
    notice('Link Shopee cadastrado na fila exclusiva deste destino.',false,'shopee-feedback');
    await refreshShopee();
  }catch(error){notice(error.message,true,'shopee-feedback');}
});
$('shopee-offers-rows').addEventListener('click',async e=>{
  const button=e.target.closest('button[data-shopee-action]');
  if(!button)return;
  const action=button.dataset.shopeeAction,id=Number(button.dataset.id);
  const message=action==='publish'
    ?'Publicar AGORA esta oferta Shopee neste canal/grupo?'
    :'Confira no canal/grupo se a oferta não foi recebida antes de liberar outra tentativa. Continuar?';
  if(!confirm(message))return;
  try{
    await call('/api/shopee/offers/'+id+'/'+action,{method:'POST',
      body:JSON.stringify({network:selectedNetwork,target_id:shopeeTarget[selectedNetwork]})});
    notice(action==='publish'?'Publicação Shopee confirmada.':'Oferta reenfileirada após conferência.',false,'shopee-feedback');
    await refreshShopee();
  }catch(error){notice(error.message,true,'shopee-feedback');await refreshShopee();}
});
$('shopee-refresh').addEventListener('click',refreshShopee);
$('channel-select').addEventListener('change',async()=>{
  currentChannelId=Number($('channel-select').value)||1;
  notice('');
  await refresh();
});
$('channel-create-toggle').addEventListener('click',()=>{
  $('channel-creation').classList.toggle('hidden');
});
$('channel-create-cancel').addEventListener('click',()=>{
  $('channel-creation').classList.add('hidden');
});
$('new-channel-bot-mode').addEventListener('change',()=>{
  $('new-channel-bot-wrap').classList.toggle('hidden',$('new-channel-bot-mode').value!=='dedicated');
});
$('channel-bot-mode').addEventListener('change',()=>{
  $('channel-bot-token-wrap').classList.toggle('hidden',$('channel-bot-mode').value!=='dedicated');
});
$('channel-create-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target));
  if(body.bot_mode!=='dedicated')delete body.bot_token;
  try{
    const result=await call('/api/channels',{method:'POST',body:JSON.stringify(body)});
    currentChannelId=result.id;
    e.target.reset();
    $('new-channel-bot-wrap').classList.add('hidden');
    $('channel-creation').classList.add('hidden');
    await refresh();
    notice('Canal criado e selecionado! Adicione seu bot, confirme o cadastro público e habilite as publicações quando estiver pronto.');
  }catch(error){notice(error.message,true,'channel-create-feedback');}
});
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();notice('',false,'login-error');
  try{ await call('/api/login',{method:'POST',body:JSON.stringify({password:$('password').value})});$('password').value='';await refresh();}
  catch(err){notice(err.message,true,'login-error');}
});
$('logout').addEventListener('click',async()=>{try{await call('/api/logout',{method:'POST',body:'{}'})}catch{}view(false);});
$('settings-form').addEventListener('submit',async e=>{
  e.preventDefault();const body={telegram_chat_id:$('telegram_chat_id').value};for(const k of ['channel_registered','telegram_enabled','automation_enabled']) body[k]=$(k).checked;
  for(const k of ['interval_minutes','max_daily','start_hour','end_hour']) body[k]=Number($(k).value);
  if(currentChannelId!==1){
    body.name=$('channel-name').value;
    body.category=$('channel-category').value;
    body.bot_mode=$('channel-bot-mode').value;
    if($('channel-bot-token').value.trim())body.bot_token=$('channel-bot-token').value.trim();
  }else body.category=$('primary-channel-category').value.trim();
  try{const saved=await call(currentChannelId===1?'/api/settings':'/api/channels/'+currentChannelId+'/settings',{method:'POST',body:JSON.stringify(body)});notice(saved.channel_changed?'Novo canal salvo e validado. Publicações pausadas: confirme o cadastro do canal no Mercado Livre, marque Canal registrado e permitido, habilite Telegram e salve novamente.':'Configurações salvas.');await refresh();}
  catch(err){notice(err.message,true);}
});
$('offer-form').addEventListener('submit',async e=>{
  e.preventDefault();const data=Object.fromEntries(new FormData(e.target));data.owner_confirmation=$('offer-form').elements.owner_confirmation.checked;
  try{
    const endpoint=currentChannelId===1?'/api/offers':'/api/channels/'+currentChannelId+'/offers';
    await call(endpoint,{method:'POST',body:JSON.stringify(data)});
    e.target.reset();notice('Oferta cadastrada somente na fila do canal selecionado.');await refresh();
  }
  catch(err){notice(err.message,true);}
});
$('wa-auto-connect').addEventListener('click',async()=>{
  const b=$('wa-auto-connect');b.disabled=true;b.textContent='Preparando QR Code...';
  try {
    const result=await call('/api/whatsapp/auto-connect',{method:'POST',body:'{}'});
    if(result.state==='open'){
      $('wa-qr-wrap').classList.add('hidden');
      notice('WhatsApp já conectado à instância cr-jornada-afiliados. Não foi criada outra.',false,'wa-feedback');
    }else if(result.qr_image){
      $('wa-qr-image').src=result.qr_image;
      $('wa-qr-wrap').classList.remove('hidden');
      notice('QR Code pronto! Leia com o número exclusivo do CR Jornada Afiliados.',false,'wa-feedback');
    }else{
      $('wa-qr-wrap').classList.add('hidden');
      notice('Instância encontrada/criada, mas o QR ainda não está pronto. Clique em Gerar novo QR Code.',true,'wa-feedback');
    }
    await refreshWhatsApp();
  }catch(error){notice(error.message,true,'wa-feedback');}
  finally{
    const state=await refreshWhatsAppConnection();
    if(state?.state!=='open'){
      b.disabled=false;
      if(!state)b.textContent='Tentar conectar novamente';
    }
  }
});
setInterval(()=>{
  if(!$('dashboard').classList.contains('hidden')&&!$('wa-qr-wrap').classList.contains('hidden'))
    refreshWhatsAppConnection();
},12000);
$('wa-groups').addEventListener('click',async()=>{
  const b=$('wa-groups');b.disabled=true;b.textContent='Consultando...';
  try{
    const name='cr-jornada-afiliados';
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
      public_registered:$('wa-registered').checked,enabled:$('wa-enabled').checked,
      interval_minutes:Number($('wa-interval').value),category:$('wa-category').value.trim()
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
    await call(currentChannelId===1?'/api/coupons':'/api/channels/'+currentChannelId+'/coupons',{method:'POST',body:JSON.stringify(body)});
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
    const result=await call(currentChannelId===1?'/api/test-telegram':'/api/channels/'+currentChannelId+'/test',{method:'POST',body:'{}'});
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
  try{const endpoint=currentChannelId===1?'/api/offers/'+id+'/'+type:'/api/channels/'+currentChannelId+'/offers/'+id+'/'+type;const result=await call(endpoint,{method:'POST',body:'{}'});notice(type==='publish'?(result.format==='photo'?'Oferta publicada com FOTO no Telegram.':'Oferta publicada em texto: foto indisponível ou não aceita pelo Telegram.'):'Oferta reenfileirada.');await refresh();}
  catch(err){notice(err.message,true);await refresh();}
});
$('refresh').addEventListener('click',refresh);
refresh();
`;
