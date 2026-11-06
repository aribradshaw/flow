// Runners belong to the server: a whole-workspace save (PUT /api/workspace) keeps what runners
// reported, e.g. a tab running older code that saves runners without their jobs. The pure rule
// (keepRunners / carryRunners) and the real server, on a loopback port with temp folders only.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {keepRunners,carryRunners,cleanRunners} from '../public/agentflow-core.js';
import {merge3} from '../public/sync-core.js';

const T0='2026-11-01T10:00:00.000Z',T1='2026-11-01T11:00:00.000Z',T2='2026-11-01T12:00:00.000Z';
const job=(id,extra={})=>({id,name:id,source:'systemd',schedule:'Daily 03:00',ai:false,enabled:true,lastStatus:'ok',...extra});
const runner=(name,reported,jobs,extra={})=>({name,models:[{id:'m1',label:'M1'}],...(jobs?{jobs,jobsReported:reported}:{}),reported,...extra});
// What a tab from before jobs saved: cleanRunners of that time kept name, models and reported only.
const oldClient=r=>({name:r.name,models:r.models,reported:r.reported});

test('a save without jobs keeps the jobs the runner reported',()=>{
  const stored=[runner('Home server',T1,[job('a'),job('b')])];
  const k=keepRunners(stored,stored.map(oldClient));
  assert.ok(k.changed);assert.deepEqual(k.runners,stored);
  // What the current client sends after normalizing an old save (jobs: [], no jobsReported) is kept back too.
  assert.deepEqual(keepRunners(stored,cleanRunners(stored.map(oldClient))).runners,stored);
});
test('a stale copy never rolls back a newer report; a dropped runner stays; new runners are added',()=>{
  const stored=[runner('Home server',T2,[job('new')]),runner('Laptop',T1,[])];
  const k=keepRunners(stored,[runner('home server',T0,[job('old')]),runner('Cloud',T0,[])]);
  assert.deepEqual(k.runners.map(r=>r.name),['Home server','Laptop','Cloud']);
  assert.deepEqual(k.runners[0],stored[0]);
});
test('a newer copy (an import from a runner\'s newer report) wins, but not with older or missing jobs',()=>{
  const stored=[runner('Home server',T1,[job('a')])];
  assert.deepEqual(keepRunners(stored,[runner('Home server',T2,[job('z')])]).runners,[runner('Home server',T2,[job('z')])]);
  const r=keepRunners(stored,[runner('Home server',T2)]).runners[0];
  assert.equal(r.reported,T2);assert.deepEqual(r.jobs,[job('a')]);assert.equal(r.jobsReported,T1);
  const cleared=runner('Home server',T2,[]);
  assert.deepEqual(keepRunners(stored,[cleared]).runners,[cleared],'a newer report that cleared the jobs stands');
});
test('nothing stored, or nothing different: the save is left alone',()=>{
  const sent=[runner('Home server',T1,[job('a')])];
  assert.deepEqual(keepRunners([],sent),{runners:sent,changed:false});
  assert.deepEqual(keepRunners(undefined,undefined),{runners:[],changed:false});
  assert.equal(keepRunners(sent,structuredClone(sent)).changed,false);
  const d={charts:[],agentflow:{agents:[{id:'x'}],workflows:[],runners:sent}};
  assert.equal(carryRunners(d,structuredClone(d)).changed,false);
  const old={charts:[],agentflow:{agents:[{id:'x'}],workflows:[],runners:sent.map(oldClient)}},c=carryRunners(d,old);
  assert.ok(c.changed);assert.deepEqual(c.data.agentflow,{agents:[{id:'x'}],workflows:[],runners:sent});
  assert.deepEqual(carryRunners(d,{charts:[]}).data.agentflow,{runners:sent},'a save from before AgentFlow keeps the runners too');
});
test('merge3 alone lets a stale local copy win (runners have no id): why the server keeps them',()=>{
  const base={agentflow:{runners:[runner('Home server',T1,[job('a')])]}},local={agentflow:{runners:base.agentflow.runners.map(oldClient)}};
  assert.equal(merge3(base,local,base).agentflow.runners[0].jobs,undefined);
});

const ROOT=fileURLToPath(new URL('..',import.meta.url)),PORT=4383,BASE=`http://127.0.0.1:${PORT}`,TOKEN='runners-save-token-0123456789abcdefghijklmnop';
let dir,app;
const call=async(method,path,body)=>{
  const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+TOKEN},body:body&&JSON.stringify(body)});
  return {status:r.status,data:await r.json().catch(()=>null)};
};
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-runners-'));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(PORT),ORG_CHART_VERIFY:'1',
    BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox')}});
  let err='';app.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
});
after(()=>{app?.kill();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('PUT /api/workspace: an old client\'s save keeps the stored jobs, and says so',async()=>{
  const env='runners-save',jobs=[job('systemd:backup.timer'),job('cron:sync',{ai:true})];
  const ws={active:'c',charts:[{id:'c',name:'C',nodes:[{id:'n',name:'N',type:'entity',x:0,y:0}],edges:[]}],projects:[],timeline:[],
    agentflow:{agents:[],workflows:[],runners:[runner('Home server',T1,jobs)]},environment:{id:env,name:'Runners',visibility:'private',members:[]}};
  let r=await call('PUT',`/api/workspace?env=${env}`,{baseRev:0,data:ws});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.runnersKept,undefined,'the first save (an import) is stored as sent');
  // A tab running code from before jobs: same revision, runners without jobs, and an edit elsewhere.
  const stale={...structuredClone(ws),agentflow:{...ws.agentflow,runners:ws.agentflow.runners.map(oldClient)}};
  stale.charts[0].nodes[0].name='Renamed';
  r=await call('PUT',`/api/workspace?env=${env}`,{baseRev:1,data:stale});
  assert.equal(r.status,200);assert.equal(r.data.runnersKept,true);
  const got=(await call('GET',`/api/workspace?env=${env}`)).data;
  assert.equal(got.rev,2);assert.equal(got.data.charts[0].nodes[0].name,'Renamed','the rest of the save stands');
  assert.deepEqual(got.data.agentflow.runners[0].jobs,jobs);assert.equal(got.data.agentflow.runners[0].jobsReported,T1);
  // A save that leaves runners as stored is not flagged.
  r=await call('PUT',`/api/workspace?env=${env}`,{baseRev:2,data:got.data});
  assert.equal(r.status,200);assert.equal(r.data.runnersKept,undefined);
});

test('PUT /api/workspace: a save cannot lower the next card number, and tells the browser to read it back',async()=>{
  const env='counter-save',ws=n=>({active:'c',charts:[{id:'c',name:'C',nodes:[{id:'n',name:'N',type:'entity',x:0,y:0}],edges:[]}],projects:[],timeline:[],
    devops:{cards:[],nextNumber:n},environment:{id:env,name:'Counter',visibility:'private',members:[]}});
  let r=await call('PUT',`/api/workspace?env=${env}`,{baseRev:0,data:ws(50)});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.countersKept,undefined);
  r=await call('PUT',`/api/workspace?env=${env}`,{baseRev:1,data:ws(2)});
  assert.equal(r.status,200);assert.equal(r.data.countersKept,true);
  const got=(await call('GET',`/api/workspace?env=${env}`)).data;
  assert.equal(got.data.devops.nextNumber,50);
  r=await call('PUT',`/api/workspace?env=${env}`,{baseRev:got.rev,data:got.data});
  assert.equal(r.status,200);assert.equal(r.data.countersKept,undefined,'a save that keeps the number is not flagged');
});
