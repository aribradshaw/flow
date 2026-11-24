// Office alerts end to end (docs/concepts/12-office.md): a real server in OneProfileID mode against a
// loopback mock of its gateway. GET /api/office/alerts is signed-in and same-origin only, and carries one
// person's own agents: when Ann's reported agent starts waiting, Ann's stream hears it and Bo's does not.
// Temp folders only; DATABASE_URL and FLOW_SYNC_URL blanked.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MOCK=4426,APP=4427,BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-alerts-fixture',SECRET='synthetic-alerts-secret-0123456789abcdef',TOKEN='alerts-e2e-token-0123456789abcdefghijklmnop';
const ANN='ann@example.test',BO='bo@example.test';
const USERS={[ANN]:{id:'u-ann',name:'Ann Example',pw:'pw-ann',localId:'owner'},[BO]:{id:'u-bo',name:'Bo Example',pw:'pw-bo',localId:'u-bo'}};
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
function agent(){
  const jar=new Map(),cookies=()=>[...jar].map(([k,v])=>`${k}=${v}`).join('; ');
  const call=async(method,path,body,headers={})=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie:cookies(),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=JSON.parse(await r.text())}catch{}
    return {status:r.status,data};
  };
  call.sse=path=>sse(path,{cookie:cookies()});
  return call;
}
function sse(path,headers={}){
  const events=[];let buf='',res;
  const ready=new Promise((ok,no)=>{const req=http.get(BASE+path,{headers},r=>{res=r;r.setEncoding('utf8');r.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n\n'))>=0){const b=buf.slice(0,i);buf=buf.slice(i+2);
    const type=/^event: (.+)$/m.exec(b)?.[1],data=/^data: (.+)$/m.exec(b)?.[1];if(type)events.push({type,data:JSON.parse(data)})}});ok(r)});req.on('error',no)});
  const next=async(type,ms=3000)=>{for(const end=Date.now()+ms;Date.now()<end;){const i=events.findIndex(e=>e.type===type);if(i>=0)return events.splice(i,1)[0].data;await new Promise(r=>setTimeout(r,15))}throw Error('no '+type+' event')};
  return {ready,events,next,close:()=>res?.destroy()};
}

let dir,mock,app,ann,bo,key;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-office-alerts-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(APP),ORG_CHART_VERIFY:'1',OWNER_EMAIL:ANN,
    BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE}});
  let err='';app.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  ann=agent();bo=agent();
  for(const [a,e,pw] of [[ann,ANN,'pw-ann'],[bo,BO,'pw-bo']])assert.equal((await a('POST','/api/auth/sign-in',{email:e,password:pw})).status,200);
  const k=await ann('POST','/api/keys',{name:'bridge',env:'default-workspace',scopes:['read','write']});
  assert.equal(k.status,201,JSON.stringify(k.data));key=k.data.key;
});
after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

const report=agents=>fetch(BASE+'/api/v1/office/agents',{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({source:'bridge:test',agents})}).then(r=>r.status);
const AG={id:'t3:1',title:'Fix login',vendor:'claude',repo:{name:'flow'}};

test('the alert stream: signed in, same origin, GET only; it carries only your own agents\' waits',async()=>{
  assert.equal((await agent()('GET','/api/office/alerts')).status,401,'signed out');
  assert.equal((await ann('GET','/api/office/alerts',undefined,{origin:'https://evil.example'})).status,403,'another site');
  assert.equal((await ann('POST','/api/office/alerts',{})).status,405);
  // An API key is not a way in: the stream is for the app's own page.
  assert.equal((await fetch(BASE+'/api/office/alerts',{headers:{authorization:'Bearer '+key}})).status,401);
  assert.equal(await report([{...AG,status:'running',activity:'Bash: npm test'}]),200);
  const a=ann.sse('/api/office/alerts'),b=bo.sse('/api/office/alerts');await Promise.all([a.ready,b.ready]);
  assert.deepEqual(await a.next('mine'),{waiting:[]});assert.deepEqual(await b.next('mine'),{waiting:[]});
  assert.equal(await report([{...AG,status:'waiting',activity:'Waiting for approval',pending:{requestId:'req-1',kind:'approval',summary:'Run: npm test',can:['allow','deny']}}]),200);
  const w=await a.next('waiting');
  assert.equal(w.id,'t3:1');assert.equal(w.source,'bridge:test');assert.equal(w.pending.summary,'Run: npm test');
  assert.deepEqual((await a.next('mine')).waiting.map(x=>x.id),['t3:1']);
  await new Promise(r=>setTimeout(r,150));
  assert.deepEqual(b.events,[],'Bo hears nothing about Ann\'s agents');
  a.close();b.close();
});
