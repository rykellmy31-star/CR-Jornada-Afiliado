// Dados da conta Shopee separados dos dados do Mercado Livre.
// O apelido/ID identificam o perfil no painel, mas NÃO concedem acesso à Open API.
const CREATE=`CREATE TABLE IF NOT EXISTS shopee_account (
  id INTEGER PRIMARY KEY CHECK(id=1),
  affiliate_name TEXT NOT NULL DEFAULT '',
  affiliate_id TEXT NOT NULL DEFAULT '',
  api_app_id TEXT NOT NULL DEFAULT '',
  api_secret_cipher TEXT,
  api_status TEXT NOT NULL DEFAULT 'not_configured',
  last_verified_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
)`;
const API='https://open-api.affiliate.shopee.com.br/graphql';
const enc=new TextEncoder();
const fail=(msg,status=400)=>Object.assign(new Error(msg),{status});
export async function ensureShopeeAccount(env){
  await env.DB.prepare(CREATE).run();
  await env.DB.prepare('INSERT OR IGNORE INTO shopee_account(id) VALUES(1)').run();
}
async function raw(env){
  await ensureShopeeAccount(env);
  return env.DB.prepare('SELECT * FROM shopee_account WHERE id=1').first();
}
export async function getShopeeAccount(env){
  const a=await raw(env);
  return {
    affiliate_name:a.affiliate_name,
    affiliate_id:a.affiliate_id,
    api_app_id:a.api_app_id,
    api_configured:!!a.api_app_id&&!!a.api_secret_cipher,
    api_status:a.api_status,
    last_verified_at:a.last_verified_at,
    last_error:a.last_error,
    // Nunca retorne a senha de API nem o texto criptografado, nem parcialmente.
  };
}
export async function saveShopeeProfile(env,body){
  const name=String(body?.affiliate_name||'').trim();
  const id=String(body?.affiliate_id||'').trim();
  if(name.length>80||id.length>60)throw fail('Apelido até 80 caracteres e ID até 60.');
  if(id&&!/^[a-zA-Z0-9_.-]+$/.test(id))throw fail('Use somente letras, números, ponto, hífen ou _ no ID de afiliado.');
  await ensureShopeeAccount(env);
  await env.DB.prepare('UPDATE shopee_account SET affiliate_name=?,affiliate_id=?,updated_at=? WHERE id=1')
    .bind(name,id,Math.floor(Date.now()/1000)).run();
  return {ok:true,...await getShopeeAccount(env)};
}
async function cryptoKey(env){
  if(typeof env.SESSION_SECRET!=='string'||env.SESSION_SECRET.length<16)
    throw fail('SESSION_SECRET ausente ou curto: não é possível proteger a Senha da API.',503);
  const original=await crypto.subtle.importKey('raw',enc.encode(env.SESSION_SECRET),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'HKDF',hash:'SHA-256',salt:enc.encode('crj-shopee-affiliate-api-v1'),
      info:enc.encode('shopee-api-secret-encryption')},
    original,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
const to64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const from64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function seal(env,value){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},await cryptoKey(env),enc.encode(value));
  return to64(iv)+'.'+to64(encrypted);
}
async function unseal(env,value){
  try{
    const [a,b]=value.split('.');
    return new TextDecoder().decode(await crypto.subtle.decrypt(
      {name:'AES-GCM',iv:from64(a)},await cryptoKey(env),from64(b)));
  }catch{throw fail('Não foi possível ler a credencial Shopee. Cadastre novamente a senha da Open API.',503);}
}
export async function saveShopeeCredentials(env,body){
  const appId=String(body?.app_id||'').trim();
  const apiSecret=body?.api_secret;
  if(!/^[0-9]{5,30}$/.test(appId))throw fail('Informe o App ID numérico que aparece na Open API de Afiliados Shopee.');
  if(typeof apiSecret!=='string'||apiSecret.length<8||apiSecret.length>512||/\s/.test(apiSecret))
    throw fail('Informe a Senha da API da Shopee (não a senha de login), com 8 a 512 caracteres, sem espaços.');
  // Nenhuma credencial é registrada em logs, no GitHub, nem devolvida ao navegador.
  const cipher=await seal(env,apiSecret);
  await ensureShopeeAccount(env);
  await env.DB.prepare("UPDATE shopee_account SET api_app_id=?,api_secret_cipher=?,api_status='credentials_saved',last_verified_at=0,last_error=NULL,updated_at=? WHERE id=1")
    .bind(appId,cipher,Math.floor(Date.now()/1000)).run();
  return {ok:true,...await getShopeeAccount(env)};
}
export async function clearShopeeCredentials(env){
  await ensureShopeeAccount(env);
  await env.DB.prepare("UPDATE shopee_account SET api_app_id='',api_secret_cipher=NULL,api_status='not_configured',last_verified_at=0,last_error=NULL,updated_at=? WHERE id=1")
    .bind(Math.floor(Date.now()/1000)).run();
  return {ok:true,...await getShopeeAccount(env)};
}
export async function verifyShopeeApi(env){
  const a=await raw(env);
  if(!a.api_app_id||!a.api_secret_cipher)throw fail('A API Shopee ainda não tem App ID e Senha cadastrados.');
  const secret=await unseal(env,a.api_secret_cipher);
  // Autorização SHA256 segundo formato público da Open API afiliada:
  // sha256(appId + timestamp + JSON body exato + secret).
  const timestamp=Math.floor(Date.now()/1000);
  const body=JSON.stringify({query:'query VerifyConnection { __typename }'});
  const digest=await crypto.subtle.digest('SHA-256',enc.encode(a.api_app_id+timestamp+body+secret));
  const signature=Array.from(new Uint8Array(digest)).map(n=>n.toString(16).padStart(2,'0')).join('');
  let ok=false,description='A verificação não foi concluída. Confira a liberação da Open API e as credenciais.';
  try{
    const response=await fetch(API,{
      method:'POST',headers:{
        'content-type':'application/json','accept':'application/json',
        'authorization':'SHA256 Credential='+a.api_app_id+', Timestamp='+timestamp+', Signature='+signature
      },body,redirect:'error',signal:AbortSignal.timeout(12000)
    });
    const data=await response.json().catch(()=>null);
    ok=response.ok&&typeof data?.data?.__typename==='string'&&
      (!Array.isArray(data.errors)||data.errors.length===0);
    if(!ok){
      const code=data?.errors?.[0]?.extensions?.code;
      if(code===10035)description='A Shopee informou que este App ID ainda não possui acesso à Open API.';
      else if(code===10020)description='A Shopee recusou a assinatura. Confira o App ID e a Senha da API.';
      else if(response.status===401||response.status===403)description='A Shopee recusou o acesso. Verifique se a Open API foi liberada.';
      else if(response.status===429)description='Limite temporário da API atingido. Tente mais tarde.';
      else description='A Shopee não confirmou a conexão. Confira o acesso e os dados, sem alterar o sistema.';
    }
  }catch{
    description='Não foi possível alcançar a Open API da Shopee nesta tentativa.';
  }
  await env.DB.prepare('UPDATE shopee_account SET api_status=?,last_verified_at=?,last_error=?,updated_at=? WHERE id=1')
    .bind(ok?'verified':'verification_failed',ok?timestamp:0,ok?null:description,timestamp).run();
  return {ok,api_status:ok?'verified':'verification_failed',message:ok?'Open API Shopee autenticada com sucesso.':description,...await getShopeeAccount(env)};
}
