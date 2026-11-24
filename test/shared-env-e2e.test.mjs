// Opening a shared environment end to end (docs/sharing.md, "Opening a shared environment"): an owner, an
// edit-share recipient, a view-share recipient and a stranger, as synthetic users on a real server
// (OneProfileID mode against a loopback mock). The recipient opens share-<shareId> and sees the owner's
// charts, timeline, board and AgentFlow through the share; writes go back only as the share allows; the
// opened environment's office is the owner's office; a revoke ends all of it at once. Temp folders only;
// FLOW_SYNC_URL and DATABASE_URL are blanked, so nothing here can reach production.
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
const MOCK=4426,APP=4427,BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-opened-fixture',SECRET='synthetic-opened-secret-0123456789abcdef';
const OWNER='owner@example.test',BO='bo@example.test',KIM='kim@example.test',EVE='eve@example.test';
const USERS={[OWNER]:{id:'u-owner',name:'Example Owner',pw:'pw-owner',localId:'owner'},[BO]:{id:'u-bo',name:'Bo B',pw:'pw-bo',localId:'u-bo'},
  [KIM]:{id:'u-kim',name:'Kim',pw:'pw-kim',localId:'u-kim'},[EVE]:{id:'u-eve',name:'Eve',pw:'pw-eve',localId:'u-eve'}};
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
  const head=()=>({cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')});
  const f=async(method,path,body)=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',...head()},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=await r.json()}catch{}
    return {status:r.status,data};
  };
  // An office stream (Server-Sent Events) as this user.
  f.sse=path=>{
    const events=[];let buf='',res,ended=false,status=0;
    const ready=new Promise((ok,no)=>{const req=http.get(BASE+path,{headers:head()},r=>{res=r;status=r.statusCode;r.setEncoding('utf8');
      r.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n\n'))>=0){const b=buf.slice(0,i);buf=buf.slice(i+2);const type=/^event: (.+)$/m.exec(b)?.[1],data=/^data: (.+)$/m.exec(b)?.[1];if(type)events.push({type,data:JSON.parse(data)})}});
      r.on('end',()=>{ended=true});r.on('close',()=>{ended=true});ok(r)});req.on('error',no)});
    const next=async(type,ms=4000)=>{for(const end=Date.now()+ms;Date.now()<end;){const i=events.findIndex(e=>e.type===type);if(i>=0)return events.splice(i,1)[0].data;await new Promise(r=>setTimeout(r,15))}throw Error('no '+type+' event')};
    return {ready,next,status:()=>status,ended:()=>ended,close:()=>res?.destroy()};
  };
  return f;
}

// Fictional fixture. c2 is outside the share's chartId: nothing on it may cross. Ana's card carries an email.
const N=(id,name,type='entity',x=0,y=0,extra={})=>({id,name,type,x,y,...extra});
const CARDS=Array.from({length:24},(_,i)=>({id:'k'+i,number:i+1,title:'Card '+i,description:'',column:'requests',project:'p1',item:'',labels:['l1'],points:null,actual:null,due:'',assignees:[],checklist:[],links:[],created:'2026-11-01T00:00:00.000Z',updated:'2026-11-01T00:00:00.000Z',moved:'2026-11-01T00:00:00.000Z'}));
const ownerFixture=()=>({active:'c1',environment:{id:'default-workspace',name:'Harbor Studio',ownerEmail:OWNER,visibility:'private',members:[]},
  charts:[{id:'c1',name:'Team',nodes:[N('ana','Ana Reyes','person',0,0,{email:'ana.private@example.test'}),N('studio','Harbor Studio LLC','entity',200,100)],
    edges:[{id:'e1',from:'ana',to:'studio',type:'ownership',percent:'100'}]},
   {id:'c2',name:'Private chart',nodes:[N('secret','Secret Holdings','entity',0,0,{notes:'Owner only'})],edges:[]}],
  projects:[{id:'p1',name:'Launch',color:'#a8524c',entity:'studio'}],
  timeline:[{id:'i1',title:'Ship it',kind:'release',status:'planned',start:'2026-12-01',end:'',priority:'',release:'',projects:['p1'],owner:'',link:'',notes:''}],
  devops:{columns:[{id:'requests',name:'Requests'},{id:'doing',name:'Doing'},{id:'blocked',name:'Blocked'},{id:'uat',name:'UAT'},{id:'done',name:'Done'}],cards:CARDS,nextNumber:25,
    labels:[{id:'l1',name:'Web',color:'#3d6fb6'},{id:'l2',name:'Unused',color:'#7cb980'}]},
  agentflow:{agents:[{id:'bot',name:'Builder',kind:'agent',title:'Builds',status:'active',live:true,reportsTo:'',supervisor:'ana',purpose:'Builds things',instructions:'Owner instructions',runtime:'homebox',models:['claude:opus'],model:'claude:opus',auto:false,schedule:'',inputs:[],outputs:[],tools:['git'],projects:['p1'],cards:['k0'],items:[]},
      {id:'lead',name:'Ana',kind:'human',title:'Lead',status:'active',live:false,reportsTo:'',supervisor:'ana',purpose:'',instructions:'',runtime:'',models:[],model:'',auto:false,schedule:'',inputs:[],outputs:[],tools:[],projects:[],cards:[],items:[]}],
    workflows:[{id:'wf',name:'Release',description:'Ship',status:'active',trigger:'manual',schedule:'',steps:[{id:'s1',agent:'bot',action:'Build',output:'A build'}],projects:['p1'],cards:[],items:[]}],
    runners:[{name:'homebox',models:[{id:'claude:opus',label:'Opus'}],jobs:[{id:'j1',name:'Nightly',source:'systemd',schedule:'daily',command:'/opt/secret/run.sh --token abc',ai:false,enabled:true,lastStatus:'ok'}],reported:'2026-11-20T00:00:00.000Z'}]}});

let dir,mock,app,owner,bo,kim,eve,editShare,viewShare,personShare;
const ownerData=async()=>(await owner('GET','/api/workspace?env=default-workspace')).data.data;
const opened=id=>'share-'+id;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-opened-e2e-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:'',PORT:String(APP),ORG_CHART_VERIFY:'1',
    BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE}});
  let err='';app.stderr.on('data',d=>{err+=d;if(process.env.DEBUG_E2E)process.stderr.write(d)});
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  owner=agent();bo=agent();kim=agent();eve=agent();
  for(const [a,email,pw] of [[owner,OWNER,'pw-owner'],[bo,BO,'pw-bo'],[kim,KIM,'pw-kim'],[eve,EVE,'pw-eve']])assert.equal((await a('POST','/api/auth/sign-in',{email,password:pw})).status,200);
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:0,data:ownerFixture()})).status,200);
  for(const a of [bo,kim,eve])assert.equal((await a('GET','/api/workspace')).status,200);
  const share=async body=>{const r=await owner('POST','/api/shares',{env:'default-workspace',...body});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.share.id};
  editShare=await share({recipientEmail:BO,scope:{kind:'environment',chartId:'c1'},permission:'edit'});
  viewShare=await share({recipientEmail:KIM,scope:{kind:'environment'},permission:'view'});
  personShare=await share({recipientEmail:KIM,scope:{kind:'person',nodeId:'ana'},permission:'edit'});
});
after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test('whole-environment shares are listed as environments to open; other scopes are not',async()=>{
  const b=(await bo('GET','/api/environments')).data;
  assert.deepEqual(b.shared.map(s=>[s.id,s.name,s.ownerName,s.permission]),[[opened(editShare),'Harbor Studio','Example Owner','edit']]);
  const k=(await kim('GET','/api/environments')).data;
  assert.deepEqual(k.shared.map(s=>s.id),[opened(viewShare)],'the person share keeps placement only');
  assert.deepEqual((await eve('GET','/api/environments')).data.shared,[]);
});

test('the opened environment is the owner’s, through the share: charts, timeline, board and AgentFlow; nothing private',async()=>{
  const r=await bo('GET','/api/workspace?env='+opened(editShare));
  assert.equal(r.status,200,JSON.stringify(r.data));
  const d=r.data.data,L=id=>`sh.${editShare}.${id}`,text=JSON.stringify(r.data);
  assert.equal(r.data.env,opened(editShare));assert.equal(d.environment.id,opened(editShare));assert.equal(d.environment.name,'Harbor Studio');
  assert.deepEqual(d.charts.map(c=>[c.id,c.name]),[[L('c1'),'Team']],'only the chart the share names');
  assert.deepEqual(d.charts[0].nodes.map(n=>n.id).sort(),[L('ana'),L('studio')]);
  assert.equal(d.charts[0].edges[0].id,L('e1'));
  assert.equal(d.timeline[0].id,L('i1'));assert.equal(d.devops.cards.length,24);assert.equal(d.devops.cards[0].project,L('p1'));
  assert.deepEqual(d.devops.labels.map(l=>l.id).sort(),[L('l1'),L('l2')],'every label of the board');
  const bot=d.agentflow.agents.find(a=>a.id===L('bot'));
  assert.ok(bot&&bot.live===true&&bot.runtime==='homebox','agents come along (owner-only fields read-only)');
  assert.deepEqual([bot.supervisor,bot.projects,bot.cards],[L('ana'),[L('p1')],[L('k0')]]);
  assert.equal(d.agentflow.workflows[0].steps[0].agent,L('bot'));
  assert.equal(d.agentflow.runners[0].name,'homebox');assert.equal(d.agentflow.runners[0].jobs[0].command,undefined,'job command lines stay on the owner’s machine');
  for(const s of ['Secret Holdings','Owner only','Private chart','ana.private@example.test','/opt/secret'])assert.ok(!text.includes(s),s+' must not cross');
  assert.equal(r.data.opened.ownerName,'Example Owner');assert.equal(d.shares[0].permission,'edit');
  // The since shortcut: unchanged while nothing changed.
  const again=await bo('GET',`/api/workspace?env=${opened(editShare)}&since=${r.data.rev}&shared=${encodeURIComponent(r.data.shared)}`);
  assert.equal(again.data.unchanged,true);
});

test('nobody else can open it or its office: 404',async()=>{
  for(const [who,env] of [[eve,opened(editShare)],[kim,opened(editShare)],[bo,opened(viewShare)],[kim,opened(personShare)],[eve,'share-nope']]){
    assert.equal((await who('GET','/api/workspace?env='+env)).status,404,env);
    assert.equal((await who('PUT','/api/workspace?env='+env,{baseRev:0,data:{active:'x',charts:[{id:'x',name:'x',nodes:[],edges:[]}]}})).status,404);
  }
  const s=eve.sse('/api/office/'+opened(editShare)+'/events');await s.ready;assert.equal(s.status(),404);s.close();
  const t=eve.sse('/api/office/default-workspace/events');await t.ready;assert.equal(t.status(),404);t.close();
});

// A recipient's save of the opened environment: the copy they had, changed, plus the edits they made.
async function save(who,shareId,change,edits){
  const r=await who('GET','/api/workspace?env='+opened(shareId)),d=structuredClone(r.data.data);change(d);
  return who('PUT','/api/workspace?env='+opened(shareId),{baseRev:r.data.rev,data:d,sharedEdits:edits(r.data.data)});
}
const L=(s,id)=>`sh.${s}.${id}`;

test('a view share cannot write',async()=>{
  const r=await save(kim,viewShare,d=>{d.devops.cards[0].title='Hijacked';d.charts[0].nodes[1].name='Renamed'},
    d=>({card:{[L(viewShare,'k0')]:{title:d.devops.cards[0].title}},node:{[d.charts[0].nodes[1].id]:{name:d.charts[0].nodes[1].name}}}));
  assert.equal(r.status,200);
  const o=await ownerData();
  assert.equal(o.devops.cards.find(c=>c.id==='k0').title,'Card 0');assert.ok(!JSON.stringify(o).includes('Hijacked')&&!JSON.stringify(o).includes('Renamed'));
});

test('an edit share writes whitelisted fields back, AgentFlow included; live, runtime and models stay the owner’s',async()=>{
  const r=await save(bo,editShare,d=>{
    d.devops.cards[1].title='Better title';const bot=d.agentflow.agents.find(a=>a.id===L(editShare,'bot'));
    bot.purpose='Builds and tests';bot.cards=[L(editShare,'k0'),L(editShare,'k1')];bot.live=false;bot.runtime='bo-laptop';bot.models=['openai:gpt'];bot.instructions='Do as Bo says';
    d.agentflow.workflows[0].description='Ship carefully';
  },d=>{const bot=d.agentflow.agents.find(a=>a.id===L(editShare,'bot'));
    return {card:{[L(editShare,'k1')]:{title:'Card 1'}},agent:{[bot.id]:{purpose:bot.purpose,cards:bot.cards,live:true,runtime:'homebox',models:bot.models,instructions:bot.instructions}},workflow:{[L(editShare,'wf')]:{description:'Ship'}}}});
  assert.equal(r.status,200,JSON.stringify(r.data));
  const o=await ownerData(),bot=o.agentflow.agents.find(a=>a.id==='bot');
  assert.equal(o.devops.cards.find(c=>c.id==='k1').title,'Better title');
  assert.equal(bot.purpose,'Builds and tests');assert.deepEqual(bot.cards,['k0','k1'],'card delegation goes through');
  assert.equal(o.agentflow.workflows[0].description,'Ship carefully');
  assert.deepEqual([bot.live,bot.runtime,bot.models,bot.instructions],[true,'homebox',['claude:opus'],'Owner instructions'],'owner-only fields never change');
  const h=(await owner('GET',`/api/shares/${editShare}/history?kind=agent&id=bot`)).data.history;
  assert.ok(h.some(e=>e.field==='cards'&&e.by===BO),'the owner sees who delegated');
});

test('without sharedEdits nothing reaches the owner; 20 or more records in one save are refused',async()=>{
  let r=await save(bo,editShare,d=>{d.devops.cards[2].title='Stale copy'},()=>({}));
  assert.equal(r.status,200);assert.equal((await ownerData()).devops.cards.find(c=>c.id==='k2').title,'Card 2');
  r=await save(bo,editShare,d=>{for(const c of d.devops.cards.slice(0,21))c.title='Bulk '+c.id},d=>({card:Object.fromEntries(d.devops.cards.slice(0,21).map(c=>[c.id,{title:c.title}]))}));
  assert.equal(r.status,200);assert.equal(r.data.bulkRefused,true,JSON.stringify(r.data));
  assert.ok(!(await ownerData()).devops.cards.some(c=>c.title.startsWith('Bulk ')),'nothing written');
});

test('new records follow the share’s additions setting',async()=>{
  const card=id=>({id,number:99,title:'From Bo '+id,description:'',column:'requests',project:L(editShare,'p1'),item:'',labels:[],points:null,actual:null,due:'',assignees:[],checklist:[],links:[]});
  let r=await save(bo,editShare,d=>{d.devops.cards.push(card('n1'))},()=>({}));
  assert.equal(r.data.notAdded,1,'adds off: not added, and the app is told');
  assert.ok(!(await ownerData()).devops.cards.some(c=>c.title==='From Bo n1'));
  assert.equal((await owner('PATCH','/api/shares/'+editShare,{adds:'direct'})).status,200);
  r=await save(bo,editShare,d=>{d.devops.cards.push(card('n2'))},()=>({}));
  assert.equal(r.status,200);assert.ok(!r.data.notAdded);
  assert.ok((await ownerData()).devops.cards.some(c=>c.title==='From Bo n2'&&c.project==='p1'),'adds direct: in the owner’s board');
  assert.ok((await bo('GET','/api/workspace?env='+opened(editShare))).data.data.devops.cards.some(c=>c.title==='From Bo n2'&&c.id.startsWith('sh.')),'and back as a linked card');
});

test('one office: the opened environment’s office is the owner’s; doors lead between offices; revoke cuts it all',async()=>{
  const mine=(await bo('GET','/api/workspace')).data.env;
  const home=bo.sse(`/api/office/${mine}/events`);await home.ready;
  const snap0=await home.next('snapshot');
  assert.ok(snap0.portals.some(p=>p.env==='default-workspace'&&p.label==="Example Owner's office"),JSON.stringify(snap0.portals));
  home.close();
  const os=owner.sse('/api/office/default-workspace/events');await os.ready;const so=await os.next('snapshot');
  const bs=bo.sse(`/api/office/${opened(editShare)}/events`);await bs.ready;assert.equal(bs.status(),200);
  const sb=await bs.next('snapshot');
  assert.equal(sb.env.id,'default-workspace','the same office');
  assert.deepEqual(sb.members.map(m=>m.name).sort(),so.members.map(m=>m.name).sort());
  assert.ok(sb.members.some(m=>m.me)&&sb.members.some(m=>m.owner));
  assert.ok(sb.portals.some(p=>p.own&&p.env===mine),'a door back to their own office');
  assert.equal((await bo('POST',`/api/office/${opened(editShare)}/presence`,{x:1,z:2})).status,200);
  assert.equal((await os.next('join')).name,'Bo B','the owner sees them come in');
  assert.equal((await owner('POST','/api/office/default-workspace/say',{text:'hello Bo'})).status,200);
  assert.equal((await bs.next('say')).text,'hello Bo');
  // Their own office, open meanwhile: its door to the owner's office goes with the share.
  const own=bo.sse(`/api/office/${mine}/events`);await own.ready;await own.next('snapshot');
  // Revoke: the open stream hears it and closes; the environment answers 410; the office refuses them.
  assert.equal((await owner('DELETE','/api/shares/'+editShare)).status,200);
  assert.ok(!(await own.next('portals')).some(p=>p.env==='default-workspace'),'the door is gone');
  assert.equal((await bs.next('gone')).reason,'access');
  for(let i=0;i<100&&!bs.ended();i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(bs.ended(),'the stream is closed');
  assert.equal((await os.next('leave')).key,sb.me.key);
  assert.equal((await bo('GET','/api/workspace?env='+opened(editShare))).status,410);
  assert.equal((await bo('POST','/api/office/default-workspace/say',{text:'still here?'})).status,404);
  assert.equal((await bo('GET','/api/environments')).data.shared.length,0);
  // Shared again: the door comes back at once.
  assert.equal((await owner('POST','/api/shares',{env:'default-workspace',recipientEmail:BO,scope:{kind:'project',projectId:'p1'},permission:'view'})).status,200);
  assert.ok((await own.next('portals')).some(p=>p.env==='default-workspace'),'a door again');
  own.close();os.close();
});

test('Only me updates an open whole-workspace share and its yacht roster',async t=>{
  const sharedEnv=opened(viewShare);
  const guest=kim.sse('/api/office/'+sharedEnv+'/events');
  t.after(()=>guest.close());
  await guest.ready;
  assert.ok((await guest.next('snapshot')).agentflow.some(a=>a.id==='bot'));

  const {data,rev}=(await owner('GET','/api/workspace?env=default-workspace')).data;
  const saved=await owner('POST','/api/saves',data);
  assert.equal(saved.status,200);
  data.projects.find(p=>p.id==='p1').onlyMe=true;
  data.charts[0].nodes.find(n=>n.id==='studio').onlyMe=true;
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:rev,data})).status,200);

  const {agentflow}=await guest.next('members');
  assert.deepEqual(agentflow.map(a=>a.id),['lead']);
  const r=await kim('GET','/api/workspace?env='+sharedEnv);
  assert.equal(r.status,200);
  const projected=r.data.data;
  assert.ok(!projected.charts.some(c=>c.nodes.some(n=>n.id===L(viewShare,'studio'))));
  assert.deepEqual(projected.projects,[]);
  assert.deepEqual(projected.timeline,[]);
  assert.deepEqual(projected.devops.cards,[]);
  assert.deepEqual(projected.agentflow.agents.map(a=>a.id),[L(viewShare,'lead')]);
  const mine=await ownerData();
  assert.ok(mine.projects.find(p=>p.id==='p1').onlyMe);
  assert.ok(mine.agentflow.agents.some(a=>a.id==='bot'));

  mine.environment.visibility='public';
  mine.devops.cards.pop();
  const current=(await owner('GET','/api/workspace?env=default-workspace')).data;
  assert.equal((await owner('PUT','/api/workspace?env=default-workspace',{baseRev:current.rev,data:mine})).status,200);
  const publicRead=await eve('GET','/api/workspace?env=default-workspace');
  assert.equal(publicRead.status,200);
  assert.deepEqual(publicRead.data.data.projects,[]);
  assert.ok(!publicRead.data.data.charts[0].nodes.some(n=>n.id==='studio'));
  const api='/api/v1/envs/default-workspace';
  assert.deepEqual((await eve('GET',api+'/projects')).data.items,[]);
  assert.deepEqual((await eve('GET',api+'/deleted-cards')).data.items,[]);
  assert.ok((await owner('GET',api+'/deleted-cards')).data.items.length);
  assert.equal((await eve('GET','/api/saves/'+saved.data.id)).status,404);
  assert.equal((await owner('GET','/api/saves/'+saved.data.id)).status,200);
});
