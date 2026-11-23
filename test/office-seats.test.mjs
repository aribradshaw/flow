// Seats in the 3D office (lib/office-seats.mjs): the agentflow contract, inference from session titles,
// agents' desks (queue and recently finished), and per-viewer redaction of seated sessions in the SSE hub.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {cleanSeatTag,parseRunnerTitle,seatIndex,resolveSeat,seatFor,deskOf} from '../lib/office-seats.mjs';
import {cleanReport,officeState,officeHub} from '../lib/office.mjs';

const NOW=Date.parse('2026-11-20T12:00:00Z'),day=864e5,iso=t=>new Date(t).toISOString();
const ctx=()=>({id:'env1',name:'Studio',ownerEmail:'ann@example.test',
  members:[{email:'ann@example.test',name:'Ann'},{email:'bo@example.test',name:'Bo'},{email:'cy@example.test',name:'Cy'}],
  projects:[{id:'p-flow',name:'Flow',repos:['acme/flow']},{id:'p-site',name:'Site',repos:['acme/site']}],
  agents:[
    {id:'af-build',name:'Builder',kind:'agent',reportsTo:'',projects:['p-flow'],cards:['c1','c2','c3','c4','c5','c6','c7','c8']},
    {id:'af-ops',name:'Ops: Infra',kind:'agent',reportsTo:'',projects:['p-site'],cards:['c9','c10']},
    {id:'af-rev',name:'Reviewer',kind:'agent',reportsTo:'',projects:[],cards:['c10']}],
  cards:[
    {id:'c1',number:1,title:'Login bug',column:'doing',project:'p-flow',moved:iso(NOW-day)},
    {id:'c2',number:2,title:'Docs',column:'requests',project:'p-flow',moved:iso(NOW)},
    {id:'c3',number:3,title:'Tests',column:'must',project:'p-flow',moved:iso(NOW)},
    {id:'c4',number:4,title:'Nice',column:'nice',project:'p-flow',moved:iso(NOW)},
    {id:'c5',number:5,title:'Blocked',column:'blocked',project:'p-flow',moved:iso(NOW)},
    {id:'c6',number:6,title:'Snoozed',column:'must',project:'p-flow',moved:iso(NOW),snoozedUntil:iso(NOW+day)},
    {id:'c7',number:7,title:'Shipped',column:'done',project:'p-flow',moved:iso(NOW-2*day)},
    {id:'c8',number:8,title:'Old',column:'done',project:'p-flow',moved:iso(NOW-30*day)},
    {id:'c9',number:9,title:'Rotate keys',column:'doing',project:'p-site',moved:iso(NOW)},
    {id:'c10',number:10,title:'Shared card',column:'requests',project:'p-site',moved:iso(NOW)},
    {id:'c11',number:11,title:'Nobody',column:'requests',project:'p-flow',moved:iso(NOW)}]});

test('the agentflow tag is cleaned: agent id or name, card number, "#n" or id; nothing else is kept',()=>{
  assert.deepEqual(cleanSeatTag({agent:' Builder ',card:12}),{agent:'Builder',card:12});
  assert.deepEqual(cleanSeatTag({agent:'af-build',card:'#7'}),{agent:'af-build',card:7});
  assert.deepEqual(cleanSeatTag({card:'c3'}),{agent:'',card:'c3'});
  assert.deepEqual(cleanSeatTag({agent:'x'.repeat(300),card:-1}),{agent:'x'.repeat(200),card:''});
  for(const bad of [null,'Builder',[],{},{agent:'',card:''},{agent:{},card:{}},{card:0}])assert.equal(cleanSeatTag(bad),null,JSON.stringify(bad));
  const r=cleanReport({source:'s',agents:[{id:'a',agentflow:{agent:'Builder',card:'#1',extra:'dropped'}},{id:'b',agentflow:'nope'},{id:'c'}]});
  assert.deepEqual(r.agents.map(a=>a.agentflow),[{agent:'Builder',card:1},undefined,undefined]);
});

test('the runner\'s title names the agent and the card, even when the agent\'s name has a colon',()=>{
  assert.deepEqual(parseRunnerTitle('[Flow] Builder: #12 Fix the login bug'),{agent:'Builder',card:12});
  assert.deepEqual(parseRunnerTitle('[Flow] Ops: Infra: #9 Rotate keys'),{agent:'Ops: Infra',card:9});
  assert.equal(parseRunnerTitle('[Flow] Pick a model for #12'),null);
  assert.equal(parseRunnerTitle('Builder: #12'),null);
});

test('seats: the tag first, then the runner title, then a "#n" card delegated to exactly one agent',()=>{
  const ix=seatIndex(ctx()),seat=s=>resolveSeat(ix,s);
  // 1. The reporter's tag: by name or id; a card alone takes its only agent; an agent this environment lacks is no seat.
  assert.deepEqual(seat({title:'whatever',agentflow:{agent:'builder',card:1}}),{agent:'af-build',card:'c1',via:'report'});
  assert.deepEqual(seat({title:'',agentflow:{agent:'af-ops',card:''}}),{agent:'af-ops',card:'',via:'report'});
  assert.deepEqual(seat({agentflow:{agent:'',card:'c9'}}),{agent:'af-ops',card:'c9',via:'report'});
  assert.equal(seat({title:'[Flow] Builder: #1 Login bug',agentflow:{agent:'Elsewhere',card:1}}),null,'the tag wins over the title');
  // 2. The runner's title.
  assert.deepEqual(seat({title:'[Flow] Builder: #1 Login bug'}),{agent:'af-build',card:'c1',via:'runner'});
  assert.deepEqual(seat({title:'[Flow] Ops: Infra: #9 Rotate keys'}),{agent:'af-ops',card:'c9',via:'runner'});
  assert.deepEqual(seat({title:'[Flow] Builder: #404 Gone'}),{agent:'af-build',card:'',via:'runner'},'the agent even when the card is not here');
  assert.equal(seat({title:'[Flow] Somebody: #1 Login bug'}),null,'an agent of another environment');
  // 3. A card number: its only agent; none or several agents link the card without a seat.
  assert.deepEqual(seat({title:'Work on #3 tests'}),{agent:'af-build',card:'c3',via:'card'});
  assert.deepEqual(seat({title:'Card #11'}),{agent:'',card:'c11',via:'card'},'no delegated agent: the card only');
  assert.deepEqual(seat({title:'Card #10 for two'}),{agent:'',card:'c10',via:'card'},'ambiguous: no seat');
  assert.equal(seat({title:'Card #99'}),null);assert.equal(seat({title:'issue&#3; a#3 #3x'}),null);assert.equal(seat({title:'Plain'}),null);
  // A session in another repo than the card's project is not taken for that card.
  assert.equal(seat({title:'#3',repo:{name:'other',remote:'https://github.com/other/thing'}}),null);
  assert.equal(seat({title:'#3',repo:{name:'flow',remote:'git@github.com:acme/flow.git'}}).agent,'af-build');
  // The runner cuts a long name to 80 characters (tools/agent-runner.mjs titleOf).
  const long=ctx(),name='Release manager for the public site and the documentation, the changelog and every tag';long.agents.push({id:'af-long',name,projects:[],cards:[]});
  assert.equal(resolveSeat(seatIndex(long),{title:`[Flow] ${name.slice(0,80).trim()}: #2 Docs`}).agent,'af-long');
  // Two agents with one name: neither is taken.
  const twin=ctx();twin.agents.push({id:'af-b2',name:'builder',projects:[],cards:[]});
  assert.equal(resolveSeat(seatIndex(twin),{title:'[Flow] Builder: #1 x'}),null);
});

test('a desk: the queue in AgentFlow\'s order (top 5, no snoozed or done cards) and what finished this week',()=>{
  const ix=seatIndex(ctx()),all={all:true,projectIds:new Set()};
  const d=deskOf(ix,'af-build',all,NOW);
  assert.deepEqual(d.queue.map(c=>c.number),[1,2,5,3,4]);assert.equal(d.queued,5);
  assert.deepEqual(d.done.map(c=>[c.number,c.column]),[[7,'done']],'30 days ago is not this week');
  assert.deepEqual(Object.keys(d.queue[0]).sort(),['column','number','title']);
  const none=deskOf(ix,'af-build',{all:false,projectIds:new Set(['p-site'])},NOW);
  assert.deepEqual([none.queue,none.done],[[],[]],'only cards the viewer can see');
  assert.deepEqual(deskOf(ix,'nope',all,NOW),{queue:[],done:[]});
  // A share's own card list (label scopes) decides when there is one.
  assert.deepEqual(deskOf(ix,'af-build',{all:false,projectIds:new Set(),cardIds:new Set(['c3'])},NOW).queue.map(c=>c.number),[3]);
  assert.deepEqual(seatFor(ix,{agent:'af-build',card:'c1'},{all:false,projectIds:new Set(['p-site'])}),null);
  assert.deepEqual(seatFor(ix,{agent:'af-build',card:'c1'},{all:false,projectIds:new Set(['p-site'])},{owner:true}),{agent:'af-build',card:{number:1,title:'Login bug',column:'doing'}});
});

function sse(url){
  const events=[];let buf='',res;
  const ready=new Promise((ok,no)=>{const req=http.get(url,r=>{res=r;r.setEncoding('utf8');r.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n\n'))>=0){const block=buf.slice(0,i);buf=buf.slice(i+2);
    const type=/^event: (.+)$/m.exec(block)?.[1],data=/^data: (.+)$/m.exec(block)?.[1];if(type)events.push({type,data:JSON.parse(data)})}});ok(r)});req.on('error',no)});
  const next=async(type,ms=2000)=>{for(const end=Date.now()+ms;Date.now()<end;){const i=events.findIndex(e=>e.type===type);if(i>=0)return events.splice(i,1)[0].data;await new Promise(r=>setTimeout(r,10))}throw Error('no '+type+' event')};
  return {ready,next,close:()=>res?.destroy()};
}

test('seated sessions are redacted per viewer: the owner sees all; others need the project and the agent or its card',async()=>{
  const st=officeState({now:()=>NOW}),c=ctx();
  // Bo's share covers Flow (Builder's project); Cy's covers Site; Dee sees Flow but only card c11 (a label share).
  c.members.push({email:'dee@example.test',name:'Dee'});
  const users={ann:{email:'ann@example.test',name:'Ann'},bo:{email:'bo@example.test',name:'Bo'},cy:{email:'cy@example.test',name:'Cy'},dee:{email:'dee@example.test',name:'Dee'}};
  const scope=(id,ids)=>({id,nodeIds:new Set(),cardIds:new Set(ids)});
  const access={
    ann:{ok:true,all:true,projectIds:new Set()},
    bo:{ok:true,all:false,projectIds:new Set(['p-flow']),scopes:[scope('bo-share',['c1','c11'])]},
    cy:{ok:true,all:false,projectIds:new Set(['p-site']),scopes:[scope('cy-share',['c9','c10'])]},
    dee:{ok:true,all:false,projectIds:new Set(['p-flow']),cardIds:new Set(['c11']),scopes:[scope('dee-share',['c11'])]},
  };
  const hub=officeHub({state:st,context:{env:async()=>c},heartbeatMs:60e3,now:()=>NOW});
  const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://x'),who=u.searchParams.get('as');
    if(u.pathname==='/events'&&users[who]){await hub.connect('env1',users[who],access[who],req,res);return}res.writeHead(404);res.end()});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const flow={name:'flow',remote:'https://github.com/acme/flow.git'};
  st.report(users.ann.email,{source:'bridge:laptop',agents:[
    {id:'t1',title:'[Flow] Builder: #1 Login bug',vendor:'claude',status:'running',activity:'Running tests',repo:flow},
    {id:'t2',title:'Tidy',vendor:'codex',status:'running',repo:flow,agentflow:{agent:'Reviewer',card:10}},
    {id:'t3',title:'Look at #11',vendor:'gemini',status:'idle',repo:flow}]});
  const url=who=>`http://127.0.0.1:${server.address().port}/events?as=${who}`;
  const conns=Object.keys(users).map(w=>sse(url(w)));
  try{
    await Promise.all(conns.map(x=>x.ready));
    const [sa,sb,sc,sd]=await Promise.all(conns.map(x=>x.next('snapshot'))),annKey=sa.me.key,live=s=>s.live[annKey];
    // Ann (owner): every seat, with its card.
    assert.deepEqual(live(sa).map(a=>a.seat),[{agent:'af-build',card:{number:1,title:'Login bug',column:'doing'}},{agent:'af-rev',card:{number:10,title:'Shared card',column:'requests'}},{agent:'',card:{number:11,title:'Nobody',column:'requests'}}]);
    assert.deepEqual(sa.agentflow.find(a=>a.id==='af-build').desk.queue.map(c=>c.number),[1,2,5,3,4]);
    // Local boards read the store. Remote boards join only the recipient's scoped projected ids.
    const ids=s=>s.agentflow.flatMap(a=>a.boardCards);
    assert.deepEqual(ids(sa),[],'the owner already has the queues in their workspace');
    assert.deepEqual(ids(sb),['sh.bo-share.c1'],'Bo only gets projected card ids in his scope');
    assert.deepEqual(ids(sc),['sh.cy-share.c9','sh.cy-share.c10'],'Cy only gets projected Site cards');
    assert.deepEqual(ids(sd),[],'Dee cannot see the cards delegated to Builder');
    // Bo sees Flow: Builder's session in full at its desk; the Reviewer session (agent and card outside his share)
    // is redacted although its repo is in Flow; #11 is in Flow, so linked.
    assert.deepEqual(live(sb).map(a=>a.private?'private':a.seat),[{agent:'af-build',card:{number:1,title:'Login bug',column:'doing'}},'private',{agent:'',card:{number:11,title:'Nobody',column:'requests'}}]);
    for(const s of ['Tidy','Reviewer','Shared card','af-rev'])assert.ok(!JSON.stringify(live(sb)).includes(s),s);
    assert.deepEqual(sb.agentflow.map(a=>a.id),['af-build']);
    // Cy sees Site only: every session is private (their repo is Flow), and no seat leaks.
    assert.ok(live(sc).every(a=>a.private&&!a.seat));assert.ok(!JSON.stringify(live(sc)).includes('af-'));
    // Dee: Flow's repo but only card c11 (and Builder through its project).
    assert.deepEqual(live(sd).map(a=>a.private?'private':a.seat),[{agent:'af-build',card:null},'private',{agent:'',card:{number:11,title:'Nobody',column:'requests'}}]);
    assert.deepEqual(sd.agentflow.find(a=>a.id==='af-build').desk.queue,[],'Builder\'s cards are outside Dee\'s share');
  }finally{for(const x of conns)x.close();hub.close();st.close();await new Promise(ok=>server.close(ok))}
});
