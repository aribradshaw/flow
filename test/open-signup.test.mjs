// Open sign-up (FLOW_OPEN_SIGNUP, on by default): any verified OneProfileID account gets its own private
// workspace, up to FLOW_MAX_USERS; full and invite-only states name the signed-in email and can record a
// request. A real server in OneProfileID mode against a loopback mock that follows OneProfileID's claim
// rules (allowSelfEnrollment, claimedEmail, one identity per localId). Synthetic users, temp folders only.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {selfLocalId} from '../lib/auth.mjs';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MOCK=4356,APP=4357,APP2=4358,APP_ID='flygon-flow-open-fixture',SECRET='synthetic-open-secret-0123456789abcdef',TOKEN='open-e2e-token-0123456789abcdefghijklmnop';
const OWNER='owner@example.test';
const USERS={};const add=(email,member=null)=>USERS[email]={id:'u-'+email.split('@')[0],name:email.split('@')[0],pw:'pw-'+email,member};
add(OWNER,'owner');for(const n of ['ana','ben','cat','dee','eve'])add(n+'@example.test');
const opid={selfEnroll:true,claims:[]};
function mockOpid(){
  const sessions=new Map();
  const cookie=req=>(String(req.headers.cookie||'').match(/(?:^|; )oneprofileid\.session_token=([^;]+)/)||[])[1];
  const emailOf=u=>Object.keys(USERS).find(k=>USERS[k]===u);
  const identity=u=>({user:{id:u.id,email:emailOf(u),name:u.name},session:{id:randomUUID()},memberships:u.member?[{localId:u.member}]:[]});
  return http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    const path=req.url.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{},me=sessions.get(cookie(req));
    if(path==='/sign-in/email'){const u=USERS[b.email];if(!u||u.pw!==b.password)return send(401,{error:'Invalid'});const t=randomUUID();sessions.set(t,u);return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly`])}
    if(path==='/get-session')return me?send(200,identity(me)):send(401,{error:'No session'});
    if(path==='/membership/claim'){
      opid.claims.push({...b,email:me&&emailOf(me)});
      if(!me)return send(401,{error:'Complete sign-in first'});
      if(!opid.selfEnroll&&typeof b.inviteToken!=='string')return send(403,{error:'Invitation required'});
      if('claimedEmail' in b&&b.claimedEmail!==emailOf(me))return send(403,{error:'Sign in with the email used for this registration'});
      if(Object.values(USERS).some(u=>u!==me&&u.member===b.localId))return send(409,{error:'Membership already belongs to another identity'});
      me.member=b.localId;return send(200,{membership:{localId:b.localId}});
    }
    if(path==='/sign-out')return send(200,{success:true});
    send(404,{error:'Not found'});
  })});
}
function agent(port=APP){
  const jar=new Map(),ip=`10.9.${Math.floor(Math.random()*250)}.${Math.floor(Math.random()*250)+1}`;
  return async(method,path,body)=>{
    const r=await fetch(`http://127.0.0.1:${port}`+path,{method,headers:{'content-type':'application/json','x-forwarded-for':ip,cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=await r.json()}catch{}
    return {status:r.status,data};
  };
}
const signIn=(a,email)=>a('POST','/api/auth/sign-in',{email,password:USERS[email].pw});
let dir,mock,app,app2,owner;
const start=(port,extra)=>{
  const p=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(port),ORG_CHART_VERIFY:'1',OWNER_EMAIL:OWNER,
    BACKUP_DIR:join(dir,'b'+port),SAVES_DIR:join(dir,'s'+port),INBOX_DIR:join(dir,'i'+port),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:`http://127.0.0.1:${port}`,...extra}});
  let err='';p.stderr.on('data',d=>err+=d);
  return new Promise((res,rej)=>{p.stdout.once('data',()=>res(p));p.once('exit',()=>rej(Error('server did not start: '+err)))});
};
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-open-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  app=await start(APP,{FLOW_MAX_USERS:'3'});
  owner=agent();assert.equal((await signIn(owner,OWNER)).status,200);
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:0,data:{active:'c',charts:[{id:'c',name:'Owner',nodes:[{id:'n',name:'Owner secret',type:'entity',x:0,y:0}],edges:[]}],environment:{id:'default-workspace',name:'Default workspace',ownerEmail:OWNER,visibility:'private',members:[]}}})).status,200);
});
after(()=>{app?.kill();app2?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('a membership id of their own: stable per account, never the owner one',()=>{
  assert.equal(selfLocalId('u-1'),selfLocalId('u-1'));assert.notEqual(selfLocalId('u-1'),selfLocalId('u-2'));
  assert.match(selfLocalId('owner'),/^s-[A-Za-z0-9_-]{22}$/);
});

test('any OneProfileID account joins with one claim and gets its own private workspace',async()=>{
  const ana=agent();opid.claims.length=0;
  const r=await signIn(ana,'ana@example.test');
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(opid.claims.length,1,'one claim');
  assert.equal(opid.claims[0].localId,selfLocalId('u-ana'));assert.ok(!('claimedEmail' in opid.claims[0]));
  const w=(await ana('GET','/api/workspace')).data;
  assert.ok(w.env&&w.env!=='default-workspace');assert.equal(w.data.environment.name,'My workspace');
  assert.equal((await ana('GET','/api/workspace?env=default-workspace')).status,404,"the owner's workspace is not even confirmed to exist");
  assert.ok(!JSON.stringify((await ana('GET','/api/saves')).data).includes('Owner secret'));
  // Signing in again later uses the membership: no claim.
  opid.claims.length=0;assert.equal((await signIn(agent(),'ana@example.test')).status,200);assert.equal(opid.claims.length,0);
});

test('when FLOW_MAX_USERS is reached, new people see "full" with their email and can ask to be told; owner invites still get in',async()=>{
  assert.equal((await signIn(agent(),'ben@example.test')).status,200);
  const cat=agent();let r=await signIn(cat,'cat@example.test');
  assert.equal(r.status,403);assert.equal(r.data.code,'full');assert.match(r.data.error,/full/);assert.match(r.data.error,/cat@example\.test/);
  assert.equal((await cat('GET','/api/auth/pending')).data.email,'cat@example.test','the screen can name the signed-in email');
  r=await cat('POST','/api/auth/request-access',{reason:'full'});
  assert.equal(r.status,200);assert.equal(r.data.email,'cat@example.test');
  assert.ok((await owner('GET','/api/invites')).data.requests.some(x=>x.email==='cat@example.test'),'the owner sees the request');
  assert.equal((await agent()('POST','/api/auth/request-access',{})).status,401,'a request needs a OneProfileID sign-in');
  await owner('POST','/api/invites',{email:'cat@example.test',send:false});
  assert.ok(!(await owner('GET','/api/invites')).data.requests.some(x=>x.email==='cat@example.test'),'inviting answers the request');
  r=await signIn(cat,'cat@example.test');assert.equal(r.status,200,'an owner invite gets in even when full');
});

test('until OneProfileID allows self-enrollment, Flow says it is invite-only (with the email) and records requests',async()=>{
  opid.selfEnroll=false;
  try{
    app2=await start(APP2,{});
    const dee=agent(APP2);const r=await signIn(dee,'dee@example.test');
    assert.equal(r.status,403);assert.equal(r.data.code,'closed');assert.match(r.data.error,/invite-only/);assert.match(r.data.error,/dee@example\.test/);
    assert.equal((await dee('POST','/api/auth/request-access',{reason:'closed'})).data.requested,true);
  }finally{opid.selfEnroll=true;app2?.kill();app2=null}
});

test('FLOW_OPEN_SIGNUP=off keeps Flow invite-only, with no claim for people without an invite',async()=>{
  app2=await start(APP2,{FLOW_OPEN_SIGNUP:'off'});
  try{
    const eve=agent(APP2);opid.claims.length=0;
    const r=await signIn(eve,'eve@example.test');
    assert.equal(r.status,403);assert.equal(r.data.code,'denied');assert.match(r.data.error,/eve@example\.test/);
    assert.equal(opid.claims.length,0);
    assert.equal((await eve('GET','/api/auth/session')).data.openSignup,false);
  }finally{app2?.kill();app2=null}
});
