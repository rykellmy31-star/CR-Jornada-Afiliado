import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPage,CSS,CLIENT_JS} from '../src/ui.js';

test('A navegação tem Telegram, WhatsApp, Cupons, Automação e conexão lateral',()=>{
  const html=renderPage();
  for(const id of ['automation-tab','coupons-tab','affiliate-page','automation-network-select',
    'ml-wa-automation-panel','auto-wa-form','ml-wa-automation-history']){
    assert.ok(html.includes('id="'+id+'"'),id+' deve existir no painel');
  }
  assert.match(html,/data-panel="affiliate"/);
  assert.match(html,/id="affiliate-page" class="card history hidden"/);
  assert.match(html,/Gerador de Links/);
});

test('Automação tem regras distintas de visibilidade para cada plataforma',()=>{
  assert.match(CSS,/data-view="mercadolivre-automation"/);
  assert.match(CSS,/data-view="shopee-automation"/);
  assert.match(CSS,/data-view="affiliate"/);
  assert.match(CSS,/shopee-queue-heading/);
  assert.match(CLIENT_JS,/selectedTab===['"]automation['"]/);
  assert.match(CLIENT_JS,/automation-tab/);
  assert.match(CLIENT_JS,/automation-network-select/);
  assert.match(CLIENT_JS,/auto-wa-form/);
});

test('Conexão de Afiliado não solicita cookies, senha ou sessão autenticada',()=>{
  const html=renderPage();
  const section=html.slice(html.indexOf('id="affiliate-page"'),html.indexOf('id="platform-context"'));
  assert.ok(section.includes('mercadolivre.com.br/l/afiliados-gere-seus-links'));
  assert.doesNotMatch(section,/<input/i);
  assert.doesNotMatch(section,/data-session|auth-cookie|cookie-value/i);
});

test('Fila WhatsApp existente é reaproveitada na aba Automação',()=>{
  assert.match(CLIENT_JS,/ml-wa-automation-history/);
  assert.match(CLIENT_JS,/appendChild\(waHistory\)/);
  assert.match(CSS,/mercadolivre-whatsapp[^\n]+#wa-direct-card/);
});

test('Grupos adicionais mantêm seus cadastros e controles em Automação',()=>{
  const html=renderPage();
  for(const id of ['auto-wa-multi','auto-wa-multi-select','auto-wa-multi-settings-form',
    'auto-wa-multi-interval','auto-wa-multi-daily','auto-wa-multi-start','auto-wa-multi-end',
    'auto-wa-multi-offer-content','wa-multi-queue-table']){
    assert.ok(html.includes('id="'+id+'"'),id+' precisa estar disponível');
  }
  assert.match(CLIENT_JS,/appendChild\(element\)/);
  assert.match(CLIENT_JS,/auto-wa-multi-settings-form/);
  assert.match(CLIENT_JS,/refreshManagedWhatsApp\(\)/);
});

test('Credenciais Shopee somente na aba lateral de conexão',()=>{
  assert.match(CSS,/#dashboard:not\(\[data-view="affiliate"\]\) > #shopee-account-panel/);
  assert.match(CLIENT_JS,/selectedPage!=='affiliate'\|\|isML/);
});
test('Automação WhatsApp não regrava os campos ocultos da conexão',()=>{
  assert.match(CLIENT_JS,/\/api\/whatsapp\/automation/);
  const x=CLIENT_JS.slice(CLIENT_JS.indexOf("auto-wa-form').addEventListener"),CLIENT_JS.indexOf("coupons-tab').addEventListener"));
  assert.doesNotMatch(x,/group_jid|instance_name|public_registered|category:/);
});
