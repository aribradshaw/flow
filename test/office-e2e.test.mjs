// The 3D office on the real server, in local single-user mode (no sign-in, no database): an API key
// (limited to one environment: agents are per person, so it still reports) reports agents over /api/v1/office, the office's SSE stream sends the snapshot and live updates, and
// presence, chat and Allow / Deny go through /api/office/{env}. Temp folders only.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url)),APP=4416,BASE=`http://127.0.0.1:${APP}`;
let dir,app,key;
const call=async(method,path,body,headers={})=>{
  const r=await fetch(BASE+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  let data=null;try{data=await r.json()}catch{}return {status:r.status,data};
};
const api=(method,path,body)=>call(method,path,body,{authorization:'Bearer '+key});
function sse(path){
  const events=[];let buf='',res;
  const ready=new Promise((ok,no)=>{const req=http.get(BASE+path,r=>{res=r;r.setEncoding('utf8');r.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n\n'))>=0){const b=buf.slice(0,i);buf=buf.slice(i+2);
    const type=/^event: (.+)$/m.exec(b)?.[1],data=/^data: (.+)$/m.exec(b)?.[1];if(type)events.push({type,data:JSON.parse(data)})}});ok(r)});req.on('error',no)});
  const next=async(type,ms=3000)=>{for(const end=Date.now()+ms;Date.now()<end;){const i=events.findIndex(e=>e.type===type);if(i>=0)return events.splice(i,1)[0].data;await new Promise(r=>setTimeout(r,15))}throw Error('no '+type+' event')};
  return {ready,next,close:()=>res?.destroy()};
}

before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-office-'));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',FLOW_SYNC_TOKEN:'',DATABASE_URL:'',PORT:String(APP),ORG_CHART_VERIFY:'1',
    OPID_BASE_URL:'',OPID_APP_ID:'',OPID_APP_SECRET:'',OPID_APP_ORIGIN:'',BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox')}});
  let err='';app.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  const r=await call('POST','/api/keys',{name:'bridge',env:'default-workspace',scopes:['read','write']});
  assert.equal(r.status,201,JSON.stringify(r.data));key=r.data.key;
});
after(()=>{app?.kill();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('local mode: the office opens for the local user with their reported agents, and Allow reaches the reporter',async()=>{
  assert.equal((await call('GET','/api/office/nowhere-env/events')).status,404,'an environment you cannot see');
  assert.equal((await call('POST','/api/office/default-workspace/say',{text:'hi'},{origin:'https://evil.example'})).status,403,'other sites cannot call it');
  let r=await api('PUT','/api/v1/office/agents',{source:'bridge:test',at:new Date().toISOString(),agents:[{id:'t3:1',title:'Fix login',vendor:'claude',model:'Opus 5.5',status:'waiting',activity:'Waiting',
    host:'box',hostLabel:'box · T3',repo:{name:'flow'},children:[{id:'c',title:'Explore',vendor:'claude',status:'running'}],pending:{requestId:'req-1',kind:'approval',summary:'Run: npm test',can:['allow','deny']}}]});
  assert.equal(r.status,200);assert.deepEqual(r.data.actions,[]);
  // Odd rows never fail a report: a null remote, a null repo, numbers for strings, junk rows.
  r=await api('PUT','/api/v1/office/agents',{source:'odd',agents:[{id:'a',repo:{name:'flow',remote:null}},{id:'b',repo:null},{id:7,title:5,children:null,pending:'x'},null,'junk',{title:'no id'}]});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.accepted,3);
  await api('PUT','/api/v1/office/agents',{source:'odd',agents:[]});
  const s=sse('/api/office/default-workspace/events');await s.ready;
  const snap=await s.next('snapshot');
  assert.equal(snap.members.length,1);assert.ok(snap.members[0].me);
  const mine=snap.live[snap.me.key];assert.equal(mine[0].title,'Fix login');assert.deepEqual(mine[0].pending.can,['allow','deny']);
  assert.equal((await call('POST','/api/office/default-workspace/presence',{x:1,z:2,heading:0,moving:true})).status,200);
  assert.equal((await call('POST','/api/office/default-workspace/say',{text:'hello'})).status,200);
  assert.equal((await s.next('say')).text,'hello');
  assert.equal((await call('POST','/api/office/default-workspace/emote',{emote:'heart'})).status,200);
  assert.equal((await s.next('emote')).emote,'heart');
  assert.equal((await call('POST','/api/office/default-workspace/answer',{source:'bridge:test',agentId:'t3:1',requestId:'nope',decision:'allow'})).data.code,'not_waiting');
  const poll=api('GET','/api/v1/office/actions?source=bridge:test&wait=10');
  await new Promise(r=>setTimeout(r,100));
  r=await call('POST','/api/office/default-workspace/answer',{source:'bridge:test',agentId:'t3:1',requestId:'req-1',decision:'allow'});
  assert.equal(r.status,200);const id=r.data.id;
  assert.equal((await s.next('action')).id,id);
  const got=await poll;assert.deepEqual(got.data.actions.map(a=>[a.id,a.decision]),[[id,'allow']]);
  assert.equal((await api('POST','/api/v1/office/actions/'+id,{ok:true,message:'Approved in T3'})).status,200);
  assert.equal((await s.next('result')).result.message,'Approved in T3');
  // The reporter's update reaches the open office.
  await api('PUT','/api/v1/office/agents',{source:'bridge:test',agents:[{id:'t3:1',title:'Fix login',vendor:'claude',status:'running',activity:'Running tests'}]});
  assert.equal((await s.next('agents')).agents[0].activity,'Running tests');
  // MCP has the same operations.
  r=await fetch(BASE+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(x=>x.json());
  assert.ok(['office_agents_report','office_actions_wait','office_actions_result'].every(n=>r.result.tools.some(t=>t.name===n)));
  s.close();
});
