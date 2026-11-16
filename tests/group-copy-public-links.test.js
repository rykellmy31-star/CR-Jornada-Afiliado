import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {withGroupCopyPublicLink,trustedGroupCopyPublicLink} from '../src/group-copy-public-links.js';
import {telegramPayload,formatOfferMessage} from '../src/logic.js';
import {inspectMonitorShortlink,parseMonitorEvent} from '../src/whatsapp-link-monitor.js';

const DIRECT='https://www.mercadolivre.com.br/vestido-feminino-tomara-que-caia-curto-tubinho-tricot/up/MLBU5327014896?matt_word=rykellmy_007&matt_tool=33321398';
const SHORT='https://promoml.app/--qmKT0XwC3R';
function dbEnv(){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE ml_group_copy_auto_history(product_id TEXT,group_id INTEGER,offer_id INTEGER,short_url TEXT,source_url TEXT,target_url TEXT,queued_at INTEGER)');
 return {env:{DB:{prepare(sql){let args=[];return {bind(...values){args=values;return this;},first(){return db.prepare(sql).get(...args)||null;}}}}},db};
}
test('copied group offer publishes short link in Telegram caption/button and WhatsApp, while source remains intact for photo retrieval',async()=>{
 const {env,db}=dbEnv();
 try{
  db.prepare('INSERT INTO ml_group_copy_auto_history VALUES(?,?,?,?,?,?,?)')
   .run('MLBU5327014896',1,1,SHORT,DIRECT,DIRECT,1794784490);
  const offer={id:1,title:'Vestido feminino tomara que caia curto tubinho tricot',affiliate_url:DIRECT,category:'Moda',created_at:Math.floor(Date.now()/1000)};
  const outgoing=await withGroupCopyPublicLink(env,offer);
  assert.equal(outgoing.affiliate_url,DIRECT);
  assert.equal(outgoing.public_url,SHORT);
  const tg=telegramPayload(outgoing,'@test',Date.now(),{includeLink:true});
  assert.equal(tg.reply_markup.inline_keyboard[0][0].url,SHORT);
  assert.ok(tg.text.includes(SHORT));
  assert.ok(!tg.text.includes(DIRECT));
  const wa=formatOfferMessage(outgoing,{platform:'mercadolivre',network:'whatsapp',includeLink:true});
  assert.ok(wa.includes(SHORT));
  assert.ok(!wa.includes(DIRECT));
  assert.equal((await withGroupCopyPublicLink(env,{...offer,affiliate_url:'https://www.mercadolivre.com.br/p/MLB12345678'})).public_url,undefined);
 }finally{db.close();}
});
test('unexpected or manipulated short URLs are rejected, and missing table does not stop scheduled messages',async()=>{
 assert.equal(trustedGroupCopyPublicLink('https://promoml.app/--qmKT0XwC3R'),SHORT);
 for(const bad of ['https://evil.test/--qmKT0XwC3R','https://promoml.app.evil.test/--qmKT0XwC3R',
  'http://promoml.app/--qmKT0XwC3R','https://promoml.app/--qmKT0XwC3R?redirect=https://evil.test',
  'https://promoml.app/invalid'])
  assert.equal(trustedGroupCopyPublicLink(bad),null);
 const output=await withGroupCopyPublicLink({DB:{prepare(){throw Error('not installed')}}},{affiliate_url:DIRECT});
 assert.equal(output.affiliate_url,DIRECT);
 assert.equal(output.public_url,undefined);
});
test('captured social ref from other affiliate resolves product but never retains origin commission',async()=>{
 const social='https://www.mercadolivre.com.br/social/other_affiliate?matt_word=other_affiliate&matt_tool=99999999&ref=ANOTHERREF';
 const event={event:'messages.upsert',instance:'afiliados',data:{key:{remoteJid:'120363000111222333@g.us',fromMe:false,id:'abc'},message:{conversation:social}}};
 const parsed=parseMonitorEvent(event);
 assert.equal(parsed.length,1);
 assert.deepEqual(parsed[0].urls,[social]);
 const res=await inspectMonitorShortlink(social,{fetcher:async(url)=>new Response(null,{status:302,headers:{location:'https://www.mercadolivre.com.br/furadeira-impacto/p/MLB12345678?matt_word=other_affiliate&matt_tool=99999999'}})});
 assert.equal(res.product.product_id,'MLB12345678');
 assert.equal(res.product.url,'https://www.mercadolivre.com.br/furadeira-impacto/p/MLB12345678');
 assert.ok(!res.product.url.includes('other_affiliate'));
});
