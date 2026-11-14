import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage, CLIENT_JS, CSS } from '../src/ui.js';

test('Automação e conexão de afiliado têm abas próprias no menu lateral', () => {
  const html=renderPage();
  assert.match(html,/data-panel="automation"/);
  assert.match(html,/data-panel="affiliate"/);
  assert.match(html,/id="automation-page"/);
  assert.match(html,/id="affiliate-page"/);
  assert.match(html,/Estado: não conectada/);
  assert.match(html,/id="auto-wa-extra-settings"/);
  assert.match(html,/id="auto-telegram-settings"/);
});

test('Formulários existentes continuam responsáveis pelos salvamentos após reagrupamento',()=>{
  assert.match(CLIENT_JS,/mountAutomationPanels/);
  assert.match(CLIENT_JS,/input\.setAttribute\('form',formId\)/);
  assert.match(CLIENT_JS,/input\.setAttribute\('form','settings-form'\)/);
  assert.match(CLIENT_JS,/move\('#shopee-content','auto-shopee-offers'\)/);
  assert.match(CLIENT_JS,/move\('#wa-direct-card','auto-wa-offers'\)/);
  assert.match(CLIENT_JS,/moveLabel\('wa-enabled','whatsapp-form'/);
  assert.match(CLIENT_JS,/moveLabel\('wa-multi-enabled','wa-multi-settings-form'/);
  assert.match(CLIENT_JS,/selectedPage==='automation'/);
  assert.match(CLIENT_JS,/refreshPlatformTargets\(\)/);
  assert.match(CSS,/#auto-telegram-controls/);
  assert.doesNotThrow(()=>new Function(CLIENT_JS));
});
