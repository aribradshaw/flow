// Live steps, the thread index and history pages (lib/office-threads.mjs, lib/office.mjs): validated, capped and
// masked on the way in, and sent only to the agent's owner on their own signed-in pages: never to a shared-project
// viewer, a stranger, or an API key's stream.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {cleanReport,officeState,viewAgent,officeHub} from '../lib/office.mjs';
import {cleanLive,cleanThreads,cleanHistory,historyBytes,LIVE_STEPS,THREADS_MAX,HISTORY_ITEMS,HISTORY_BYTES} from '../lib/office-threads.mjs';

const T0=Date.parse('2026-11-22T10:00:00Z'),at=i=>new Date(T0+i*1000).toISOString();
const ann='ann@example.test',src='bridge:laptop';
const LIVE={phase:'thinking',text:'Checking the UAT cards before answering',steps:[{kind:'thinking',text:'Checking the UAT cards',at:at(1)},{kind:'tool',text:'Run: npm test',at:at(2)}]};
const AGENT={id:'host:t3:1',title:'Fix the login bug',vendor:'claude',model:'Opus 5.5',status:'running',activity:'Thinking',host:'laptop',hostLabel:'laptop · T3',
  repo:{name:'flow',remote:'https://github.com/acme/flow.git'},children:[],pending:null,can:['message','stop','history'],live:LIVE};
const THREADS={items:[{id:'host:t3:1',title:'Fix the login bug',project:'Flow',state:'working',updatedAt:at(3),branch:'main'},
  {id:'host:t3:idle',title:'Plan the launch',project:'Flow',state:'done',updatedAt:at(2),unread:true},
  {id:'host:t3:zz',title:'Old thing',project:'SongBrain',state:'snoozed',updatedAt:at(1)}],counts:{snoozed:7,settled:231},can:['message','history']};

test('live: phases and steps checked, the last 8 steps kept, texts masked and cut, dropped while idle',()=>{
  const steps=Array.from({length:20},(_,i)=>({kind:['thinking','tool','writing'][i%3],text:'step '+i,at:at(i)}));
  const live=cleanLive({phase:'tool',text:'Run: curl -H "Authorization: Bearer abcdefghijklmnopq" x\n'+'y'.repeat(2000),steps:[...steps,{kind:'shell',text:'no'},{kind:'tool',text:''},null]});
  assert.equal(live.phase,'tool');
  assert.ok(live.text.startsWith('Run: curl -H "Authorization: •••" x'),live.text);assert.ok(live.text.length<=600);
  assert.equal(live.steps.length,LIVE_STEPS);assert.equal(live.steps.at(-1).text,'step 19');assert.equal(live.steps[0].at,at(12));
  assert.equal(cleanLive({phase:'dancing',steps:[{kind:'tool',text:'Read a.js'}]}).phase,'tool','an unknown phase: the last step\'s kind');
  assert.equal(cleanLive({phase:'nope'}),null);assert.equal(cleanLive('x'),null);
  assert.equal(cleanLive({steps:[{kind:'tool',text:'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz'}]}).steps[0].text,'export GITHUB_TOKEN=•••');
  const [running,idle]=cleanReport({source:'s',agents:[{...AGENT},{...AGENT,id:'b',status:'idle'}]}).agents;
  assert.deepEqual(running.live.steps.map(s=>s.text),['Checking the UAT cards','Run: npm test']);
  assert.equal(idle.live,undefined);
  assert.deepEqual(running.can,['message','stop','history']);
  assert.deepEqual(viewAgent({...running,source:'s'},{owner:true}).live,running.live);
  assert.equal(viewAgent({...running,source:'s'},{full:true,key:()=>'k'}).live,undefined,'a viewer of its project never gets it');
  assert.equal(viewAgent({...running,source:'s'},{key:()=>'k'}).live,undefined);
});

test('threads: states checked, up to 150, titles masked, counts and can kept; missing keeps the last index, null clears it',()=>{
  const many=Array.from({length:200},(_,i)=>({id:'t'+i,title:'T '+i,state:'done'}));
  const t=cleanThreads({items:[{id:'x',title:'token=abcdefghijklmno',state:'woke'},{id:'bad',state:'sleeping'},{id:'has space',state:'done'},{id:'x',state:'done'},...many],counts:{snoozed:3,settled:-1},can:['message','fly']});
  assert.equal(t.items.length,THREADS_MAX);assert.equal(t.items[0].title,'token=•••');assert.equal(t.items[0].state,'woke');
  assert.ok(!t.items.some(x=>x.id==='bad'||x.id==='has space'));assert.equal(t.items.filter(x=>x.id==='x').length,1);
  assert.deepEqual(t.counts,{snoozed:3,settled:0});assert.deepEqual(t.can,['message']);
  assert.equal(cleanThreads(null),null);assert.equal(cleanThreads('x'),undefined);
  const st=officeState();
  st.report(ann,{source:src,agents:[AGENT],threads:THREADS});
  st.report(ann,{source:src,agents:[AGENT]});
  assert.deepEqual(st.threads(ann).map(x=>[x.source,x.items.length,x.counts.settled]),[[src,3,231]],'a report without threads keeps them');
  st.report(ann,{source:src,agents:[AGENT],threads:null});
  assert.deepEqual(st.threads(ann),[]);
  assert.deepEqual(st.threads('bo@example.test'),[]);
  st.close();
});

test('patchLive: only agents in the source\'s report, only changes, idle skipped, null clears, rate-limited per source',()=>{
  let t=1e6;const st=officeState({now:()=>t}),events=[];st.on(e=>events.push(e));
  assert.deepEqual(st.patchLive(ann,{source:src,agents:[{id:AGENT.id,live:LIVE}]}),{accepted:0},'no report yet');
  st.report(ann,{source:src,agents:[AGENT,{...AGENT,id:'idle',status:'idle'}]});
  assert.deepEqual(st.patchLive(ann,{source:src,agents:[{id:AGENT.id,live:LIVE},{id:'idle',live:LIVE},{id:'nobody',live:LIVE}]}),{accepted:0},'unchanged, idle, unknown');
  const next={phase:'writing',text:'There are 18 cards in UAT',steps:[...LIVE.steps,{kind:'writing',text:'There are 18 cards in UAT',at:at(4)}]};
  assert.deepEqual(st.patchLive(ann,{source:src,agents:[{id:AGENT.id,live:next}]}),{accepted:1});
  assert.equal(st.live(ann)[0].live.text,'There are 18 cards in UAT');
  const live=events.filter(e=>e.type==='live');
  assert.deepEqual(live.map(e=>[e.email,e.source,e.agents[0].id,e.agents[0].live.phase]),[[ann,src,AGENT.id,'writing']]);
  st.patchLive(ann,{source:src,agents:[{id:AGENT.id,live:null}]});
  assert.equal(st.live(ann)[0].live,undefined);
  assert.throws(()=>st.patchLive(ann,{agents:[]}),{status:400});
  let limited=false;for(let i=0;i<40&&!limited;i++)try{st.patchLive(ann,{source:src,agents:[]})}catch(e){limited=e.status===429}
  assert.ok(limited,'30 in a burst, then 8 a second');
  t+=1000;st.patchLive(ann,{source:src,agents:[]});
  st.close();
});

test('messages reach idle threads in the index; stops only live agents; the thread must still be listed',async()=>{
  const st=officeState();
  st.report(ann,{source:src,agents:[AGENT],threads:THREADS});
  const base={by:ann,owner:ann,source:src};
  const poll=st.wait(ann,src,5000);
  const m=st.steer({...base,agentId:'host:t3:idle',kind:'message',text:'Pick this back up'});
  assert.deepEqual((await poll).map(x=>[x.id,x.agentId,x.kind,x.text]),[[m.id,'host:t3:idle','message','Pick this back up']]);
  assert.throws(()=>st.steer({...base,agentId:'host:t3:idle',kind:'stop'}),{status:404},'nothing is running there');
  assert.throws(()=>st.steer({...base,agentId:'host:t3:gone',kind:'message',text:'hi'}),{status:404,message:/T3 sidebar/});
  assert.throws(()=>st.steer({...base,by:'bo@example.test',agentId:'host:t3:idle',kind:'message',text:'hi'}),{status:403});
  // An index that does not offer messages: no messages to idle threads.
  st.report(ann,{source:src,agents:[AGENT],threads:{...THREADS,can:['history']}});
  assert.throws(()=>st.steer({...base,agentId:'host:t3:idle',kind:'message',text:'hi'}),{status:404});
  st.close();
});

test('history: owner only, a cursor checked, rate-limited, delivered to the reporter, the page capped and never stored',async()=>{
  let t=1e6;const st=officeState({now:()=>t}),events=[];st.on(e=>events.push(e));
  st.report(ann,{source:src,agents:[AGENT],threads:THREADS});
  const base={by:ann,owner:ann,source:src};
  assert.throws(()=>st.history({...base,by:'bo@example.test',agentId:'host:t3:idle'}),{status:403});
  assert.throws(()=>st.history({...base,agentId:'host:t3:gone'}),{status:404});
  assert.throws(()=>st.history({...base,agentId:'host:t3:idle',before:'bad\ncursor'}),{status:400});
  const poll=st.wait(ann,src,5000);
  const h=st.history({...base,agentId:'host:t3:idle',before:'o:120'});
  const [got]=await poll;
  assert.deepEqual({kind:got.kind,agentId:got.agentId,before:got.before,text:got.text},{kind:'history',agentId:'host:t3:idle',before:'o:120',text:undefined});
  const page={items:[{role:'user',text:'What is in UAT?',at:at(1)},{role:'reasoning',title:'Checking UAT',text:'Listing cards',at:at(2)},
    {role:'tool',title:'Run: flow cards list',detail:'export FLOW_API_KEY=flow_live_abcdefghijklmnopqrst\n18 cards',status:'completed',at:at(3)},
    {role:'assistant',text:'18 cards are in UAT.',at:at(4)},{role:'system',text:'dropped'},{role:'tool'}],before:'o:90',more:true};
  const r=st.result(ann,h.id,{ok:true,message:'4 items',data:page});
  assert.equal(r.data,undefined,'the reporter gets no echo');
  const ev=events.filter(e=>e.type==='result').at(-1);
  assert.equal(ev.email,ann);
  assert.deepEqual(ev.action.data.items.map(x=>x.role),['user','reasoning','tool','assistant']);
  assert.equal(ev.action.data.items[2].detail,'export FLOW_API_KEY=•••\n18 cards');
  assert.deepEqual([ev.action.data.before,ev.action.data.more],['o:90',true]);
  assert.ok(!JSON.stringify(await st.recent(ann)).includes('What is in UAT'),'the page is not kept');
  // Rate limits: 6 per thread in a burst.
  let limited=false;for(let i=0;i<10&&!limited;i++)try{st.history({...base,agentId:'host:t3:idle'})}catch(e){limited=e.status===429}
  assert.ok(limited);
  // A live agent listing history in can works without an index.
  st.report(ann,{source:src,agents:[AGENT],threads:null});t+=60e3;
  assert.equal(st.history({...base,agentId:AGENT.id}).kind,'history');
  assert.throws(()=>st.history({...base,agentId:'host:t3:idle'}),{status:404});
  st.close();
});

test('history pages: up to 60 items and 64 KB (long texts cut harder first), masked',()=>{
  const items=Array.from({length:100},(_,i)=>({role:'assistant',text:'x'.repeat(3900)+i,at:at(i)}));
  const page=cleanHistory({items,before:'c',more:true});
  assert.equal(page.items.length,HISTORY_ITEMS);assert.ok(historyBytes(page)<=HISTORY_BYTES);assert.ok(page.items.at(-1).text.length<=1000);
  assert.deepEqual(cleanHistory({items:[],more:true}),{items:[],before:null,more:false},'more needs a cursor');
  assert.throws(()=>cleanHistory('x'),{status:400});
  const titles=Array.from({length:60},()=>({role:'tool',title:'t'.repeat(200),detail:'d'.repeat(600),text:'z'.repeat(300)}));
  assert.ok(historyBytes(cleanHistory({items:titles}))<=HISTORY_BYTES);
});

// ---------- over the live channel ----------
async function office(){
  const st=officeState();
  const users={ann:{email:ann,name:'Ann'},bo:{email:'bo@example.test',name:'Bo'},cy:{email:'cy@example.test',name:'Cy'},key:{email:ann,name:'Ann',key:'k1'}};
  const ctx={id:'env1',name:'Studio',ownerEmail:ann,members:[users.ann,users.bo,users.cy].map(u=>({email:u.email,name:u.name})),projects:[{id:'p-flow',name:'Flow',repos:['acme/flow']}],agents:[]};
  // Bo's share covers the agent's project (he sees its details); Cy's covers nothing; "key" is Ann's own API key.
  const access={ann:{ok:true,all:true,projectIds:new Set()},bo:{ok:true,all:false,projectIds:new Set(['p-flow'])},cy:{ok:true,all:false,projectIds:new Set()},key:{ok:true,all:true,projectIds:new Set()}};
  const hub=officeHub({state:st,context:{env:async()=>ctx},heartbeatMs:60e3});
  const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://x');const who=u.searchParams.get('as');await hub.connect('env1',users[who],access[who],req,res)});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const streams=[];
  const open=who=>{const s={events:[],buf:'',raw:''};streams.push(s);return new Promise((ok,no)=>{s.req=http.get(`http://127.0.0.1:${server.address().port}/events?as=${who}`,r=>{s.res=r;r.setEncoding('utf8');r.on('data',c=>{s.raw+=c;s.buf+=c;let i;while((i=s.buf.indexOf('\n\n'))>=0){const b=s.buf.slice(0,i);s.buf=s.buf.slice(i+2);const type=/^event: (.+)$/m.exec(b)?.[1],data=/^data: (.+)$/m.exec(b)?.[1];if(type)s.events.push({type,data:JSON.parse(data),raw:data})}});ok(s)});s.req.on('error',no)})};
  const next=async(s,type,ms=2000)=>{for(const end=Date.now()+ms;Date.now()<end;){const i=s.events.findIndex(e=>e.type===type);if(i>=0)return s.events.splice(i,1)[0];await new Promise(r=>setTimeout(r,10))}throw Error('no '+type)};
  const close=()=>{for(const s of streams)s.res?.destroy();hub.close();st.close();server.close()};
  return {st,hub,users,open,next,close};
}
const SECRET_WORDS=['Checking the UAT cards','Plan the launch','Old thing','What is in UAT','18 cards are in UAT'];

test('live channel: only the owner\'s signed-in page gets live steps, threads and history pages',async()=>{
  const o=await office();
  o.st.report(ann,{source:src,agents:[AGENT],threads:THREADS});
  try{
    const [a,b,c,k]=await Promise.all(['ann','bo','cy','key'].map(o.open));
    const [sa,sb,sc,sk]=await Promise.all([a,b,c,k].map(s=>o.next(s,'snapshot')));
    const me=sa.data.me.key;
    assert.equal(sa.data.live[me][0].live.text,LIVE.text,'the owner sees what it is doing');
    assert.deepEqual(sa.data.threads.map(t=>[t.source,t.items.length,t.counts.snoozed]),[[src,3,7]]);
    assert.equal(sb.data.live[me][0].title,'Fix the login bug','Bo sees the details…');
    for(const s of [sb,sc,sk]){assert.equal(s.data.live[me][0].live,undefined,'…but not live steps');assert.deepEqual(s.data.threads,[])}
    // A live update and a new index: the owner's page only.
    o.st.patchLive(ann,{source:src,agents:[{id:AGENT.id,live:{...LIVE,text:'Checking the UAT cards again'}}]});
    const la=await o.next(a,'live');
    assert.deepEqual([la.data.source,la.data.agents[0].id,la.data.agents[0].live.text],[src,AGENT.id,'Checking the UAT cards again']);
    o.st.report(ann,{source:src,agents:[AGENT],threads:{...THREADS,items:[...THREADS.items,{id:'host:t3:new',title:'Plan the launch, part 2',state:'working'}]}});
    const ta=await o.next(a,'threads');
    assert.equal(ta.data.items.length,4);
    // History: asked from the owner's page, answered by the reporter, delivered to that page only.
    await assert.rejects(async()=>o.hub.answer('env1',o.users.key,{kind:'history',source:src,agentId:'host:t3:idle'}),{status:403},'not from an API key');
    const h=await o.hub.answer('env1',o.users.ann,{kind:'history',source:src,agentId:'host:t3:idle'});
    const [got]=await o.st.wait(ann,src,0);assert.equal(got.id,h.id);
    o.st.result(ann,h.id,{ok:true,message:'2 items',data:{items:[{role:'user',text:'What is in UAT?'},{role:'assistant',text:'18 cards are in UAT.'}],before:null}});
    const ra=await o.next(a,'result');
    assert.deepEqual(ra.data.data.items.map(x=>x.text),['What is in UAT?','18 cards are in UAT.']);
    // A message to an idle thread from the page.
    const m=await o.hub.answer('env1',o.users.ann,{kind:'message',source:src,agentId:'host:t3:idle',text:'Pick this back up'});
    assert.equal(m.kind,'message');
    await o.next(a,'action');
    await new Promise(r=>setTimeout(r,100));
    for(const s of [b,c,k]){
      assert.ok(!s.events.some(e=>['live','threads'].includes(e.type)),'no live or threads events');
      for(const word of SECRET_WORDS)assert.ok(!s.raw.includes(word),word);
      assert.ok(!s.raw.includes('Pick this back up'));
    }
  }finally{o.close()}
});
