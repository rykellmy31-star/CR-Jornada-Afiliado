import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewState} from '../src/overview.js';
import {renderPage,CSS,CLIENT_JS} from '../src/ui.js';
import worker from '../src/index.js';

function makeDB(tables=[],counts={},firsts={},listResults={}) {
  let writes=0;
  return {
    get writes(){return writes;},
    prepare(query){
      if(!/^\s*SELECT\b/i.test(query)){writes++;throw new Error('Visão Geral não pode modificar banco');}
      return {
        async all(){
          if(query.includes('FROM sqlite_master'))return {results:tables.map(name=>({name}))};
          for(const [fragment,results] of Object.entries(listResults))
            if(query.includes(fragment))return {results};
          const match=query.match(/SELECT status,COUNT\(\*\) AS total FROM ([a-z_]+) GROUP BY status/);
          if(match)return {results:counts[match[1]]||[]};
          return {results:[]};
        },
        async first(){
          for(const [fragment,result] of Object.entries(firsts))
            if(query.includes(fragment))return result;
          return {total:0};
        }
      };
    }
  };
}

test('Visão Geral preserva navegação e mantém seções fechadas no início',()=>{
  const page=renderPage();
  assert.match(page,/data-panel="overview"/);
  assert.match(page,/id="overview-page"/);
  assert.match(page,/<details class="overview-accordion">/);
  assert.doesNotMatch(page,/<details class="overview-accordion" open/);
  assert.match(CSS,/#dashboard:not\(\[data-view="overview"\]\) > #overview-page/);
  assert.match(CLIENT_JS,/selectedPage='overview'/);
  assert.match(CLIENT_JS,/refreshOverview\(\)/);
  assert.match(page,/data-platform="mercadolivre"/);
  assert.match(page,/data-platform="shopee"/);
});

test('Visão Geral vazia retorna zeros, sem escrever nem criar tabelas',async()=>{
  const DB=makeDB();
  const state=await overviewState({DB});
  assert.deepEqual(state.counts,{captured:0,queued:0,published:0,review:0});
  assert.equal(state.monitor.enabled,false);
  assert.equal(state.destinations.connection_verified,false);
  assert.equal(DB.writes,0);
});

test('Visão Geral soma dados das filas e distingue habilitação de conexão',async()=>{
  const tables=['offers','channel_offers','whatsapp_direct_offers','whatsapp_group_offers','shopee_offers',
  'ml_monitor_links','ml_monitor_shortlinks','ml_monitor_groups','ml_monitor_settings',
  'ml_monitor_diagnostics','settings','telegram_channels','whatsapp_settings','whatsapp_groups','logs'];
  const DB=makeDB(tables,{
    offers:[{status:'ready',total:2},{status:'published',total:4},{status:'needs_review',total:1}],
    channel_offers:[{status:'ready',total:3}],
    whatsapp_direct_offers:[{status:'published',total:2}],
    whatsapp_group_offers:[{status:'needs_review',total:1}],
    shopee_offers:[{status:'ready',total:1},{status:'published',total:3}]
  },{
    "FROM ml_monitor_links":{total:14},
    "FROM ml_monitor_shortlinks":{total:2},
    "FROM ml_monitor_groups":{total:3},
    "FROM ml_monitor_settings":{enabled:1},
    "FROM ml_monitor_diagnostics":{last_event_at:1730000000,last_link_at:1730000010},
    "FROM settings WHERE":{telegram_enabled:1,channel_registered:1,automation_enabled:1},
    "FROM telegram_channels WHERE":{total:2},
    "FROM whatsapp_settings":{enabled:1,public_registered:1},
    "FROM whatsapp_groups WHERE":{total:3}
  },{
    "FROM logs ORDER BY":[{event:'published',created_at:1730000040}]
  });
  const state=await overviewState({DB});
  assert.deepEqual(state.counts,{captured:14,queued:6,published:9,review:4});
  assert.equal(state.monitor.enabled,true);
  assert.equal(state.monitor.authorized_groups,3);
  assert.equal(state.destinations.telegram_active,3);
  assert.equal(state.destinations.whatsapp_active,4);
  assert.equal(state.destinations.connection_verified,false);
  assert.equal(state.events.length,1);
  assert.equal(DB.writes,0);
});

test('Dados de Visão Geral exigem sessão autenticada',async()=>{
  const response=await worker.fetch(new Request('https://afiliados.exemplo.com/api/overview'),{
    DB:{},ADMIN_PASSWORD:'somente-teste',SESSION_SECRET:'somente-teste'
  });
  assert.equal(response.status,401);
});
