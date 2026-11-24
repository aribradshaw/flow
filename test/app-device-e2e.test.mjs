// The Flow app's routes and pushes end to end (lib/app-device.mjs, lib/apns.mjs): a real server in
// OneProfileID mode against a loopback mock of its gateway, and a loopback mock of APNs (HTTP/2 without TLS,
// APNS_URL) that checks every request's token signature. Temp folders only; DATABASE_URL and FLOW_SYNC_URL blanked.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import http2 from 'node:http2';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,generateKeyPairSync,createVerify} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MOCK=4461,APP=4462,APNS=4463,BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-app-fixture',SECRET='synthetic-app-secret-0123456789abcdef';
const ANN='ann@example.test',BO='bo@example.test',TOPIC='com.example.flow';
const ANN_PHONE='a1'.repeat(32),BO_PHONE='b2'.repeat(32),DEAD='de'.repeat(32);
const USERS={[ANN]:{id:'u-ann',name:'Ann Example',pw:'pw-ann',localId:'owner'},[BO]:{id:'u-bo',name:'Bo Example',pw:'pw-bo',localId:'u-bo'}};
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});

function mockOpid(){
  const sessions=new Map();
  const cookie=req=>(String(req.headers.cookie||'').match(/(?:^|; )oneprofileid\.session_token=([^;]+)/)||[])[1];
  const identity=u=>({user:{id:u.id,email:Object.keys(USERS).find(k=>USERS[k]===u),name:u.name},session:{id:randomUUID()},memberships:[{localId:u.localId}]});
  return http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    const path=req.url.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{};
    if(path==='/sign-in/email'){const u=USERS[b.email];if(!u||u.pw!==b.password)return send(401,{error:'Invalid'});const t=randomUUID();sessions.set(t,u);return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly`])}
    if(path==='/get-session'){const u=sessions.get(cookie(req));return u?send(200,identity(u)):send(401,{error:'No session'})}
    send(404,{error:'Not found'});
  })});
}
// APNs: records each push after checking its ES256 token; DEAD is an unregistered device.
const pushes=[];
function mockApns(){
  const s=http2.createServer();
  s.on('stream',(stream,h)=>{let body='';stream.setEncoding('utf8');stream.on('data',c=>body+=c);stream.on('end',()=>{
    const [head,claims,sig]=String(h.authorization||'').replace(/^bearer /,'').split('.');
    const ok=!!sig&&createVerify('SHA256').update(`${head}.${claims}`).verify({key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url'));
    const token=h[':path'].split('/').pop();
    pushes.push({token,ok,topic:h['apns-topic'],type:h['apns-push-type'],jwt:ok?JSON.parse(Buffer.from(head,'base64url')):null,payload:JSON.parse(body)});
    if(!ok){stream.respond({':status':403});return stream.end(JSON.stringify({reason:'InvalidProviderToken'}))}
    if(token===DEAD){stream.respond({':status':410});return stream.end(JSON.stringify({reason:'Unregistered'}))}
    stream.respond({':status':200});stream.end();
  })});
  return s;
}
function agent(){
  const jar=new Map(),cookies=()=>[...jar].map(([k,v])=>`${k}=${v}`).join('; ');
  return async(method,path,body)=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie:cookies()},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=JSON.parse(await r.text())}catch{}
    return {status:r.status,data};
  };
}
const keyed=key=>async(method,path,body)=>{
  const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+key},body:body===undefined?undefined:JSON.stringify(body)});
  let data=null;try{data=JSON.parse(await r.text())}catch{}
  return {status:r.status,data};
};
const until=async(fn,ms=3000)=>{for(const end=Date.now()+ms;Date.now()<end;){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,20))}return null};

let dir,mock,apns,app,annKey,annPhone,boPhone,env;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-app-device-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  apns=mockApns();await new Promise(r=>apns.listen(APNS,'127.0.0.1',r));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',PORT:String(APP),ORG_CHART_VERIFY:'1',OWNER_EMAIL:ANN,
    BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE,
    APNS_KEY:privateKey.export({type:'pkcs8',format:'pem'}).replace(/\n/g,'\\n'),APNS_KEY_ID:'KEY0123456',APNS_TEAM_ID:'TEAM012345',APNS_TOPIC:TOPIC,APNS_URL:`http://127.0.0.1:${APNS}`}});
  let err='';app.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  const ann=agent(),bo=agent();
  for(const [a,e,pw] of [[ann,ANN,'pw-ann'],[bo,BO,'pw-bo']])assert.equal((await a('POST','/api/auth/sign-in',{email:e,password:pw})).status,200);
  const made=await ann('POST','/api/environments',{name:'Work'});assert.equal(made.status,200,JSON.stringify(made.data));env=made.data.id;
  const mk=async(a,name,scopes)=>{const k=await a('POST','/api/keys',{name,env:'*',scopes,expiresInDays:30});assert.equal(k.status,201,JSON.stringify(k.data));return k.data.key};
  annKey=keyed(await mk(ann,'bridge',['write']));
  annPhone=keyed(await mk(ann,'Flow app · iPhone t1',['write','device']));
  boPhone=keyed(await mk(bo,'Flow app · iPad t2',['write','device']));
});
after(()=>{app?.kill();mock?.close();apns?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('only a device key reaches /api/app: not an agent\'s key, not no key',async()=>{
  assert.equal((await fetch(BASE+'/api/app/inbox')).status,401);
  const r=await annKey('GET','/api/app/inbox');
  assert.equal(r.status,403);assert.equal(r.data.code,'device_key_required');
  assert.equal((await annKey('POST','/api/app/agents/answer',{source:'x',agentId:'y',requestId:'z',decision:'allow'})).status,403,'an agent cannot approve prompts');
  const ok=await annPhone('GET','/api/app/inbox');
  assert.equal(ok.status,200);assert.deepEqual(ok.data.push,{enabled:true});
  assert.equal((await annPhone('GET','/api/app/nope')).status,404);
});

test('devices: register, validate, remove',async()=>{
  assert.equal((await annPhone('PUT','/api/app/devices',{token:'not-hex',bundle:TOPIC})).status,400);
  assert.equal((await annPhone('PUT','/api/app/devices',{token:ANN_PHONE,bundle:'bad bundle!'})).status,400);
  const r=await annPhone('PUT','/api/app/devices',{token:ANN_PHONE,environment:'sandbox',bundle:TOPIC,prefs:{agents:true,cards:true}});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.device.environment,'sandbox');
  assert.equal((await annPhone('PUT','/api/app/devices',{token:DEAD,bundle:TOPIC})).status,200);
  assert.equal((await boPhone('DELETE','/api/app/devices',{token:ANN_PHONE})).data.removed,false,'not Bo\'s device');
  assert.equal((await boPhone('PUT','/api/app/devices',{token:BO_PHONE,bundle:TOPIC})).status,200);
});

test('an agent starts waiting: a push with Allow / Deny, the inbox lists it, and the phone answers it',async()=>{
  pushes.length=0;
  const AG={id:'t3:1',title:'Fix login',vendor:'claude',status:'waiting',activity:'Waiting for approval',pending:{requestId:'req-1',kind:'approval',summary:'Run: npm test',can:['allow','deny']}};
  // A source's first report never alerts (a reconnect would flood you): it was running, then it waits.
  assert.equal((await annKey('PUT','/api/v1/office/agents',{source:'bridge:test',agents:[{...AG,status:'running',activity:'Bash: npm test',pending:undefined}]})).status,200);
  assert.equal((await annKey('PUT','/api/v1/office/agents',{source:'bridge:test',agents:[AG]})).status,200);
  const p=await until(()=>pushes.find(x=>x.token===ANN_PHONE));
  assert.ok(p,'Ann\'s phone got a push');
  assert.ok(p.ok,'signed with the APNs key');assert.equal(p.jwt.kid,'KEY0123456');assert.equal(p.topic,TOPIC);assert.equal(p.type,'alert');
  assert.equal(p.payload.aps.category,'FLOW_AGENT_APPROVAL');assert.equal(p.payload.aps.alert.body,'Run: npm test');
  assert.deepEqual(p.payload.flow,{type:'agent',source:'bridge:test',agentId:'t3:1',requestId:'req-1',kind:'approval'});
  await until(()=>pushes.some(x=>x.token===DEAD));
  assert.ok(!pushes.some(x=>x.token===BO_PHONE),'nothing to Bo about Ann\'s agent');
  const inbox=await annPhone('GET','/api/app/inbox');
  assert.deepEqual(inbox.data.agents.map(a=>[a.id,a.pending.requestId]),[['t3:1','req-1']]);
  const ans=await annPhone('POST','/api/app/agents/answer',{source:'bridge:test',agentId:'t3:1',requestId:'req-1',decision:'allow'});
  assert.equal(ans.status,200,JSON.stringify(ans.data));assert.equal(ans.data.action.decision,'allow');
  assert.equal((await boPhone('POST','/api/app/agents/answer',{source:'bridge:test',agentId:'t3:1',requestId:'req-1',decision:'deny'})).status,404,'Bo cannot answer Ann\'s agent');
  // APNs said the dead token is gone: the next push skips it.
  pushes.length=0;
  await annKey('PUT','/api/v1/office/agents',{source:'bridge:test',agents:[{...AG,pending:{...AG.pending,requestId:'req-2'}}]});
  await until(()=>pushes.some(x=>x.token===ANN_PHONE));
  assert.ok(!pushes.some(x=>x.token===DEAD));
});

test('cards: assigned to you and moved push to you, not to whoever made the change; your inbox lists them',async()=>{
  pushes.length=0;
  for(const [name,email] of [['Bo Example',BO],['Ann Example',ANN]]){
    const n=await annKey('POST',`/api/v1/envs/${env}/charts/active/nodes`,{name,type:'person',email});
    assert.equal(n.status,201,JSON.stringify(n.data));
  }
  const c=await annKey('POST',`/api/v1/envs/${env}/cards`,{title:'Build sign-up form'});assert.equal(c.status,201,JSON.stringify(c.data));
  const id=c.data.card.id;
  assert.equal((await annKey('PATCH',`/api/v1/envs/${env}/cards/${id}`,{assignees:[{node:'Bo Example',role:'developer'},{node:'Ann Example',role:'tester'}]})).status,200);
  const got=await until(()=>pushes.find(x=>x.token===BO_PHONE));
  assert.ok(got,'Bo was told');
  assert.equal(got.payload.aps.alert.title,'Assigned to you');assert.match(got.payload.aps.alert.body,/^#\d+ Build sign-up form$/);
  assert.deepEqual(got.payload.flow,{type:'card',env,card:id,number:c.data.card.number});
  assert.equal((await annKey('POST',`/api/v1/envs/${env}/cards/${id}/move`,{column:'uat'})).status,200);
  const moved=await until(()=>pushes.find(x=>x.token===BO_PHONE&&x.payload.aps.alert.title==='Moved to UAT'));
  assert.ok(moved,'Bo heard about the move');
  await new Promise(r=>setTimeout(r,150));
  assert.ok(!pushes.some(x=>x.token===ANN_PHONE),'Ann made the changes: nothing to her phone');
  const inbox=await annPhone('GET','/api/app/inbox');
  assert.deepEqual(inbox.data.cards.map(x=>[x.id,x.column,x.roles.join()]),[[id,'uat','tester']]);
  assert.equal(inbox.data.cards[0].envName,'Work');
});

test('a revoked device key: refused, and its device gets no more pushes',async()=>{
  const ann=agent();assert.equal((await ann('POST','/api/auth/sign-in',{email:ANN,password:'pw-ann'})).status,200);
  const keys=(await ann('GET','/api/keys')).data.keys.filter(k=>k.name.startsWith('Flow app')&&!k.revokedAt);
  for(const k of keys)assert.equal((await ann('DELETE',`/api/keys/${k.id}`)).status,200);
  assert.equal((await annPhone('GET','/api/app/inbox')).status,401);
  pushes.length=0;
  await annKey('PUT','/api/v1/office/agents',{source:'bridge:test',agents:[{id:'t3:2',title:'Other',vendor:'claude',status:'waiting',pending:{requestId:'req-9',kind:'approval',summary:'x',can:['allow','deny']}}]});
  await new Promise(r=>setTimeout(r,300));
  assert.ok(!pushes.some(x=>x.token===ANN_PHONE));
});
