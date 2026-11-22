// Removing someone from Flow, and signing in with the email Flow knows: a real server in OneProfileID
// mode (SSO on) against a loopback mock of OneProfileID that follows its membership rules: /membership/revoke
// (the app secret alone), /membership/events, claims that cannot undo a revocation without a new invitation,
// and the SSO authorize URL's login_hint and prompt. Synthetic users and temp folders only.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MOCK=4406,APP=4407,BASE=`http://127.0.0.1:${APP}`,ISSUER=`http://127.0.0.1:${MOCK}/api/auth`;
const APP_ID='flygon-flow-removal-fixture',SECRET='synthetic-removal-secret-0123456789abcdef',TOKEN='removal-e2e-token-0123456789abcdefghijklmnop';
const SSO_ID='flow-sso-removal',SSO_SECRET='synthetic-removal-sso-secret-0123456789abcdef';
const OWNER='owner@example.test';
const USERS={};const add=(email,member=null)=>USERS[email]={id:'u-'+email.split('@')[0].replace(/\W/g,''),name:email.split('@')[0],pw:'pw-'+email,member};
add(OWNER,'owner');for(const n of ['mia','finn','gus','hal','ivy'])add(n+'@example.test');
// OneProfileID's side: active memberships (user.member), revoked ids, events, and what Flow asked of it.
const opid={invites:new Map(),revoked:new Set(),events:[],revokeCalls:[],eventCalls:[],failRevoke:false};
const event=(localId,kind)=>opid.events.push({id:String(opid.events.length+1),localId,kind,createdAt:new Date().toISOString()});
function mockOpid(){
  const sessions=new Map();
  const cookie=req=>(String(req.headers.cookie||'').match(/(?:^|; )oneprofileid\.session_token=([^;]+)/)||[])[1];
  const emailOf=u=>Object.keys(USERS).find(k=>USERS[k]===u);
  const identity=u=>({user:{id:u.id,email:emailOf(u),name:u.name},session:{id:randomUUID()},memberships:u.member?[{localId:u.member}]:[]});
  return http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    if(req.url.endsWith('/.well-known/openid-configuration'))return send(200,{issuer:ISSUER,authorization_endpoint:ISSUER+'/oauth2/authorize',token_endpoint:ISSUER+'/oauth2/token',jwks_uri:ISSUER+'/jwks',response_types_supported:['code']});
    if(req.headers['x-opid-app']!==APP_ID||req.headers['x-opid-client-secret']!==SECRET)return send(401,{error:'Unknown application'});
    const path=req.url.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{},me=sessions.get(cookie(req));
    if(path==='/sign-in/email'){const u=USERS[b.email];if(!u||u.pw!==b.password)return send(401,{error:'Invalid'});const t=randomUUID();sessions.set(t,u);return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly`])}
    if(path==='/get-session')return me?send(200,identity(me)):send(401,{error:'No session'});
    if(path==='/membership/invite'){
      if(Object.values(USERS).some(u=>u.member===b.localId))return send(409,{error:'This membership already has an identity'});
      const token='tok'+randomUUID().replace(/-/g,'');opid.invites.set(token,{localId:b.localId,email:b.email,used:false});
      return send(200,{token,expiresAt:new Date(Date.now()+72*3600e3).toISOString()});
    }
    if(path==='/membership/claim'){
      if(!me)return send(401,{error:'Complete sign-in first'});
      if('claimedEmail' in b&&emailOf(me)!==b.claimedEmail)return send(403,{error:'Sign in with the email used for this registration'});
      if(Object.values(USERS).some(u=>u!==me&&u.member===b.localId))return send(409,{error:'Membership already belongs to another identity'});
      if(b.inviteToken){const i=opid.invites.get(b.inviteToken);if(!i||i.used||i.localId!==b.localId||i.email!==emailOf(me))return send(409,{error:'Invalid invitation'});i.used=true;if(opid.revoked.delete(b.localId))event(b.localId,'claimed')}
      // Without an invitation a revoked membership stays revoked.
      else if(opid.revoked.has(b.localId))return send(409,{error:'Membership already belongs to another identity'});
      me.member=b.localId;return send(200,{membership:{localId:b.localId}});
    }
    if(path==='/membership/revoke'){
      opid.revokeCalls.push({...b,cookie:String(req.headers.cookie||'')});
      if(opid.failRevoke)return send(503,{error:'Unavailable'});
      const u=Object.values(USERS).find(x=>x.member===b.localId),was=!!u;if(u)u.member=null;
      if(was){opid.revoked.add(b.localId);event(b.localId,'revoked')}
      return send(200,{localId:b.localId,revoked:was,invitationsRevoked:0});
    }
    if(path==='/membership/events'){
      opid.eventCalls.push(b);const after=Number(b.after||0),list=opid.events.filter(e=>Number(e.id)>after);
      return send(200,{events:list,cursor:list.length?list.at(-1).id:String(after),more:false});
    }
    if(path==='/sign-out')return send(200,{success:true});
    send(404,{error:'Not found'});
  })});
}
function agent(){
  const jar=new Map(),ip=`10.9.${Math.floor(Math.random()*250)}.${Math.floor(Math.random()*250)+1}`;
  const call=async(method,path,body,headers={})=>{
    const r=await fetch(BASE+path,{method,redirect:'manual',headers:{'content-type':'application/json','x-forwarded-for':ip,cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');if(/max-age=0/i.test(c))jar.delete(pair.slice(0,i).trim());else jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=await r.clone().json()}catch{}
    return {status:r.status,data,location:r.headers.get('location')||''};
  };
  call.jar=jar;return call;
}
const signIn=(a,email)=>a('POST','/api/auth/sign-in',{email,password:USERS[email].pw});
const until=async(fn,ms=8000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)return null;await new Promise(r=>setTimeout(r,200))}};
const mails=to=>{try{return readFileSync(join(dir,'mail.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(m=>m.to===to)}catch{return []}};
const linkIn=to=>(mails(to).at(-1)?.text.match(/https?:\/\/\S+\/join\?\S+/)||[])[0]||'';
const pathOf=u=>{const x=new URL(u);return x.pathname+x.search};
// A member with a session and an API key for their own environment.
async function memberWithKey(email){
  const a=agent();assert.equal((await signIn(a,email)).status,200);
  const env=(await a('GET','/api/workspace')).data.env;
  const k=await a('POST','/api/keys',{name:'cli',env,scopes:['read']});assert.equal(k.status,201,JSON.stringify(k.data));
  const key=k.data.key,api=()=>fetch(BASE+'/api/v1/envs',{headers:{authorization:'Bearer '+key}}).then(r=>r.status);
  assert.equal(await api(),200);
  return {a,api,key};
}
let dir,mock,app,owner;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-removal-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(APP),ORG_CHART_VERIFY:'1',OWNER_EMAIL:OWNER,
    FLOW_EMAIL_TRANSPORT:'file:'+join(dir,'mail.jsonl'),FLOW_EMAIL_FROM:'Flow <noreply@example.test>',FLOW_MEMBERSHIP_POLL_SECONDS:'1',
    BACKUP_DIR:join(dir,'b'),SAVES_DIR:join(dir,'s'),INBOX_DIR:join(dir,'i'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE,
    OPID_SSO_CLIENT_ID:SSO_ID,OPID_SSO_CLIENT_SECRET:SSO_SECRET,OPID_SSO_ISSUER:ISSUER}});
  let err='';app.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  owner=agent();assert.equal((await signIn(owner,OWNER)).status,200);
});
after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('SSO start pre-fills the email Flow knows and can ask OneProfileID to choose an account',async()=>{
  const a=agent();
  const auth=r=>{assert.equal(r.status,303);const u=new URL(r.location);assert.equal(u.origin+u.pathname,ISSUER+'/oauth2/authorize');return u.searchParams};
  let q=auth(await a('GET','/api/auth/sso/start'));
  assert.equal(q.get('login_hint'),null);assert.equal(q.get('prompt'),null);
  q=auth(await a('GET','/api/auth/sso/start?resume=1&hint='+encodeURIComponent('Finn@Example.test')));
  assert.equal(q.get('login_hint'),'finn@example.test');
  q=auth(await a('GET','/api/auth/sso/start?prompt=select_account'));
  assert.equal(q.get('prompt'),'select_account');assert.equal(q.get('login_hint'),null);
  q=auth(await a('GET','/api/auth/sso/start?prompt=consent&hint=not-an-email'));
  assert.equal(q.get('prompt'),null,'only select_account is passed on');assert.equal(q.get('login_hint'),null,'a malformed hint is dropped');
  // An invite link's address is the default hint.
  await a('GET','/join?invite='+'t'.repeat(32)+'&email=ivy%40example.test');
  q=auth(await a('GET','/api/auth/sso/start'));
  assert.equal(q.get('login_hint'),'ivy@example.test');
});

test('the owner removes a member: OneProfileID revokes it, and their sessions and API keys stop',async()=>{
  const mia=await memberWithKey('mia@example.test');
  const before=(await owner('GET','/api/members')).data.members.find(m=>m.email==='mia@example.test');
  assert.ok(before&&!before.removedAt);
  // Only the owner manages who is in Flow.
  const finn=agent();assert.equal((await signIn(finn,'finn@example.test')).status,200);
  assert.equal((await finn('GET','/api/members')).status,403);
  assert.equal((await finn('DELETE','/api/members?email=mia%40example.test')).status,403);
  assert.equal((await owner('DELETE','/api/members?email='+encodeURIComponent(OWNER))).status,400);
  const localId=USERS['mia@example.test'].member;assert.match(localId,/^s-/);
  const r=await owner('DELETE','/api/members?email=mia%40example.test');
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.opidRevoked,true);
  const call=opid.revokeCalls.at(-1);assert.deepEqual({localId:call.localId,cookie:call.cookie},{localId,cookie:''},'revoked with the app secret alone, never a browser cookie');
  assert.equal((await mia.a('GET','/api/workspace')).status,401,'their session ended');
  assert.equal(await mia.api(),401,'their API key stopped');
  const mcp=await fetch(BASE+'/mcp',{method:'POST',headers:{authorization:'Bearer '+mia.key,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.equal(mcp.status,401,'and MCP with it');
  assert.ok((await owner('GET','/api/members')).data.members.find(m=>m.email==='mia@example.test').removedAt);
  // Signing in again is refused with a reason, and open sign-up does not let them back in.
  const again=agent(),s=await signIn(again,'mia@example.test');
  assert.equal(s.status,403);assert.equal(s.data.code,'revoked');assert.match(s.data.error,/removed this account/);
});

test('a new invite brings a removed person back',async()=>{
  const r=await owner('POST','/api/invites',{email:'mia@example.test'});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.token,true);
  const mia=agent();await mia('GET',pathOf(linkIn('mia@example.test')));
  const s=await signIn(mia,'mia@example.test');
  assert.equal(s.status,200,JSON.stringify(s.data));
  assert.equal((await mia('GET','/api/workspace')).status,200);
  assert.ok(!(await owner('GET','/api/members')).data.members.find(m=>m.email==='mia@example.test').removedAt);
});

test('revoking an invite someone used removes them; only the owner may',async()=>{
  // Gus is invited by Finn (a member) and joins with the link.
  const finn=agent();assert.equal((await signIn(finn,'finn@example.test')).status,200);
  assert.equal((await finn('POST','/api/invites',{email:'gus@example.test'})).status,200);
  const gus=agent();await gus('GET',pathOf(linkIn('gus@example.test')));
  assert.equal((await signIn(gus,'gus@example.test')).status,200);
  const r=await finn('DELETE','/api/invites?email=gus%40example.test');
  assert.equal(r.status,403);assert.equal((await gus('GET','/api/workspace')).status,200,'a member cannot remove who they invited');
  const o=await owner('DELETE','/api/invites?email=gus%40example.test');
  assert.equal(o.status,200);assert.equal(o.data.removed,true);
  assert.equal((await gus('GET','/api/workspace')).status,401);
  assert.equal((await owner('GET','/api/invites')).data.invites.find(i=>i.email==='gus@example.test').revokedAt!==null,true);
});

test('Flow refuses a removed member even when OneProfileID cannot be reached, and retries',async()=>{
  const hal=await memberWithKey('hal@example.test');
  opid.failRevoke=true;
  const r=await owner('DELETE','/api/members?email=hal%40example.test');
  assert.equal(r.status,200);assert.equal(r.data.opidRevoked,false);
  assert.ok(USERS['hal@example.test'].member,'still active on OneProfileID');
  assert.equal((await hal.a('GET','/api/workspace')).status,401);assert.equal(await hal.api(),401);
  const back=agent();const s=await signIn(back,'hal@example.test');
  assert.equal(s.status,403);assert.equal(s.data.code,'revoked','refused by Flow itself');
  opid.failRevoke=false;
  assert.ok(await until(()=>!USERS['hal@example.test'].member),'the poller retries the revocation');
});

test('a revocation made on OneProfileID is applied by the poller, and the cursor is kept',async()=>{
  const ivy=await memberWithKey('ivy@example.test');
  const localId=USERS['ivy@example.test'].member;
  USERS['ivy@example.test'].member=null;opid.revoked.add(localId);event(localId,'revoked');
  assert.ok(await until(async()=>await ivy.api()===401),'their API key stops within a poll');
  assert.equal((await ivy.a('GET','/api/workspace')).status,401);
  const file=join(dir,'b','_membership-cursor.json');
  assert.ok(await until(()=>existsSync(file)&&JSON.parse(readFileSync(file,'utf8')).cursor===opid.events.at(-1).id),'cursor stored');
  assert.ok(opid.eventCalls.some(b=>b.after),'later polls start after the stored cursor');
});
