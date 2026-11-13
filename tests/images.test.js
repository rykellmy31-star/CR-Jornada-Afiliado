import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedProductPage, trustedProductImage, extractProductImage, findProductImage, highQualityPhotoCandidates } from '../src/images.js';

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

test('prioriza foto grande -F da mesma imagem e não aceita domínio externo', () => {
  const source='https://http2.mlstatic.com/D_Q_NP_2X_902305-MLB88750630332_082025-AB.webp?foo=bar';
  assert.deepEqual(highQualityPhotoCandidates(source), [
    'https://http2.mlstatic.com/D_NQ_NP_902305-MLB88750630332_082025-F.jpg',
    'https://http2.mlstatic.com/D_NQ_NP_902305-MLB88750630332_082025-OO.jpg',
    'https://http2.mlstatic.com/D_NQ_NP_902305-MLB88750630332_082025-O.jpg',
    'https://http2.mlstatic.com/D_Q_NP_2X_902305-MLB88750630332_082025-AB.jpg?foo=bar'
  ]);
  assert.deepEqual(highQualityPhotoCandidates('https://malicious.example.com/D_NQ_NP_902305-MLB-F.jpg'), []);
});

test('busca variante original F e evita foto inexistente ou HTML', async () => {
  const photo='https://http2.mlstatic.com/D_NQ_NP_777-MLB123-P.webp';
  const calls=[];
  const result=await findProductImage('https://meli.la/2bsHW5y',async(url,opts={})=>{
    calls.push({url:String(url),method:opts.method||'GET'});
    if(String(url)==='https://meli.la/2bsHW5y')
      return new Response('<meta property="og:image" content="'+photo+'">',{headers:{'content-type':'text/html'}});
    if(String(url)==='https://http2.mlstatic.com/D_NQ_NP_777-MLB123-F.jpg')
      return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'650000'}});
    return new Response(null,{status:404});
  });
  assert.equal(result,'https://http2.mlstatic.com/D_NQ_NP_777-MLB123-F.jpg');
  assert.equal(calls.filter(c=>c.method==='HEAD').length,1);
});

test('não usa arquivo maior que 5 MB e verifica próxima variante', async () => {
  const result=await findProductImage('https://meli.la/2bsHW5y',async(url)=>{
    const address=String(url);
    if(address==='https://meli.la/2bsHW5y') return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_888-MLB999-P.jpg">',{headers:{'content-type':'text/html'}});
    if(address.endsWith('-F.jpg')) return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'6000000'}});
    if(address.endsWith('-OO.jpg')) return new Response(null,{status:404});
    if(address.endsWith('-O.jpg')) return new Response(null,{status:200,headers:{'content-type':'image/jpeg','content-length':'180000'}});
    return new Response(null,{status:404});
  });
  assert.equal(result,'https://http2.mlstatic.com/D_NQ_NP_888-MLB999-O.jpg');
});

test('falha segura se a CDN servir texto em vez de imagem', async () => {
  const result=await findProductImage('https://meli.la/2bsHW5y',async(url)=>{
    if(String(url)==='https://meli.la/2bsHW5y')return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_111-MLB222-P.webp">',{headers:{'content-type':'text/html'}});
    return new Response(null,{status:200,headers:{'content-type':'text/html'}});
  });
  assert.equal(result,null);
});

test('HEAD não suportado: confirma imagem por GET parcial com Content-Range',async()=>{
  const seen=[];
  const result=await findProductImage('https://meli.la/2bsHW5y',async(url,opts={})=>{
    seen.push({url:String(url),method:opts.method||'GET',range:opts.headers?.range});
    if(String(url)==='https://meli.la/2bsHW5y')
      return new Response('<meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_333-MLB444-P.webp">',{headers:{'content-type':'text/html'}});
    if(String(url).endsWith('-F.jpg') && opts.method==='HEAD')return new Response(null,{status:405});
    if(String(url).endsWith('-F.jpg') && opts.method==='GET')return new Response(new Uint8Array([0xff,0xd8]),{status:206,headers:{'content-type':'image/jpeg','content-range':'bytes 0-1/900000','content-length':'2'}});
    return new Response(null,{status:404});
  });
  assert.equal(result,'https://http2.mlstatic.com/D_NQ_NP_333-MLB444-F.jpg');
  assert.ok(seen.some(c=>c.method==='GET'&&c.range==='bytes=0-1023'));
});
