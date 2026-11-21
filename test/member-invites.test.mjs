// Member invites over OneProfileID invitations: any member may invite a friend (a weekly quota; the owner
// without one), the link carries a one-use token bound to the invited address (or a login alias of it),
// /join keeps it in an httpOnly cookie through sign-up, and the claim sends it as inviteToken. A real server
// in OneProfileID mode against a loopback mock of /membership/invite and /membership/claim that follows
// OneProfileID's rules. Synthetic users and temp folders only.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MOCK=4346,APP=4347,BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-invite-fixture',SECRET='synthetic-invite-secret-0123456789abcdef',TOKEN='invite-e2e-token-0123456789abcdefghijklmnop';
const OWNER='owner@example.test',MIA='mia@example.test';
const USERS={};const add=(email,member=null,aliases=[])=>USERS[email]={id:'u-'+email.split('@')[0].replace(/\W/g,''),name:email.split('@')[0],pw:'pw-'+email,member,aliases};
add(OWNER,'owner');add(MIA,'u-mia');for(const n of ['finn','gus','hal','ida'])add(n+'@example.test');add('alex@example.test',null,['alex.work@example.test']);
const opid={invites:new Map(),allowInvites:true,claims:[],inviteCalls:[]};
function mockOpid(){
  const sessions=new Map();
  const cookie=req=>(String(req.headers.cookie||'').match(/(?:^|; )oneprofileid\.session_token=([^;]+)/)||[])[1];
  const emailOf=u=>Object.keys(USERS).find(k=>USERS[k]===u);
  const owns=(u,e)=>emailOf(u)===e||u.aliases.includes(e);
  const identity=u=>({user:{id:u.id,email:emailOf(u),name:u.name},session:{id:randomUUID()},memberships:u.member?[{localId:u.member}]:[]});
  return http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    const path=req.url.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{},me=sessions.get(cookie(req));
    if(path==='/sign-in/email'){const u=USERS[b.email];if(!u||u.pw!==b.password)return send(401,{error:'Invalid'});const t=randomUUID();sessions.set(t,u);return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly`])}
    if(path==='/get-session')return me?send(200,identity(me)):send(401,{error:'No session'});
    if(path==='/membership/invite'){
      opid.inviteCalls.push({...b,actor:me?emailOf(me):'application'});
      if(!opid.allowInvites)return send(403,{error:'Membership provisioning is unavailable'});
      if(cookie(req)&&!me)return send(401,{error:'Complete sign-in first'});
      if(me&&!me.member)return send(403,{error:'Invitation unavailable'});
      if(Object.values(USERS).some(u=>u.member===b.localId))return send(409,{error:'This membership already has an identity'});
      const token='tok'+randomUUID().replace(/-/g,'');opid.invites.set(token,{localId:b.localId,email:b.email,used:false});
      return send(200,{token,expiresAt:new Date(Date.now()+72*3600e3).toISOString()});
    }
    if(path==='/membership/claim'){
      opid.claims.push({...b,email:me&&emailOf(me)});
      if(!me)return send(401,{error:'Complete sign-in first'});
      if('claimedEmail' in b&&!owns(me,b.claimedEmail))return send(403,{error:'Sign in with the email used for this registration'});
      if(Object.values(USERS).some(u=>u!==me&&u.member===b.localId))return send(409,{error:'Membership already belongs to another identity'});
      if(b.inviteToken){const i=opid.invites.get(b.inviteToken);if(!i||i.used||i.localId!==b.localId||!owns(me,i.email))return send(409,{error:'Membership already belongs to another identity'});i.used=true}
      me.member=b.localId;return send(200,{membership:{localId:b.localId}});
    }
    if(path==='/sign-out')return send(200,{success:true});
    send(404,{error:'Not found'});
  })});
}
function agent(){
  const jar=new Map(),ip=`10.8.${Math.floor(Math.random()*250)}.${Math.floor(Math.random()*250)+1}`;
  const call=async(method,path,body)=>{
    const r=await fetch(BASE+path,{method,redirect:'manual',headers:{'content-type':'application/json','x-forwarded-for':ip,cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:body===undefined?undefined:JSON.stringify(body)});
    const set=r.headers.getSetCookie();
    for(const c of set){const [pair]=c.split(';'),i=pair.indexOf('=');if(/max-age=0/i.test(c))jar.delete(pair.slice(0,i).trim());else jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=await r.clone().json()}catch{}
    return {status:r.status,data,set,text:data?'':await r.text()};
  };
  call.jar=jar;return call;
}
const signIn=(a,email)=>a('POST','/api/auth/sign-in',{email,password:USERS[email].pw});
const mails=to=>{try{return readFileSync(join(dir,'mail.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(m=>m.to===to)}catch{return []}};
const linkIn=to=>(mails(to).at(-1)?.text.match(/https?:\/\/\S+\/join\?\S+/)||[])[0]||'';
const pathOf=u=>{const x=new URL(u);return x.pathname+x.search};
let dir,mock,app,owner,mia;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-invite-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(APP),ORG_CHART_VERIFY:'1',OWNER_EMAIL:OWNER,
    FLOW_EMAIL_TRANSPORT:'file:'+join(dir,'mail.jsonl'),FLOW_EMAIL_FROM:'Flow <noreply@example.test>',
    BACKUP_DIR:join(dir,'b'),SAVES_DIR:join(dir,'s'),INBOX_DIR:join(dir,'i'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE}});
  let err='',out='';app.stderr.on('data',d=>err+=d);app.stdout.on('data',d=>out+=d);app.logs=()=>out+err;
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  owner=agent();mia=agent();
  assert.equal((await signIn(owner,OWNER)).status,200);assert.equal((await signIn(mia,MIA)).status,200);
});
after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('a member invites a friend: a OneProfileID invitation in their name, and an email with the token link',async()=>{
  const r=await mia('POST','/api/invites',{email:'finn@example.test'});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.sent,true);assert.equal(r.data.token,true);
  assert.deepEqual(r.data.quota,{limit:5,used:1});
  const call=opid.inviteCalls.at(-1);assert.equal(call.actor,MIA,"OneProfileID sees the member as the inviter (its own limits apply)");assert.equal(call.sendEmail,false);
  const link=linkIn('finn@example.test');
  assert.match(link,/\/join\?invite=tok[0-9a-f]{32}&email=finn%40example\.test$/);
  const m=mails('finn@example.test').at(-1);
  assert.match(m.text,/^mia invited you to Flygon Flow/);assert.match(m.text,/Make an account/);
  assert.ok(!app.logs().includes(new URL(link).searchParams.get('invite')),'the token is never logged');
});

test('the friend opens /join, makes an account, and the token claims their membership',async()=>{
  const finn=agent(),link=linkIn('finn@example.test');
  const page=await finn('GET',pathOf(link));
  assert.equal(page.status,200);assert.match(page.text,/<html/);
  const c=page.set.find(x=>x.startsWith('flow_invite='));
  assert.ok(c&&/HttpOnly/i.test(c)&&/SameSite=Lax/i.test(c),'the token is kept in an httpOnly cookie');
  opid.claims.length=0;
  const r=await signIn(finn,'finn@example.test');
  assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal(opid.claims.length,1);assert.ok(opid.claims[0].inviteToken,'claimed with the token');assert.ok(!('claimedEmail' in opid.claims[0]));
  assert.ok(!finn.jar.has('flow_invite'),'the cookie is cleared once used');
  assert.ok((await mia('GET','/api/invites')).data.invites.find(i=>i.email==='finn@example.test').claimedAt,'Mia sees Finn joined');
  const w=(await finn('GET','/api/workspace')).data;assert.ok(w.env&&w.env!=='default-workspace');
  assert.equal((await finn('GET','/api/workspace?env=default-workspace')).status,404);
});

test('a token for a login alias works; a token for someone else falls back to an account of their own',async()=>{
  await owner('POST','/api/invites',{email:'alex.work@example.test'});
  const alex=agent();await alex('GET',pathOf(linkIn('alex.work@example.test')));
  opid.claims.length=0;assert.equal((await signIn(alex,'alex@example.test')).status,200);
  assert.equal(opid.claims.length,1);assert.ok(opid.claims[0].inviteToken);
  assert.ok((await owner('GET','/api/invites')).data.invites.find(i=>i.email==='alex.work@example.test').claimedAt);
  // Gus opens a link meant for Hal: the token is refused, and Gus joins on his own instead.
  await mia('POST','/api/invites',{email:'hal@example.test'});
  const gus=agent();await gus('GET',pathOf(linkIn('hal@example.test')));
  opid.claims.length=0;const r=await signIn(gus,'gus@example.test');
  assert.equal(r.status,200);assert.equal(opid.claims.length,2,'the token, then his own membership');
  assert.ok(!(await mia('GET','/api/invites')).data.invites.find(i=>i.email==='hal@example.test').claimedAt,"Hal's invite is still open");
});

test('members have a weekly quota and see only their own invites; the owner has no quota',async()=>{
  // Two used so far (Finn, Hal): three more fit in the week.
  for(const e of ['q1','q2','q3'])assert.equal((await mia('POST','/api/invites',{email:e+'@example.test'})).status,200);
  const r=await mia('POST','/api/invites',{email:'q4@example.test'});
  assert.equal(r.status,429);assert.equal(r.data.code,'invite_quota');assert.match(r.data.error,/5 invites a week/);
  assert.equal((await mia('POST','/api/invites',{email:'q1@example.test',resend:true})).status,429,'resends count too');
  const list=(await mia('GET','/api/invites')).data;
  assert.ok(list.invites.every(i=>i.invitedBy===MIA));assert.equal(list.requests,undefined,'join requests are the owner\'s');
  await mia('DELETE','/api/invites?email=alex.work@example.test');
  assert.ok(!(await owner('GET','/api/invites')).data.invites.find(i=>i.email==='alex.work@example.test').revokedAt,"a member cannot revoke the owner's invite");
  for(let i=0;i<7;i++)assert.equal((await owner('POST','/api/invites',{email:`o${i}@example.test`})).status,200);
  assert.equal((await mia('POST','/api/invites',{email:OWNER})).status,400);
  assert.equal((await mia('POST','/api/invites',{email:'finn@example.test'})).status,409,'someone already in Flow is shared with, not invited');
});

test('without OneProfileID invitations the link names the address only, and the email match still works',async()=>{
  opid.allowInvites=false;
  try{
    const r=await owner('POST','/api/invites',{email:'ida@example.test'});
    assert.equal(r.data.token,false);
    const link=linkIn('ida@example.test');assert.match(link,/\/join\?email=ida%40example\.test$/);
    const ida=agent();await ida('GET',pathOf(link));
    opid.claims.length=0;assert.equal((await signIn(ida,'ida@example.test')).status,200);
    assert.equal(opid.claims.length,1);assert.equal(opid.claims[0].claimedEmail,'ida@example.test');
  }finally{opid.allowInvites=true}
});
