# CR Jornada Afiliados — MVP Telegram

Projeto novo, independente e preparado para Cloudflare Workers + D1. **Não foi publicado em produção.**

## O que já está implementado

- Painel adaptado a computador e celular, com senha administrativa e sessão assinada por HMAC, cookie HttpOnly/SameSite=Strict.
- Cadastro de produtos com link de afiliado gerado previamente na Central de Afiliados.
- Exigência de confirmação expressa de origem do link. Validação sintática de domínios; não afirma verificar comissão automaticamente.
- Fila de ofertas (cada URL uma publicação), deduplicação, registro de histórico e estado `needs_review` quando há falha ambígua.
- Configurações de janela 8h–21h (Bahia), intervalo padrão 30 minutos e até 12 posts por dia; tudo editável.
- Cron Trigger a cada 5 minutos, respeitando intervalo, janela e limite diário. Publicação **desligada por padrão**.
- Telegram Bot API: publicação no canal configurado, com foto do produto quando metadados públicos e imagem compatível estão disponíveis, com legenda, aviso de publicidade e botão de compra. Quando a foto não está acessível, publica o texto com URL e prévia quando o Telegram conseguir gerá-la; não repete envio em falha ambígua. O teste de conexão continua sendo somente texto.
- Preço manual opcional. Se informado há mais de 6 horas, não é anunciado como preço atual.

## O que não está implementado (não confundir com sistema em produção)

- Busca automática de produtos: removida a pedido do proprietário; o robô continua publicando somente ofertas cadastradas com links oficiais de afiliado.
- Geração automática de novos links de afiliado: **não disponível**; depende de método autorizado pelo Mercado Livre. Produtos pesquisados jamais são publicados como links afiliados até cadastro da URL oficial.
- WhatsApp: integração opcional Evolution API v2 para espelhar novas ofertas já publicadas no Telegram em um grupo público cadastrado na Central de Afiliados. Desligada por padrão e depende de credenciais autorizadas.
- Sincronização automática de preços e estoque. O painel somente usa preços digitados, com a proteção de exibição após 6h.
- Foto garantida para todo link: a busca de imagem depende de metadados públicos do produto e da disponibilidade da imagem na CDN, sem autenticação, scraping de páginas privadas ou contorno de bloqueios.
- Relatórios reais de comissões: estes são consultados na Central de Afiliados do Mercado Livre.

## Identificadores pré-configurados

- Perfil de afiliado exibido: `rykellmy_007` (não é autenticação).
- Destino Telegram: configurável pelo painel como canal público (`https://t.me/seucanal` ou `@seucanal`). O endereço antigo `@achadinhosml1101` correspondia a um grupo; é necessário apontar para o novo canal e dar permissão de publicação ao `@Crjornadabot`.
- Link de exemplo do próprio usuário: `https://meli.la/2bsHW5y` (não vem pré-cadastrado/ativado).

## Instalação e publicação em conta Cloudflare autorizada

Requisitos: Node.js 20+, acesso à sua conta Cloudflare e token do BotFather guardado **fora do código**.

1. Descompactar e executar `npm install`.
2. Fazer `npx wrangler login` (autenticação ocorre com você, pelo navegador).
3. Criar **um novo banco separado**, sem tocar nos bancos de outros sistemas: `npx wrangler d1 create cr-jornada-afiliados-db`.
4. Copiar o `database_id` retornado para o `wrangler.toml`, substituindo `SUBSTITUIR_PELO_ID_DO_D1`.
5. Executar `npx wrangler d1 migrations apply cr-jornada-afiliados-db --remote`.
6. Configurar os três segredos via CLI (cada comando solicitará o valor sem gravá-lo no código):
   - `npx wrangler secret put ADMIN_PASSWORD` (crie senha forte, única)
   - `npx wrangler secret put SESSION_SECRET` (gere string aleatória com 32+ bytes)
   - `npx wrangler secret put TELEGRAM_BOT_TOKEN` (token do `@Crjornadabot`)
7. Publicar: `npx wrangler deploy`.
8. Abrir a URL Worker retornada; entrar com ADMIN_PASSWORD.
9. Confirmar que o grupo @achadinhosml1101 está **cadastrado na Central do Afiliado e permitido** para essa conta. Se não estiver, **não habilitar a publicação**.
10. Informar o novo canal público do Telegram no painel e salvar. A mudança pausa o envio, limpa a confirmação anterior e exige nova confirmação de canal cadastrado no programa de afiliados. Confirmar as permissões de administrador do bot no novo canal, marcar "Canal registrado e permitido", ativar Telegram, salvar e pressionar "Testar Telegram".
11. Cadastrar os links que você mesmo gerou no Portal de Afiliados, ativar Telegram e depois a automação.

> Proteção adicional recomendada em produção: restringir o acesso à URL do painel via Cloudflare Access e configurar regras de limite de tentativas de login (WAF). O login incluído não substitui esses controles.
>
> O bot não recebe senhas nem tokens enviados via conversa. Configure-os diretamente no seu Cloudflare.

## Teste sem contas externas

`npm test` — usa SQLite local em memória e simula a resposta da API Telegram. **Não envia mensagem real** e não acessa contas Cloudflare/Mercado Livre. Para conferir a interface localmente, após criar o D1 e colocar os segredos no arquivo `.dev.vars` (nunca versionado), execute `npx wrangler d1 migrations apply cr-jornada-afiliados-db --local` e `npm run dev`.

## Segurança e políticas

- O destino de publicação é um canal público configurável pelo proprietário no painel; o Worker consulta `getChat` e rejeita grupos. A mudança de destino pausa automaticamente a publicação e exige nova confirmação. Não realiza disparos em massa a números privados.
- Cada oferta exige confirmação do proprietário de que o link foi gerado oficialmente; essa confirmação não garante receita nem converte URL comum em URL de afiliado.
- Não automatizar logins/captchas, não capturar credenciais, não burlar o Mercado Livre ou o WhatsApp.
- Divulgação tem de obedecer às regras vigentes do programa, inclusive identificação clara como publicidade e uso apenas de canais públicos cadastrados.
- Se uma requisição ao Telegram falhar de maneira ambígua, a oferta entra em "Revisar". **Confira primeiro se já saiu no grupo** antes de reenfileirar para não duplicar.

Referências oficiais:
- Mercado Livre — Checklist: https://www.mercadolivre.com.br/l/checklist
- Mercado Livre — Onde compartilhar links: https://www.mercadolivre.com.br/l/afiliados-onde-compartilhar-links
- Mercado Livre — Gerar links: https://www.mercadolivre.com.br/l/afiliados-gere-seus-links
- Telegram Bot API: https://core.telegram.org/bots/api
- Cloudflare Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare D1 Migrations: https://developers.cloudflare.com/d1/reference/migrations/

## Imagens automáticas no Telegram

O robô tenta obter a imagem divulgada nos metadados públicos (`og:image` ou `twitter:image`) da página correspondente ao próprio link de afiliado `meli.la` / `mercadolivre.com.br`. A partir desta melhoria, ele reconstrói somente variantes da mesma foto identificada pela CDN, priorizando a versão oficial `-F.jpg` de maior resolução, depois a original disponível e, por último, uma versão intermediária. Antes do envio, confirma por HTTPS que a URL retorna JPEG ou PNG dentro do limite de 5 MB aceito por URL pelo Telegram. Quando a CDN não permite HEAD, tenta uma verificação GET parcial. Não cria detalhes artificiais nem promete qualidade superior à foto original do vendedor. Redirecionamentos ficam restritos a domínios oficiais; as imagens aceitas têm origem na CDN oficial `http2.mlstatic.com`. O bot tenta o método `sendPhoto` com a legenda e mantém exatamente o link de afiliado no botão.

Caso a página não exponha imagem pública, ou a foto seja recusada explicitamente pela API do Telegram, a oferta será enviada como texto contendo o link, permitindo a prévia automática quando disponível. Em falha ambígua de rede o registro fica em revisão para evitar duplicidade. **A alteração vale para as próximas ofertas**, não edita publicações antigas. Não há nova migração D1 nem segredos adicionais.


## Cupons vinculados às ofertas (integração segura)

No painel, você pode vincular um cupom oficialmente informado/confirmado a uma oferta ainda na fila, com código ou ativação, tipo/valor de desconto, mínimo do carrinho, teto, vigência e fonte oficial. Nas próximas publicações, o robô inclui automaticamente a descrição do cupom enquanto estiver dentro da validade informada. Após o vencimento, publica a oferta sem aquele cupom. O link de afiliado, a imagem e o agendamento permanecem funcionando. Não calcula nem promete preço final no checkout.

O Worker cria automaticamente a tabela isolada offer_coupons no mesmo D1, com CREATE TABLE IF NOT EXISTS. Não execute novamente o SQL inicial e não modifique os bancos de outros projetos.

Limite atual: não há fonte/API oficialmente autorizada para que um afiliado comum pesquise todos os novos cupons e teste sua aplicação por CPF. Por isso, esta versão não extrai cupons por robôs do site do Mercado Livre, não executa compra e não afirma elegibilidade. A API SELLER_COUPON_CAMPAIGN documentada pelo Mercado Livre é voltada a vendedores. Para descobrir novos cupons sem cadastrar manualmente será necessária uma integração oficialmente autorizada.

## Troca de grupo para canal Telegram

Abra **Automação** no painel e cole o link público do novo canal em **Canal público do Telegram**. Salve as configurações. A primeira gravação muda o destino mas **desliga automaticamente a publicação**, por segurança. Garanta que o bot `@Crjornadabot` foi adicionado ao canal como administrador com permissão de publicar. Verifique o cadastro desse canal na Central do Afiliado. Marque **Canal registrado e permitido** somente quando isso for verdadeiro, ative **Habilitar publicação no Telegram**, salve novamente, envie **Testar Telegram** e só depois reative a automação. As ofertas já publicadas no grupo antigo não são reenviadas automaticamente ao canal novo. Não precisa alterar D1 nem renovar os Secrets.

## Canal oficial configurado em 13/11/2026

Endereço público informado: https://t.me/achadinhosmlcr (canal **ACHADINHOS ML (CR)**). A primeira consulta ao banco D1 feita pela nova versão migra **somente** o destino armazenado `@achadinhosml1101` para `@achadinhosmlcr` e desliga publicação/automação, exigindo nova confirmação do canal na Central de Afiliados do Mercado Livre. Não são apagados produtos, filas, cupons ou histórico. O token do BotFather e a base D1 não precisam ser recriados. A integração deve ser testada no painel após adicionar @Crjornadabot como administrador do canal, com permissão de publicar. Se o destino no banco já for diferente, a migração não o sobrescreve.


## Remoção do Radar de Produtos (13/11/2026)

O Radar de Produtos e suas modalidades Google Alertas (RSS) e API de catálogo foram retirados do painel, da API e do agendamento automático. Os dados antigos do Radar permanecem nas tabelas históricas do D1, sem consultas ou escrita pela versão atual. **Não apague as tabelas, a fila de ofertas, os cupons nem os dados do Telegram.** O Cron de 5 minutos foi mantido exclusivamente para as publicações da fila previamente autorizadas.

Quando a aplicação oficial do Mercado Livre estiver disponível, uma nova integração poderá ser desenvolvida separadamente, sem reativar o Radar antigo.


## WhatsApp com sua Evolution API (opcional)

O painel tem agora a área **WhatsApp • Evolution API**, independente do Telegram. O Worker utiliza a variável pública `EVOLUTION_API_URL = https://evolution.crjornada.com` definida no `wrangler.toml` (não use `/manager/`). Configure apenas o Secret `EVOLUTION_API_KEY` (chave de sua instalação Evolution API v2). Esses segredos não devem ser enviados pelo chat nem colocados no repositório.

No painel do CR Jornada Afiliados, clique em **Conectar WhatsApp • Gerar QR Code**. O servidor verifica a lista de instâncias, cria **somente se estiver ausente** a instância exclusiva `cr-jornada-afiliados` com `WHATSAPP-BAILEYS`, e mostra o QR Code retornado pela Evolution API. Não precisa criar ou digitar nomes manualmente. Leia o QR no WhatsApp do número exclusivo em **Aparelhos conectados → Conectar um aparelho**. O sistema acompanha o estado da conexão. Se o QR expirar ou não chegar, use **Gerar novo QR Code**; a instância existente é reutilizada e nunca excluída. Depois de conectar, clique **Buscar meus grupos**, escolha seu grupo público aberto e cadastrado como mídia na Central do Mercado Livre, salve e depois confirme a autorização e ative. Mudanças de instância ou grupo exigem reconfirmação e não disparam posts antigos. O link de convite `chat.whatsapp.com/...` não substitui o ID do grupo (`@g.us`). Botão **Enviar teste ao grupo** exige clique e confirmação explícita. A configuração é criada automaticamente em tabelas separadas `whatsapp_settings` e `whatsapp_deliveries` sem mudar os demais dados.

Após ativar, uma execução agendada a cada 5 minutos copia **somente novas ofertas publicadas no Telegram após a ativação**, uma por ciclo, com legenda de publicidade, link original do afiliado, cupons elegíveis e foto oficial do produto quando disponível. Nada é enviado a contatos privados. O envio pelo WhatsApp tem controle próprio de deduplicação. Falha ou resposta ambígua fica em **Revisar** e exige verificação do grupo e ação manual antes de nova tentativa. O envio do Telegram é independente.

**Cuidados:** Evolution API via WhatsApp Web é não oficial e pode causar restrições na conta. O Mercado Livre proíbe divulgação para grupos fechados e mídias não declaradas; a confirmação do usuário não garante comissões. Não use para disparos em massa, listas privadas nem grupos sem consentimento. Fontes: https://www.mercadolivre.com.br/l/afiliados-onde-compartilhar-links e https://docs.evoapicloud.com/api-reference/group-controller/fetch-all-groups.

O endpoint para consultar grupos utiliza `GET /group/fetchAllGroups/{instance}?getParticipants=false`, sem baixar participantes, conforme a documentação da Evolution API. A chave de API deve permanecer no Secret da Cloudflare, nunca no código nem em mensagens.


### Segurança da criação automática

O QR Code só pode ser solicitado após login no painel administrativo. O endpoint de criação utiliza a chave global `EVOLUTION_API_KEY` guardada no Secret do Worker, que **nunca é devolvida ao navegador**. Só podem ser criadas instâncias com o nome fixo `cr-jornada-afiliados`; antes de criar, a API consulta as existentes e falha de forma segura se não puder confirmar o resultado. As outras instâncias da VPS não sofrem alteração. Criar ou conectar não ativa o disparo de mensagens, não escolhe grupos e não altera o Telegram.

A API de instâncias utilizada é a Evolution API v2: `GET /instance/fetchInstances`, `POST /instance/create`, `GET /instance/connect/cr-jornada-afiliados` e `GET /instance/connectionState/cr-jornada-afiliados`. A leitura de QR é local ao WhatsApp; a API devolve base64 de imagem, não é usada nenhuma API externa de geração de QR.


### Falha de autenticação ao gerar QR Code

Se aparecer HTTP 401/403 ao consultar `/instance/fetchInstances`, isso não significa que o QR esteja quebrado: o Worker reconheceu que existe um Secret, mas a Evolution API recusou a credencial fornecida. Em **Cloudflare → Workers & Pages → cr-jornada-afiliados → Settings → Variables and Secrets**, confira se `EVOLUTION_API_KEY` contém a **API Key Global** usada na tela de login do Evolution Manager, correspondente a `AUTHENTICATION_API_KEY` do servidor. Não use a API key individual de uma instância. A URL é `https://evolution.crjornada.com` sem `/manager/`. Salve o Secret e clique em **Tentar conectar novamente**. Nunca envie a chave em prints, chats ou repositórios. O indicador de chave presente não comprova a validade.


### Intervalos independentes de Telegram e WhatsApp

Telegram e WhatsApp têm **campos numéricos livres para digitar de 1 a 1440 minutos** (por exemplo: 7, 20, 45, 90). O padrão do WhatsApp é 60 minutos e o Telegram mantém o valor que já estava salvo. A Cloudflare verifica ambos os serviços **a cada minuto**, mas respeita o intervalo independente de cada plataforma. No WhatsApp, o intervalo conta a partir da última tentativa de envio. A reserva do intervalo no WhatsApp é atômica para evitar disparos simultâneos em ciclos concorrentes. Ele continua compartilhando somente novas ofertas já publicadas no Telegram após a ativação; sem oferta elegível, não envia nada. Falha ambígua continua exigindo revisão manual.

Os intervalos personalizados do WhatsApp são salvos na nova tabela aditiva `whatsapp_schedule_custom`, criada com `CREATE TABLE IF NOT EXISTS` no banco D1 existente. A tabela antiga `whatsapp_schedule`, que restringia os valores, é preservada; o novo registro importa a configuração e o último envio existentes sem sobrescrever as alterações posteriores. Nenhuma tabela é apagada, e os dados de ofertas, cupons, WhatsApp, Telegram e instâncias existentes permanecem preservados. Alterar apenas o intervalo do WhatsApp não muda configurações do Telegram.


### Intervalo livre (13/11/2026)

Os menus com tempos fixos foram substituídos por caixas numéricas editáveis para **ambas** as plataformas, de 1 a 1440 minutos, somente inteiros. Basta apagar o número anterior, digitar o desejado (ex.: 20) e salvar as configurações correspondentes. Valores vazios, decimais, negativos e maiores que 1440 são rejeitados. Para cumprir intervalos de 1, 7 ou 20 minutos sem arredondar a blocos de cinco, o Cron do Worker executa a cada minuto; portanto o envio ocorre no primeiro ciclo permitido, sujeito ao processamento da plataforma e da fila. No Telegram seguem valendo a janela e a quantidade máxima diária; o WhatsApp só publica ofertas já enviadas no Telegram depois de ativado. Intervalos muito curtos no WhatsApp aumentam o risco de restrições do serviço.


## Central multicanal Telegram — preservação de dados existentes

O painel passa a permitir **vários canais públicos do Telegram**, cada um com seu próprio nome, categoria de ofertas, bot, intervalo em minutos, limite diário, janela horária (Bahia), fila de ofertas, cupons e histórico. É possível criar cinco canais ou mais, conforme a capacidade operacional. Para selecionar um canal, use **Central multicanal do Telegram**. Clique em **Adicionar canal** para configurar nome, @canal, categoria e bot. Os novos canais sempre iniciam **desligados** e só publicam após confirmação da mídia cadastrada na Central de Afiliados, bot administrador e ativação explícita. O canal principal existente permanece como **Canal principal**, com seus dados e configurações intactos; todas as rotas anteriores continuam válidas.

**Bots:** escolha **Usar bot principal** para compartilhar o token de seu bot atual sem compartilhamento de filas, ou **Bot exclusivo** para informar um token BotFather específico daquele canal. Os tokens exclusivos são verificados na API oficial do Telegram (getMe) e criptografados com AES-GCM antes do armazenamento D1; a chave criptográfica é derivada do SESSION_SECRET existente, que não deve ser trocado sem procedimento de migração. Tokens nunca são devolvidos à interface ou registrados em logs. Alterar o bot ou endereço desliga a publicação do respectivo canal e exige nova confirmação. Para ativar, o bot deve ser administrador do canal público com direito de publicar.

**Ofertas distintas:** uma oferta cadastrada em um canal entra somente naquela fila, respeitando a categoria configurada. Links repetidos entre canais são rejeitados. Cada novo canal tem a própria contagem, tempo mínimo de publicação, máximo diário e histórico; a publicação automática roda no Cron existente. Cupons com origem e datas confirmadas funcionam também nos novos canais. Mensagens de resultado ambíguo ficam em revisão e só podem ser reenfileiradas manualmente após conferência, para evitar duplicidade.

**Migração não destrutiva:** são criadas apenas as tabelas adicionais telegram_channels, channel_offers, channel_offer_coupons e channel_logs mediante CREATE TABLE IF NOT EXISTS; nenhuma tabela preexistente é recriada, limpa ou excluída. O canal e as ofertas anteriores continuam em settings, offers, offer_coupons e logs e são administrados pelo canal virtual de ID 1. A integração WhatsApp atual continua espelhando somente as publicações do canal principal — não publica automaticamente as filas dos canais adicionais.

**Limitação atual:** a ferramenta é de **gestão multicanal e publicação automática de ofertas previamente cadastradas**. A busca automática de produtos no Mercado Livre e a criação automática de links com comissão dependem da aplicação oficial do Mercado Livre e de credenciais autorizadas, que ainda não estão disponíveis. O recurso antigo Radar de Produtos continua removido.


## Central multigrupos do WhatsApp e categorias por destino

A central do WhatsApp agora administra **vários grupos**, com **categoria, horários, intervalo em minutos, limite diário, fila de ofertas, cupons e histórico próprios**, sem interferir nas publicações do Telegram. Use o painel **Central multigrupos do WhatsApp** para adicionar grupo, nomeá-lo (Motos, Feminino, Masculino, Infantil, Peças etc.) e escolher entre **usar o número Evolution já conectado** ou **conectar número exclusivo via QR Code**. Para um número exclusivo, o sistema cria somente quando necessário a instância `cr-jornada-grupo-N` (N = ID do grupo), sem modificar as demais instâncias da VPS. O administrador seleciona somente grupos realmente ligados àquela instância, confirma que são grupos públicos e declarados no programa de afiliados e autoriza cada publicação. **Todos os grupos novos iniciam desligados** e não recebem automaticamente mensagens antigas.

O grupo principal permanece na área antiga **WhatsApp • Evolution API** e mantém o envio das ofertas do Telegram principal. Ele também recebe um novo **campo de categoria**, salvo em tabela complementar e aplicado como filtro sem apagar configurações históricas. A categoria do Telegram principal agora é configurável em sua área de automação e aplica-se à inclusão de ofertas e aos envios (manuais e agendados). Os canais Telegram extras já têm categoria individual configurável. **Geral** é uma categoria curinga, enquanto outra categoria só aceita ofertas com o mesmo nome (sem distinção de maiúsculas/minúsculas); o usuário informa manualmente a categoria ao cadastrar cada oferta, pois a pesquisa/classificação automática de produtos do Mercado Livre ainda depende da integração oficial.

As ofertas dos **novos grupos WhatsApp** são colocadas diretamente na fila daquele grupo, com o link oficial gerado pelo usuário; não dependem de ser publicadas primeiro no Telegram. O envio usa a mesma Evolution API, respeita horários, intervalo, máximo diário e há proteção contra concorrência, duplicação de links entre grupos e envio em grupos errados. Se a API não confirmar o envio, a oferta fica em revisão, exigindo verificação humana antes do reenfileiramento. Há proteção adicional de intervalo mínimo de 60 segundos por instância compartilhada, inclusive quando grupos diferentes têm intervalos próprios. A integração Evolution é não oficial e pode sofrer bloqueios; intervalos muito curtos e grande quantidade de grupos aumentam o risco.

A migração é estritamente aditiva: as tabelas novas `whatsapp_groups`, `whatsapp_group_offers`, `whatsapp_group_coupons`, `whatsapp_group_logs`, `whatsapp_instance_pacing`, `whatsapp_primary_category` e `primary_channel_category` são criadas por `CREATE TABLE IF NOT EXISTS`. Não apague nem recrie banco D1, ofertas, filas, tokens de bots, cupons ou instâncias existentes. A busca de produtos/links afiliados via API do Mercado Livre continua pendente de autorização da aplicação oficial.

Regras oficiais consultadas: https://www.mercadolivre.com.br/l/afiliados-compartilhamento-de-publicacao — somente canais ou grupos públicos/abertos, cadastrados como mídia pelo afiliado.
