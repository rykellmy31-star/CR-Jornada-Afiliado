// Último recurso para vitrines oficiais /social com o botão principal carregado
// por JavaScript. Clica SOMENTE no cartão destacado, nunca em recomendações.
// A verificação do URL/MLB final é feita pelo monitor antes de salvar o produto.
export async function browseFeaturedDestination(env,socialUrl,{launchBrowser=null}={}){
 if(!env?.BROWSER)return null;
 let browser;
 try{
  const launcher=launchBrowser||((await import('@cloudflare/puppeteer')).default.launch);
  browser=await launcher(env.BROWSER);
  const page=await browser.newPage();
  await page.goto(socialUrl,{waitUntil:'domcontentloaded',timeout:20000});
  try{await page.waitForSelector('.rl-card-featured-wrapper,.card-featured-wrapper',{timeout:7500});}
  catch{return null;}
  // Toda seleção ocorre dentro do cartão principal. Não usar a primeira
  // URL da página nem recorrer a itens "Você também pode gostar".
  const raw=await page.evaluate(()=>{
   const root=document.querySelector('.rl-card-featured-wrapper,.card-featured-wrapper');
   if(!root)return JSON.stringify({missing:true});
   const nodes=Array.from(root.querySelectorAll('a,button,[role="link"]')).slice(0,80);
   const text=el=>String(el.textContent||el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim();
   const actions=nodes.filter(el=>/\bir\s+para\s+(?:o\s+)?produto\b/i.test(text(el)));
   const titles=nodes.filter(el=>el.matches('a.poly-component__title[href],a.poly-component__link--action-link[href],a.poly-action-links__action--link[href]'));
   const targets=actions.length?actions:titles;
   if(!targets.length)return JSON.stringify({missing:true});
   const hrefs=[...new Set(targets.map(el=>el.getAttribute('href')).filter(Boolean))];
   if(hrefs.length>1)return JSON.stringify({ambiguous:true});
   const selected=targets[0];
   selected.setAttribute('data-crj-featured-cta','1');
   if(selected.tagName==='A')selected.setAttribute('target','_self');
   return JSON.stringify({href:hrefs[0]||null,matched:targets.length});
  });
  let chosen;
  try{chosen=JSON.parse(raw);}catch{return null;}
  if(!chosen||chosen.missing||chosen.ambiguous)return null;
  const addresses=[];
  if(chosen.href)try{addresses.push(new URL(chosen.href,socialUrl).href);}catch{}
  // O CTA pode ser /sec/... ou um <button> sem href. Nesse caso é
  // necessário executar o clique real para observar o destino do navegador.
  if(!addresses.some(url=>/^https:\/\/(?:www\.|produto\.)?mercadolivre\.com\.br\/.*(?:\/p\/MLB\d{6,}|\/up\/MLBU\d{6,}|\/MLB-\d{6,})/i.test(url))){
   try{
    const nav=page.waitForNavigation({waitUntil:'domcontentloaded',timeout:9500}).catch(()=>null);
    await page.click('[data-crj-featured-cta="1"]',{delay:15});
    await nav;
   }catch{/* Navegação pode abrir outra aba ou permanecer no mesmo endereço. */}
   addresses.push(page.url());
   if(typeof browser.pages==='function'){
    try{
     const pages=await browser.pages();
     for(const opened of pages.slice(0,5))addresses.push(opened.url());
    }catch{}
   }
  }
  return {addresses:[...new Set(addresses)].slice(0,8)};
 }catch(error){
  console.warn('Navegação do cartão principal indisponível:',String(error?.message||error).slice(0,100));
  return null;
 }finally{
  if(browser)try{await browser.close();}catch{}
 }
}
