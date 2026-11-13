import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { renderPage, CLIENT_JS } from '../src/ui.js';
import { shouldSend } from '../src/logic.js';
import worker from '../src/index.js';

function mockDB(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  return {
    prepare(sql){
      let params=[];
      return {
        bind(...values){params=values;return this;},
        first(){return db.prepare(sql).get(...params)||null;},
        all(){return {results:db.prepare(sql).all(...params)};},
        run(){const r=db.prepare(sql).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
      };
    },
    close(){db.close();}
  };
}

test('painel mostra campos numéricos editáveis para Telegram e WhatsApp, sem opções fixas',()=>{
  const html=renderPage();
  assert.match(html,/<input id="interval_minutes" type="number" inputmode="numeric" min="1" max="1440" step="1"/);
  assert.match(html,/<input id="wa-interval" type="number" inputmode="numeric" min="1" max="1440" step="1"/);
  assert.doesNotMatch(html,/<select id="interval_minutes"/);
  assert.doesNotMatch(html,/<select id="wa-interval"/);
  assert.match(CLIENT_JS,/\$\('wa-interval'\)\.value=String\(d\.schedule\?\.interval_minutes\|\|60\)/);
});

test('Cloudflare cron executa a cada minuto para honrar intervalos não múltiplos de cinco',()=>{
  const config=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8');
  assert.match(config,/crons = \["\* \* \* \* \*"\]/);
});

test('Telegram respeita o intervalo digitado: 7, 20 ou 45 minutos',()=>{
  const now=new Date('2026-11-13T12:00:00Z');
  const s={automation_enabled:1,telegram_enabled:1,channel_registered:1,
    start_hour:0,end_hour:24,max_daily:48,interval_minutes:20};
  assert.equal(shouldSend(s,now,1,now.getTime()-19*60000),false);
  assert.equal(shouldSend(s,now,1,now.getTime()-20*60000),true);
  assert.equal(shouldSend({...s,interval_minutes:7},now,1,now.getTime()-6*60000),false);
  assert.equal(shouldSend({...s,interval_minutes:7},now,1,now.getTime()-7*60000),true);
  assert.equal(shouldSend({...s,interval_minutes:45},now,1,now.getTime()-44*60000),false);
});

test('API de configurações do Telegram aceita minutos personalizados e rejeita valores inválidos',async()=>{
  const DB=mockDB();
  const ORIGIN='https://afiliados.example.test';
  const env={DB,ADMIN_PASSWORD:'senha_super_forte_123',SESSION_SECRET:'segredo_de_32_caracteres_para_teste'};
  const request=(path,body,cookie)=>{
    const headers={'content-type':'application/json',origin:ORIGIN};
    if(cookie)headers.cookie=cookie;
    return new Request(ORIGIN+path,{method:'POST',headers,body:JSON.stringify(body)});
  };
  try{
    const login=await worker.fetch(request('/api/login',{password:env.ADMIN_PASSWORD}),env);
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const settings={telegram_chat_id:'@achadinhosmlcr',channel_registered:false,telegram_enabled:false,
      automation_enabled:false,interval_minutes:20,max_daily:12,start_hour:8,end_hour:21};
    for(const interval of [1,7,20,45,1440]){
      const response=await worker.fetch(request('/api/settings',{...settings,interval_minutes:interval},cookie),env);
      assert.equal(response.status,200,'Telegram should accept '+interval);
      assert.equal(DB.prepare('SELECT interval_minutes FROM settings WHERE id=1').first().interval_minutes,interval);
    }
    for(const interval of [0,-1,1441,1.5,'',null]){
      const response=await worker.fetch(request('/api/settings',{...settings,interval_minutes:interval},cookie),env);
      assert.equal(response.status,400,'Telegram should reject '+String(interval));
      assert.equal(DB.prepare('SELECT interval_minutes FROM settings WHERE id=1').first().interval_minutes,1440);
    }
  }finally{DB.close();}
});
