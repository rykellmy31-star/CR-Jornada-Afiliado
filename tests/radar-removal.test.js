import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage, CSS, CLIENT_JS } from '../src/ui.js';
import worker from '../src/index.js';

test('Radar retirado do painel e do JavaScript sem afetar ofertas e cupons', () => {
  const page=renderPage();
  for(const removed of ['radar', 'Google Alertas', 'OAuth', '/api/discovery/']) {
    assert.doesNotMatch(page,new RegExp(removed,'i'));
    assert.doesNotMatch(CLIENT_JS,new RegExp(removed,'i'));
  }
  assert.doesNotMatch(CSS,/radar/i);
  for(const preserved of ['id="offer-form"','id="coupon-form"','id="settings-form"','id="offers-rows"']) {
    assert.ok(page.includes(preserved), 'Deve preservar '+preserved);
  }
});

test('Agendador mantém publicações Telegram, WhatsApp e canais extras sem Radar externo', async () => {
  const jobs=[];
  await worker.scheduled({}, {DB:null}, {waitUntil:job=>jobs.push(job)});
  assert.equal(jobs.length,3);
  await Promise.all(jobs);
});
