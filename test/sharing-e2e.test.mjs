// Sharing end to end: two synthetic users on a real server (OneProfileID mode against a loopback mock),
// the owner-token CLI, and the recipient's workspace as the browser sees it. Temp folders only; the
// server runs with FLOW_SYNC_URL, FLOW_SYNC_TOKEN (a test one) and DATABASE_URL blanked, so nothing
// here can reach production. Run: node --test 'test/**/*.test.mjs'
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MOCK=4376,APP=4377,BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-share-fixture',SECRET='synthetic-share-secret-0123456789abcdef',TOKEN='share-e2e-token-0123456789abcdefghijklmnop';
const OWNER='owner@example.test',BO='bo@example.test',KIM='kim@example.test';
const USERS={[OWNER]:{id:'u-owner',name:'Example Owner',pw:'pw-owner',localId:'owner'},[BO]:{id:'u-bo',name:'Bo B',pw:'pw-bo',localId:'u-bo'},[KIM]:{id:'u-kim',name:'Kim',pw:'pw-kim',localId:'u-kim'}};
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
  const f=async(method,path,body)=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=await r.json()}catch{}
    return {status:r.status,data};
  };
  f.cookie=async()=>[...jar].map(([k,v])=>`${k}=${v}`).join('; ');
  return f;
}
const cli=args=>new Promise(res=>execFile(process.execPath,['tools/env.mjs',...args,'--to',BASE],{cwd:ROOT,env:{...process.env,FLOW_SYNC_TOKEN:TOKEN}},(e,out,err)=>res({code:e?e.code||1:0,out:out+err})));

// Fictional fixture: Bo -> Marsh -> Campfire Studio -> Campfire Studio Ads; Kestrel Group groups Marsh and
// Kestrel Services; Quill owns 50% of Campfire Studio; Cleo owns Quill and Cedar Ventures.
const N=(id,name,type='entity',x=0,y=0,extra={})=>({id,name,type,x,y,...extra});
const ownerFixture=()=>({active:'c1',environment:{id:'default-workspace',name:"Default workspace",ownerEmail:OWNER,visibility:'private',members:[]},
  charts:[{id:'c1',name:'Flygon',nodes:[N('bo','Bo Marsh','person',656,144),N('marsh','Marsh Holdings LLC','entity',656,320),N('campaign','Campfire Studio','entity',496,544),N('ads','Campfire Studio Ads','area',496,700),
    N('flygon','Kestrel Group','entity',400,0,{notes:'Kestrel private notes'}),N('fms','Kestrel Services','entity',900,0),N('cleo','Cleo Park','person',320,144),N('quill','Quill Ventures LLC','entity',320,320,{notes:'Quill private notes'}),
    N('labs','Quill Labs','entity',100,500),N('cedar','Cedar Ventures','entity',100,144),N('memo','Private memo','note',0,900,{notes:'Owner only'})],
   edges:[{id:'o-bo',from:'bo',to:'marsh',type:'ownership',percent:''},{id:'o-marsh',from:'marsh',to:'campaign',type:'ownership',percent:'50'},{id:'g-ads',from:'campaign',to:'ads',type:'group',percent:''},
    {id:'g-marsh',from:'flygon',to:'marsh',type:'group',percent:''},{id:'g-fms',from:'flygon',to:'fms',type:'group',percent:''},{id:'o-sun',from:'quill',to:'campaign',type:'ownership',percent:'50'},
    {id:'o-cleo',from:'cleo',to:'quill',type:'ownership',percent:'50'},{id:'o-labs',from:'quill',to:'labs',type:'ownership',percent:'100'},{id:'o-delg',from:'cleo',to:'cedar',type:'ownership',percent:'100'}]},
   {id:'c2',name:'Private chart',nodes:[N('secret','Secret Holdings','entity',0,0)],edges:[]}],
  projects:[{id:'p-cb',name:'Studio launch',color:'#a8524c',entity:'campaign'},{id:'p-fms',name:'Service retainer',color:'#3d6fb6',entity:'fms'}],
  timeline:[{id:'i-cb',title:'Launch',kind:'release',status:'planned',start:'2026-12-01',end:'',priority:'',release:'',projects:['p-cb'],owner:'',link:'',notes:''},
    {id:'i-fms',title:'Service invoice',kind:'deadline',status:'planned',start:'2026-11-15',end:'',priority:'',release:'',projects:['p-fms'],owner:'',link:'',notes:''}]});
const PRIVATE=['Kestrel Services','Cleo Park','Quill Labs','Cedar Ventures','Private memo','Owner only','Secret Holdings','Service retainer','Service invoice','Kestrel private notes','Quill private notes','Private chart'];
const linked=d=>d.charts.flatMap(c=>c.nodes).filter(n=>n.id.startsWith('sh.'));

let dir,mock,app,owner,bo,kim,boEnv,shareId;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-share-e2e-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(APP),ORG_CHART_VERIFY:'1',
    BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE}});
  let err='';app.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  owner=agent();bo=agent();kim=agent();
  assert.equal((await owner('POST','/api/auth/sign-in',{email:OWNER,password:'pw-owner'})).status,200);
  assert.equal((await bo('POST','/api/auth/sign-in',{email:BO,password:'pw-bo'})).status,200);
  assert.equal((await kim('POST','/api/auth/sign-in',{email:KIM,password:'pw-kim'})).status,200);
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:0,data:ownerFixture()})).status,200);
  boEnv=(await bo('GET','/api/workspace')).data.env;
  assert.ok(boEnv&&boEnv!=='default-workspace');
});
after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('only the owner can share or list shares; others get 404',async()=>{
  const scope={kind:'person',nodeId:'bo'};
  assert.equal((await bo('POST','/api/shares',{env:'default-workspace',recipientEmail:KIM,scope,permission:'view'})).status,404);
  assert.equal((await bo('GET','/api/shares?env=default-workspace')).status,404);
  assert.equal((await bo('POST','/api/shares/preview',{env:'default-workspace',scope})).status,404);
  assert.equal((await agent()('GET','/api/shares/incoming')).status,401);
});

test("the owner's preview of Bo's scope: Marsh and Campfire Studio, stubs for Kestrel Group and Quill, nothing else",async()=>{
  const r=await owner('POST','/api/shares/preview',{env:'default-workspace',scope:{kind:'person',nodeId:'bo'}});
  assert.equal(r.status,200);
  assert.deepEqual(r.data.preview.nodes.map(n=>n.name).sort(),['Bo Marsh','Campfire Studio','Campfire Studio Ads','Marsh Holdings LLC']);
  assert.deepEqual(r.data.preview.stubs.map(n=>n.name).sort(),['Kestrel Group','Quill Ventures LLC']);
  assert.deepEqual(r.data.preview.projects.map(p=>p.name),['Studio launch']);
  for(const p of PRIVATE)assert.ok(!JSON.stringify(r.data).includes(p),p+' must not be in the preview');
});

test('the owner-token CLI shares a person by name (preview first, token never printed), and lists it',async()=>{
  const dry=await cli(['share','--env','default-workspace','--person','Bo Marsh','--permission','edit','--email',BO,'--dry-run']);
  assert.equal(dry.code,0,dry.out);assert.match(dry.out,/Marsh Holdings LLC/);assert.match(dry.out,/Dry run/);
  const c=await cli(['share','--env','default-workspace','--person','Bo Marsh','--permission','edit','--email',BO]);
  assert.equal(c.code,0,c.out);
  assert.match(c.out,/Cards \(4\): .*Marsh Holdings LLC.*Campfire Studio/);assert.match(c.out,/stubs.*Kestrel Group.*Quill Ventures LLC/);
  for(const p of PRIVATE)assert.ok(!c.out.includes(p),p+' must not be printed');
  assert.ok(!c.out.includes(TOKEN));
  shareId=/Shared: ([0-9a-f-]{36})/.exec(c.out)?.[1];assert.ok(shareId,c.out);
  const again=await cli(['share','--env','default-workspace','--person','Bo Marsh','--permission','edit','--email',BO]);
  assert.match(again.out,/Already shared/);
  const list=await cli(['shares','--env','default-workspace']);
  assert.equal(list.out.trim().split('\n').length,1);assert.match(list.out,new RegExp(`${shareId}\\s+${BO}\\s+edit\\s+Bo Marsh and everything below`));
  assert.notEqual((await cli(['share','--env','default-workspace','--person','Nobody Here','--email',BO])).code,0);
});

test('the recipient sees it under Shared with you and adds it to their own environment',async()=>{
  let r=await bo('GET','/api/shares/incoming');
  assert.equal(r.data.shares.length,1);assert.equal(r.data.shares[0].id,shareId);assert.deepEqual(r.data.shares[0].envs,[]);
  assert.equal((await kim('GET','/api/shares/incoming')).data.shares.length,0);
  assert.equal((await kim('GET',`/api/shares/${shareId}/preview`)).status,404,'someone else cannot preview it');
  assert.equal((await bo('POST',`/api/shares/${shareId}/attach`,{env:'default-workspace'})).status,404,"Bo cannot attach it to Owner's environment");
  assert.equal((await bo('POST',`/api/shares/${shareId}/attach`,{env:boEnv})).status,200);
  assert.deepEqual((await bo('GET','/api/shares/incoming')).data.shares[0].envs,[boEnv]);
});

// The 3D office (docs/concepts/12-office.md): a share's recipient is a member of the owner's office and sees a
// live agent's details only when its repo belongs to a project in their share's scope; Kim, with no share, cannot enter.
test("3D office: Bo enters the owner's office; agents in Bo's shared project show in full, others as Private project",async()=>{
  const k=await owner('POST','/api/keys',{name:'office',env:'*',scopes:['read','write']});assert.equal(k.status,201);
  assert.equal((await owner('PATCH','/api/v1/envs/default-workspace/projects/Studio%20launch',{repos:['acme/studio']})).status,200);
  assert.equal((await owner('PATCH','/api/v1/envs/default-workspace/projects/Service%20retainer',{repos:['acme/retainer']})).status,200);
  const put=await fetch(BASE+'/api/v1/office/agents',{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+k.data.key},body:JSON.stringify({source:'bridge:t',agents:[
    {id:'a1',title:'Studio fix',vendor:'claude',status:'running',repo:{name:'studio',remote:'git@github.com:acme/studio.git'}},
    {id:'a2',title:'Retainer invoice script',vendor:'codex',status:'waiting',repo:{name:'retainer',remote:'https://github.com/acme/retainer'},pending:{requestId:'r',summary:'Run: send invoices',can:['allow']}}]})});
  assert.equal(put.status,200);
  const snapshot=async who=>{
    const r=await fetch(BASE+'/api/office/default-workspace/events',{headers:{cookie:await who.cookie()}});
    if(r.status!==200)return {status:r.status};
    const rd=r.body.getReader(),dec=new TextDecoder();let buf='';
    try{for(;;){const {value,done}=await rd.read();if(done)break;buf+=dec.decode(value);const m=/event: snapshot\ndata: (.+)\n\n/.exec(buf);if(m)return {status:200,data:JSON.parse(m[1])}}}finally{rd.cancel().catch(()=>{})}
  };
  const b=await snapshot(bo),mine=b.data.live[b.data.members.find(m=>m.owner).key];
  assert.equal(b.status,200);assert.equal(b.data.members.length,2,'the owner and Bo have rooms');
  assert.deepEqual(mine.map(a=>a.private?'private':a.title),['Studio fix','private']);
  const text=JSON.stringify(b.data);for(const s of ['Retainer','retainer','send invoices','Service retainer'])assert.ok(!text.includes(s),s+' must not reach Bo');
  assert.equal((await snapshot(kim)).status,404,'no share, no office');
  const o=await snapshot(owner);assert.deepEqual(o.data.live[o.data.me.key].map(a=>a.title),['Studio fix','Retainer invoice script']);
  for(const p of ['Studio%20launch','Service%20retainer'])await owner('PATCH','/api/v1/envs/default-workspace/projects/'+p,{repos:[]});
  await fetch(BASE+'/api/v1/office/agents',{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+k.data.key},body:JSON.stringify({source:'bridge:t',agents:[]})});
});

test("Bo's workspace: Marsh and Campfire Studio linked, Kestrel Group and Quill as read-only stubs, never anything else",async()=>{
  const r=await bo('GET','/api/workspace?env='+boEnv),d=r.data.data,nodes=linked(d);
  assert.deepEqual(nodes.filter(n=>!n.linked.stub).map(n=>n.name).sort(),['Bo Marsh','Campfire Studio','Campfire Studio Ads','Marsh Holdings LLC']);
  assert.deepEqual(nodes.filter(n=>n.linked.stub).map(n=>n.name).sort(),['Kestrel Group','Quill Ventures LLC']);
  assert.ok(nodes.filter(n=>n.linked.stub).every(n=>n.linked.readOnly&&n.notes===undefined),'stubs carry name and type only');
  assert.ok(nodes.every(n=>n.linked.permission==='edit'&&n.linked.home==='default-workspace'));
  const body=JSON.stringify(r.data);
  for(const p of PRIVATE)assert.ok(!body.includes(p),p+' must never reach Bo');
  assert.ok(d.shares?.[0]?.id===shareId&&r.data.shared.startsWith(shareId),'the response describes the share and signs it');
  assert.ok(d.timeline.some(i=>i.title==='Launch')&&d.projects.some(p=>p.name==='Studio launch'));
  // Kim and the anonymous never see it; Owner's own workspace is unchanged.
  assert.equal((await kim('GET','/api/workspace?env='+boEnv)).status,404);
  assert.ok(!linked((await owner('GET','/api/workspace?env=default-workspace')).data.data).length);
});

test('edits sync both ways per permission; stubs and layout stay with their owner',async()=>{
  const {fieldBase}=await import('../public/sync-core.js');
  let r=await bo('GET','/api/workspace?env='+boEnv);const d=r.data.data,rev=r.data.rev,served=structuredClone(d);
  const marsh=linked(d).find(n=>n.name==='Marsh Holdings LLC'),stub=linked(d).find(n=>n.name==='Kestrel Group');
  marsh.name='Marsh Holdings';marsh.x=2000;stub.name='Hacked';
  // Bo's own card and a private edge to the linked Marsh.
  const mine=d.charts.find(c=>c.nodes.includes(marsh));mine.nodes.push(N('bo-own','Bo Side LLC','entity',0,0));mine.edges.push({id:'bo-edge',from:'bo-own',to:marsh.id,type:'ownership',percent:'10'});
  // The browser sends the edits its user made (sync-core noteEdits), here the same as fieldBase of what was served.
  r=await bo('PUT','/api/workspace?env='+boEnv,{baseRev:rev,data:d,sharedEdits:fieldBase(served,d)});assert.equal(r.status,200,JSON.stringify(r.data));
  const home=(await owner('GET','/api/workspace?env=default-workspace')).data.data,hn=home.charts[0].nodes;
  assert.equal(hn.find(n=>n.id==='marsh').name,'Marsh Holdings','an edit-permission rename reaches the owner');
  assert.equal(hn.find(n=>n.id==='marsh').x,656,"Bo's layout is his own");
  assert.equal(hn.find(n=>n.id==='flygon').name,'Kestrel Group','stubs are read-only');
  assert.ok(!JSON.stringify(home).includes('Bo Side LLC')&&!JSON.stringify(home).includes('bo-edge'),"Bo's private data never reaches Owner");
  const h=(await owner('GET',`/api/shares/${shareId}/history?kind=node&id=marsh`)).data.history;
  assert.ok(h.some(e=>e.field==='name'&&e.new==='Marsh Holdings'&&e.by===BO),'the edit is in the history');
  r=await bo('GET','/api/workspace?env='+boEnv);
  const back=linked(r.data.data).find(n=>n.id===marsh.id);
  assert.equal(back.x,2000,'placement kept');assert.ok(r.data.data.charts.some(c=>c.edges.some(e=>e.id==='bo-edge')),'private edge to a linked card survives');
  assert.equal(linked(r.data.data).find(n=>n.linked.stub&&n.id.endsWith('.flygon')).name,'Kestrel Group');
  // The owner edits: Bo's poll with ?since + shared signature sees it.
  const sig=r.data.shared,jrev=r.data.rev;
  assert.equal((await bo('GET',`/api/workspace?env=${boEnv}&since=${jrev}&shared=${encodeURIComponent(sig)}`)).data.unchanged,true);
  const a=(await owner('GET','/api/workspace?env=default-workspace')).data;a.data.charts[0].nodes.find(n=>n.id==='campaign').notes='Kickoff Monday';
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:a.rev,data:a.data})).status,200);
  r=await bo('GET',`/api/workspace?env=${boEnv}&since=${jrev}&shared=${encodeURIComponent(sig)}`);
  assert.ok(!r.data.unchanged&&linked(r.data.data).find(n=>n.name==='Campfire Studio').notes==='Kickoff Monday','owner edits reach Bo');
});

test('view permission: Bo edits are dropped; comments need comment permission',async()=>{
  assert.equal((await bo('PATCH',`/api/shares/${shareId}`,{permission:'view'})).status,404,'Bo cannot change his own permission');
  assert.equal((await owner('PATCH',`/api/shares/${shareId}`,{permission:'view'})).data.share.permission,'view');
  let r=await bo('GET','/api/workspace?env='+boEnv);const d=r.data.data;
  const n=linked(d).find(n=>n.name==='Campfire Studio');n.name='Renamed by Bo';
  assert.equal((await bo('PUT','/api/workspace?env='+boEnv,{baseRev:r.data.rev,data:d,sharedEdits:{node:{[n.id]:{name:'Campfire Studio'}}}})).status,200);
  assert.ok((await owner('GET','/api/workspace?env=default-workspace')).data.data.charts[0].nodes.some(n=>n.name==='Campfire Studio'));
  assert.equal((await bo('POST',`/api/shares/${shareId}/comments`,{kind:'node',id:'campaign',comment:'hi'})).status,403);
  await owner('PATCH',`/api/shares/${shareId}`,{permission:'comment'});
  assert.equal((await bo('POST',`/api/shares/${shareId}/comments`,{kind:'node',id:'campaign',comment:'Looks good'})).status,200);
  assert.equal((await bo('POST',`/api/shares/${shareId}/comments`,{kind:'node',id:'fms',comment:'peek'})).status,404,'out of scope');
  assert.equal((await bo('POST',`/api/shares/${shareId}/comments`,{kind:'node',id:'flygon',comment:'x'})).status,403,'stubs take no comments');
  await owner('PATCH',`/api/shares/${shareId}`,{permission:'edit'});
});

test('share requests go to the owner for approval',async()=>{
  assert.equal((await bo('POST','/api/shares',{env:boEnv,recipientEmail:KIM,scope:{kind:'person',nodeId:`sh.${shareId}.bo`}})).status,400,'Bo cannot share linked cards on from his own environment');
  let r=await bo('POST',`/api/shares/${shareId}/requests`,{toEmail:KIM,permission:'edit',note:'Kim helps with Marsh'});
  assert.equal(r.status,200);const rid=r.data.request.id;
  assert.equal((await kim('POST',`/api/share-requests/${rid}`,{approve:true})).status,404);
  r=await owner('GET','/api/share-requests');assert.ok(r.data.requests.some(x=>x.id===rid&&x.toEmail===KIM));
  r=await owner('POST',`/api/share-requests/${rid}`,{approve:true,permission:'view'});
  assert.equal(r.status,200);assert.equal(r.data.share.permission,'view');assert.equal(r.data.share.recipientEmail,KIM);
  assert.equal((await owner('POST',`/api/share-requests/${rid}`,{approve:false})).status,409);
  assert.equal((await kim('GET','/api/shares/incoming')).data.shares.length,1);
  await owner('DELETE',`/api/shares/${r.data.share.id}`);
});

test("revoke removes everything from Bo's workspace and keeps his own data",async()=>{
  assert.equal((await bo('DELETE',`/api/shares/${shareId}`)).status,404,'only the owner revokes');
  const c=await cli(['unshare',shareId]);assert.equal(c.code,0,c.out);
  const r=await bo('GET','/api/workspace?env='+boEnv),d=r.data.data;
  assert.equal(linked(d).length,0);
  const all=JSON.stringify(d);for(const p of ['Marsh','Campaign','Flygon','Quill',"Default workspace"])assert.ok(!all.includes(p),p+' left after revoke');
  assert.ok(!d.projects.length&&!d.timeline.length&&d.charts.every(c=>c.nodes.every(n=>!n.id.startsWith('sh.'))&&c.edges.every(e=>!e.id.startsWith('sh.'))));
  assert.ok(d.charts.some(c=>c.nodes.some(n=>n.name==='Bo Side LLC')),"Bo's own card stays");
  assert.ok(d.charts.every(c=>c.edges.every(e=>c.nodes.some(n=>n.id===e.from)&&c.nodes.some(n=>n.id===e.to))),'no dangling edges');
  assert.equal((await bo('GET','/api/shares/incoming')).data.shares.length,0);
  assert.equal((await bo('GET',`/api/shares/${shareId}/preview`)).status,404);
});

// An extra grouping path makes a person scope broader than a hand-picked scope.
test("hand-picked share for Bo: exactly Marsh and Campfire Studio, stubs Kestrel Group and Quill, nothing else",async()=>{
  const a=(await owner('GET','/api/workspace?env=default-workspace')).data,c=a.data.charts[0];
  c.nodes.push(N('hfa','Example App','area',800,100),N('emo','Example Board','entity',900,400));
  Object.assign(c.edges.find(e=>e.id==='g-marsh'),{type:'ownership',percent:'50'});
  c.edges.push({id:'g-bo-hfa',from:'bo',to:'hfa',type:'group',percent:''},{id:'g-hfa-fl',from:'hfa',to:'flygon',type:'group',percent:''},{id:'o-marsh-emo',from:'marsh',to:'emo',type:'ownership',percent:'50'});
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:a.rev,data:a.data})).status,200);
  const wide=await owner('POST','/api/shares/preview',{env:'default-workspace',scope:{kind:'person',nodeId:'bo'}});
  assert.ok(wide.data.preview.nodes.some(n=>n.name==='Kestrel Services'),'a person walk from Bo now reaches FMS (why it is not used)');
  const dry=await cli(['share','--env','default-workspace','--node','Bo Marsh','--node','Marsh Holdings','--node','Campfire Studio','--permission','edit','--email',BO,'--dry-run']);
  assert.equal(dry.code,0,dry.out);
  assert.match(dry.out,/Cards \(3\): Bo Marsh, Marsh Holdings, Campfire Studio\n/);
  assert.match(dry.out,/stubs, name only \(2\): Kestrel Group → Marsh Holdings 50%, Quill Ventures LLC → Campfire Studio 50%\n/);
  const c2=await cli(['share','--env','default-workspace','--node','Bo Marsh','--node','Marsh Holdings','--node','Campfire Studio','--permission','edit','--email',BO]);
  const id=/Shared: ([0-9a-f-]{36})/.exec(c2.out)?.[1];assert.ok(id,c2.out);
  assert.equal((await bo('POST',`/api/shares/${id}/attach`,{env:boEnv})).status,200);
  const r=await bo('GET','/api/workspace?env='+boEnv),nodes=linked(r.data.data);
  assert.deepEqual(nodes.filter(n=>!n.linked.stub).map(n=>n.name).sort(),['Bo Marsh','Campfire Studio','Marsh Holdings']);
  assert.deepEqual(nodes.filter(n=>n.linked.stub).map(n=>n.name).sort(),['Kestrel Group','Quill Ventures LLC']);
  const body=JSON.stringify(r.data);
  for(const p of [...PRIVATE,'Example App','Example Board','Campfire Studio Ads'])assert.ok(!body.includes(p),p+' must never reach Bo');
  await cli(['unshare',id]);
});

// API keys, /api/v1 and /mcp mounted on the real server (docs/api.md, docs/api-keys.md, docs/mcp-cli.md).
test('API keys: /api/v1 and /mcp work with a key, within its environment and scopes, and see the shares placed there',async()=>{
  const bearer=k=>({authorization:'Bearer '+k,'content-type':'application/json'});
  let r=await owner('POST','/api/keys',{name:'ci',env:'default-workspace',scopes:['read']});
  assert.equal(r.status,201,JSON.stringify(r.data));const ro=r.data.key;assert.match(ro,/^flow_test_/);
  r=await owner('POST','/api/keys',{name:'rw',env:'default-workspace',scopes:['read','write']});const rw=r.data.key;
  assert.equal((await bo('POST','/api/keys',{name:'x',env:'default-workspace',scopes:['read']})).status>=400,true,"Bo cannot make a key for Owner's environment");
  const v1=(k,method,path,body)=>fetch(BASE+'/api/v1'+path,{method,headers:bearer(k),body:body&&JSON.stringify(body)}).then(async x=>({status:x.status,data:await x.json().catch(()=>null)}));
  r=await v1(ro,'GET','/envs');assert.equal(r.status,200,JSON.stringify(r.data));assert.deepEqual(r.data.items.map(e=>e.id),['default-workspace']);
  r=await v1(ro,'GET','/envs/default-workspace/charts/c1/nodes');assert.equal(r.status,200);assert.ok(r.data.items.some(n=>n.name==='Kestrel Services'));
  r=await v1(ro,'POST','/envs/default-workspace/charts/c1/nodes',{name:'Nope',type:'entity'});assert.equal(r.status,403,'a read key cannot write');
  r=await v1(rw,'POST','/envs/default-workspace/charts/c1/nodes',{name:'Made by API',type:'entity'});assert.equal(r.status,201,JSON.stringify(r.data));
  assert.ok((await owner('GET','/api/workspace?env=default-workspace')).data.data.charts[0].nodes.some(n=>n.name==='Made by API'));
  assert.equal((await v1(ro,'GET',`/envs/${boEnv}`)).status,404,"Owner's key cannot see Bo's environment");
  assert.equal((await v1('flow_test_'+'x'.repeat(40),'GET','/envs')).status,401);
  r=await fetch(BASE+'/api/v1/openapi.json');assert.equal(r.status,200);assert.equal((await r.json()).openapi,'3.1.0');
  // Bo's key over his own environment: his data plus the linked copies of the share placed there, as the app shows them.
  const s=await owner('POST','/api/shares',{env:'default-workspace',recipientEmail:BO,scope:{kind:'nodes',nodeIds:['marsh']},permission:'edit'});
  const sid=s.data.share.id,M=`sh.${sid}.marsh`,SC=`sh.${sid}.chart`;
  await bo('POST',`/api/shares/${sid}/attach`,{env:boEnv});
  assert.ok(linked((await bo('GET','/api/workspace?env='+boEnv)).data.data).length>0);
  const jk=(await bo('POST','/api/keys',{name:'bo',env:boEnv,scopes:['read']})).data.key;
  const jw=(await bo('POST','/api/keys',{name:'bo-rw',env:boEnv,scopes:['read','write']})).data.key;
  r=await v1(jk,'GET','/envs');assert.deepEqual(r.data.items.map(e=>e.id),[boEnv]);
  r=await v1(jk,'GET',`/envs/${boEnv}/search?q=Marsh`);assert.equal(r.status,200,JSON.stringify(r.data));
  assert.ok(r.data.items.some(x=>x.id===M),'the linked copy is found through the API');
  r=await v1(jk,'GET',`/envs/${boEnv}/charts`);assert.ok(r.data.items.some(c=>c.id===SC),"the share's chart is listed");
  r=await v1(jk,'GET',`/envs/${boEnv}/charts/${encodeURIComponent(SC)}/nodes`);
  const body=JSON.stringify(r.data);assert.ok(body.includes('Marsh Holdings'));
  for(const x of PRIVATE)assert.ok(!body.includes(x),x+' must never reach Bo through the API');
  assert.equal((await v1(jk,'GET','/envs/default-workspace')).status,404);
  assert.equal((await v1(jk,'PATCH',`/envs/${boEnv}/charts/${encodeURIComponent(SC)}/nodes/${encodeURIComponent(M)}`,{name:'Nope'})).status,403,'a read key cannot write');
  // Edits the share allows reach the owner, with history; layout stays Bo's.
  const node=`/envs/${boEnv}/charts/${encodeURIComponent(SC)}/nodes/`;
  r=await v1(jw,'PATCH',node+encodeURIComponent(M),{notes:'Set by Bo via API'});assert.equal(r.status,200,JSON.stringify(r.data));
  r=await v1(jw,'POST',node+encodeURIComponent(M)+'/move',{x:3000,y:40});assert.equal(r.status,200,JSON.stringify(r.data));
  let home=(await owner('GET','/api/workspace?env=default-workspace')).data.data.charts[0].nodes.find(n=>n.id==='marsh');
  assert.equal(home.notes,'Set by Bo via API','an allowed edit reaches the owner');assert.notEqual(home.x,3000,"Bo's layout is his own");
  assert.ok((await owner('GET',`/api/shares/${sid}/history?kind=node&id=marsh`)).data.history.some(e=>e.field==='notes'&&e.by===BO));
  r=await v1(jk,'GET',node+encodeURIComponent(M));assert.equal(r.data.node.x,3000,'placement kept');assert.equal(r.data.node.notes,'Set by Bo via API');
  // Bo's own card in the share's chart, with a private edge to the linked one: his, never the owner's.
  r=await v1(jw,'POST',`/envs/${boEnv}/charts/${encodeURIComponent(SC)}/nodes`,{name:'Bo API Side',type:'entity'});assert.equal(r.status,201,JSON.stringify(r.data));
  r=await v1(jw,'POST',`/envs/${boEnv}/charts/${encodeURIComponent(SC)}/edges`,{from:r.data.node.id,to:M,type:'ownership',percent:'5'});assert.equal(r.status,201,JSON.stringify(r.data));
  assert.ok(!JSON.stringify((await owner('GET','/api/workspace?env=default-workspace')).data).includes('Bo API Side'));
  // Refused: nothing is saved, and the reason is in the error.
  const stub=(await v1(jk,'GET',`/envs/${boEnv}/charts/${encodeURIComponent(SC)}/nodes`)).data.items.find(n=>n.linked?.stub);
  assert.ok(stub,'a stub is listed');
  const refused=async(method,path,b,code,why)=>{const before=(await bo('GET','/api/workspace?env='+boEnv)).data.rev,x=await v1(jw,method,path,b);
    assert.equal(x.status,403,why+': '+JSON.stringify(x.data));assert.equal(x.data.error?.code||x.data.code,code,JSON.stringify(x.data));
    assert.equal((await bo('GET','/api/workspace?env='+boEnv)).data.rev,before,why+': nothing saved')};
  await refused('PATCH',node+encodeURIComponent(stub.id),{name:'Hacked'},'share_read_only','a stub');
  await refused('PATCH',node+encodeURIComponent(M),{type:'area'},'share_read_only_field','a field the share does not carry');
  const ledge=(await v1(jk,'GET',`/envs/${boEnv}/charts/${encodeURIComponent(SC)}/edges`)).data.items.find(e=>e.id.startsWith('sh.'));
  await refused('DELETE',`/envs/${boEnv}/charts/${encodeURIComponent(SC)}/edges/${encodeURIComponent(ledge.id)}`,undefined,'share_delete','deleting a linked edge');
  assert.equal((await owner('PATCH',`/api/shares/${sid}`,{permission:'view'})).status,200);
  await refused('PATCH',node+encodeURIComponent(M),{name:'Not allowed'},'share_permission','a view share');
  home=(await owner('GET','/api/workspace?env=default-workspace')).data.data;
  assert.notEqual(home.charts[0].nodes.find(n=>n.id==='marsh').name,'Not allowed');assert.equal(home.charts[0].nodes.find(n=>n.id===stub.id.split('.').pop()).name,stub.name);
  assert.equal((await owner('PATCH',`/api/shares/${sid}`,{permission:'edit'})).status,200);
  // MCP sees the same.
  {const m=await fetch(BASE+'/mcp',{method:'POST',headers:{...bearer(jw),accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'search',arguments:{env:boEnv,q:'Marsh'}}})}).then(x=>x.json());
    assert.ok(!m.result.isError&&JSON.stringify(m.result).includes(M),JSON.stringify(m).slice(0,300))}
  // MCP over HTTP with the same keys.
  const mcp=(k,body)=>fetch(BASE+'/mcp',{method:'POST',headers:{...bearer(k),accept:'application/json, text/event-stream'},body:JSON.stringify(body)}).then(async x=>({status:x.status,data:await x.json().catch(()=>null)}));
  r=await mcp(ro,{jsonrpc:'2.0',id:1,method:'tools/list'});assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(r.data.result.tools.some(t=>t.name==='nodes_list'));
  r=await mcp(ro,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'nodes_list',arguments:{env:'default-workspace',chart:'c1'}}});
  assert.ok(!r.data.result.isError&&JSON.stringify(r.data.result).includes('Made by API'),JSON.stringify(r.data).slice(0,300));
  r=await mcp(ro,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'nodes_create',arguments:{env:'default-workspace',chart:'c1',name:'Via MCP',type:'entity'}}});
  assert.ok(r.data.result?.isError,'a read key cannot write through MCP');
  r=await mcp(jk,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'nodes_list',arguments:{env:'default-workspace',chart:'c1'}}});
  assert.ok(r.data.result?.isError&&!JSON.stringify(r.data).includes('Kestrel Services'),"Bo's key cannot read Owner's environment through MCP");
  assert.equal((await mcp('flow_test_'+'y'.repeat(40),{jsonrpc:'2.0',id:5,method:'tools/list'})).status,401);
  await owner('DELETE',`/api/shares/${s.data.share.id}`);
});

// Sharing by API key and MCP (shares.* in lib/registry.mjs): the same rules as the app, a preview before
// anything is shared, read-only keys refused, and the key's name on the share.
test('API keys and MCP share: preview first, then confirm; read-only refused; recipients ask instead; approve and revoke by key',async()=>{
  const bearer=k=>({authorization:'Bearer '+k,'content-type':'application/json',accept:'application/json, text/event-stream'});
  const v1=(k,method,path,body)=>fetch(BASE+'/api/v1'+path,{method,headers:bearer(k),body:body&&JSON.stringify(body)}).then(async x=>({status:x.status,data:await x.json().catch(()=>null)}));
  let n=100;const tool=(k,name,args)=>fetch(BASE+'/mcp',{method:'POST',headers:bearer(k),body:JSON.stringify({jsonrpc:'2.0',id:n++,method:'tools/call',params:{name,arguments:args}})}).then(x=>x.json()).then(m=>m.result);
  const key=async(who,name,env,scopes)=>{const r=await who('POST','/api/keys',{name,env,scopes});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.key};
  const rw=await key(owner,'Laptop agent','default-workspace',['read','write']),ro=await key(owner,'Read-only agent','default-workspace',['read']);
  const list=await fetch(BASE+'/mcp',{method:'POST',headers:bearer(ro),body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(x=>x.json());
  const names=list.result.tools.map(t=>t.name);
  for(const t of ['shares_list','shares_preview','shares_create','shares_update','shares_revoke','shares_incoming','shares_requests_list','shares_requests_create','shares_requests_decide'])assert.ok(names.includes(t),t+' is listed');
  assert.match(list.result.tools.find(t=>t.name==='shares_create').description,/confirm: true/);
  const mine=async()=>(await owner('GET','/api/shares?env=default-workspace')).data.shares;
  const before=(await mine()).length;
  // Preview first: nothing is shared.
  const args={env:'default-workspace',recipientEmail:BO,scope:{kind:'project',project:'studio launch'},permission:'edit'};
  let r=await tool(rw,'shares_create',args);
  assert.ok(!r.isError,JSON.stringify(r));assert.deepEqual([r.structuredContent.created,r.structuredContent.confirmed],[false,false]);
  assert.deepEqual(r.structuredContent.preview.projects.map(p=>p.name),['Studio launch']);
  for(const p of PRIVATE)assert.ok(!JSON.stringify(r).includes(p),p+' must not be in the preview');
  assert.equal((await mine()).length,before,'a preview shares nothing');
  // A read-only key cannot share, through MCP or REST.
  r=await tool(ro,'shares_create',{...args,confirm:true});assert.ok(r.isError&&/insufficient_scope/.test(r.content[0].text),JSON.stringify(r));
  assert.equal((await v1(ro,'POST','/envs/default-workspace/shares',{...args,confirm:true})).status,403);
  assert.equal((await mine()).length,before);
  // confirm: true shares it, under the key's name.
  r=await tool(rw,'shares_create',{...args,confirm:true});
  assert.ok(!r.isError&&r.structuredContent.created,JSON.stringify(r));
  const s=r.structuredContent.share;assert.deepEqual([s.actor,s.createdBy,s.permission,s.scope],['Laptop agent',OWNER,'edit',{kind:'project',projectId:'p-cb'}]);
  assert.equal((await mine()).find(x=>x.id===s.id)?.actor,'Laptop agent','Settings › Sharing gets the key name');
  r=await tool(ro,'shares_revoke',{share:s.id});assert.ok(r.isError,'a read-only key cannot revoke');
  r=await tool(ro,'shares_update',{share:s.id,permission:'view'});assert.ok(r.isError,'or change it');
  r=await tool(ro,'shares_list',{env:'default-workspace'});assert.ok(!r.isError&&r.structuredContent.shares.some(x=>x.id===s.id),'but can list it');
  // Bo adds it to his environment. His key cannot share the linked project on; it asks the owner instead.
  assert.equal((await bo('POST',`/api/shares/${s.id}/attach`,{env:boEnv})).status,200);
  const bw=await key(bo,'Bo agent',boEnv,['read','write']),br=await key(bo,'Bo reader',boEnv,['read']);
  r=await v1(bw,'POST',`/envs/${boEnv}/shares`,{recipientEmail:KIM,scope:{kind:'project',project:'Studio launch'},permission:'view',confirm:true});
  assert.deepEqual([r.status,r.data.code],[400,'share_linked'],JSON.stringify(r.data));
  r=await tool(bw,'shares_create',{env:boEnv,recipientEmail:KIM,scope:{kind:'nodes',nodes:[`sh.${s.id}.campaign`]}});
  assert.ok(r.isError&&/share_linked/.test(r.content[0].text),JSON.stringify(r));
  assert.equal((await v1(bw,'GET','/envs/default-workspace/shares')).status,404,"Bo's key cannot list the owner's shares");
  r=await v1(bw,'GET','/shares/incoming');assert.deepEqual(r.data.shares.find(x=>x.id===s.id)?.envs,[boEnv]);
  assert.equal((await v1(br,'POST',`/shares/${s.id}/requests`,{toEmail:KIM})).status,403,'a read-only key cannot ask');
  r=await tool(bw,'shares_requests_create',{share:s.id,toEmail:KIM,permission:'comment',note:'Kim helps with the launch'});
  assert.ok(!r.isError,JSON.stringify(r));const rid=r.structuredContent.request.id;
  // The owner approves by key, at view.
  r=await tool(rw,'shares_requests_list',{});assert.ok(r.structuredContent.requests.some(x=>x.id===rid));
  assert.ok((await tool(ro,'shares_requests_decide',{request:rid,approve:true})).isError,'a read-only key cannot approve');
  r=await tool(rw,'shares_requests_decide',{request:rid,approve:true,permission:'view'});
  assert.ok(!r.isError,JSON.stringify(r));const k=r.structuredContent.share;
  assert.deepEqual([k.recipientEmail,k.permission,k.via,k.actor],[KIM,'view',rid,'Laptop agent']);
  assert.ok((await kim('GET','/api/shares/incoming')).data.shares.some(x=>x.id===k.id),'Kim has it');
  // Revoke both by key: Bo's linked copies go.
  assert.equal((await v1(rw,'DELETE',`/shares/${k.id}`)).status,200);
  r=await tool(rw,'shares_revoke',{share:s.id});assert.ok(!r.isError&&r.structuredContent.revoked,JSON.stringify(r));
  assert.ok(!JSON.stringify((await bo('GET','/api/workspace?env='+boEnv)).data.data).includes(`sh.${s.id}.`),"nothing of the share is left in Bo's environment");
  assert.equal((await mine()).length,before);
});

// Cards #61 and #63 on the real server: members as assignees, stale copies, and conflicts both ways.
test('shared cards: members can be assigned, stale copies never overwrite, and the loser of a conflict is told',async()=>{
  const {fieldBase}=await import('../public/sync-core.js');
  let a=(await owner('GET','/api/workspace?env=default-workspace')).data;
  a.data.charts[0].nodes.push(N('me','Owner Person','person',1200,900,{email:OWNER}));
  const now=new Date().toISOString();
  a.data.devops={...a.data.devops,cards:[...(a.data.devops?.cards||[]),{id:'k-ad',number:90,title:'Ad copy',description:'',column:'requests',project:'p-cb',labels:[],points:null,due:'',
    assignees:[{node:'bo',role:'developer'},{node:'cleo',role:'tester'}],checklist:[],links:[],item:'',created:now,updated:now,moved:now}]};
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:a.rev,data:a.data})).status,200);
  const s=(await owner('POST','/api/shares',{env:'default-workspace',recipientEmail:BO,scope:{kind:'nodes',nodeIds:['bo','campaign']},permission:'edit'})).data.share;
  assert.equal((await bo('POST',`/api/shares/${s.id}/attach`,{env:boEnv})).status,200);
  const L=id=>`sh.${s.id}.${id}`,card=d=>d.devops.cards.find(c=>c.id===L('k-ad')),home=async()=>(await owner('GET','/api/workspace?env=default-workspace')).data;
  const save=async(r,d)=>{const x=await bo('PUT','/api/workspace?env='+boEnv,{baseRev:r.data.rev,data:d,sharedEdits:fieldBase(r.data.data,d)});assert.equal(x.status,200,JSON.stringify(x.data));return x};

  // Bo sees in-scope people and the share's members; Cleo (outside the scope) stays hidden.
  let r=await bo('GET','/api/workspace?env='+boEnv);
  assert.deepEqual(card(r.data.data).assignees,[{node:L('bo'),role:'developer'}]);
  const meta=r.data.data.shares.find(x=>x.id===s.id);
  assert.deepEqual(meta.members.map(m=>[m.id,m.name]),[['@'+OWNER,'Owner Person'],['@'+BO,BO]]);
  assert.ok(!JSON.stringify(r.data).includes('Cleo Park')&&!JSON.stringify(r.data).includes('"cleo"'));
  let d=structuredClone(r.data.data);card(d).assignees.push({node:'@'+OWNER,role:'tester'});
  await save(r,d);
  let h=await home();
  assert.deepEqual(h.data.devops.cards.find(c=>c.id==='k-ad').assignees,[{node:'cleo',role:'tester'},{node:'bo',role:'developer'},{node:'me',role:'tester'}],'the owner is assigned as their person card; Cleo stays');
  assert.ok(!JSON.stringify((await bo('GET',`/api/shares/${s.id}/history?kind=card&id=k-ad`)).data).includes('cleo'),'the history Bo reads leaves Cleo out');

  // The owner renames the card; Bo's copy is stale. An unrelated save of his does not undo the rename.
  const stale=await bo('GET','/api/workspace?env='+boEnv);
  h.data.devops.cards.find(c=>c.id==='k-ad').title='Ad copy v2';
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:h.rev,data:h.data})).status,200);
  d=structuredClone(stale.data.data);d.charts[0].nodes.push(N('bo-note','Bo note','note',5,5));
  const s1=await save(stale,d);
  assert.equal((await home()).data.devops.cards.find(c=>c.id==='k-ad').title,'Ad copy v2','a stale copy never overwrites the owner');

  // Bo, still on the old title, renames it: last write wins, and the owner is told on that field.
  d=structuredClone(d);card(d).title='Bo copy';
  await save({data:{rev:s1.data.rev,data:stale.data.data}},d);
  h=await home();
  assert.equal(h.data.devops.cards.find(c=>c.id==='k-ad').title,'Bo copy');
  const lost=h.conflicts.find(c=>c.id==='k-ad'&&c.field==='title');
  assert.ok(lost,JSON.stringify(h.conflicts));
  assert.deepEqual([lost.kind,lost.by,lost.previous,lost.value],['card',BO,'Ad copy v2','Bo copy']);
  assert.ok(!(await bo('GET','/api/workspace?env='+boEnv)).data.conflicts.length,'the winner sees no notice');
  assert.ok(h.data.shareMembers.some(m=>m.id==='@'+BO&&m.cards.includes('k-ad')),'the owner can assign Bo on the card shared with him');

  // Restore (just another edit, over the value the owner now sees): no new conflict for Bo.
  const base=structuredClone(h.data);h.data.devops.cards.find(c=>c.id==='k-ad').title='Ad copy v2';
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:h.rev,data:h.data,fieldBase:fieldBase(base,h.data)})).status,200);
  assert.ok(!(await bo('GET','/api/workspace?env='+boEnv)).data.conflicts.length);

  // The other way: Bo writes the description, then the owner's merged copy (which never showed it) wins.
  r=await bo('GET','/api/workspace?env='+boEnv);d=structuredClone(r.data.data);card(d).description='Bo notes';await save(r,d);
  h=await home();assert.equal(h.data.devops.cards.find(c=>c.id==='k-ad').description,'Bo notes');
  h.data.devops.cards.find(c=>c.id==='k-ad').description='Owner notes';
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:h.rev,data:h.data,fieldBase:{card:{'k-ad':{description:''}}}})).status,200);
  r=await bo('GET','/api/workspace?env='+boEnv);
  const mine=r.data.conflicts.find(c=>c.field==='description');
  assert.deepEqual(mine&&[mine.kind,mine.id,mine.by,mine.previous,mine.value],['card',L('k-ad'),OWNER,'Bo notes','Owner notes']);
  const hist=(await bo('GET',`/api/shares/${s.id}/history?kind=card&id=k-ad`)).data.history;
  assert.ok(hist.some(e=>e.field==='description'&&e.by===OWNER&&e.new==='Owner notes'),"the owner's edits are in the share's history too");
  assert.ok(hist.every(e=>e.over===undefined),'who lost is not part of the history a recipient reads');

  // The same card through Bo's API key: allowed fields reach the owner; a card he may only see is not deleted.
  const key=(await bo('POST','/api/keys',{name:'bo-cards',env:boEnv,scopes:['read','write']})).data.key;
  const v1=(method,path,b)=>fetch(BASE+'/api/v1/envs/'+boEnv+path,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:b&&JSON.stringify(b)}).then(async x=>({status:x.status,data:await x.json().catch(()=>null)}));
  let x=await v1('GET','/cards?q=Ad%20copy');assert.ok(x.data.items.some(c=>c.id===L('k-ad')),JSON.stringify(x.data));
  x=await v1('PATCH','/cards/'+encodeURIComponent(L('k-ad')),{title:'Ad copy v2',points:3});assert.equal(x.status,200,JSON.stringify(x.data));
  x=await v1('POST','/cards/'+encodeURIComponent(L('k-ad'))+'/move',{column:'doing'});assert.equal(x.status,200,JSON.stringify(x.data));
  h=await home();const k=h.data.devops.cards.find(c=>c.id==='k-ad');
  assert.deepEqual([k.title,k.points,k.column],['Ad copy v2',3,'doing'],'API edits to a shared card reach the owner');
  assert.ok(k.assignees.some(a=>a.node==='cleo'),"the owner's hidden assignee stays");
  // Members by email through the API: the owner (a member, whose person card is outside the scope) is stored as their card.
  x=await v1('PATCH','/cards/'+encodeURIComponent(L('k-ad')),{assignees:[{node:L('bo'),role:'developer'},{node:OWNER,role:'tester'}]});
  assert.equal(x.status,200,JSON.stringify(x.data));
  assert.deepEqual(x.data.card.assignees,[{node:L('bo'),role:'developer'},{node:'@'+OWNER,role:'tester'}]);
  h=await home();assert.deepEqual(h.data.devops.cards.find(c=>c.id==='k-ad').assignees.map(a=>a.node).sort(),['bo','cleo','me']);
  x=await v1('PATCH','/cards/'+encodeURIComponent(L('k-ad')),{assignees:[{node:KIM,role:'tester'}]});
  assert.equal(x.status,400,'someone who is not a member: '+JSON.stringify(x.data));
  assert.equal((await v1('POST','/cards',{title:'Bo private',assignees:[{node:OWNER}]})).status,400,"a member is not assignable on Bo's own cards");
  // The owner's key: a recipient without a person card is assignable on the cards shared with them only.
  {const ok=(await owner('POST','/api/keys',{name:'own-cards',env:'default-workspace',scopes:['read','write']})).data.key;
    const o1=(method,path,b)=>fetch(BASE+'/api/v1/envs/default-workspace'+path,{method,headers:{authorization:'Bearer '+ok,'content-type':'application/json'},body:b&&JSON.stringify(b)}).then(async y=>({status:y.status,data:await y.json().catch(()=>null)}));
    let y=await o1('PATCH','/cards/k-ad',{assignees:[{node:'cleo',role:'developer'},{node:BO,role:'tester'}]});
    assert.equal(y.status,200,JSON.stringify(y.data));assert.ok(y.data.card.assignees.some(a=>a.node==='@'+BO),JSON.stringify(y.data.card.assignees));
    y=await o1('POST','/cards',{title:'Not shared',assignees:[{node:BO}]});assert.equal(y.status,400,'not on a card that is not shared with them');
    y=await o1('GET','/cards?assignee='+encodeURIComponent(BO));assert.deepEqual(y.data.items.map(c=>c.id),['k-ad'],JSON.stringify(y.data));}
  assert.equal((await v1('POST','/projects',{name:'Bo own project'})).status,201);
  x=await v1('PATCH','/cards/'+encodeURIComponent(L('k-ad')),{project:'Bo own project'});
  assert.equal(x.status,403,'a shared card keeps its project: '+JSON.stringify(x.data));
  await owner('DELETE',`/api/shares/${s.id}`);
});

// Nov 2026: a recipient's browser held a copy of a whole-environment share that was older than what it
// had read, and its save put old columns, points, due dates and descriptions back on 43 of the owner's
// cards. Only the fields the recipient changed (sharedEdits) may reach the owner.
test('a stale copy of shared cards never reverts the owner; real edits and conflicts still go through',async()=>{
  const {fieldBase}=await import('../public/sync-core.js');
  const now=new Date().toISOString(),K=n=>`k-st${n}`;
  const blank=n=>({id:K(n),number:200+n,title:'Stale test '+n,description:'',column:'requests',project:'',labels:[],points:null,actual:null,due:'',assignees:[],checklist:[],links:[],item:'',created:now,updated:now,moved:now});
  let a=(await owner('GET','/api/workspace?env=default-workspace')).data;
  a.data.devops={...a.data.devops,cards:[...a.data.devops.cards,...Array.from({length:24},(_,i)=>blank(i))]};
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:a.rev,data:a.data})).status,200);
  const s=(await owner('POST','/api/shares',{env:'default-workspace',recipientEmail:BO,scope:{kind:'environment'},permission:'edit'})).data.share;
  assert.equal((await bo('POST',`/api/shares/${s.id}/attach`,{env:boEnv})).status,200);
  const L=id=>`sh.${s.id}.${id}`,home=async()=>(await owner('GET','/api/workspace?env=default-workspace')).data;
  const own=async n=>(await home()).data.devops.cards.find(c=>c.id===K(n));

  // Bo's browser reads the cards at rev N.
  const old=(await bo('GET','/api/workspace?env='+boEnv)).data;
  // The owner (or an agent) moves them on: done, points, a due date, a new description.
  a=await home();
  for(const c of a.data.devops.cards)if(c.id.startsWith('k-st')){c.column='done';c.points=3;c.actual=2;c.due='2026-12-01';c.description='Agent notes'}
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:a.rev,data:a.data})).status,200);
  // Bo's browser reads again, but its stored copy is still the old one and it saves that (what a tab
  // running the older sync sent: the stale copy, with a fieldBase taken against the newer read).
  const fresh=(await bo('GET','/api/workspace?env='+boEnv)).data;
  let r=await bo('PUT','/api/workspace?env='+boEnv,{baseRev:fresh.rev,data:old.data,fieldBase:fieldBase(fresh.data,old.data)});
  assert.equal(r.status,200,JSON.stringify(r.data));
  let k=await own(3);
  assert.deepEqual([k.column,k.points,k.actual,k.due,k.description],['done',3,2,'2026-12-01','Agent notes'],'an untouched stale copy changes nothing on the owner');
  // Nor when the stale copy comes with sharedEdits that list nothing.
  r=await bo('PUT','/api/workspace?env='+boEnv,{baseRev:r.data.rev,data:old.data,sharedEdits:{},fieldBase:fieldBase(fresh.data,old.data)});
  assert.equal(r.status,200);k=await own(3);assert.equal(k.column,'done');
  assert.ok(!(await bo('GET',`/api/shares/${s.id}/history?kind=card&id=${K(3)}`)).data.history.some(e=>e.by===BO),'and writes no history');

  // A real edit from that same stale copy: only the field Bo changed is written; the rest stays.
  let d=structuredClone(old.data);d.devops.cards.find(c=>c.id===L(K(5))).title='Bo renamed';
  r=await bo('PUT','/api/workspace?env='+boEnv,{baseRev:r.data.rev,data:d,sharedEdits:{card:{[L(K(5))]:{title:'Stale test 5'}}}});
  assert.equal(r.status,200);k=await own(5);
  assert.deepEqual([k.title,k.column,k.points,k.due,k.description],['Bo renamed','done',3,'2026-12-01','Agent notes']);
  // Bo changes a field the owner changed since he read it: last write wins, and the owner is told.
  d=structuredClone(old.data);d.devops.cards.find(c=>c.id===L(K(6))).column='doing';
  r=await bo('PUT','/api/workspace?env='+boEnv,{baseRev:r.data.rev,data:d,sharedEdits:{card:{[L(K(6))]:{column:'requests'}}}});
  assert.equal(r.status,200);assert.equal((await own(6)).column,'doing');
  const lost=(await home()).conflicts.find(c=>c.id===K(6)&&c.field==='column');
  assert.deepEqual(lost&&[lost.by,lost.previous,lost.value],[BO,'done','doing'],'the conflict is recorded for the owner');

  // A save claiming edits on 20 or more shared cards at once is refused (no client edits like that).
  d=structuredClone(old.data);const many={};
  for(let i=0;i<24;i++){const c=d.devops.cards.find(x=>x.id===L(K(i)));c.column='blocked';many[c.id]={column:'requests'}}
  r=await bo('PUT','/api/workspace?env='+boEnv,{baseRev:r.data.rev,data:d,sharedEdits:{card:many}});
  assert.equal(r.status,200);
  assert.deepEqual([(await own(10)).column,(await own(6)).column],['done','doing'],'a bulk rewrite of shared cards is refused');
  await owner('DELETE',`/api/shares/${s.id}`);
});

// Additions (share.adds): a recipient adds records inside a share; the owner approves them, or they land at once.
test('additions: off, needs approval, allowed; app saves, the API and MCP; scope limits; approve and deny',async()=>{
  const {fieldBase,noteEdits,linkedFields}=await import('../public/sync-core.js');
  const bearer=k=>({authorization:'Bearer '+k,'content-type':'application/json'});
  const v1=(k,method,path,body)=>fetch(BASE+'/api/v1'+path,{method,headers:bearer(k),body:body&&JSON.stringify(body)}).then(async x=>({status:x.status,data:await x.json().catch(()=>null)}));
  const mcp=(k,name,args)=>fetch(BASE+'/mcp',{method:'POST',headers:{...bearer(k),accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}).then(x=>x.json());
  const kimEnv=(await kim('GET','/api/workspace')).data.env;assert.ok(kimEnv&&kimEnv!=='default-workspace'&&kimEnv!==boEnv);
  const home=async()=>(await owner('GET','/api/workspace?env=default-workspace')).data.data;
  const mine=async()=>(await kim('GET','/api/workspace?env='+kimEnv)).data;
  const s=(await owner('POST','/api/shares',{env:'default-workspace',recipientEmail:KIM,scope:{kind:'environment'},permission:'edit',adds:'approve'})).data.share;
  assert.equal(s.adds,'approve');
  assert.equal((await kim('POST',`/api/shares/${s.id}/attach`,{env:kimEnv})).status,200);
  const L=id=>`sh.${s.id}.${id}`,SC=L('chart');
  const card=(id,title,extra={})=>({id,number:50,title,description:'',column:'requests',project:L('p-cb'),labels:[],points:null,due:'',assignees:[],checklist:[],links:[],item:'',created:new Date().toISOString(),updated:new Date().toISOString(),moved:new Date().toISOString(),...extra});
  const appAdd=async f=>{const r=await kim('GET','/api/workspace?env='+kimEnv),d=structuredClone(r.data.data);f(d);
    // As the browser saves: with the edits of linked (and pending) records its user made.
    const x=await kim('PUT','/api/workspace?env='+kimEnv,{baseRev:r.data.rev,data:d,fieldBase:fieldBase(r.data.data,d),sharedEdits:noteEdits({},linkedFields(r.data.data),d)});assert.equal(x.status,200,JSON.stringify(x.data));return x};
  const kimCard=(d,id)=>d.devops.cards.find(c=>c.id===id);

  // Needs approval, from the app: a card in a shared project and a mind map card on the share's chart.
  await appAdd(d=>{d.devops.cards.push(card('k-kim1','Kim idea'));d.charts.find(c=>c.id===SC).nodes.push({id:'n-kim1',name:'Kim Node',type:'entity',x:40,y:40})});
  let h=await home();
  assert.ok(!h.devops?.cards?.some(c=>c.title==='Kim idea')&&!h.charts[0].nodes.some(n=>n.name==='Kim Node'),'nothing reaches the owner before approval');
  let k=await mine();
  assert.ok(kimCard(k.data,L('k-kim1')),'Kim sees her card as a linked copy');assert.ok(!kimCard(k.data,'k-kim1'),'and not as her own');
  const meta=k.data.shares.find(x=>x.id===s.id);assert.equal(meta.adds,'approve');assert.ok(meta.pending.includes(L('k-kim1'))&&meta.pending.includes(L('n-kim1')),'both are marked pending');
  let list=(await owner('GET','/api/shares?env=default-workspace')).data;
  const prop=list.proposals.find(p=>p.proposedBy===KIM);assert.ok(prop,'the owner sees the proposal next to share requests');
  assert.deepEqual(prop.preview.map(r=>r.title).sort(),['Kim Node','Kim idea']);
  // Kim renames the pending card: the proposal changes, the owner still has nothing.
  await appAdd(d=>{kimCard(d,L('k-kim1')).title='Kim better idea'});
  assert.equal((await owner('GET','/api/share-proposals')).data.proposals.find(p=>p.id===prop.id).records.card[0].title,'Kim better idea');
  assert.equal((await kim('POST',`/api/share-proposals/${prop.id}`,{approve:true})).status,404,'only the owner decides');
  let r=await owner('POST',`/api/share-proposals/${prop.id}`,{approve:true});assert.equal(r.status,200,JSON.stringify(r.data));
  assert.equal((await owner('POST',`/api/share-proposals/${prop.id}`,{approve:true})).status,409,'decided once');
  h=await home();
  const added=h.devops.cards.find(c=>c.id==='k-kim1');assert.equal(added?.title,'Kim better idea');assert.equal(added.project,'p-cb');
  assert.ok(h.charts[0].nodes.some(n=>n.id==='n-kim1'),"the node is the owner's now");
  k=await mine();assert.ok(kimCard(k.data,L('k-kim1')),'it flows back as a normal linked copy');assert.ok(!(k.data.shares.find(x=>x.id===s.id).pending||[]).length);
  assert.ok(k.data.shares.find(x=>x.id===s.id).decided.some(x=>x.id===prop.id&&x.status==='approved'));

  // Deny: the pending copy goes, and Kim is told.
  await appAdd(d=>{d.devops.cards.push(card('k-kim2','Kim maybe'))});
  const p2=(await owner('GET','/api/share-proposals')).data.proposals.find(p=>p.proposedBy===KIM);
  assert.equal((await owner('POST',`/api/share-proposals/${p2.id}`,{approve:false})).data.proposal.status,'denied');
  k=await mine();assert.ok(!kimCard(k.data,L('k-kim2'))&&!kimCard(k.data,'k-kim2'),'gone from Kim');
  assert.ok(k.data.shares.find(x=>x.id===s.id).decided.some(x=>x.id===p2.id&&x.status==='denied'&&x.titles.includes('Kim maybe')));
  assert.ok(!(await home()).devops.cards.some(c=>c.title==='Kim maybe'));
  // A stale copy that still holds the denied card does not propose it again.
  const stale=structuredClone(k.data);stale.devops.cards.push(card('k-kim2','Kim maybe'));
  assert.equal((await kim('PUT','/api/workspace?env='+kimEnv,{baseRev:k.rev,data:stale})).status,200);
  assert.ok(!(await owner('GET','/api/share-proposals')).data.proposals.some(p=>p.proposedBy===KIM),'no new proposal');

  // A card Kim made on her board first and put in the shared project after: proposed then, not recorded as deleted.
  await appAdd(d=>{d.devops.cards.push(card('k-kim5','Kim later',{project:''}))});
  assert.ok(kimCard((await mine()).data,'k-kim5'),'her own card first');
  const moved=await appAdd(d=>{kimCard(d,'k-kim5').project=L('p-cb')});assert.equal(moved.data.removedCards,undefined,'not a deletion');
  k=await mine();assert.ok(kimCard(k.data,L('k-kim5'))&&k.data.shares.find(x=>x.id===s.id).pending.includes(L('k-kim5')));
  const p5=(await owner('GET','/api/share-proposals')).data.proposals.find(p=>p.records.card.some(c=>c.id==='k-kim5'));
  assert.equal((await kim('DELETE',`/api/share-proposals/${p5.id}`)).data.proposal.status,'withdrawn','Kim can take it back');
  assert.ok(!kimCard((await mine()).data,L('k-kim5')));
  // Allowed: it lands at once, with history.
  assert.equal((await owner('PATCH',`/api/shares/${s.id}`,{adds:'direct'})).data.share.adds,'direct');
  assert.equal((await kim('PATCH',`/api/shares/${s.id}`,{adds:'direct'})).status,404,'the recipient cannot change it');
  await appAdd(d=>{d.devops.cards.push(card('k-kim3','Kim direct'))});
  assert.ok((await home()).devops.cards.some(c=>c.id==='k-kim3'),'in the owner data at once');
  assert.ok((await owner('GET',`/api/shares/${s.id}/history?kind=card&id=k-kim3`)).data.history.some(e=>e.field==='added'&&e.by===KIM));
  k=await mine();assert.ok(kimCard(k.data,L('k-kim3'))&&!(k.data.shares.find(x=>x.id===s.id).pending||[]).includes(L('k-kim3')));

  // Off: from the app it stays Kim's own card, as before.
  await owner('PATCH',`/api/shares/${s.id}`,{adds:'off'});
  await appAdd(d=>{d.devops.cards.push(card('k-kim4','Kim private'))});
  k=await mine();assert.ok(kimCard(k.data,'k-kim4'),'stays her own');assert.ok(!(await home()).devops.cards.some(c=>c.id==='k-kim4'));

  // The API and MCP: 403 under off, 201 pending under approve, 201 plain under direct.
  const kw=(await kim('POST','/api/keys',{name:'kim-rw',env:kimEnv,scopes:['read','write']})).data.key;
  const ow=(await owner('POST','/api/keys',{name:'owner-rw',env:'default-workspace',scopes:['read','write']})).data.key;
  assert.ok(!(await v1(kw,'GET',`/envs/${kimEnv}/deleted-cards`)).data.items.some(e=>e.cardId==='k-kim5'),'a card moved to the owner is not in Recently deleted');
  r=await v1(kw,'POST',`/envs/${kimEnv}/cards`,{title:'API off',project:'Studio launch'});
  assert.equal(r.status,403,JSON.stringify(r.data));assert.equal(r.data.code,'share_adds_off');
  r=await v1(kw,'POST',`/envs/${kimEnv}/charts/${encodeURIComponent(SC)}/nodes`,{name:'API off node',type:'entity'});assert.equal(r.status,403);
  await owner('PATCH',`/api/shares/${s.id}`,{adds:'approve'});
  r=await v1(kw,'POST',`/envs/${kimEnv}/cards`,{title:'API pending',project:L('p-cb')});
  assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.pending,true);assert.ok(r.data.card.id.startsWith(`sh.${s.id}.`),r.data.card.id);
  const pendingId=r.data.card.id;
  r=await v1(kw,'PATCH',`/envs/${kimEnv}/cards/${encodeURIComponent(pendingId)}`,{description:'More detail'});assert.equal(r.status,200,JSON.stringify(r.data));
  r=await v1(kw,'POST',`/envs/${kimEnv}/cards`,{title:'API explicit',share:s.id});assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.pending,true);
  r=await v1(ow,'GET','/envs/default-workspace/proposals');assert.equal(r.status,200,JSON.stringify(r.data));
  const apiProps=r.data.items.filter(p=>p.role==='owner'&&p.proposedBy===KIM);assert.equal(apiProps.length,2);
  const pend=apiProps.find(p=>p.preview.some(x=>x.title==='API pending'));assert.equal(pend.records.card[0].description,'More detail');
  assert.equal((await v1(kw,'GET',`/envs/${kimEnv}/proposals`)).data.items.filter(p=>p.role==='proposer').length,2,'Kim follows her own');
  assert.equal((await v1(kw,'POST',`/envs/${kimEnv}/proposals/${pend.id}/approve`)).status,404,'Kim cannot approve');
  let m=await mcp(ow,'proposals_approve',{env:'default-workspace',proposal:pend.id});assert.ok(!m.result.isError,JSON.stringify(m).slice(0,400));
  assert.ok((await home()).devops.cards.some(c=>c.title==='API pending'&&c.description==='More detail'));
  m=await mcp(ow,'proposals_deny',{env:'default-workspace',proposal:apiProps.find(p=>p!==pend).id});assert.ok(!m.result.isError,JSON.stringify(m).slice(0,400));
  assert.ok(!(await home()).devops.cards.some(c=>c.title==='API explicit'));
  m=await mcp(kw,'cards_create',{env:kimEnv,title:'MCP pending',project:L('p-cb')});
  assert.ok(!m.result.isError&&JSON.stringify(m.result).includes('"pending":true'),JSON.stringify(m).slice(0,400));
  await owner('PATCH',`/api/shares/${s.id}`,{adds:'direct'});
  r=await v1(kw,'POST',`/envs/${kimEnv}/cards`,{title:'API direct',project:L('p-cb')});
  assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.pending,undefined);assert.ok(r.data.card.id.startsWith(`sh.${s.id}.`));
  assert.ok((await home()).devops.cards.some(c=>c.title==='API direct'));
  r=await v1(kw,'POST',`/envs/${kimEnv}/charts/${encodeURIComponent(SC)}/edges`,{from:L('marsh'),to:L('labs'),type:'group'});
  assert.equal(r.status,201,JSON.stringify(r.data));assert.ok((await home()).charts[0].edges.some(e=>e.from==='marsh'&&e.to==='labs'),'an edge between shared cards');
  await owner('DELETE',`/api/shares/${s.id}`);

  // Scope limits: a project share holds cards and items of that project, nothing else.
  const ps=(await owner('POST','/api/shares',{env:'default-workspace',recipientEmail:KIM,scope:{kind:'project',projectId:'p-cb'},permission:'edit',adds:'direct'})).data.share;
  await kim('POST',`/api/shares/${ps.id}/attach`,{env:kimEnv});
  r=await v1(kw,'POST',`/envs/${kimEnv}/items`,{title:'Project date',projects:[`sh.${ps.id}.p-cb`],start:'2026-12-09'});
  assert.equal(r.status,201,JSON.stringify(r.data));assert.ok((await home()).timeline.some(i=>i.title==='Project date'&&i.projects.includes('p-cb')));
  r=await v1(kw,'POST',`/envs/${kimEnv}/projects`,{name:'Not in this share',share:ps.id});
  assert.equal(r.status,409,JSON.stringify(r.data));assert.equal(r.data.code,'share_add_out_of_scope');
  await owner('DELETE',`/api/shares/${ps.id}`);
  // View and comment shares never add, whatever was asked.
  const vs=(await owner('POST','/api/shares',{env:'default-workspace',recipientEmail:KIM,scope:{kind:'environment'},permission:'comment',adds:'direct'})).data.share;
  assert.equal(vs.adds,'off');
  await kim('POST',`/api/shares/${vs.id}/attach`,{env:kimEnv});
  r=await v1(kw,'POST',`/envs/${kimEnv}/cards`,{title:'Comment only',project:`sh.${vs.id}.p-cb`});assert.equal(r.status,403);
  await owner('DELETE',`/api/shares/${vs.id}`);
  // A recipient still cannot share what is shared with them.
  assert.equal((await kim('POST','/api/shares',{env:kimEnv,recipientEmail:BO,scope:{kind:'nodes',nodeIds:[L('marsh')]}})).status,400);
});
