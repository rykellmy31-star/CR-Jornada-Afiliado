import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedProductPage, trustedProductImage, extractProductImage, findProductImage } from '../src/images.js';

test('imagens somente da CDN do Mercado Livre e navegação sem redirecionar para terceiros',async()=>{
  assert.equal(trustedProductPage('https://meli.la/2bsHW5y'),true);
  assert.equal(trustedProductPage('https://meli.la.evil.com/2bsHW5y'),false);
  assert.equal(trustedProductImage('https://http2.mlstatic.com/D_NQ_NP_123-MLB-O.jpg'),true);
  assert.equal(trustedProductImage('https://evil.com/a.jpg'),false);
  const value=extractProductImage('<meta content="https://http2.mlstatic.com/D_NQ_NP_123-MLB-P.jpg?x=1&amp;y=2" property="og:image">');
  assert.equal(value,'https://http2.mlstatic.com/D_NQ_NP_123-MLB-P.jpg?x=1&y=2');
  const calls=[];
  const result=await findProductImage('https://meli.la/2bsHW5y',async (url)=>{
    calls.push(url);
    return new Response(null,{status:302,headers:{location:'https://evil.com/steal'}});
  });
  assert.equal(result,null);
  assert.equal(calls.length,1);
});

test('não usa imagem de outro domínio ou HTML sem metadados',()=>{
  assert.equal(extractProductImage('<meta property="og:image" content="https://evil.com/photo.jpg">'),null);
  assert.equal(extractProductImage('<html><h1>Produto</h1></html>'),null);
});
