import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_JS, renderPage } from '../src/ui.js';

test('JavaScript do painel multicanal compila para uso no navegador',()=>{
  assert.doesNotThrow(()=>new Function(CLIENT_JS));
});

test('todos os controles novos do painel multicanal estão presentes no HTML',()=>{
  const page=renderPage();
  for(const id of [
    'channels-panel','channel-select','channel-create-toggle','channel-creation',
    'channel-create-form','channel-create-cancel','new-channel-bot-mode','new-channel-bot-wrap',
    'channel-extra-settings','channel-name','channel-category','channel-bot-mode',
    'channel-bot-token-wrap','channel-bot-token','telegram_chat_id','offer-form','coupon-form',
    'offers-rows','settings-form','whatsapp-form'
  ])assert.ok(page.includes('id="'+id+'"'),'Campo ausente: '+id);
});

test('interface compartilha o contexto de canal entre configurações, ofertas, cupons e histórico',()=>{
  assert.match(CLIENT_JS,/let currentChannelId=1;/);
  assert.match(CLIENT_JS,/\/api\/channels\/'\+currentChannelId\+'\/state/);
  assert.match(CLIENT_JS,/\/api\/channels\/'\+currentChannelId\+'\/offers/);
  assert.match(CLIENT_JS,/\/api\/channels\/'\+currentChannelId\+'\/coupons/);
  assert.match(CLIENT_JS,/\/api\/channels\/'\+currentChannelId\+'\/test/);
  assert.match(CLIENT_JS,/bot_token/);
});

test('painel mobile conserva escala sem zoom por pinça ou foco de campos',()=>{
  const html=renderPage();
  assert.match(html,/name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/);
  assert.match(CLIENT_JS,/document\.addEventListener\('gesturestart'/);
  assert.match(CLIENT_JS,/document\.addEventListener\('gesturechange'/);
  assert.match(CLIENT_JS,/event\.touches\.length>1/);
  assert.match(CLIENT_JS,/passive:false/);
});
