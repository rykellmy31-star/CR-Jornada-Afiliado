import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_JS, renderPage } from '../src/ui.js';

const NAV_KEY = 'cr-jornada-afiliados:navegacao:v1';
const SCROLL_KEY = 'cr-jornada-afiliados:rolagem:v1';
const stateStart = CLIENT_JS.indexOf('let currentChannelId=1;');
const stateEnd = CLIENT_JS.indexOf('let shoAccountState=null;');
assert.ok(stateStart !== -1 && stateEnd > stateStart);
const stateSource = CLIENT_JS.slice(stateStart, stateEnd);

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key,value) => map.set(key,String(value)),
    removeItem: key => map.delete(key)
  };
}

function openPage(sessionStorage) {
  const callbacks = new Map();
  const scrolled = [];
  const window = {
    scrollY:0,
    addEventListener: (event,fn) => callbacks.set(event,fn),
    scrollTo: (x,y) => scrolled.push([x,y])
  };
  const run = new Function('sessionStorage','window','requestAnimationFrame',
    stateSource + [
      'return {',
      'snapshot: () => ({platform:selectedPlatform,network:selectedNetwork,lastNetwork:{...lastNetwork},channelId:currentChannelId,whatsappGroupId:currentWaGroupId,shopeeTelegram:shopeeTarget.telegram,shopeeWhatsApp:shopeeTarget.whatsapp}),',
      'choose: (platform,network,channel,group,shopeeTelegram,shopeeWhatsApp) => { selectedPlatform=platform;selectedNetwork=network;lastNetwork[platform]=network;currentChannelId=channel;currentWaGroupId=group;shopeeTarget.telegram=shopeeTelegram;shopeeTarget.whatsapp=shopeeWhatsApp; },',
      'rememberNavigation,restoreScrollAfterRefresh',
      '};'
    ].join('\n'));
  return {...run(sessionStorage,window,fn=>fn()),callbacks,window,scrolled};
}

test('F5 restaura Shopee, WhatsApp, destino e preferências das outras abas',()=>{
  const storage=memoryStorage();
  const first=openPage(storage);
  first.choose('shopee','whatsapp',3,6,1002,1005);
  first.rememberNavigation();
  const second=openPage(storage);
  assert.deepEqual(second.snapshot(),{
    platform:'shopee',network:'whatsapp',
    lastNetwork:{mercadolivre:'telegram',shopee:'whatsapp'},
    channelId:3,whatsappGroupId:6,shopeeTelegram:1002,shopeeWhatsApp:1005
  });
});

test('F5 restaura o canal e grupo do Mercado Livre',()=>{
  const storage=memoryStorage();
  const first=openPage(storage);
  first.choose('mercadolivre','whatsapp',4,9,null,null);
  first.rememberNavigation();
  assert.equal(openPage(storage).snapshot().whatsappGroupId,9);
  assert.equal(openPage(storage).snapshot().network,'whatsapp');
  assert.equal(openPage(storage).snapshot().channelId,4);
});

test('dados de navegação inválidos ou armazenamento indisponível não quebram o painel',()=>{
  const storage=memoryStorage();
  storage.setItem(NAV_KEY,JSON.stringify({
    platform:'site-desconhecido',network:'invalido',
    lastNetwork:{mercadolivre:'invalido'},
    channelId:-5,whatsappGroupId:'invalido',shopeeTelegram:1,shopeeWhatsApp:0
  }));
  assert.deepEqual(openPage(storage).snapshot(),{
    platform:'mercadolivre',network:'telegram',
    lastNetwork:{mercadolivre:'telegram',shopee:'telegram'},
    channelId:1,whatsappGroupId:1,shopeeTelegram:null,shopeeWhatsApp:null
  });
  const broken={
    getItem(){throw new Error('Storage bloqueado');},
    setItem(){throw new Error('Storage bloqueado');},
    removeItem(){throw new Error('Storage bloqueado');}
  };
  const page=openPage(broken);
  assert.equal(page.snapshot().platform,'mercadolivre');
  assert.doesNotThrow(()=>page.rememberNavigation());
});

test('recarregar restaura a rolagem depois que os elementos retornam',()=>{
  const storage=memoryStorage();
  const oldPage=openPage(storage);
  oldPage.window.scrollY=840;
  oldPage.callbacks.get('pagehide')();
  assert.equal(storage.getItem(SCROLL_KEY),'840');
  const reloaded=openPage(storage);
  reloaded.restoreScrollAfterRefresh();
  assert.deepEqual(reloaded.scrolled,[[0,840]]);
  assert.equal(storage.getItem(SCROLL_KEY),null);
  reloaded.restoreScrollAfterRefresh();
  assert.equal(reloaded.scrolled.length,1);
});

test('esconde login e painel até validar sessão e carregar a aba',()=>{
  assert.doesNotThrow(()=>new Function(CLIENT_JS));
  const html=renderPage();
  assert.match(html, /id="initial-loading"/);
  assert.match(html, /id="login" class="login card hidden" hidden/);
  assert.match(html, /id="dashboard" class="hidden" hidden/);
  const refreshSection=CLIENT_JS.slice(
    CLIENT_JS.indexOf('async function refresh(){'),
    CLIENT_JS.indexOf('for(let h=0;h<=24;h++)')
  );
  assert.ok(refreshSection.indexOf('applyPlatformView();') < refreshSection.indexOf('view(true);'));
  assert.match(refreshSection,/if\(e\.status===401\)/);
  assert.match(CLIENT_JS,/err\.status=r\.status/);
  assert.match(CLIENT_JS,/rememberNavigation\(\)/);
});
