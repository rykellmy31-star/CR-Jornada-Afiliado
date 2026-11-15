import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPage,CLIENT_JS,CSS} from '../src/ui.js';

function calculator(){
 const start=CLIENT_JS.indexOf('function calculateTelegramDailyCapacity(');
 const stop=CLIENT_JS.indexOf('function updateTelegramCapacity()',start);
 assert.ok(start>=0&&stop>start,'função da calculadora presente no cliente');
 return new Function(CLIENT_JS.slice(start,stop)+'\nreturn calculateTelegramDailyCapacity;')();
}
test('calculadora aparece dentro da automação do Telegram e é acessível no celular',()=>{
 const html=renderPage();
 const form=html.indexOf('id="settings-form"');
 const card=html.indexOf('id="telegram-capacity"');
 const closing=html.indexOf('</form>',form);
 assert.ok(form>=0&&card>form&&card<closing);
 for(const id of ['telegram-capacity','telegram-capacity-count','telegram-capacity-detail'])
  assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(html,/Calculadora de publicações em tempo real/);
 assert.match(CSS,/\.telegram-capacity\{/);
 assert.match(CLIENT_JS,/addEventListener\('input',updateTelegramCapacity\)/);
 assert.match(CLIENT_JS,/addEventListener\('change',updateTelegramCapacity\)/);
 assert.match(CLIENT_JS,/for\(const k of \['interval_minutes','max_daily','start_hour','end_hour'\]\) \$\(k\)\.value=s\[k\];\s*updateTelegramCapacity\(\)/);
 assert.doesNotThrow(()=>new Function(CLIENT_JS));
});
test('08 às 21 com intervalo de 30 minutos precisa de 26 links (21:00 não publica)',()=>{
 const calc=calculator();
 const c=calc(8,21,30,48);
 assert.equal(c.windowMinutes,780);
 assert.equal(c.possibleSlots,26);
 assert.equal(c.linksNeeded,26);
 assert.equal(c.limitedByDaily,false);
});
test('alterando horários, intervalos e máximo diário calcula sem arredondar abaixo',()=>{
 const calc=calculator();
 assert.equal(calc(8,21,60,48).linksNeeded,13);
 assert.equal(calc(8,21,45,48).linksNeeded,18);
 assert.equal(calc(8,21,1,48).linksNeeded,48);
 assert.equal(calc(8,21,30,12).linksNeeded,12);
 assert.equal(calc(8,9,30,48).linksNeeded,2);
 assert.equal(calc(0,24,1440,48).linksNeeded,1);
 assert.equal(calc(8,21,1440,48).linksNeeded,1);
 assert.equal(calc(8,21,31,48).linksNeeded,26);
 assert.equal(calc(8,21,1,48).limitedByDaily,true);
});
test('horários e limites inválidos não exibem quantidades incorretas',()=>{
 const calc=calculator();
 for(const args of [[8,8,30,48],[21,8,30,48],[-1,21,30,48],[8,25,30,48],
   [8,21,0,48],[8,21,1441,48],[8,21,30,0],[8,21,30,49],[8,21,30.5,48]])
  assert.equal(calc(...args),null,JSON.stringify(args));
});
test('visualização muda imediatamente com input ou change sem salvar os dados',()=>{
 const fields={
  start_hour:{value:'8'},end_hour:{value:'21'},interval_minutes:{value:'30'},max_daily:{value:'48'},
  'telegram-capacity-count':{textContent:''},
  'telegram-capacity-detail':{textContent:''}
 };
 const events={};
 for(const id of ['start_hour','end_hour','interval_minutes','max_daily']){
  fields[id].addEventListener=(event,fn)=>{events[id+':'+event]=fn;};
 }
 const document={getElementById:id=>fields[id]};
 const start=CLIENT_JS.indexOf('function calculateTelegramDailyCapacity(');
 const end=CLIENT_JS.indexOf('let currentChannelId=1;',start);
 assert.ok(start>=0&&end>start);
 const code=CLIENT_JS.slice(start,end);
 const functions=new Function('document',
  'const $ = id => document.getElementById(id);\n'+code+
  '\nreturn {updateTelegramCapacity};')(document);
 for(const id of ['start_hour','end_hour','interval_minutes','max_daily']){
  // Os controles existentes podem disparar input/change sem requisição ao servidor.
  assert.match(CLIENT_JS,new RegExp(id));
 }
 functions.updateTelegramCapacity();
 assert.equal(fields['telegram-capacity-count'].textContent,'26');
 assert.match(fields['telegram-capacity-detail'].textContent,/26 horários possíveis/);
 fields.interval_minutes.value='60';
 functions.updateTelegramCapacity();
 assert.equal(fields['telegram-capacity-count'].textContent,'13');
 fields.max_daily.value='10';
 functions.updateTelegramCapacity();
 assert.equal(fields['telegram-capacity-count'].textContent,'10');
 fields.end_hour.value='7';
 functions.updateTelegramCapacity();
 assert.equal(fields['telegram-capacity-count'].textContent,'—');
 assert.match(fields['telegram-capacity-detail'].textContent,/Confira/);
});