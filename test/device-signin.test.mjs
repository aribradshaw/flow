// Sign in with your phone (lib/device-signin.mjs) against a fake OneProfileID: no network, synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeviceSignIn} from '../lib/device-signin.mjs';

const SECRET='synthetic-client-secret-0123456789abcdef-xyz';
const ISSUER='https://identity.example/api/auth';

function fixture({membership=true,startLimit,deviceStatus='pending'}={}){
  let clock=1_000_000;
  const calls=[],exchanges=[],completes=[];
  const state={status:deviceStatus,slowDown:false,expired:false,used:false};
  const fetchImpl=async(url,init)=>{
    const path=new URL(url).pathname,fields=Object.fromEntries(new URLSearchParams(String(init.body)));
    calls.push({path,fields,auth:init.headers.authorization});
    const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    if(init.headers.authorization!=='Basic '+Buffer.from(`flow-client:${SECRET}`).toString('base64'))return reply(401,{error:'invalid_client'});
    if(path==='/api/auth/device/code')return reply(200,{device_code:'synthetic-device-code',user_code:'ABCDEFGH',verification_uri:'https://identity.example/device',
      verification_uri_complete:'https://identity.example/device?user_code=ABCDEFGH',expires_in:900,interval:5});
    if(path==='/api/auth/oauth2/token'){
      assert.equal(fields.grant_type,'urn:ietf:params:oauth:grant-type:device_code');
      assert.equal(fields.device_code,'synthetic-device-code');
      if(state.slowDown){state.slowDown=false;return reply(400,{error:'slow_down'})}
      if(state.expired)return reply(400,{error:'expired_token'});
      if(state.status==='pending')return reply(400,{error:'authorization_pending'});
      if(state.status==='denied')return reply(400,{error:'access_denied'});
      if(state.used)return reply(400,{error:'invalid_grant'});
      state.used=true;return reply(200,{access_token:'synthetic-access-token',token_type:'Bearer',expires_in:120});
    }
    return reply(404,{});
  };
  const native={request:async(path,{body})=>{exchanges.push({path,body});
    return {ok:true,status:200,payload:{user:{id:'u-1',email:'person@example.test'},memberships:membership?[{localId:'u-1'}]:[]},cookies:['oneprofileid.session_token=synthetic; Path=/; HttpOnly']}}};
  const complete=async(req,set)=>{completes.push(set);
    return membership?{status:200,user:{id:'u-1',email:'person@example.test'},set:[...set,'flow_sid=synthetic-sid; Path=/; HttpOnly']}:{status:403,error:'This OneProfileID account does not have access to Flygon Flow.',set}};
  const d=createDeviceSignIn({issuer:ISSUER,clientId:'flow-client',clientSecret:SECRET,native,complete,secure:true,fetchImpl,now:()=>clock,...(startLimit?{startLimit}:{})});
  const browser=()=>{let cookie='';return {
    get cookie(){return cookie},set cookie(v){cookie=v},
    async call(action){
      const o=await d[action]({headers:{cookie}},{ip:'192.0.2.1',userAgent:'Fixture screen'});
      for(const c of o.set)if(c.startsWith('flow_device=')){const v=c.split(';')[0];cookie=/Max-Age=0/.test(c)?'':v}
      return o;
    }}};
  return {d,state,calls,exchanges,completes,browser,advance:ms=>{clock+=ms}};
}
const tokenPolls=f=>f.calls.filter(c=>c.path==='/api/auth/oauth2/token').length;

test('start: asks OneProfileID with the app credentials and gives the browser a code, a QR and an httpOnly cookie',async()=>{
  const f=fixture(),screen=f.browser();
  const o=await screen.call('start');
  assert.equal(o.status,200);
  assert.equal(f.calls[0].path,'/api/auth/device/code');
  assert.deepEqual(f.calls[0].fields,{client_id:'flow-client',scope:'openid profile email opid:session'});
  assert.equal(o.body.userCode,'ABCDEFGH');
  assert.equal(o.body.verificationUri,'https://identity.example/device');
  assert.equal(o.body.verificationUriComplete,'https://identity.example/device?user_code=ABCDEFGH');
  assert.equal(o.body.expiresIn,900);assert.equal(o.body.interval,5);
  assert.match(o.body.qr,/^<svg[\s\S]*<\/svg>$/);
  assert.ok(!/script|on\w+=/i.test(o.body.qr),'the QR is plain SVG');
  const text=JSON.stringify(o.body);
  assert.ok(!text.includes(SECRET)&&!text.includes('synthetic-device-code'),'no client secret or device code reaches the browser');
  const set=o.set.find(c=>c.startsWith('flow_device='));
  assert.match(set,/HttpOnly/);assert.match(set,/SameSite=Lax/);assert.match(set,/Secure/);assert.match(set,/Path=\/api\/auth\/device/);assert.match(set,/Max-Age=900/);
  assert.match(screen.cookie,/^flow_device=[A-Za-z0-9_-]{43}$/);
});

test('poll: pending, never faster than the interval, slower after slow_down',async()=>{
  const f=fixture(),screen=f.browser();
  await screen.call('start');
  // Too early: OneProfileID is not asked at all.
  let o=await screen.call('poll');
  assert.equal(o.body.status,'pending');assert.equal(tokenPolls(f),0);assert.ok(o.body.retryIn>=1);
  f.advance(5000);
  o=await screen.call('poll');
  assert.equal(o.status,200);assert.equal(o.body.status,'pending');assert.equal(tokenPolls(f),1);
  f.advance(1000);await screen.call('poll');assert.equal(tokenPolls(f),1,'still within the interval');
  f.state.slowDown=true;f.advance(5000);
  o=await screen.call('poll');
  assert.equal(o.body.status,'pending');assert.equal(o.body.interval,10,'slow_down adds five seconds');assert.equal(tokenPolls(f),2);
  f.advance(6000);await screen.call('poll');assert.equal(tokenPolls(f),2,'the new interval is respected');
  f.advance(5000);await screen.call('poll');assert.equal(tokenPolls(f),3);
});

test('poll: expired and denied codes end the pending sign-in',async()=>{
  let f=fixture(),screen=f.browser();
  await screen.call('start');f.state.expired=true;f.advance(5000);
  let o=await screen.call('poll');
  assert.equal(o.status,410);assert.equal(o.body.status,'expired');assert.equal(screen.cookie,'','the cookie is cleared');
  // Past the code's own lifetime the server answers without asking OneProfileID.
  f=fixture();screen=f.browser();await screen.call('start');f.advance(901_000);
  o=await screen.call('poll');assert.equal(o.body.status,'expired');assert.equal(tokenPolls(f),0);
  f=fixture({deviceStatus:'denied'});screen=f.browser();await screen.call('start');f.advance(5000);
  o=await screen.call('poll');
  assert.equal(o.status,403);assert.equal(o.body.status,'denied');assert.equal(f.exchanges.length,0);
  f.advance(5000);assert.equal((await screen.call('poll')).body.status,'missing');
});

test('poll: approved with a membership opens the Flow session through the device exchange, once',async()=>{
  const f=fixture({deviceStatus:'approved'}),screen=f.browser();
  await screen.call('start');f.advance(5000);
  const used=screen.cookie;
  const o=await screen.call('poll');
  assert.equal(o.status,200);assert.equal(o.body.status,'done');assert.equal(o.body.user.id,'u-1');
  assert.deepEqual(f.exchanges,[{path:'/sso/device-exchange',body:{clientId:'flow-client',accessToken:'synthetic-access-token'}}]);
  assert.deepEqual(f.completes,[['oneprofileid.session_token=synthetic; Path=/; HttpOnly']],'the same membership checks as other sign-ins');
  assert.ok(o.set.some(c=>c.startsWith('flow_sid=')));
  assert.ok(o.set.some(c=>c.startsWith('oneprofileid.session_token=')));
  assert.ok(!JSON.stringify(o.body).includes('synthetic-access-token'),'the token never reaches the browser');
  assert.equal(screen.cookie,'');
  // Single use: replaying the old cookie finds nothing.
  screen.cookie=used;f.advance(5000);
  assert.equal((await screen.call('poll')).body.status,'missing');assert.equal(f.exchanges.length,1);assert.equal(tokenPolls(f),1);
});

test('poll: approved without a membership is refused and no Flow session is opened',async()=>{
  const f=fixture({deviceStatus:'approved',membership:false}),screen=f.browser();
  await screen.call('start');f.advance(5000);
  const o=await screen.call('poll');
  assert.equal(o.status,403);assert.equal(o.body.status,'refused');assert.match(o.body.error,/does not have access/);
  assert.ok(!o.set.some(c=>c.startsWith('flow_sid=')));
});

test('only the browser that started a sign-in can complete it',async()=>{
  const f=fixture({deviceStatus:'approved'}),screen=f.browser(),other=f.browser();
  await screen.call('start');f.advance(5000);
  assert.equal((await other.call('poll')).body.status,'missing','no cookie');
  other.cookie='flow_device='+'A'.repeat(43);
  assert.equal((await other.call('poll')).body.status,'missing','a guessed cookie');
  assert.equal(tokenPolls(f),0);assert.equal(f.exchanges.length,0);
  assert.equal((await screen.call('poll')).body.status,'done');
});

test('a new code replaces the old one; cancel forgets it; starts are rate limited',async()=>{
  let f=fixture(),screen=f.browser();
  await screen.call('start');const first=screen.cookie;
  await screen.call('start');assert.notEqual(screen.cookie,first);assert.equal(f.d.size,1);
  await screen.call('cancel');assert.equal(screen.cookie,'');assert.equal(f.d.size,0);
  let n=0;f=fixture({startLimit:()=>++n<=2});screen=f.browser();
  assert.equal((await screen.call('start')).status,200);assert.equal((await screen.call('start')).status,200);
  const limited=await screen.call('start');
  assert.equal(limited.status,429);assert.equal(f.calls.length,2,'a limited start does not reach OneProfileID');
});

test('configuration: https issuer and a real secret are required',()=>{
  const base={issuer:ISSUER,clientId:'flow-client',clientSecret:SECRET,native:{},complete:async()=>({})};
  assert.throws(()=>createDeviceSignIn({...base,issuer:'http://identity.example/api/auth'}));
  assert.throws(()=>createDeviceSignIn({...base,clientSecret:'short'}));
  assert.doesNotThrow(()=>createDeviceSignIn({...base,issuer:'http://127.0.0.1:9/api/auth',secure:false}));
});
