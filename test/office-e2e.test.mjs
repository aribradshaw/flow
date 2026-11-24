// The 3D office on the real server, in local single-user mode (no sign-in, no database): an API key
// (limited to one environment: agents are per person, so it still reports) reports agents over /api/v1/office, the office's SSE stream sends the snapshot and live updates, and
// presence, chat and Allow / Deny go through /api/office/{env}. Temp folders only.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
let dir,app,key,base;
const call=async(method,path,body,headers={})=>{
  const r=await fetch(base+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  let data=null;try{data=await r.json()}catch{}return {status:r.status,data};
};
const api=(method,path,body)=>call(method,path,body,{authorization:'Bearer '+key});
function sse(path,headers={}){
  const events=[];let buf='',res;
  let end;const ended=new Promise(resolve=>{end=resolve});
  const ready=new Promise((ok,no)=>{const req=http.get(base+path,{headers},r=>{res=r;r.once('end',end);r.setEncoding('utf8');r.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n\n'))>=0){const b=buf.slice(0,i);buf=buf.slice(i+2);
    const type=/^event: (.+)$/m.exec(b)?.[1],data=/^data: (.+)$/m.exec(b)?.[1];if(type)events.push({type,data:JSON.parse(data),id:/^id: (.+)$/m.exec(b)?.[1],retry:Number(/^retry: (.+)$/m.exec(b)?.[1])})}});ok(r)});req.on('error',no)});
  const nextEvent=async(type,ms=3000)=>{for(const end=Date.now()+ms;Date.now()<end;){const i=events.findIndex(e=>e.type===type);if(i>=0)return events.splice(i,1)[0];await new Promise(r=>setTimeout(r,15))}throw Error('no '+type+' event')};
  return {ready,ended,nextEvent,next:async type=>(await nextEvent(type)).data,close:()=>res?.destroy()};
}

async function start(){
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',FLOW_SYNC_TOKEN:'',DATABASE_URL:'',PORT:'0',ORG_CHART_VERIFY:'1',
    OPID_BASE_URL:'',OPID_APP_ID:'',OPID_APP_SECRET:'',OPID_APP_ORIGIN:'',BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox')}});
  let err='';app.stderr.on('data',d=>err+=d);
  base=await new Promise((resolve,reject)=>{
    let output='';
    app.stdout.on('data',chunk=>{
      output+=chunk;
      const url=/Flygon Flow: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      if(url)resolve(url);
    });
    app.once('exit',()=>reject(Error('server did not start: '+err)));
  });
}

before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-office-'));
  await start();
  const r=await call('POST','/api/office/default-workspace/bridge-key',{});
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
  assert.deepEqual(snap.yourSources.map(s=>[s.source,s.agents]),[['bridge:test',1],['odd',0]]);
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
  // A dashboard can watch the stream with an API key for the environment (read scope); a bad key is refused.
  assert.equal((await call('GET','/api/office/default-workspace/events',undefined,{authorization:'Bearer flow_test_nope'})).status,401);
  const k=sse('/api/office/default-workspace/events',{authorization:'Bearer '+key});await k.ready;assert.equal((await k.next('snapshot')).live[snap.me.key][0].title,'Fix login');k.close();
  // MCP has the same operations.
  r=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(x=>x.json());
  assert.ok(['office_agents_report','office_actions_wait','office_actions_result'].every(n=>r.result.tools.some(t=>t.name===n)));
  s.close();
});

test('SIGTERM announces restart, closes the stream and preserves the office for its successor',{timeout:10000},async()=>{
  const office='/api/office/default-workspace',source='restart-test';
  const report={source,at:'2026-01-01T00:00:00.000Z',agents:[
    {id:'waiting',status:'waiting',pending:{requestId:'queued',kind:'approval',can:['allow']}},
  ]};
  assert.equal((await call('GET','/health')).status,200);
  assert.equal((await api('PUT','/api/v1/office/agents',report)).status,200);
  const s=sse(office+'/events');await s.ready;
  const snapshot=await s.nextEvent('snapshot');
  const same=sse(office+'/events',{'Last-Event-ID':snapshot.id});await same.ready;
  assert.equal((await same.next('snapshot')).resumedHere,true);
  same.close();
  assert.equal((await call('POST',office+'/presence',{x:7,z:9,status:'Available'})).status,200);
  assert.equal((await call('POST',office+'/say',{text:'Back in a moment'})).status,200);
  const action=await call('POST',office+'/answer',{source,agentId:'waiting',requestId:'queued',decision:'allow'});
  assert.equal(action.status,200);
  const alerts=sse('/api/office/alerts');await alerts.next('mine');
  const late=JSON.stringify({source:'during-drain',agents:[{id:'in-flight'}]});
  const incoming=http.request(base+'/api/v1/office/agents',{method:'PUT',headers:{
    authorization:'Bearer '+key,'content-type':'application/json','content-length':Buffer.byteLength(late),expect:'100-continue',
  }});
  const continued=once(incoming,'continue'),response=once(incoming,'response');incoming.flushHeaders();
  await continued;
  const exit=once(app,'exit');app.kill('SIGTERM');
  const restart=await s.nextEvent('restart');
  incoming.end(late);
  const [finished]=await response;assert.equal(finished.statusCode,200);finished.resume();
  assert.equal((await alerts.nextEvent('restart')).retry,500);
  await alerts.ended;
  assert.equal(restart.retry,500);
  assert.match(restart.id,/^[a-f0-9-]+:\d+$/);
  await s.ended;
  assert.deepEqual(await exit,[0,null]);

  await start();
  const resumed=sse(office+'/events?lastEventId='+encodeURIComponent(restart.id));await resumed.ready;
  const fresh=await resumed.next('snapshot');
  assert.equal(fresh.resumedHere,false);
  assert.equal(fresh.me.key,snapshot.data.me.key);
  assert.equal(fresh.me.status,'Available');
  assert.deepEqual(fresh.people,[]);
  assert.equal(fresh.chat.at(-1).text,'Back in a moment');
  assert.equal(fresh.live[fresh.me.key].find(a=>a.source===source).id,'waiting');
  assert.equal(fresh.live[fresh.me.key].find(a=>a.source==='during-drain').id,'in-flight');
  assert.equal(fresh.yourSources.find(s=>s.source===source).at,report.at);
  assert.ok(fresh.actions.some(a=>a.id===action.data.id));
  assert.deepEqual((await api('GET','/api/v1/office/actions?source='+source)).data.actions.map(a=>a.id),[action.data.id]);
  assert.deepEqual((await api('PUT','/api/v1/office/agents',report)).data.actions,[]);
  resumed.close();
  const secondExit=once(app,'exit');app.kill('SIGTERM');await secondExit;

  await start();
  assert.deepEqual((await api('GET','/api/v1/office/actions?source='+source)).data.actions,[]);
});
