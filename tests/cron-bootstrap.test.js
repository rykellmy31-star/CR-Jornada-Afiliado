import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readMasterForScheduled,recordTelegramCronOutcome} from '../src/index.js';

test('Cron lê apenas o estado mestre e não inicializa categorias antes da publicação',async()=>{
 const queries=[];
 const env={DB:{prepare(sql){
  queries.push(sql);
  if(sql.startsWith('CREATE')||sql.includes('affiliate_group_categories'))
   throw Error('A rotina de categorias não pode bloquear a publicação');
  assert.equal(sql,'SELECT enabled FROM automation_master WHERE id=1');
  return {first:async()=>({enabled:1})};
 }}};
 assert.deepEqual(await readMasterForScheduled(env),{enabled:true});
 assert.deepEqual(queries,['SELECT enabled FROM automation_master WHERE id=1']);
});

test('Cron respeita robô explicitamente desligado',async()=>{
 const env={DB:{prepare:()=>({first:async()=>({enabled:0})})}};
 assert.deepEqual(await readMasterForScheduled(env),{enabled:false});
});

test('Cron mantém compatibilidade com instalação sem tabela mestre',async()=>{
 const env={DB:{prepare:()=>({first:async()=>{throw Error('D1_ERROR: no such table: automation_master: SQLITE_ERROR');}})}};
 assert.deepEqual(await readMasterForScheduled(env),{enabled:null});
});

test('Erro de banco diferente de tabela ausente não liga o robô sem confirmação',async()=>{
 const env={DB:{prepare:()=>({first:async()=>{throw Error('database unavailable');}})}};
 await assert.rejects(()=>readMasterForScheduled(env),/database unavailable/);
});

test('último resultado automático é persistido sem interromper o publicador',async()=>{
 const params=[];
 const env={DB:{prepare(sql){
  if(sql.startsWith('CREATE TABLE'))return {run:async()=>({})};
  return {bind(...values){params.push(values);return {run:async()=>({})};}};
 }}};
 await recordTelegramCronOutcome(env,{skipped:'interval_or_schedule'});
 assert.equal(params.length,1);
 assert.equal(params[0][1],'interval_or_schedule');
 assert.equal(params[0][2],'');
});

test('Cron usa leitura leve antes do publicador manual e conserva intervalos',()=>{
 const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const scheduled=source.slice(source.indexOf('async scheduled('));
 assert.match(scheduled,/const master=readMasterForScheduled\\(env\\)/);
 assert.match(scheduled,/const telegramPublished=start\\(runScheduled,'Telegram'\\)/);
 assert.match(source,/shouldSend\\(settings,now,total,latest/);
 assert.doesNotMatch(scheduled,/const master=env.DB\\?masterState/);
});