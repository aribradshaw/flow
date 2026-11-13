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
  return async(method,path,body)=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=await r.json()}catch{}
    return {status:r.status,data};
  };
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
  let r=await bo('GET','/api/workspace?env='+boEnv);const d=r.data.data,rev=r.data.rev;
  const marsh=linked(d).find(n=>n.name==='Marsh Holdings LLC'),stub=linked(d).find(n=>n.name==='Kestrel Group');
  marsh.name='Marsh Holdings';marsh.x=2000;stub.name='Hacked';
  // Bo's own card and a private edge to the linked Marsh.
  const mine=d.charts.find(c=>c.nodes.includes(marsh));mine.nodes.push(N('bo-own','Bo Side LLC','entity',0,0));mine.edges.push({id:'bo-edge',from:'bo-own',to:marsh.id,type:'ownership',percent:'10'});
  r=await bo('PUT','/api/workspace?env='+boEnv,{baseRev:rev,data:d});assert.equal(r.status,200,JSON.stringify(r.data));
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
  linked(d).find(n=>n.name==='Campfire Studio').name='Renamed by Bo';
  assert.equal((await bo('PUT','/api/workspace?env='+boEnv,{baseRev:r.data.rev,data:d})).status,200);
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
test('API keys: /api/v1 and /mcp work with a key, within its environment and scopes; shared copies never appear',async()=>{
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
  // Bo's key over his own environment: his data only, never the linked copies of a share.
  const s=await owner('POST','/api/shares',{env:'default-workspace',recipientEmail:BO,scope:{kind:'nodes',nodeIds:['marsh']},permission:'edit'});
  await bo('POST',`/api/shares/${s.data.share.id}/attach`,{env:boEnv});
  assert.ok(linked((await bo('GET','/api/workspace?env='+boEnv)).data.data).length>0);
  const jk=(await bo('POST','/api/keys',{name:'bo',env:boEnv,scopes:['read']})).data.key;
  r=await v1(jk,'GET','/envs');assert.deepEqual(r.data.items.map(e=>e.id),[boEnv]);
  r=await v1(jk,'GET',`/envs/${boEnv}/search?q=Marsh`);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.items.length,0,'no linked copies through the API');
  assert.equal((await v1(jk,'GET','/envs/default-workspace')).status,404);
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
  const save=async(r,d)=>{const x=await bo('PUT','/api/workspace?env='+boEnv,{baseRev:r.data.rev,data:d,fieldBase:fieldBase(r.data.data,d)});assert.equal(x.status,200,JSON.stringify(x.data));return x};

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
  await owner('DELETE',`/api/shares/${s.id}`);
});
