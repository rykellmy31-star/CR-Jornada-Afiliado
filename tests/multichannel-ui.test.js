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
  assert.match(CLIENT_JS,/\/api\/channels\/'\+initialId\+'\/state/);
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


test('Cupons começam ocultos e aparecem somente ao selecionar a aba Cupons da plataforma',()=>{
  const html=renderPage();
  for(const id of ['shopee-coupon-panel','ml-whatsapp-coupon-panel','ml-coupon-panel']){
    assert.match(html,new RegExp('<section class="card coupon-panel hidden" id="'+id+'"'),
      'Formulário '+id+' não pode aparecer ao abrir Telegram/WhatsApp');
  }
  assert.doesNotMatch(CLIENT_JS,/querySelector\('#dashboard > \.coupon-panel'\)/,
    'Nunca selecionar o primeiro painel genérico de cupons');
  const first=CLIENT_JS.indexOf('function applyPlatformView(){');
  const last=CLIENT_JS.indexOf('async function refreshMainWhatsappCoupons(){');
  assert.ok(first>=0&&last>first,'Precisa existir a rotina de exibição por abas');
  const code=CLIENT_JS.slice(first,last);
  function renderState(selectedPlatform,selectedNetwork,selectedTab,currentWaGroupId){
    const elements=new Map();
    const get=id=>{
      if(!elements.has(id)){
        const state=new Set(['shopee-coupon-panel','ml-whatsapp-coupon-panel','ml-coupon-panel'].includes(id)?['hidden']:[]);
        elements.set(id,{
          id,tagName:'SECTION',children:[],dataset:{},textContent:'',value:'',
          classList:{
            toggle(name,active){if(active)state.add(name);else state.delete(name);},
            add(name){state.add(name);},remove(name){state.delete(name);},
            contains(name){return state.has(name);}
          }
        });
      }
      return elements.get(id);
    };
    const document={
      querySelector(selector){return get(selector);},
      querySelectorAll(){return [];}
    };
    const run=new Function('document','$','updatePlatformIdentity',
      'selectedPlatform','selectedNetwork','selectedTab','currentWaGroupId','selectedPage',
      code+';applyPlatformView();');
    run(document,get,()=>{},selectedPlatform,selectedNetwork,selectedTab,currentWaGroupId,'platform');
    return {
      shopee:!get('shopee-coupon-panel').classList.contains('hidden'),
      mlWhatsapp:!get('ml-whatsapp-coupon-panel').classList.contains('hidden'),
      ml:!get('ml-coupon-panel').classList.contains('hidden')
    };
  }
  const none={shopee:false,mlWhatsapp:false,ml:false};
  for(const platform of ['mercadolivre','shopee']){
    for(const network of ['telegram','whatsapp']){
      assert.deepEqual(renderState(platform,network,network,2),none,
        platform+' '+network+' não pode mostrar formulários de cupons');
    }
  }
  assert.deepEqual(renderState('mercadolivre','telegram','coupons',1),
    {shopee:false,mlWhatsapp:false,ml:true});
  assert.deepEqual(renderState('mercadolivre','whatsapp','coupons',1),
    {shopee:false,mlWhatsapp:false,ml:true});
  assert.deepEqual(renderState('mercadolivre','whatsapp','coupons',2),
    {shopee:false,mlWhatsapp:true,ml:false});
  assert.deepEqual(renderState('shopee','telegram','coupons',1),
    {shopee:true,mlWhatsapp:false,ml:false});
});


test('Trocas rápidas descartam resposta antiga que misturaria grupo WhatsApp no seletor do Telegram',async()=>{
  const from=CLIENT_JS.indexOf('async function refreshPlatformTargets(');
  const to=CLIENT_JS.indexOf('async function refreshShopee(){',from);
  assert.ok(from>=0&&to>from);
  const select={dataset:{},innerHTML:'',value:'',disabled:true};
  const invoke=new Function('call','select',
    "let selectedPlatform='mercadolivre',selectedNetwork='telegram',selectedPage='platform';"+
    "let destinationRequestRevision=0,currentChannelId=1,currentWaGroupId=1;"+
    "const shopeeTarget={telegram:null,whatsapp:null};"+
    "const $=()=>select,escape=s=>String(s);"+
    "const rememberNavigation=()=>{},updatePlatformIdentity=()=>{};"+
    CLIENT_JS.slice(from,to)+
    "return {setNetwork:n=>{selectedNetwork=n;},setPlatform:p=>{selectedPlatform=p;},refreshPlatformTargets};");
  const pending=new Map();
  const mockCall=path=>new Promise(resolve=>pending.set(path,resolve));
  const state=invoke(mockCall,select);
  const oldTelegram=state.refreshPlatformTargets();
  state.setNetwork('whatsapp');
  const newWhatsapp=state.refreshPlatformTargets();
  pending.get('/api/wa-groups')({groups:[{id:8,name:'Grupo WhatsApp correto',category:'Geral'}]});
  assert.equal(await newWhatsapp,true);
  pending.get('/api/channels')({channels:[{id:1,name:'Canal Telegram atrasado',category:'Geral'}]});
  assert.equal(await oldTelegram,false);
  assert.equal(select.dataset.network,'whatsapp');
  assert.equal(select.dataset.platform,'mercadolivre');
  assert.match(select.innerHTML,/Grupo WhatsApp correto/);
  assert.doesNotMatch(select.innerHTML,/Canal Telegram atrasado/);

  state.setPlatform('shopee');
  state.setNetwork('telegram');
  const oldShopee=state.refreshPlatformTargets();
  state.setPlatform('mercadolivre');
  state.setNetwork('telegram');
  const newTelegram=state.refreshPlatformTargets();
  pending.get('/api/channels')({channels:[{id:1,name:'Canal Telegram correto',category:'Geral'}]});
  assert.equal(await newTelegram,true);
  pending.get('/api/shopee/destinations')({destinations:[{network:'telegram',target_id:1000,name:'Canal da Shopee',category:'Geral'}]});
  assert.equal(await oldShopee,false);
  assert.equal(select.dataset.platform,'mercadolivre');
  assert.equal(select.dataset.network,'telegram');
  assert.match(select.innerHTML,/Canal Telegram correto/);
  assert.doesNotMatch(select.innerHTML,/Shopee/);
});

test('Abas separadas e troca instantânea não permitem conteúdo WhatsApp sobre Telegram',()=>{
  assert.match(CLIENT_JS,/destinationRequestRevision/);
  assert.match(CLIENT_JS,/select\.dataset\.platform=platform/);
  assert.match(CLIENT_JS,/select\.dataset\.network=network/);
  assert.match(CLIENT_JS,/requestRevision!==destinationRequestRevision/);
  assert.match(CLIENT_JS,/\$\('dashboard'\)\.dataset\.view=/);
  assert.match(CLIENT_JS,/shopeeStateRequestRevision/);
  assert.match(CLIENT_JS,/Promise\.allSettled\(\[refreshShopeeAccount\(\),refreshShopee\(\)\]\)/);
});
