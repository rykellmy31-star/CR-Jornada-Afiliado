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

- Busca automática de produtos do catálogo: **Radar preparado via API oficial /products/search e OAuth**, a ser autorizado pelo proprietário na Cloudflare. Os resultados são sugestões, não ofertas verificadas.
- Geração automática de novos links de afiliado: **não disponível**; depende de método autorizado pelo Mercado Livre. Produtos pesquisados jamais são publicados como links afiliados até cadastro da URL oficial.
- WhatsApp: ainda não há disparos; o grupo de convite não é prova de elegibilidade de canal público.
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

O robô tenta obter a imagem divulgada nos metadados públicos (`og:image` ou `twitter:image`) da página correspondente ao próprio link de afiliado `meli.la` / `mercadolivre.com.br`. Redirecionamentos ficam restritos a domínios oficiais; as imagens aceitas têm origem na CDN oficial `http2.mlstatic.com`. O bot tenta o método `sendPhoto` com a legenda e mantém exatamente o link de afiliado no botão.

Caso a página não exponha imagem pública, ou a foto seja recusada explicitamente pela API do Telegram, a oferta será enviada como texto contendo o link, permitindo a prévia automática quando disponível. Em falha ambígua de rede o registro fica em revisão para evitar duplicidade. **A alteração vale para as próximas ofertas**, não edita publicações antigas. Não há nova migração D1 nem segredos adicionais.


## Cupons vinculados às ofertas (integração segura)

No painel, você pode vincular um cupom oficialmente informado/confirmado a uma oferta ainda na fila, com código ou ativação, tipo/valor de desconto, mínimo do carrinho, teto, vigência e fonte oficial. Nas próximas publicações, o robô inclui automaticamente a descrição do cupom enquanto estiver dentro da validade informada. Após o vencimento, publica a oferta sem aquele cupom. O link de afiliado, a imagem e o agendamento permanecem funcionando. Não calcula nem promete preço final no checkout.

O Worker cria automaticamente a tabela isolada offer_coupons no mesmo D1, com CREATE TABLE IF NOT EXISTS. Não execute novamente o SQL inicial e não modifique os bancos de outros projetos.

Limite atual: não há fonte/API oficialmente autorizada para que um afiliado comum pesquise todos os novos cupons e teste sua aplicação por CPF. Por isso, esta versão não extrai cupons por robôs do site do Mercado Livre, não executa compra e não afirma elegibilidade. A API SELLER_COUPON_CAMPAIGN documentada pelo Mercado Livre é voltada a vendedores. Para descobrir novos cupons sem cadastrar manualmente será necessária uma integração oficialmente autorizada.

## Troca de grupo para canal Telegram

Abra **Automação** no painel e cole o link público do novo canal em **Canal público do Telegram**. Salve as configurações. A primeira gravação muda o destino mas **desliga automaticamente a publicação**, por segurança. Garanta que o bot `@Crjornadabot` foi adicionado ao canal como administrador com permissão de publicar. Verifique o cadastro desse canal na Central do Afiliado. Marque **Canal registrado e permitido** somente quando isso for verdadeiro, ative **Habilitar publicação no Telegram**, salve novamente, envie **Testar Telegram** e só depois reative a automação. As ofertas já publicadas no grupo antigo não são reenviadas automaticamente ao canal novo. Não precisa alterar D1 nem renovar os Secrets.

## Canal oficial configurado em 13/11/2026

Endereço público informado: https://t.me/achadinhosmlcr (canal **ACHADINHOS ML (CR)**). A primeira consulta ao banco D1 feita pela nova versão migra **somente** o destino armazenado `@achadinhosml1101` para `@achadinhosmlcr` e desliga publicação/automação, exigindo nova confirmação do canal na Central de Afiliados do Mercado Livre. Não são apagados produtos, filas, cupons ou histórico. O token do BotFather e a base D1 não precisam ser recriados. A integração deve ser testada no painel após adicionar @Crjornadabot como administrador do canal, com permissão de publicar. Se o destino no banco já for diferente, a migração não o sobrescreve.


## Radar automático de produtos do catálogo

O Radar pesquisa periodicamente palavras-chave no catálogo oficial via API documentada; organiza os resultados e evita duplicações. Não faz scraping, não calcula descontos e nunca publica sugestões como se já fossem links de afiliado. Para transformar uma sugestão em anúncio, abra o produto, gere o link oficial na Central do Afiliado e cadastre na fila.

### Conectar o Mercado Livre (OAuth)

1. Crie um aplicativo autorizado no DevCenter do Mercado Livre com leitura e offline_access, quando disponíveis. A API de catálogo é voltada a vendedores e pode ser negada à conta de afiliado.
2. Configure no aplicativo a URL Redirect URI mostrada no painel Radar; termina em `/api/discovery/callback` e precisa corresponder exatamente ao endereço do Worker.
3. Na Cloudflare, salve três Secrets: `MELI_APP_ID` (APP ID), `MELI_APP_SECRET` (Secret Key) e `MELI_TOKEN_KEY` (32 bytes aleatórios em Base64).
4. No painel, clique em "Conectar Mercado Livre (OAuth)" e autorize no site oficial. Os tokens de acesso e renovação são guardados criptografados com AES-GCM no D1. Guarde sua chave MELI_TOKEN_KEY.
5. Defina até 12 palavras-chave, intervalo de 1 a 6 horas e ative "Pesquisar automaticamente".
6. Abra "Produtos encontrados", consulte o produto e gere o link de afiliado. Clique em "Criar oferta" para preencher título/categoria e então informe o link oficial. Os resultados do catálogo não são considerados promoções de preço verificado.

Em caso de erro de autorização ou permissão, o Radar será pausado sem interferir nas publicações existentes do Telegram.

### Isolamento e segurança

O Radar cria somente as tabelas `discovery_settings`, `discovered_products`, `discovery_oauth` e `discovery_oauth_states` no D1 já existente. O histórico, os cupons, as ofertas, as senhas, o token do Telegram e o destino `@achadinhosmlcr` são preservados. OAuth tem state aleatório de uso único e expiração de 10 minutos; tokens ficam criptografados. A renovação de tokens ocorre automaticamente quando o Mercado Livre autoriza o aplicativo.

Fontes: https://developers.mercadolivre.com.br/buscador-de-produtos ; https://developers.mercadolivre.com.br/autenticacao-e-autorizacao ; https://developers.mercadolivre.com.br/pt_br/termos-e-condicoes ; https://www.mercadolivre.com.br/l/afiliados-gere-seus-links


## Radar sem aplicativo do Mercado Livre — Google Alertas (RSS)

Existe agora uma segunda modalidade no **Radar de Produtos**, usando feeds RSS do [Google Alertas](https://www.google.com/alerts). Não exige conta de desenvolvedor, Client ID ou chaves do Mercado Livre. A alternativa OAuth original continua disponível opcionalmente.

Para criar o feed RSS:
1. Entre em https://www.google.com/alerts e faça login na sua conta Google.
2. Crie um alerta com uma consulta como `site:mercadolivre.com.br/p/ "fone bluetooth"`. Também pode usar outras palavras ou termos OR, conforme o Google Alertas aceitar.
3. Em "Mostrar opções", selecione Brasil, idioma português e "Entregar para" → Feed RSS. Se RSS estiver indisponível, verifique as configurações de resumo/horário de entrega e a frequência "Quando disponível".
4. Crie o alerta e clique no ícone RSS ao lado do alerta para copiar a URL que começa com `https://www.google.com/alerts/feeds/`.
5. No Radar, cole o endereço em **Google Alertas RSS**, salve, selecione a frequência e ative **Pesquisar automaticamente**. Teste em **Pesquisar agora**. O sistema só registra sugestões de páginas de produtos do Mercado Livre que o Google encontrar.

O RSS não descobre ofertas em tempo real, não verifica cupons e preços, nem gera links de afiliado. Feeds novos podem estar vazios por algum tempo. As sugestões **nunca** entram na fila de publicações automaticamente; o link oficial comissionado precisa ser cadastrado separadamente. O sistema nunca transforma um link comum do produto em link de afiliado, evitando a falsa promessa de comissão.

Segurança: a URL RSS deve corresponder ao formato de Google Alertas, consultas externas seguem apenas esse domínio e não seguem redirecionamentos, links extraídos devem apontar para produtos MLB em domínios permitidos, deduplicação por hash de URL, e limite de 30 resultados por feed. A alternativa OAuth permanece isolada. Sem novas variáveis secretas e sem execução manual de migração.
