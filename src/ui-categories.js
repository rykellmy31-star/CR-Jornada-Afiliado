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
