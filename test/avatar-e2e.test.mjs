// Account avatars end to end (docs/concepts/13-avatars.md): synthetic users on a real server in OneProfileID
// mode against a loopback mock. GET/PUT /api/me/avatar (session only, validated, size-capped), GET
// /api/avatar/<key> (only people the viewer already sees, never by email), and one avatar in every office:
// the owner's own and an environment shared with them. Temp folders only; DATABASE_URL and FLOW_SYNC_URL blanked.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {defaultAvatar,lookFromSpec,validateAvatar} from '../public/avatar-spec.js';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const freePort=()=>new Promise((ok,no)=>{const s=createNetServer().once('error',no);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p))})});
const MOCK=await freePort(),APP=await freePort(),BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-avatar-fixture',SECRET='synthetic-avatar-secret-0123456789abcdef',TOKEN='avatar-e2e-token-0123456789abcdefghijklmn';
const OWNER='owner@example.test',BO='bo@example.test',KIM='kim@example.test';
const USERS={[OWNER]:{id:'u-owner',name:'Example Owner',pw:'pw-owner',localId:'owner'},[BO]:{id:'u-bo',name:'Bo Marsh',pw:'pw-bo',localId:'u-bo'},[KIM]:{id:'u-kim',name:'Kim',pw:'pw-kim',localId:'u-kim'}};
function mockOpid(){
  const sessions=new Map();
  const cookie=req=>(String(req.headers.cookie||'').match(/(?:^|; )oneprofileid\.session_token=([^;]+)/)||[])[1];
  const identity=u=>({user:{id:u.id,email:Object.keys(USERS).find(k=>USERS[k]===u),name:u.name},session:{id:randomUUID()},memberships:[{localId:u.localId}]});
  return http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    const path=req.url.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{};
    if(path==='/sign-in/email'){const u=USERS[b.email];if(!u||u.pw!==b.password)return send(401,{error:'Invalid'});const t=randomUUID();sessions.set(t,u);return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly`])}
    if(path==='/get-session'){const u=sessions.get(cookie(req));return u?send(200,identity(u)):send(401,{error:'No session'})}
    if(path==='/profile/member-images'){
      if(!sessions.get(cookie(req)))return send(401,{error:'No session'});
      return send(200,{images:Object.fromEntries(b.userIds.map(id=>[id,`data:image/png;base64,${Buffer.from('photo-of-'+id).toString('base64')}`]))});
    }
    send(404,{error:'Not found'});
  })});
}
function agent(){
  const jar=new Map(),head=()=>({cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')});
  const f=async(method,path,body,headers={})=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',...head(),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=await r.json()}catch{}
    return {status:r.status,data};
  };
  f.sse=path=>{
    const events=[];let buf='',res,status=0;
    const ready=new Promise((ok,no)=>{const req=http.get(BASE+path,{headers:head()},r=>{res=r;status=r.statusCode;r.setEncoding('utf8');
      r.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n\n'))>=0){const b=buf.slice(0,i);buf=buf.slice(i+2);const type=/^event: (.+)$/m.exec(b)?.[1],data=/^data: (.+)$/m.exec(b)?.[1];if(type)events.push({type,data:JSON.parse(data)})}});ok(r)});req.on('error',no)});
    const next=async(type,ms=4000)=>{for(const end=Date.now()+ms;Date.now()<end;){const i=events.findIndex(e=>e.type===type);if(i>=0)return events.splice(i,1)[0].data;await new Promise(r=>setTimeout(r,15))}throw Error('no '+type+' event')};
    return {ready,next,status:()=>status,close:()=>res?.destroy()};
  };
  return f;
}
const N=(id,name,type='entity',extra={})=>({id,name,type,x:0,y:0,...extra});
const fixture=(env,ownerEmail)=>({active:'c1',environment:{id:env,name:'Studio',ownerEmail,visibility:'private',members:[]},
  charts:[{id:'c1',name:'Team',nodes:[{...N('me','Someone','person'),email:ownerEmail}],edges:[]}],projects:[],timeline:[]});
const ENV='default-workspace';

let dir,mock,app,owner,bo,kim,boEnv,boShare;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-avatar-e2e-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(APP),ORG_CHART_VERIFY:'1',OWNER_EMAIL:OWNER,
    BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE}});
  let err='';app.stderr.on('data',d=>{err+=d;if(process.env.DEBUG_E2E)process.stderr.write(d)});
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  owner=agent();bo=agent();kim=agent();
  for(const [a,e,pw] of [[owner,OWNER,'pw-owner'],[bo,BO,'pw-bo'],[kim,KIM,'pw-kim']])assert.equal((await a('POST','/api/auth/sign-in',{email:e,password:pw})).status,200);
  assert.equal((await owner('PUT','/api/workspace?env='+ENV,{baseRev:0,data:fixture(ENV,OWNER)})).status,200);
  boEnv=(await bo('GET','/api/workspace')).data.env;
  for(const a of [kim])assert.equal((await a('GET','/api/workspace')).status,200);
  // The owner shares their whole environment with Bo; Bo shares his with the owner.
  assert.equal((await owner('POST','/api/shares',{env:ENV,recipientEmail:BO,scope:{kind:'environment'},permission:'view'})).status,200);
  const s=await bo('POST','/api/shares',{env:boEnv,recipientEmail:OWNER,scope:{kind:'environment'},permission:'view'});
  assert.equal(s.status,200,JSON.stringify(s.data));boShare=s.data.share.id;
});
after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('GET and PUT /api/me/avatar are for the signed-in page only',async()=>{
  const anon=agent();
  assert.equal((await anon('GET','/api/me/avatar')).status,401);
  assert.equal((await owner('GET','/api/me/avatar',undefined,{origin:'https://evil.example'})).status,403,'other sites cannot read it');
  assert.equal((await owner('GET','/api/me/avatar',undefined,{authorization:'Bearer '+TOKEN})).status,403,'the owner token cannot');
  assert.equal((await owner('PUT','/api/me/avatar',{usePortrait:true},{authorization:'Bearer flow_sk_nope'})).status,403,'nor an API key');
  const r=await owner('GET','/api/me/avatar');
  assert.equal(r.status,200);
  assert.equal(r.data.custom,false);assert.equal(r.data.usePortrait,false);assert.match(r.data.key,/^m[A-Za-z0-9_-]{12}$/);
  assert.deepEqual(r.data.avatar,defaultAvatar(r.data.key),'no avatar yet: the default for their seed');
  assert.ok(!JSON.stringify(r.data).includes('@'),'it carries no email');
});

test('PUT /api/me/avatar validates, caps the size, keeps unknown fields and saves the toggle',async()=>{
  const key=(await owner('GET','/api/me/avatar')).data.key,base=defaultAvatar(key);
  const mine={...base,hair:{style:'afro',color:'#3f6fd1'},hat:{style:'captain',color:'#f3f0e9'},future:{sparkle:true},face:{...base.face,wink:'left'}};
  for(const bad of [{avatar:{...mine,skin:'peach'}},{avatar:{...mine,hat:{style:'crown',color:'#ffffff'}}},{avatar:{...mine,v:2}},{avatar:'x'},{},{avatar:mine,email:'x@example.test'},{usePortrait:'yes'}]){
    const r=await owner('PUT','/api/me/avatar',bad);assert.equal(r.status,400,JSON.stringify(bad));
  }
  assert.equal((await owner('PUT','/api/me/avatar',{avatar:{...mine,notes:'x'.repeat(5000)}})).status,413,'a body over the cap');
  const big=await owner('PUT','/api/me/avatar',{avatar:{...mine,notes:'x'.repeat(1900)}});
  assert.deepEqual([big.status,big.data.code],[413,'avatar_too_large'],'a spec over 2 KB');
  assert.equal((await owner('PUT','/api/me/avatar','{"avatar":',{})).status,400);
  let r=await owner('PUT','/api/me/avatar',{avatar:mine});
  assert.equal(r.status,200);assert.equal(r.data.custom,true);
  assert.deepEqual(r.data.avatar,validateAvatar(mine));
  r=await owner('GET','/api/me/avatar');
  assert.deepEqual([r.data.avatar.future,r.data.avatar.face.wink,r.data.avatar.hair.style],[{sparkle:true},'left','afro'],'unknown fields round-trip');
  r=await owner('PUT','/api/me/avatar',{usePortrait:true});
  assert.deepEqual([r.status,r.data.usePortrait,r.data.avatar.hair.style],[200,true,'afro']);
  // Saving the default is having none; the toggle stays.
  r=await owner('PUT','/api/me/avatar',{avatar:defaultAvatar(key)});
  assert.deepEqual([r.data.custom,r.data.usePortrait],[false,true]);
  r=await owner('PUT','/api/me/avatar',{avatar:mine,usePortrait:false});
  assert.deepEqual([r.data.custom,r.data.usePortrait],[true,false]);
});

test('GET /api/avatar/<key> shows only people the viewer already sees, and never by email',async()=>{
  const ownerKey=(await owner('GET','/api/me/avatar')).data.key,kimKey=(await kim('GET','/api/me/avatar')).data.key;
  const saved=(await owner('GET','/api/me/avatar')).data.avatar;
  // Bo sees the owner: he is a recipient of the owner's environment.
  let r=await bo('GET',`/api/avatar/${ownerKey}?env=${ENV}`);
  assert.equal(r.status,200);assert.deepEqual(r.data,{key:ownerKey,avatar:saved,custom:true});
  // By OneProfileID id too, in the same environment.
  r=await bo('GET',`/api/avatar/u-owner?env=${ENV}`);assert.deepEqual([r.status,r.data.key],[200,ownerKey]);
  // Through the opened shared environment's id as well.
  const opened=(await bo('GET','/api/shares/incoming')).data.shares.find(s=>s.scope?.kind==='environment');
  r=await bo('GET',`/api/avatar/${ownerKey}?env=share-${opened.id}`);assert.deepEqual([r.status,r.data.key],[200,ownerKey]);
  assert.equal((await kim('GET',`/api/avatar/${ownerKey}?env=share-${opened.id}`)).status,404,'someone else\'s opened share');
  // Never by email, never without an environment.
  for(const id of [encodeURIComponent(OWNER),'owner%40example.test'])assert.equal((await bo('GET',`/api/avatar/${id}?env=${ENV}`)).status,400);
  assert.equal((await bo('GET',`/api/avatar/${ownerKey}`)).status,400);
  // Kim has no access to the owner's environment, and is not in it: 404 either way.
  assert.equal((await kim('GET',`/api/avatar/${ownerKey}?env=${ENV}`)).status,404);
  assert.equal((await owner('GET',`/api/avatar/${kimKey}?env=${ENV}`)).status,404,'not a member of this environment');
  assert.equal((await owner('GET',`/api/avatar/mAAAAAAAAAAAA?env=${ENV}`)).status,404);
  assert.equal((await owner('GET',`/api/avatar/${ownerKey}?env=${ENV}`,undefined,{origin:'https://evil.example'})).status,403);
  assert.equal((await owner('PUT',`/api/avatar/${ownerKey}?env=${ENV}`,{avatar:saved})).status,405);
});

test('one avatar in every office: your own, and an environment shared with you',async()=>{
  const me=(await owner('GET','/api/me/avatar')).data,look=lookFromSpec(me.avatar,me.key);
  const a=owner.sse(`/api/office/${ENV}/events`),b=owner.sse(`/api/office/share-${boShare}/events`),seen=bo.sse(`/api/office/${boEnv}/events`);
  try{
    await Promise.all([a.ready,b.ready,seen.ready]);
    assert.deepEqual([a.status(),b.status(),seen.status()],[200,200,200]);
    const [sa,sb,ss]=await Promise.all([a.next('snapshot'),b.next('snapshot'),seen.next('snapshot')]);
    assert.equal(sa.me.key,me.key);assert.equal(sb.me.key,me.key);
    assert.deepEqual(sa.looks[me.key],look,'office A');assert.deepEqual(sb.looks[me.key],look,'office B, shared with them');
    assert.deepEqual(ss.looks[me.key],look,'and what Bo sees there');
    // A change from Settings reaches both offices at once.
    const next={...me.avatar,top:{...me.avatar.top,style:'hoodie'}};
    assert.equal((await owner('PUT','/api/me/avatar',{avatar:next})).status,200);
    for(const s of [a,b,seen])assert.equal((await s.next('look')).look.top,'hoodie');
    // The office's own save route still works, and also saves to the account.
    const r=await owner('POST',`/api/office/share-${boShare}/look`,{look:{...look,top:'blazer'}});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal((await owner('GET','/api/me/avatar')).data.avatar.top.style,'blazer');
    assert.equal((await owner('GET','/api/me/avatar')).data.avatar.future?.sparkle,true,'the office save kept the unknown field');
  }finally{a.close();b.close();seen.close()}
});
