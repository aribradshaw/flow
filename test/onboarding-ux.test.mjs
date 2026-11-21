// Onboarding details that need no browser: the SSO sign-in transaction outlives making a OneProfileID
// account (30 minutes), the first-run picker only greets an untouched new workspace, and the empty-chart
// hint. The full journey is measured by tools/onboarding-eval.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {createSsoClient}=require('../lib/opid-sso-client.cjs');

test('a sign-in transaction lasts 30 minutes, not 5',async t=>{
  const PORT=4336,ISSUER=`http://127.0.0.1:${PORT}/api/auth`;
  const srv=http.createServer((req,res)=>{
    if(req.url.endsWith('/.well-known/openid-configuration'))return res.writeHead(200,{'content-type':'application/json'}),res.end(JSON.stringify({issuer:ISSUER,authorization_endpoint:ISSUER+'/oauth2/authorize',token_endpoint:ISSUER+'/oauth2/token',jwks_uri:ISSUER+'/jwks',response_types_supported:['code']}));
    res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:'invalid_grant'}));
  });
  await new Promise(r=>srv.listen(PORT,'127.0.0.1',r));t.after(()=>srv.close());
  const origin='http://127.0.0.1:4337';
  const sso=createSsoClient({issuer:ISSUER,clientId:'c',clientSecret:'x'.repeat(40),redirectUri:origin+'/api/auth/sso/callback',nativeBaseURL:'http://127.0.0.1:4338',appId:'flow-test',nativeSecret:'y'.repeat(40),origin,production:false});
  const {url,cookie}=await sso.start({returnTo:'/'});
  const state=new URL(url).searchParams.get('state'),jar=cookie.split(';')[0];
  const callback=`${origin}/api/auth/sso/callback?code=c1&state=${state}`;
  const real=Date.now;
  try{
    Date.now=()=>real()+25*60e3;
    await assert.rejects(sso.callback({url:callback,cookie:jar}),e=>!/Expired sign-in transaction/.test(e.message),'25 minutes later the transaction still holds (the code exchange is what fails here)');
    Date.now=()=>real()+31*60e3;
    await assert.rejects(sso.callback({url:callback,cookie:jar}),/Expired sign-in transaction/);
  }finally{Date.now=real}
});

test('the first-run picker is for an untouched new workspace only; an empty chart gets a hint',async()=>{
  globalThis.localStorage??={getItem:()=>null,setItem:()=>{}};
  const {untouched,canvasHint}=await import('../public/first-run.js');
  const blank={charts:[{id:'c',name:'Untitled chart',nodes:[],edges:[]}],projects:[],timeline:[],devops:{cards:[]}};
  assert.equal(untouched(blank),true);
  assert.equal(untouched({...blank,charts:[{...blank.charts[0],nodes:[{id:'n'}]}]}),false);
  assert.equal(untouched({...blank,devops:{cards:[{id:'k'}]}}),false);
  assert.equal(untouched({...blank,charts:[...blank.charts,{id:'d',nodes:[],edges:[]}]}),false);
  assert.match(canvasHint(blank.charts[0]),/data-canvas-hint/);assert.match(canvasHint(blank.charts[0]),/Add entity/);
  assert.equal(canvasHint({nodes:[{id:'n'}]}),'');
});
