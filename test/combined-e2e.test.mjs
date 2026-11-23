// Combined view end to end (docs/combined.md): synthetic users on a real server (OneProfileID mode against a
// loopback mock). Owner combines a second environment of their own, which holds an environment Bo shared,
// into Default workspace: the cards show, edits go back where each card lives, and nothing of either is
// ever stored in Default workspace. Temp folders only; FLOW_SYNC_URL, FLOW_SYNC_TOKEN and DATABASE_URL
// are blanked or test values, so nothing here can reach production.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createNetServer} from 'node:net';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {linkedFields,noteEdits} from '../public/sync-core.js';
// What the browser sends: the edits its user made to linked and combined records (sync.js noteEdits).
const made=(shown,local)=>noteEdits(null,linkedFields(shown),local);

const ROOT=fileURLToPath(new URL('..',import.meta.url));
// Ports the OS hands out (other suites or servers on this machine may hold fixed ones).
const freePort=()=>new Promise((ok,no)=>{const s=createNetServer().once('error',no);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p))})});
const MOCK=await freePort(),APP=await freePort(),BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-combined-fixture',SECRET='synthetic-combined-secret-0123456789abcdef',TOKEN='combined-e2e-token-0123456789abcdefghijklm';
const OWNER='owner@example.test',BO='bo@example.test';
const USERS={[OWNER]:{id:'u-owner',name:'Example Owner',pw:'pw-owner',localId:'owner'},[BO]:{id:'u-bo',name:'Bo B',pw:'pw-bo',localId:'u-bo'}};
function mockOpid(){
  const sessions=new Map();
  const cookie=req=>(String(req.headers.cookie||'').match(/(?:^|; )oneprofileid\.session_token=([^;]+)/)||[])[1];
  const identity=u=>({user:{id:u.id,email:Object.keys(USERS).find(k=>USERS[k]===u),name:u.name},session:{id:randomUUID()},memberships:[{localId:u.localId}]});
  return http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    const path=req.url.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{};
    if(path==='/sign-in/email'){const u=USERS[b.email];if(!u||u.pw!==b.password)return send(401,{error:'Invalid'});const t=randomUUID();sessions.set(t,u);return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly`])}
    if(path==='/get-session'){const u=sessions.get(cookie(req));return u?send(200,identity(u)):send(401,{error:'No session'})}
    if(path==='/sign-out')return send(200,{success:true});
    send(404,{error:'Not found'});
  })});
}
function agent(){
  const jar=new Map();
  return async(method,path,body)=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=await r.json()}catch{}
    return {status:r.status,data};
  };
}
const card=(id,number,extra={})=>({id,number,title:'Card '+id,description:'',column:'requests',project:'',labels:[],points:null,actual:null,due:'',assignees:[],checklist:[],links:[],item:'',created:'2026-11-01T00:00:00.000Z',updated:'2026-11-01T00:00:00.000Z',moved:'2026-11-01T00:00:00.000Z',...extra});
const labels=[{id:'hi',name:'High',section:'priority',color:'red'},{id:'lo',name:'Low',section:'priority',color:'green'}];
const ws=(id,name,owner,{nodes=[],cards=[],projects=[],timeline=[]}={})=>({active:'c-'+id,charts:[{id:'c-'+id,name,nodes,edges:[]}],projects,timeline,devops:{columns:[],cards,nextNumber:cards.length+1,labels},environment:{id,name,ownerEmail:owner,visibility:'private',members:[]}});
const N=(id,name,type='person')=>({id,name,type,x:0,y:0});

let dir,mock,app,owner,bo,sideEnv,boEnv,shareId;
const stored=env=>JSON.parse(readFileSync(join(dir,'backups','workspaces',env+'.json'),'utf8'));
const get=(who,env,combine)=>who('GET',`/api/workspace?env=${env}${combine?'&combine='+combine:''}`);
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-combined-e2e-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(APP),ORG_CHART_VERIFY:'1',
    BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE}});
  let err='';app.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  owner=agent();bo=agent();
  assert.equal((await owner('POST','/api/auth/sign-in',{email:OWNER,password:'pw-owner'})).status,200);
  assert.equal((await bo('POST','/api/auth/sign-in',{email:BO,password:'pw-bo'})).status,200);
  // Owner's home: Default workspace, cards #1 and #2.
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:0,data:ws('default-workspace','Default workspace',OWNER,{nodes:[N('me','Me')],cards:[card('h1',1),card('h2',2)]})})).status,200);
  // Owner's second environment: a project, an item and cards whose numbers repeat the home's.
  sideEnv=(await owner('POST','/api/environments',{name:'Side gig'})).data.id;
  const side=(await get(owner,sideEnv)).data;
  const sd=ws(sideEnv,'Side gig',OWNER,{nodes:[N('cleo','Cleo Park')],projects:[{id:'sp',name:'Side project',color:'#3d6fb6',entity:''}],
    timeline:[{id:'si',title:'Side launch',kind:'release',status:'planned',start:'2026-12-01',end:'',priority:'',release:'',projects:['sp'],owner:'',link:'',notes:''}],
    cards:[card('s1',1,{project:'sp',labels:['hi'],assignees:[{node:'cleo',role:'developer'}],item:'si'}),card('s2',2)]});
  assert.equal((await owner('PUT','/api/workspace?env='+sideEnv,{baseRev:side.rev,data:sd})).status,200);
  // Bo's environment, shared whole with Owner (edit), placed in Side gig.
  boEnv=(await get(bo,'')).data.env;
  const b=(await get(bo,boEnv)).data;
  assert.equal((await bo('PUT','/api/workspace?env='+boEnv,{baseRev:b.rev,data:ws(boEnv,'Bo board',BO,{cards:[card('b1',1,{title:'Bo task'})]})})).status,200);
  const sh=await bo('POST','/api/shares',{env:boEnv,recipientEmail:OWNER,scope:{kind:'environment'},permission:'edit'});
  assert.equal(sh.status,200,JSON.stringify(sh.data));shareId=sh.data.share.id;
  assert.equal((await owner('POST',`/api/shares/${shareId}/attach`,{env:sideEnv})).status,200);
});
after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('combining shows the other environment\'s cards, items, projects and the share placed there, and nothing without asking',async()=>{
  const plain=(await get(owner,'default-workspace')).data;
  assert.ok(!JSON.stringify(plain.data).includes('cx.'),'nothing combined unless asked');
  const r=(await get(owner,'default-workspace',sideEnv)).data,d=r.data,ids=d.devops.cards.map(c=>c.id);
  assert.ok(ids.includes('h1')&&ids.includes(`cx.${sideEnv}.s1`)&&ids.includes(`cx.${sideEnv}.s2`));
  assert.ok(ids.includes(`cx.${sideEnv}.sh.${shareId}.b1`),'a share placed in the combined environment comes too');
  const s1=d.devops.cards.find(c=>c.id===`cx.${sideEnv}.s1`);
  assert.equal(s1.number,1);assert.equal(s1.project,`cx.${sideEnv}.sp`);assert.deepEqual(s1.labels,[`cx.${sideEnv}.hi`]);assert.equal(s1.assignees[0].node,`cx.${sideEnv}.cleo`);
  assert.ok(d.timeline.some(i=>i.id===`cx.${sideEnv}.si`)&&d.projects.some(p=>p.id===`cx.${sideEnv}.sp`));
  assert.equal(d.charts.length,1,'the mind map is the home\'s only');
  assert.deepEqual(d.combined.map(m=>[m.env,m.name]),[[sideEnv,'Side gig']]);
  assert.ok(d.combined[0].people.some(p=>p.name==='Cleo Park'));
  assert.equal(d.combined[0].shares[0].id,shareId);
  assert.match(r.shared,new RegExp(`cx:${sideEnv}:`),'its revision is in the signature');
  // An environment the user does not own is never combined (Bo's, asked for by id), nor the home itself.
  const other=(await get(owner,'default-workspace',`${boEnv},default-workspace`)).data.data;
  assert.ok(!JSON.stringify(other.devops).includes('cx.')&&!other.combined,'not this user\'s: ignored');
  const boTry=(await get(bo,boEnv,sideEnv)).data.data;
  assert.ok(!boTry.combined&&!JSON.stringify(boTry.devops).includes('Side project'),'Bo cannot combine Owner\'s environment');
});

test('edits to combined cards go back to their own environment, and nothing is stored in the home',async()=>{
  const r=(await get(owner,'default-workspace',sideEnv)).data,shown=r.data,local=structuredClone(shown);
  const s1=local.devops.cards.find(c=>c.id===`cx.${sideEnv}.s1`),b1=local.devops.cards.find(c=>c.id===`cx.${sideEnv}.sh.${shareId}.b1`);
  s1.title='Side renamed';s1.column='doing';s1.labels=[`cx.${sideEnv}.lo`];
  b1.title='Bo task, edited by Owner';
  local.devops.cards.find(c=>c.id==='h1').title='Home renamed';
  local.timeline.find(i=>i.id===`cx.${sideEnv}.si`).status='active';
  const put=await owner('PUT','/api/workspace?env=default-workspace&combine='+sideEnv,{baseRev:r.rev,data:local,sharedEdits:made(shown,local)});
  assert.equal(put.status,200,JSON.stringify(put.data));
  assert.ok(put.data.shared,'the browser is told to read the result back');
  const side=stored(sideEnv).data,ss1=side.devops.cards.find(c=>c.id==='s1');
  assert.deepEqual([ss1.title,ss1.column,ss1.labels],['Side renamed','doing',['lo']]);
  assert.equal(side.timeline.find(i=>i.id==='si').status,'active');
  assert.equal(stored(boEnv).data.devops.cards.find(c=>c.id==='b1').title,'Bo task, edited by Owner','a share placed there goes on to its owner');
  const homeFile=JSON.stringify(stored('default-workspace'));
  assert.ok(!homeFile.includes('cx.')&&!homeFile.includes('Side renamed')&&!homeFile.includes('Bo task')&&!homeFile.includes('"combined"'),'nothing combined is stored in the home');
  const h=stored('default-workspace').data;
  assert.equal(h.devops.cards.find(c=>c.id==='h1').title,'Home renamed');assert.equal(h.devops.nextNumber,3,'the home next number is unchanged');
  assert.ok(!JSON.stringify(stored(sideEnv)).includes('cx.'),'nor in the combined environment');
  // Read back: what the browser sees next.
  const back=(await get(owner,'default-workspace',sideEnv)).data.data;
  assert.equal(back.devops.cards.find(c=>c.id===`cx.${sideEnv}.s1`).title,'Side renamed');
});

test('stale copies, deletions and new cards never reach the combined environment',async()=>{
  const before=stored(sideEnv).data.devops.cards.map(c=>c.id);
  const r=(await get(owner,'default-workspace',sideEnv)).data,d=structuredClone(r.data);
  d.devops.cards=d.devops.cards.filter(c=>c.id!==`cx.${sideEnv}.s2`);
  d.devops.cards.push(card(`cx.${sideEnv}.new`,50,{title:'Planted'}));
  // Differs from what the server holds, but this user did not change it (not in sharedEdits): a stale copy.
  d.devops.cards.find(c=>c.id===`cx.${sideEnv}.s1`).title='Stale value';
  const put=await owner('PUT','/api/workspace?env=default-workspace&combine='+sideEnv,{baseRev:r.rev,data:d,sharedEdits:{}});
  assert.equal(put.status,200,JSON.stringify(put.data));
  const cards=stored(sideEnv).data.devops.cards;
  assert.deepEqual(cards.map(c=>c.id),before,'removing one from the home save deletes nothing there, and nothing is created');
  assert.equal(cards.find(c=>c.id==='s1').title,'Side renamed','a stale copy never overwrites');
  const home=JSON.stringify(stored('default-workspace'));
  assert.ok(!home.includes('Planted')&&!home.includes('Stale value'));
});

test('polling: unchanged while nothing moves, and a change in the combined environment is heard',async()=>{
  const r=(await get(owner,'default-workspace',sideEnv)).data;
  const poll=()=>owner('GET',`/api/workspace?env=default-workspace&combine=${sideEnv}&since=${r.rev}&shared=${encodeURIComponent(r.shared)}`);
  assert.equal((await poll()).data.unchanged,true);
  const s=(await get(owner,sideEnv)).data;s.data.devops.cards.find(c=>c.id==='s2').title='Changed in Side gig';
  assert.equal((await owner('PUT','/api/workspace?env='+sideEnv,{baseRev:s.rev,data:s.data})).status,200);
  const p=(await poll()).data;
  assert.ok(!p.unchanged,'the signature moved');
  assert.equal(p.data.devops.cards.find(c=>c.id===`cx.${sideEnv}.s2`).title,'Changed in Side gig');
});

test('a view-only share placed in the combined environment stays read-only',async()=>{
  assert.equal((await bo('PATCH','/api/shares/'+shareId,{permission:'view'})).status,200);
  const r=(await get(owner,'default-workspace',sideEnv)).data,shown=r.data,local=structuredClone(shown);
  assert.equal(shown.combined[0].shares[0].permission,'view');
  local.devops.cards.find(c=>c.id===`cx.${sideEnv}.sh.${shareId}.b1`).title='Not allowed';
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace&combine='+sideEnv,{baseRev:r.rev,data:local,sharedEdits:made(shown,local)})).status,200);
  assert.equal(stored(boEnv).data.devops.cards.find(c=>c.id==='b1').title,'Bo task, edited by Owner');
  assert.ok(!JSON.stringify(stored(sideEnv)).includes('Not allowed')&&!JSON.stringify(stored('default-workspace')).includes('Not allowed'));
});
