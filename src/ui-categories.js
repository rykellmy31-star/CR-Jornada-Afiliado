export const CATEGORY_PAGE_HTML = `
<section id="categories-page" class="card categories-page hidden">
  <div class="section-header"><div><h2>📁 Categorias e distribuição</h2><p>Gerencie categorias e escolha vários canais ou grupos para cada assunto.</p></div><button id="categories-refresh" class="outline" type="button">Atualizar</button></div>
  <p class="hint">Categorias de grupo definem os assuntos. Os produtos cadastrados são classificados automaticamente quando há correspondência segura. A descoberta de novos anúncios depende de integrações oficiais.</p>
  <div class="categories-grid">
    <div class="category-inner">
      <h2>Categorias de grupos</h2>
      <form id="category-create-form" class="category-form">
        <label>Nome da categoria<input name="name" maxlength="60" minlength="3" required placeholder="Ex.: Ferramentas, Peças de motos"></label>
        <label>Palavras-chave dos produtos<input name="keywords" maxlength="350" placeholder="Ex.: chave de fenda, chave de boca, furadeira"></label>
        <button type="submit" class="primary">Criar categoria</button>
      </form>
      <div class="divider-wa"></div>
      <label>Categoria para configurar<select id="category-group-select"><option value="">Selecione uma categoria</option></select></label>
      <form id="category-edit-form" class="category-form">
        <label>Palavras-chave para reconhecimento<input id="category-edit-keywords" maxlength="350" placeholder="Separe por vírgulas"></label>
        <label class="check-row"><input id="category-edit-enabled" type="checkbox" checked><span><b>Categoria ativa</b><small>Desativada não distribui ofertas</small></span></label>
        <button type="submit" class="outline">Salvar categoria</button>
      </form>
    </div>
    <div class="category-inner">
      <h2>Destinos da categoria selecionada</h2>
      <p class="hint">Marque os grupos/canais e as plataformas permitidas. Uma categoria pode ser enviada a vários destinos, inclusive o mesmo WhatsApp pelas duas lojas.</p>
      <form id="category-routes-form">
        <div id="category-routes" class="category-route-list">Selecione uma categoria primeiro.</div>
        <button type="submit" class="primary">Salvar distribuição</button>
      </form>
    </div>
  </div>
  <p id="category-feedback" class="feedback" role="status"></p>
  <div class="category-inner" style="margin-top:18px">
    <h2>Categorias de produtos encontradas</h2>
    <p class="hint">Produtos sem categoria identificada permanecem pendentes de classificação e não são encaminhados automaticamente.</p>
    <div class="table-scroll"><table><thead><tr><th>Produto</th><th>Plataforma</th><th>Categoria</th><th>Subcategoria</th><th>Classificação</th></tr></thead><tbody id="category-products"><tr><td colspan="5">Nenhum produto registrado.</td></tr></tbody></table></div>
  </div>
</section>`;
export const CATEGORY_CSS = `
.master-toggle{cursor:pointer;background:#164b65;color:#fff;border:1px solid #38b8b1;font-weight:800;font-size:13px;padding:12px 18px}
.master-toggle.running{background:#0e867f;border-color:#4ee0c6}.master-toggle.paused{background:#51342f;border-color:#d4a18b}
.master-toggle:disabled{opacity:.7;cursor:wait}
.categories-page{padding:24px;margin-bottom:20px}.categories-page h2{margin-bottom:9px}
.categories-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:18px;margin-top:20px}
.category-inner{background:#f8fafc;border:1px solid #e1e8ef;border-radius:14px;padding:18px}
.category-form{display:flex;flex-direction:column;gap:12px}.category-route-list{display:flex;flex-direction:column;gap:8px;margin:15px 0}
.category-route-item{border:1px solid #e0e8f3;border-radius:12px;background:white;padding:12px;display:flex;gap:15px;align-items:center;flex-wrap:wrap}
.category-route-item strong{flex:1;min-width:180px}.category-route-item label{display:flex;flex-direction:row;align-items:center;gap:8px}
.category-route-item input[type=checkbox]{width:18px;height:18px;accent-color:#119d8d}
.category-route-item small{color:#68748b}.category-inner .table-scroll{margin-top:12px}
@media(max-width:900px){.categories-grid{grid-template-columns:1fr}}@media(max-width:520px){.categories-page{padding:15px}}
`;

export const CATEGORY_CLIENT_JS = `
let categoryData={groups:[],products:[],routes:[]};
let categoryDestinations=[];
let categorySelectedId=null;
let masterActive=null;

function setCategoryFieldValue(el,value){
  if(typeof el==='string')el=$(el);
  if(!el)return;
  const text=String(value||'Geral');
  el.dataset.desiredCategory=text;
  if(Array.from(el.options).some(o=>o.value===text))el.value=text;
}
function refreshCategoryDropdowns(){
  const options=['Geral',...categoryData.groups.filter(c=>c.enabled&&c.name!=='Geral').map(c=>c.name)];
  for(const element of document.querySelectorAll('select[data-category-selector]')){
    const desired=element.dataset.desiredCategory||element.value||'Geral';
    element.innerHTML=options.map(name=>'<option value="'+escape(name)+'">'+escape(name)+'</option>').join('');
    if(options.includes(desired))element.value=desired;
    else{
      element.add(new Option('Selecione uma categoria existente',''));
      element.value='';
    }
    element.dataset.desiredCategory=element.value;
  }
}
async function fetchCategoryOptions(){
  const data=await call('/api/categories');
  categoryData=data;
  refreshCategoryDropdowns();
  return data;
}
function renderCategoryRoutes(){
  const id=Number($('category-group-select').value);
  categorySelectedId=Number.isSafeInteger(id)&&id>0?id:null;
  const selected=categoryData.groups.find(g=>g.id===id);
  $('category-edit-keywords').value=selected?.keywords||'';
  $('category-edit-enabled').checked=selected?!!selected.enabled:false;
  const container=$('category-routes');
  if(!selected){
    container.textContent='Selecione uma categoria para configurar os destinos.';
    return;
  }
  container.innerHTML=categoryDestinations.map(d=>{
    const active=categoryData.routes.find(r=>r.group_category_id===id&&r.destination_scope===d.scope&&r.network===d.network&&r.destination_id===d.id);
    return '<div class="category-route-item" data-scope="'+escape(d.scope)+'" data-network="'+escape(d.network)+'" data-id="'+Number(d.id)+'">'+
      '<strong>'+escape(d.name)+' <small>('+escape(d.scope==='shopee'?'Shopee':'Mercado Livre')+' • '+escape(d.network)+
      (d.active?' • autorizado':' • inativo')+')</small></strong>'+
      '<label><input type="checkbox" data-platform-ml'+(active?.allow_mercadolivre?' checked':'')+'> Mercado Livre</label>'+
      '<label><input type="checkbox" data-platform-shopee'+(active?.allow_shopee?' checked':'')+'> Shopee</label></div>';
  }).join('')||'Nenhum canal ou grupo cadastrado. Cadastre e autorize os destinos primeiro.';
}
function renderCategoryProducts(){
  $('category-products').innerHTML=categoryData.products.length?categoryData.products.map(p=>{
    return '<tr><td>'+escape(p.title)+'</td><td>'+escape(p.platform==='shopee'?'Shopee':'Mercado Livre')+
      '</td><td>'+escape(p.group_category||'A revisar')+'</td><td>'+escape(p.subcategory||'A identificar')+
      '</td><td>'+escape(p.classification==='needs_review'?'Revisão necessária':p.classification==='selected'?'Selecionada':'Automática')+'</td></tr>';
  }).join(''):'<tr><td colspan="5">Os produtos cadastrados aparecerão aqui.</td></tr>';
}
async function refreshCategories(){
  const [data,targets]=await Promise.all([fetchCategoryOptions(),call('/api/categories/destinations')]);
  categoryDestinations=targets.destinations||[];
  const select=$('category-group-select');
  const selection=categorySelectedId||Number(select.value);
  select.innerHTML='<option value="">Selecione uma categoria</option>'+data.groups.map(c=>
    '<option value="'+Number(c.id)+'">'+escape(c.name)+(c.enabled?'':' (inativa)')+'</option>').join('');
  if(data.groups.some(c=>c.id===selection))select.value=String(selection);
  else if(data.groups.length){select.value=String(data.groups[0].id);categorySelectedId=data.groups[0].id;}
  renderCategoryRoutes();
  renderCategoryProducts();
}
async function loadMasterState(){
  const state=await call('/api/master');
  masterActive=state.enabled;
  const button=$('master-toggle');
  button.textContent=masterActive===true?'Desligar robô':'Ligar robô';
  button.classList.toggle('running',masterActive===true);
  button.classList.toggle('paused',masterActive===false);
  button.setAttribute('aria-pressed',masterActive===true?'true':'false');
}
$('master-toggle').addEventListener('click',async()=>{
  const b=$('master-toggle'),target=masterActive!==true;
  if(!target&&!confirm('Desligar os envios automáticos do Mercado Livre e da Shopee? As ofertas e configurações serão preservadas.'))return;
  b.disabled=true;
  try{
    await call('/api/master',{method:'POST',body:JSON.stringify({enabled:target})});
    await loadMasterState();
    notice(target?'Robô geral ligado. Somente destinos cadastrados e autorizados serão utilizados.':'Robô geral pausado. Nenhuma fila foi apagada.');
  }catch(e){notice('Controle geral: '+e.message,true);}
  finally{b.disabled=false;}
});
$('categories-refresh').addEventListener('click',()=>refreshCategories().catch(e=>notice(e.message,true,'category-feedback')));
$('category-group-select').addEventListener('change',renderCategoryRoutes);
$('category-create-form').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const payload=Object.fromEntries(new FormData(e.target));
    const result=await call('/api/categories/groups',{method:'POST',body:JSON.stringify(payload)});
    categorySelectedId=result.id;
    e.target.reset();
    await refreshCategories();
    notice('Categoria criada e disponível nos seletores.',false,'category-feedback');
  }catch(err){notice(err.message,true,'category-feedback');}
});
$('category-edit-form').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!categorySelectedId){notice('Selecione uma categoria.',true,'category-feedback');return;}
  try{
    await call('/api/categories/groups/'+categorySelectedId,{method:'POST',body:JSON.stringify({
      keywords:$('category-edit-keywords').value,enabled:$('category-edit-enabled').checked
    })});
    await refreshCategories();
    notice('Categoria atualizada.',false,'category-feedback');
  }catch(err){notice(err.message,true,'category-feedback');}
});
$('category-routes-form').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!categorySelectedId){notice('Selecione uma categoria primeiro.',true,'category-feedback');return;}
  const routes=[];
  for(const el of $('category-routes').querySelectorAll('.category-route-item')){
    const ml=el.querySelector('[data-platform-ml]').checked;
    const sh=el.querySelector('[data-platform-shopee]').checked;
    if(ml||sh)routes.push({scope:el.dataset.scope,network:el.dataset.network,id:Number(el.dataset.id),mercadolivre:ml,shopee:sh});
  }
  try{
    await call('/api/categories/groups/'+categorySelectedId+'/routes',{method:'POST',body:JSON.stringify({routes})});
    await refreshCategories();
    notice('Distribuição salva. Apenas destinos autorizados poderão receber anúncios.',false,'category-feedback');
  }catch(error){notice(error.message,true,'category-feedback');}
});
$('activity-refresh').addEventListener('click',()=>refreshActivity().catch(e=>notice(e.message,true)));
`;
