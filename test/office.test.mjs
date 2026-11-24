// The 3D office core (lib/office.mjs): repo matching, report validation, per-viewer redaction, owner-only
// answers, the long-poll, stale sources, and the SSE hub on a loopback server. In memory only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {normalizeRepo,repoMatches,cleanReport,officeState,viewAgent,officeHub,inferKind,ACTIVITY_KINDS,MAX_AGENTS,MAX_CHILDREN} from '../lib/office.mjs';

test('repo names, owner/name and git remotes normalise to the same thing',()=>{
  for(const s of ['flow','Flow','flow.git'])assert.deepEqual(normalizeRepo(s),{full:'',name:'flow'},s);
  for(const s of ['acme/flow','Acme/Flow.git','github.com/acme/flow','https://github.com/acme/flow.git','https://github.com/acme/flow/','http://user:tok@github.com/acme/flow',
    'git@github.com:acme/flow.git','github.com:acme/flow.git','ssh://git@github.com:22/acme/flow.git','git+ssh://git@host.example/acme/flow','https://gitlab.example/group/acme/flow.git?x=1'])
    assert.deepEqual(normalizeRepo(s),{full:'acme/flow',name:'flow'},s);
  assert.equal(normalizeRepo(''),null);assert.equal(normalizeRepo('https://github.com/'),null);
  // owner/name when both sides have it, else the bare name.
  assert.ok(repoMatches(['acme/flow'],{name:'flow',remote:'git@github.com:acme/flow.git'}));
  assert.ok(!repoMatches(['other/flow'],{name:'flow',remote:'git@github.com:acme/flow.git'}),'another owner\'s fork is not the project');
  assert.ok(repoMatches(['flow'],{name:'x',remote:'https://github.com/acme/flow'}));
  assert.ok(repoMatches(['acme/flow'],{name:'flow',remote:''}),'only a name reported: names compared');
  assert.ok(repoMatches(['https://github.com/acme/flow.git'],{name:'flow'}));
  assert.ok(!repoMatches(['flow'],{name:'flowchart'}));assert.ok(!repoMatches([],{name:'flow'}));assert.ok(!repoMatches(['flow'],null));
});

test('reports are validated and capped: unknown values fall back, strings are cut, sizes capped, secrets in remotes dropped',()=>{
  assert.throws(()=>cleanReport({agents:[]}),{code:'invalid_input'});
  assert.throws(()=>cleanReport({source:'s',agents:'no'}),{code:'invalid_input'});
  assert.throws(()=>cleanReport({source:'',agents:[]}),{code:'invalid_input'});
  const many=Array.from({length:MAX_AGENTS+30},(_,i)=>({id:'a'+i,status:'running'}));
  assert.equal(cleanReport({source:'s',agents:many}).agents.length,MAX_AGENTS);
  const r=cleanReport({source:'x'.repeat(80),at:'nope',agents:[
    {id:'a',title:'t'.repeat(500),vendor:'OpenAI',status:'busy',model:'m',activity:'line\nbreak',repo:{name:'flow',remote:'https://bot:ghp_secret@github.com/acme/flow.git'},
      children:Array.from({length:30},(_,i)=>({id:'c'+i,vendor:'gemini',status:'running'})),pending:{requestId:'r',can:['allow']}},
    {id:'a',title:'duplicate'},{title:'no id'},null,'x',
    {id:'w',status:'waiting',vendor:'claude',pending:{requestId:'r1',kind:'question',summary:'Which one?',can:['maybe','deny','deny']}}]});
  assert.equal(r.source.length,60);assert.ok(Date.parse(r.at));
  assert.deepEqual(r.agents.map(a=>a.id),['a','w']);
  const [a,w]=r.agents;
  assert.equal(cleanReport({source:'s',agents:[{id:'d',vendor:'other',model:'DeepSeek V4'},{id:'g',vendor:'xai'},{id:'q',model:'qwen3'},{id:'m',model:'muse-wonder-1.0'},{id:'l',vendor:'meta'}]}).agents.map(x=>x.vendor).join(),'deepseek,grok,other,meta,meta');
  assert.equal(a.title.length,200);assert.equal(a.vendor,'codex');assert.equal(a.status,'idle');assert.equal(a.activity,'line break');
  assert.equal(a.children.length,MAX_CHILDREN);assert.equal(a.pending,null,'pending only while waiting');
  assert.ok(!JSON.stringify(a).includes('ghp_secret'));assert.equal(a.repo.remote,'https://github.com/acme/flow.git');
  assert.deepEqual(w.pending,{requestId:'r1',kind:'question',summary:'Which one?',can:['deny']});
  assert.deepEqual(cleanReport({source:'s',agents:[{id:'x',repo:{remote:'git@github.com:acme/flow.git'}},{id:'y',repo:{remote:'bot:tok@host.example:acme/flow'}}]}).agents.map(a=>a.repo.remote),['git@github.com:acme/flow.git','host.example:acme/flow']);
  assert.equal(viewAgent(cleanReport({source:'s',agents:[{id:'x',repo:{remote:'git@github.com:acme/flow.git'}}]}).agents[0],{owner:true}).repo.slug,'acme/flow');
});

test('activityKind: a valid reported kind is kept, anything else is inferred from activity; idle is idle',()=>{
  assert.deepEqual(ACTIVITY_KINDS,['edit','read','search','run','test','think','web','idle']);
  const cases={
    'Edit lib/office.mjs':'edit','MultiEdit':'edit','Write docs/a.md':'edit','apply_patch':'edit','Fixing the login bug':'edit',
    'Read README.md':'read','Reading the docs':'read','Explore':'read',
    'Grep "officeHub"':'search','Glob **/*.mjs':'search','Searching for callers':'search',
    'Bash: git status':'run','Bash(ls -la)':'run','$ make build':'run','Running npm install':'run',
    'Bash: npm test':'test','npm test':'test','Running tests':'test','shell: cargo test --all':'test','node --test test/office.test.mjs':'test',
    'WebFetch https://example.com':'web','WebSearch three.js instancing':'web','Browsing the docs site':'web',
    'Thinking':'think','Planning the change':'think','':'think','Waiting for approval':'think'};
  for(const [text,kind] of Object.entries(cases))assert.equal(inferKind(text),kind,JSON.stringify(text));
  assert.equal(inferKind('Edit a.mjs','idle'),'idle');
  const r=cleanReport({source:'s',agents:[
    {id:'a',status:'running',activity:'Bash: npm test'},
    {id:'b',status:'running',activity:'Bash: npm test',activityKind:'WEB'},
    {id:'c',status:'running',activity:'Read x',activityKind:'dance'},
    {id:'d',status:'idle',activity:'Edit x',activityKind:'edit'},
    {id:'e',status:'waiting',activityKind:'search',children:[{id:'k1',title:'Explore the repo',status:'running'},{id:'k2',status:'running',activityKind:'test'},{id:'k3',status:'idle',activityKind:'test'},{id:'k4',status:'running',activity:'WebFetch x',title:'Helper'}]},
    {id:'f',status:'running',activity:5,activityKind:7}]});
  assert.deepEqual(r.agents.map(a=>a.activityKind),['test','web','read','idle','search','think']);
  assert.deepEqual(r.agents[4].children.map(c=>c.activityKind),['read','test','idle','web']);
  // Every view carries it: the owner's, a project viewer's and the private one.
  const a=r.agents[4];
  for(const v of [viewAgent(a,{owner:true}),viewAgent(a,{full:true}),viewAgent(a,{})]){assert.equal(v.activityKind,'search');assert.equal(v.children[0].activityKind,'read')}
});

test('waiting: an agent starting to wait (or on a new prompt) is an event for its owner; a first report or a steady wait is not',()=>{
  const st=officeState(),ev=[];st.on(e=>{if(e.type==='waiting')ev.push(e)});
  const ag=(id,status,requestId)=>({id,status,vendor:'claude',title:'T '+id,pending:requestId?{requestId,summary:'Run: x',can:['allow']}:null});
  st.report('Ann@example.test',{source:'s',agents:[ag('1','waiting','r1'),ag('2','running')]});
  assert.deepEqual(ev,[],'a source\'s first report alerts nobody');
  st.report('ann@example.test',{source:'s',agents:[ag('1','waiting','r1'),ag('2','waiting','r2')]});
  assert.deepEqual(ev.map(e=>[e.email,e.agent.id,e.agent.source,e.agent.pending.requestId]),[['ann@example.test','2','s','r2']]);
  st.report('ann@example.test',{source:'s',agents:[ag('1','waiting','r1'),{...ag('2','waiting','r2'),activity:'still'}]});
  assert.equal(ev.length,1,'still waiting on the same prompt');
  st.report('ann@example.test',{source:'s',agents:[ag('1','waiting','r9'),ag('2','waiting')]});
  assert.deepEqual(ev.slice(1).map(e=>e.agent.id),['1'],'a new prompt alerts again; losing the prompt does not');
  st.report('ann@example.test',{source:'s',agents:[ag('1','waiting','r9'),ag('2','waiting'),ag('3','waiting')]});
  assert.deepEqual(ev.slice(2).map(e=>e.agent.id),['3'],'a new agent already waiting');
  st.report('ann@example.test',{source:'s',agents:[ag('1','running'),ag('2','idle'),ag('3','waiting')]});st.report('ann@example.test',{source:'s',agents:[ag('1','waiting'),ag('2','idle'),ag('3','waiting')]});
  assert.deepEqual(ev.slice(3).map(e=>e.agent.id),['1'],'back to waiting');
  st.close();
  let t=0;const s2=officeState({now:()=>t}),ev2=[];s2.on(e=>{if(e.type==='waiting')ev2.push(e)});
  s2.report('ann@example.test',{source:'s',agents:[ag('1','running')]});t=95e3;s2.report('ann@example.test',{source:'s',agents:[ag('1','waiting','r1')]});
  assert.deepEqual(ev2,[],'a source back after going stale is a first report');s2.close();
});

const AGENT={id:'host:t3:1',title:'Fix the login bug',vendor:'claude',model:'Opus 5.5',status:'waiting',activity:'Waiting for approval',host:'laptop',hostLabel:'laptop · T3',
  repo:{name:'flow',remote:'https://github.com/acme/flow.git'},children:[{id:'c1',title:'Explore',vendor:'claude',status:'running'}],
  pending:{requestId:'req-1',kind:'approval',summary:'Run: rm -rf build',can:['allow','deny']}};

test('redaction: the owner sees all and may answer; a project viewer sees details only; anyone else sees a mascot',()=>{
  const st=officeState();st.report('ann@example.test',{source:'bridge:laptop',agents:[AGENT]});
  const a=st.live('ann@example.test')[0];
  const own=viewAgent(a,{owner:true});
  assert.equal(own.id,AGENT.id);assert.equal(own.source,'bridge:laptop');assert.equal(own.pending.requestId,'req-1');assert.deepEqual(own.pending.can,['allow','deny']);assert.equal(own.mine,true);
  const shared=viewAgent(a,{full:true,key:()=>'opaque'});
  assert.equal(shared.title,'Fix the login bug');assert.equal(shared.repo.slug,'acme/flow');assert.equal(shared.id,'opaque');
  assert.deepEqual(shared.pending.can,[]);assert.equal(shared.pending.requestId,undefined);assert.equal(shared.source,undefined);
  const priv=viewAgent(a,{key:()=>'opaque'});
  assert.deepEqual(Object.keys(priv).sort(),['activityKind','children','id','private','status','vendor']);
  assert.deepEqual(priv,{id:'opaque',vendor:'claude',status:'waiting',activityKind:'think',private:true,children:[{vendor:'claude',status:'running',activityKind:'read'}]});
  const text=JSON.stringify(priv);
  for(const secret of ['Fix the login','Opus','Waiting for approval','flow','laptop','rm -rf','req-1','host:t3'])assert.ok(!text.includes(secret),secret);
});

test('answers: owner only, only for the request it waits on, once; long-poll delivers once; results come back',async()=>{
  let t=1e6;const st=officeState({now:()=>t}),events=[];st.on(e=>events.push(e));
  const base={by:'ann@example.test',owner:'ann@example.test',source:'bridge:laptop',agentId:AGENT.id,requestId:'req-1',decision:'allow'};
  st.report('Ann@Example.test',{source:'bridge:laptop',agents:[AGENT,{...AGENT,id:'cli',pending:{requestId:'q',can:[]}}]});
  assert.throws(()=>st.answer({...base,by:'bo@example.test'}),{status:403,code:'not_owner'});
  assert.throws(()=>st.answer({...base,requestId:'req-2'}),{status:409,code:'not_waiting'});
  assert.throws(()=>st.answer({...base,agentId:'nope'}),{status:404});
  assert.throws(()=>st.answer({...base,decision:'maybe'}),{status:400});
  assert.throws(()=>st.answer({...base,agentId:'cli',requestId:'q'}),{code:'cannot_answer'},'a prompt the reporter cannot answer');
  const waiting=st.wait('ann@example.test','bridge:laptop',5000),other=st.wait('ann@example.test','bridge:desktop',20);
  const act=st.answer(base);
  assert.throws(()=>st.answer(base),{code:'already_answered'});
  assert.deepEqual((await waiting).map(x=>x.id),[act.id],'the long-poll answers as soon as it is queued');
  assert.deepEqual(await other,[],'another source hears nothing');
  assert.deepEqual(st.report('ann@example.test',{source:'bridge:laptop',agents:[AGENT]}).actions,[],'already delivered');
  assert.deepEqual(events.filter(e=>e.type==='action').map(e=>[e.email,e.action.id]),[['ann@example.test',act.id]]);
  assert.throws(()=>st.result('bo@example.test',act.id,{ok:true}),{status:404});
  st.result('ann@example.test',act.id,{ok:false,message:'Already answered in T3'});
  assert.equal(events.find(e=>e.type==='result').action.result.message,'Already answered in T3');
  // Queued while no long-poll is open: the next report carries it.
  st.report('ann@example.test',{source:'bridge:laptop',agents:[{...AGENT,pending:{...AGENT.pending,requestId:'req-9'}}]});
  const next=st.answer({...base,requestId:'req-9',decision:'deny'});
  assert.deepEqual(st.report('ann@example.test',{source:'bridge:laptop',agents:[]}).actions.map(x=>[x.id,x.decision]),[[next.id,'deny']]);
  st.close();
});

test('each source replaces only its own agents, and a source silent for 90 s is gone',()=>{
  let t=0;const st=officeState({now:()=>t}),events=[];st.on(e=>events.push(e));
  st.report('ann@example.test',{source:'a',agents:[{id:'1'}]});
  t=40e3;st.report('ann@example.test',{source:'b',agents:[{id:'2'},{id:'3'}]});
  assert.deepEqual(st.live('ann@example.test').map(x=>x.source+x.id).sort(),['a1','b2','b3']);
  t=60e3;st.report('ann@example.test',{source:'b',agents:[{id:'2'}]});
  assert.deepEqual(st.live('ann@example.test').map(x=>x.source+x.id).sort(),['a1','b2']);
  const n=events.length;st.report('ann@example.test',{source:'b',agents:[{id:'2'}]});assert.equal(events.length,n,'an unchanged report is not an event');
  t=95e3;assert.deepEqual(st.live('ann@example.test').map(x=>x.source+x.id),['b2'],'a is stale');
  st.sweep();assert.equal(events.at(-1).type,'agents');
  t=200e3;st.sweep();assert.deepEqual(st.live('ann@example.test'),[]);assert.deepEqual(st.sources('ann@example.test'),[]);
});

// ---------- the SSE hub ----------
function sse(url,{headers={}}={}){
  const events=[];let buf='',res;
  const ready=new Promise((ok,no)=>{const req=http.get(url,{headers},r=>{res=r;r.setEncoding('utf8');r.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n\n'))>=0){const block=buf.slice(0,i);buf=buf.slice(i+2);
    const type=/^event: (.+)$/m.exec(block)?.[1],data=/^data: (.+)$/m.exec(block)?.[1];if(type)events.push({type,data:JSON.parse(data)})}});ok(r)});req.on('error',no)});
  const next=async(type,ms=2000)=>{for(const end=Date.now()+ms;Date.now()<end;){const i=events.findIndex(e=>e.type===type);if(i>=0)return events.splice(i,1)[0].data;await new Promise(r=>setTimeout(r,10))}throw Error('no '+type+' event')};
  return {ready,events,next,close:()=>res?.destroy()};
}

test('the SSE hub: a snapshot redacted per viewer, presence, chat, emotes, live agent updates, answers and leave',async()=>{
  let time=0;
  const st=officeState({now:()=>time,staleMs:1000});
  const users={ann:{email:'ann@example.test',name:'Ann'},bo:{email:'bo@example.test',name:'Bo'},cy:{email:'cy@example.test',name:'Cy'}};
  const ctx={id:'env1',name:'Studio',ownerEmail:users.ann.email,members:Object.values(users).map(u=>({email:u.email,name:u.name})),
    projects:[{id:'p-flow',name:'Flow',repos:['acme/flow']},{id:'p-site',name:'Site',repos:['site']}],agents:[{id:'af0',name:'Ann',kind:'human',reportsTo:'',projects:[],memberEmail:'ann@example.test'},{id:'af1',name:'Researcher',kind:'agent',reportsTo:'',projects:[]},{id:'af2',name:'Site bot',kind:'agent',reportsTo:'',projects:['p-site']}]};
  // Bo's share covers Flow; Cy's covers Site only.
  const access={ann:{ok:true,all:true,projectIds:new Set()},bo:{ok:true,all:false,projectIds:new Set(['p-flow'])},cy:{ok:true,all:false,projectIds:new Set(['p-site'])}};
  const hub=officeHub({state:st,context:{env:async()=>ctx},heartbeatMs:60e3});
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://x'),who=u.searchParams.get('as');
    if(u.pathname==='/events'){await hub.connect('env1',users[who],access[who],req,res);return}
    res.writeHead(404);res.end();
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const url=who=>`http://127.0.0.1:${server.address().port}/events?as=${who}`;
  st.report(users.ann.email,{source:'bridge:laptop',agents:[AGENT,{...AGENT,id:'side',title:'Side project',repo:{name:'secret-thing'},pending:null,status:'running'}]});
  st.report(users.bo.email,{source:'bridge:empty',agents:[]});
  try{
    const ann=sse(url('ann')),bo=sse(url('bo')),cy=sse(url('cy'));await Promise.all([ann.ready,bo.ready,cy.ready]);
    const [sa,sb,sc]=await Promise.all([ann.next('snapshot'),bo.next('snapshot'),cy.next('snapshot')]);
    const annKey=sa.me.key;
    assert.deepEqual(sa.yourSources.map(s=>[s.source,s.agents]),[['bridge:laptop',2]]);
    assert.deepEqual(sb.yourSources.map(s=>[s.source,s.agents]),[['bridge:empty',0]]);
    assert.deepEqual(sc.yourSources,[]);
    st.report(users.cy.email,{source:'bridge:desk',agents:[]});
    assert.deepEqual((await cy.next('yourSources')).map(s=>[s.source,s.agents]),[['bridge:desk',0]]);
    await ann.next('agents');await bo.next('agents');await cy.next('agents');
    assert.ok(!ann.events.some(e=>e.type==='yourSources'));
    assert.ok(!bo.events.some(e=>e.type==='yourSources'));

    assert.equal(sa.members.length,3);assert.ok(sa.members.find(m=>m.key===annKey).owner);assert.ok(!JSON.stringify(sa).includes('@example.test'),'no emails reach the browser');
    assert.deepEqual(sa.agentflow.map(a=>a.name),['Ann','Researcher','Site bot']);
    assert.equal(sa.agentflow[0].member,annKey,'a human agent that is a member carries their key, never their email');assert.equal(sa.agentflow[1].member,'');
    assert.deepEqual(sb.agentflow,[],'a project share shows only the AgentFlow agents of its projects');assert.deepEqual(sc.agentflow.map(a=>a.name),['Site bot']);
    assert.deepEqual(sb.live[annKey][0].projects,['Flow']);assert.deepEqual(sa.live[annKey][0].projects,['Flow']);
    assert.deepEqual(sa.live[annKey].map(a=>[a.title,a.mine,a.pending?.can]),[['Fix the login bug',true,['allow','deny']],['Side project',true,undefined]]);
    // Bo sees the Flow agent (his share covers its repo) without the answer, and the side project redacted.
    assert.deepEqual(sb.live[annKey].map(a=>a.private?'private':a.title),['Fix the login bug','private']);
    assert.deepEqual(sb.live[annKey][0].pending.can,[]);assert.equal(sb.live[annKey][0].id.startsWith('host:'),false,'no real ids to others');
    // Cy sees neither.
    assert.deepEqual(sc.live[annKey].map(a=>a.private),[true,true]);
    for(const s of ['Fix the login','Side project','secret-thing','Opus','rm -rf','laptop'])assert.ok(!JSON.stringify(sc).includes(s),s);
    // Presence: the first move is a join for the others, then moves; never echoed to the mover.
    hub.move('env1',users.bo,{x:3,z:-2,heading:1,moving:true});
    assert.deepEqual(await ann.next('join'),{key:sb.me.key,name:'Bo',image:'',x:3,y:0,z:-2,heading:1,moving:true,jump:false,sprint:false});
    hub.move('env1',users.bo,{x:4,y:1.35,z:-2,heading:1,moving:true,jump:true,sprint:true});
    const airborne=await ann.next('move');
    assert.deepEqual([airborne.x,airborne.y,airborne.jump,airborne.sprint],[4,1.35,true,true]);
    hub.move('env1',users.bo,{x:4,z:-2,heading:1,moving:false});
    const legacy=await ann.next('move');
    assert.deepEqual([legacy.y,legacy.jump,legacy.sprint],[0,false,false]);
    assert.ok(!bo.events.some(e=>e.type==='join'||e.type==='move'));
    assert.throws(()=>hub.move('env1',users.bo,{x:'a',z:1}),{status:400});
    assert.throws(()=>hub.say('env1',{email:'zed@example.test'},'hi'),{status:409},'only people in the office');
    // Chat and emotes reach everyone; chat is kept for the next snapshot.
    hub.say('env1',users.cy,'  hello   team  ');assert.equal((await ann.next('say')).text,'hello team');
    assert.throws(()=>hub.say('env1',users.cy,'x'.repeat(0)),{status:400});
    hub.emote('env1',users.ann,'wave');assert.equal((await bo.next('emote')).emote,'wave');
    assert.throws(()=>hub.emote('env1',users.ann,'dance'),{status:400});
    // A new report pushes fresh views, re-redacted for each viewer.
    st.report(users.ann.email,{source:'bridge:laptop',agents:[{...AGENT,activity:'Running tests',status:'running',pending:null}]});
    assert.equal((await bo.next('agents')).agents[0].activity,'Running tests');
    assert.deepEqual((await cy.next('agents')).agents,[{id:sc.live[annKey][0].id,vendor:'claude',status:'running',activityKind:'test',private:true,children:[{vendor:'claude',status:'running',activityKind:'read'}]}],'same opaque id as before');
    // Answers: only the owner, and only the owner hears it was queued and how it went.
    st.report(users.ann.email,{source:'bridge:laptop',agents:[AGENT]});await ann.next('agents');
    assert.throws(()=>hub.answer('env1',users.bo,{source:'bridge:laptop',agentId:AGENT.id,requestId:'req-1',decision:'allow'}),{status:404},'Bo has no such agent of his own');
    const act=hub.answer('env1',users.ann,{source:'bridge:laptop',agentId:AGENT.id,requestId:'req-1',decision:'allow'});
    assert.equal((await ann.next('action')).id,act.id);
    // Everyone sees the agent react, under the id they know it by; never the prompt.
    const [ra,rb,rc]=await Promise.all([ann.next('reaction'),bo.next('reaction'),cy.next('reaction')]);
    assert.deepEqual(ra,{member:annKey,decision:'allow',phase:'answered',agent:AGENT.id});
    assert.equal(rb.agent,sb.live[annKey][0].id);assert.equal(rc.agent,sc.live[annKey][0].id);
    for(const r of [rb,rc])assert.ok(!/rm -rf|req-1|host:t3/.test(JSON.stringify(r)),JSON.stringify(r));
    st.result(users.ann.email,act.id,{ok:true,message:'Approved in T3'});
    assert.equal((await ann.next('result')).result.message,'Approved in T3');
    assert.deepEqual(await cy.next('reaction'),{member:annKey,decision:'allow',phase:'result',ok:true,agent:sc.live[annKey][0].id});
    await new Promise(r=>setTimeout(r,50));assert.ok(!bo.events.some(e=>e.type==='action'||e.type==='result'));
    time=1001;st.sweep();
    assert.deepEqual(await cy.next('yourSources'),[],'stale sources disappear over SSE');
    const reconnect=sse(url('cy'));await reconnect.ready;
    assert.deepEqual((await reconnect.next('snapshot')).yourSources,[],'stale sources stay out of snapshots');
    reconnect.close();
    // Leaving removes the avatar.
    bo.close();assert.equal((await ann.next('leave')).key,sb.me.key);
    const again=sse(url('cy'));await again.ready;const snap=await again.next('snapshot');
    assert.deepEqual(snap.chat.map(c=>c.text),['hello team']);assert.ok(!snap.people.some(p=>p.key===sb.me.key));
    ann.close();cy.close();again.close();
  }finally{hub.close();st.close();server.close()}
});

test('alert streams: only the owner hears that their agent waits, never a viewer who can see its project',async()=>{
  const st=officeState();
  const users={ann:{email:'ann@example.test',name:'Ann'},bo:{email:'bo@example.test',name:'Bo'}};
  const ctx={id:'env1',name:'Studio',ownerEmail:users.ann.email,members:Object.values(users).map(u=>({email:u.email,name:u.name})),projects:[{id:'p-flow',name:'Flow',repos:['acme/flow']}],agents:[]};
  const access={ann:{ok:true,all:true,projectIds:new Set()},bo:{ok:true,all:false,projectIds:new Set(['p-flow'])}};
  const hub=officeHub({state:st,context:{env:async()=>ctx},heartbeatMs:60e3});
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://x'),who=u.searchParams.get('as');
    if(u.pathname==='/events'){await hub.connect('env1',users[who],access[who],req,res);return}
    if(u.pathname==='/alerts'){hub.alerts(users[who],req,res);return}
    res.writeHead(404);res.end();
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const url=(path,who)=>`http://127.0.0.1:${server.address().port}/${path}?as=${who}`;
  const running={...AGENT,status:'running',pending:null,activity:'Bash: npm test'};
  st.report(users.ann.email,{source:'bridge:laptop',agents:[running]});
  try{
    const annAlerts=sse(url('alerts','ann')),boAlerts=sse(url('alerts','bo')),boOffice=sse(url('events','bo')),annOffice=sse(url('events','ann'));
    await Promise.all([annAlerts.ready,boAlerts.ready,boOffice.ready,annOffice.ready]);
    assert.deepEqual(await annAlerts.next('mine'),{waiting:[]});assert.deepEqual(await boAlerts.next('mine'),{waiting:[]});
    await boOffice.next('snapshot');await annOffice.next('snapshot');
    assert.equal(hub.alertClients(),2);
    st.report(users.ann.email,{source:'bridge:laptop',agents:[AGENT]});
    const w=await annAlerts.next('waiting');
    assert.deepEqual(w,{id:AGENT.id,source:'bridge:laptop',title:'Fix the login bug',vendor:'claude',activityKind:'think',host:'laptop · T3',pending:{requestId:'req-1',kind:'approval',summary:'Run: rm -rf build'}});
    assert.deepEqual((await annAlerts.next('mine')).waiting.map(a=>a.id),[AGENT.id]);
    // Bo sees the agent wait in the office (his share covers its project), but gets no alert of any kind.
    const seen=await boOffice.next('agents');assert.equal(seen.agents[0].status,'waiting');
    await annOffice.next('agents');
    await new Promise(r=>setTimeout(r,80));
    assert.deepEqual(boAlerts.events,[],'nothing on Bo\'s alert stream');
    assert.ok(![...boOffice.events,...annOffice.events].some(e=>e.type==='waiting'||e.type==='mine'),'office streams carry no alerts');
    // Answered elsewhere: it stops waiting, and the owner's list empties.
    st.report(users.ann.email,{source:'bridge:laptop',agents:[running]});
    assert.deepEqual(await annAlerts.next('mine'),{waiting:[]});
    assert.ok(!annAlerts.events.some(e=>e.type==='waiting'));
    annAlerts.close();await new Promise(r=>setTimeout(r,50));assert.equal(hub.alertClients(),1);
    boAlerts.close();boOffice.close();annOffice.close();
  }finally{hub.close();st.close();server.close()}
});

test('a long reporter request id comes back unchanged in the queued answer',async()=>{
  const {officeState}=await import('../lib/office.mjs');
  const st=officeState(),rid='runtime-request:'+'x'.repeat(360);
  st.report('ann@example.test',{source:'saguaro',agents:[{id:'t1',title:'T',vendor:'claude',status:'waiting',pending:{requestId:rid,kind:'approval',summary:'Run: true',can:['allow','deny']}}]});
  const a=st.answer({by:'ann@example.test',owner:'ann@example.test',source:'saguaro',agentId:'t1',requestId:rid,decision:'allow'});
  assert.equal(a.requestId,rid);
});

test('a conductor: role is kept for everyone, its reply only for its owner, masked and capped; it is private to others whatever its repo',()=>{
  const r=cleanReport({source:'s',agents:[
    {id:'cos',title:'[Flow] Chief of Staff · conductor',status:'idle',role:'Conductor',can:['message'],repo:{name:'flow',remote:'https://github.com/acme/flow'},
      modelId:'cursor_personal:default',modelProviders:[{id:'cursor_personal',label:'Cursor Personal',models:[{id:'cursor_personal:default',label:'Auto'},{id:'wrong:default'}]}],
      reply:{text:'Routed to Builder as #461 · token=ghp_abcdefghijklmnopqrstuvwxyz0123 '+'x'.repeat(900),at:'2026-11-22T10:00:00Z',cards:[461,'#12',461,-1,1.5,'x',...Array.from({length:20},(_,i)=>100+i)]},
      transcript:[{role:'assistant',text:'hi'}]},
    {id:'plain',status:'running',role:'boss',reply:{text:''}},
    {id:'bad-reply',status:'running',reply:'just text'},
  ]});
  const [cos,plain,bad]=r.agents;
  assert.equal(cos.role,'conductor');assert.deepEqual(cos.can,['message']);
  assert.ok(!('role' in plain),'only known roles are kept');assert.ok(!('reply' in plain),'an empty reply is dropped');assert.ok(!('reply' in bad));
  assert.ok(cos.reply.text.length<=600&&cos.reply.text.endsWith('…'));
  assert.ok(!cos.reply.text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'),'secrets in a reply are masked');
  assert.equal(cos.reply.at,'2026-11-22T10:00:00.000Z');
  assert.deepEqual(cos.reply.cards.slice(0,3),[461,12,100]);assert.equal(cos.reply.cards.length,12);
  const a={...cos,source:'s'};
  const own=viewAgent(a,{owner:true});
  assert.equal(own.role,'conductor');assert.equal(own.reply.text,cos.reply.text);assert.ok(own.transcript);assert.deepEqual(own.can,['message']);
  assert.deepEqual(own.modelProviders,[{id:'cursor_personal',label:'Cursor Personal',models:[{id:'cursor_personal:default',label:'Auto'}]}]);
  for(const full of [true,false]){
    const other=viewAgent(a,{full,key:()=>'opaque'});
    assert.equal(other.role,'conductor','others know it is a conductor (it walks with its person)');
    assert.equal(other.private,true,'a conductor is private to others even when its repo is visible');
    for(const k of ['reply','transcript','title','activity','repo','can','modelId','modelProviders'])assert.ok(!(k in other),k+' never reaches someone else');
    assert.equal(other.status,'idle');assert.equal(other.id,'opaque');
  }
  // An ordinary agent is unchanged: no role, no reply.
  const o=viewAgent({...r.agents[1],source:'s'},{owner:true});assert.ok(!('role' in o)&&!('reply' in o));
});
