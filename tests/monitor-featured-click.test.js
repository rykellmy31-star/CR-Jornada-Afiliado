import test from 'node:test';
import assert from 'node:assert/strict';
import {browseFeaturedDestination} from '../src/monitor-featured-click.js';
import {browserFeaturedProduct} from '../src/whatsapp-link-monitor.js';

const social='https://www.mercadolivre.com.br/social/teste-ofertas?matt_word=teste';
const product='https://www.mercadolivre.com.br/kit-moto/p/MLB12345678';
const recommendation='https://www.mercadolivre.com.br/tambem-comprou/p/MLB87654321';
function mockBrowser({href='/sec/ir-para-produto',destination=product,ambiguous=false}={}){
 const calls={clicks:0,closed:0,scripts:[]};
 const page={
  current:social,
  async goto(url){this.current=url;},
  async waitForSelector(selector){assert.match(selector,/rl-card-featured-wrapper/);},
  async evaluate(script){calls.scripts.push(String(script));return JSON.stringify(ambiguous?{ambiguous:true}:{href,matched:1});},
  async waitForNavigation(){return null;},
  async click(selector){
   assert.equal(selector,'[data-crj-featured-cta="1"]');
   calls.clicks++;this.current=destination;
  },
  url(){return this.current;}
 };
 const browser={newPage:async()=>page,pages:async()=>[page],
  close:async()=>{calls.closed++;}};
 return {browser,calls};
}
test('navegação do destaque segue somente o CTA real e fecha sessão',async()=>{
 const {browser,calls}=mockBrowser();
 const result=await browseFeaturedDestination({BROWSER:{}},social,{launchBrowser:async()=>browser});
 assert.ok(result.addresses.includes(product));
 assert.equal(calls.clicks,1);
 assert.equal(calls.closed,1);
 assert.ok(calls.scripts[0].includes('rl-card-featured-wrapper'));
 assert.ok(calls.scripts[0].includes('ir\\s+para'));
});
test('sessão do navegador classifica apenas produto final, sem recomendação',async()=>{
 const {browser,calls}=mockBrowser();
 const result=await browserFeaturedProduct({
  BROWSER:{quickAction:async()=>{throw new Error('Não deve consultar a página após clique confirmado');}}
 },social,{launchBrowser:async()=>browser});
 assert.equal(result.product_id,'MLB12345678');
 assert.equal(calls.closed,1);
});
test('a vitrine ambígua jamais é aprovada como anúncio aleatório',async()=>{
 const {browser,calls}=mockBrowser({ambiguous:true});
 const result=await browseFeaturedDestination({BROWSER:{}},social,{launchBrowser:async()=>browser});
 assert.equal(result,null);
 assert.equal(calls.clicks,0);
 assert.equal(calls.closed,1);
});
test('se browser abrir anúncios diferentes a classificação não escolhe um arbitrariamente',async()=>{
 const {browser,calls}=mockBrowser({destination:recommendation});
 // Simula abertura de duas abas distintas após o CTA.
 browser.pages=async()=>[{url:()=>product},{url:()=>recommendation}];
 const result=await browserFeaturedProduct({BROWSER:{quickAction:async()=>new Response('sem marcador',{headers:{'content-type':'text/html'}})}},social,{launchBrowser:async()=>browser});
 assert.equal(result,null);
 assert.equal(calls.closed,1);
});
