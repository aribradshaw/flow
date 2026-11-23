// The 3D office's transcript tail (lib/office.mjs, lib/office-mask.mjs): validated, capped and masked on the
// way in, and sent only to the agent's owner, never to a shared-project viewer or anyone else.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {cleanReport,officeState,viewAgent,officeHub,TRANSCRIPT_MAX,TRANSCRIPT_TEXT} from '../lib/office.mjs';
import {maskSecrets,transcriptText} from '../lib/office-mask.mjs';

const T0=Date.parse('2026-11-22T10:00:00Z');
const lines=n=>Array.from({length:n},(_,i)=>({role:['user','assistant','tool'][i%3],text:'line '+i,at:new Date(T0+i*1000).toISOString()}));
const AGENT={id:'host:t3:1',title:'Fix the login bug',vendor:'claude',model:'Opus 5.5',status:'running',activity:'Running tests',host:'laptop',hostLabel:'laptop · T3',
  repo:{name:'flow',remote:'https://github.com/acme/flow.git'},children:[],pending:null,
  transcript:[{role:'user',text:'Fix the login loop',at:new Date(T0).toISOString()},{role:'assistant',text:'Found it: the callback keeps ?next=/login.',at:new Date(T0+1000).toISOString()}]};

test('secrets are masked: tokens, keys, Authorization headers, credentials in URLs and .env lines',()=>{
  const cases={
    'Authorization: Bearer abcdefghijklmnop':'Authorization: •••',
    'curl -H "authorization: ghp_abcdefghijklmnopqrstuvwxyz" x':'curl -H "authorization: •••" x',
    'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx':'export OPENAI_API_KEY=•••',
    'DATABASE_URL=postgres://u:p@h/db\nnext line':'DATABASE_URL=•••\nnext line',
    '"apiKey": "abc123"':'"apiKey": "•••"',
    'git push https://bot:s3cret@github.com/acme/flow':'git push https://bot:•••@github.com/acme/flow',
    'key flow_live_abcdefghijklmnopqrstu here':'key ••• here',
    'aws AKIAABCDEFGHIJKLMNOP':'aws •••',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk':'jwt •••',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----':'[private key •••]',
  };
  for(const [input,want] of Object.entries(cases))assert.equal(maskSecrets(input),want,input);
  // Ordinary text and commit ids are left alone.
  for(const s of ['Run: npm test','the sketchbook skeleton is fine','commit 9807cb8d508a33e2f1c0b9a8d7e6f5a4b3c2d1e0','Read lib/auth.mjs'])assert.equal(maskSecrets(s),s);
  // Masked before it is cut: a long key at the edge is never left half visible.
  const cut=transcriptText('x'.repeat(390)+' token=abcdefghijklmnopqrstuvwxyz',400);
  assert.ok(!cut.includes('abcdefghij'),cut);
  assert.equal(transcriptText('a\u0007b\r\n\n\n\nc   d'),'a b\n\nc d','control characters dropped, blank runs folded');
});

test('transcript: the last 12 lines with known roles, each text cut to 400 characters and masked',()=>{
  const [a]=cleanReport({source:'s',agents:[{id:'a',transcript:[...lines(20),{role:'system',text:'hidden'},{role:'user',text:''},{role:'tool',text:'Run: curl -H "Authorization: Bearer abcdefghijklmnopq" x'},
    {role:'ASSISTANT',text:'y'.repeat(1000),at:'nope'},null,'junk']}]}).agents;
  assert.equal(a.transcript.length,TRANSCRIPT_MAX);
  assert.deepEqual(a.transcript.at(-2),{role:'tool',text:'Run: curl -H "Authorization: •••" x'});
  assert.equal(a.transcript.at(-1).role,'assistant');assert.equal(a.transcript.at(-1).text.length,TRANSCRIPT_TEXT);assert.equal(a.transcript.at(-1).at,undefined);
  assert.ok(!a.transcript.some(e=>e.text==='hidden'));
  assert.equal(a.transcript[0].text,'line 10');assert.equal(a.transcript[0].at,new Date(T0+10e3).toISOString());
  // No transcript sent: none kept (older reporters).
  assert.equal(cleanReport({source:'s',agents:[{id:'b'}]}).agents[0].transcript,undefined);
  assert.deepEqual(cleanReport({source:'s',agents:[{id:'b',transcript:'no'}]}).agents[0].transcript,undefined);
});

test('transcript privacy in viewAgent: the owner only',()=>{
  const st=officeState();st.report('ann@example.test',{source:'bridge:laptop',agents:[AGENT]});
  const a=st.live('ann@example.test')[0];
  assert.deepEqual(viewAgent(a,{owner:true}).transcript.map(e=>e.text),['Fix the login loop','Found it: the callback keeps ?next=/login.']);
  assert.equal(viewAgent(a,{full:true,key:()=>'k'}).transcript,undefined,'a viewer of the project never gets it');
  assert.equal(viewAgent(a,{key:()=>'k'}).transcript,undefined);
  st.close();
});

test('transcript privacy over the live channel: shared-project viewers and strangers never receive it',async()=>{
  const st=officeState();
  const users={ann:{email:'ann@example.test',name:'Ann'},bo:{email:'bo@example.test',name:'Bo'},cy:{email:'cy@example.test',name:'Cy'}};
  const ctx={id:'env1',name:'Studio',ownerEmail:users.ann.email,members:Object.values(users).map(u=>({email:u.email,name:u.name})),
    projects:[{id:'p-flow',name:'Flow',repos:['acme/flow']}],agents:[]};
  // Bo's share covers the agent's project (he sees its details); Cy's covers nothing.
  const access={ann:{ok:true,all:true,projectIds:new Set()},bo:{ok:true,all:false,projectIds:new Set(['p-flow'])},cy:{ok:true,all:false,projectIds:new Set()}};
  const hub=officeHub({state:st,context:{env:async()=>ctx},heartbeatMs:60e3});
  const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://x');if(u.pathname!=='/events'){res.writeHead(404);res.end();return}const who=u.searchParams.get('as');await hub.connect('env1',users[who],access[who],req,res)});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const streams=[];
  const open=who=>{const s={events:[],buf:''};streams.push(s);return new Promise((ok,no)=>{s.req=http.get(`http://127.0.0.1:${server.address().port}/events?as=${who}`,r=>{s.res=r;r.setEncoding('utf8');r.on('data',c=>{s.buf+=c;let i;while((i=s.buf.indexOf('\n\n'))>=0){const b=s.buf.slice(0,i);s.buf=s.buf.slice(i+2);const type=/^event: (.+)$/m.exec(b)?.[1],data=/^data: (.+)$/m.exec(b)?.[1];if(type)s.events.push({type,data:JSON.parse(data),raw:data})}});ok(s)});s.req.on('error',no)})};
  const next=async(s,type)=>{for(const end=Date.now()+2000;Date.now()<end;){const i=s.events.findIndex(e=>e.type===type);if(i>=0)return s.events.splice(i,1)[0];await new Promise(r=>setTimeout(r,10))}throw Error('no '+type)};
  st.report(users.ann.email,{source:'bridge:laptop',agents:[AGENT]});
  try{
    const [ann,bo,cy]=await Promise.all(['ann','bo','cy'].map(open));
    const [sa,sb,sc]=await Promise.all([ann,bo,cy].map(s=>next(s,'snapshot')));
    const annKey=sa.data.me.key;
    assert.equal(sa.data.live[annKey][0].transcript.length,2,'the owner sees it');
    assert.equal(sb.data.live[annKey][0].title,'Fix the login bug','Bo sees the details…');
    assert.equal(sb.data.live[annKey][0].transcript,undefined,'…but not the transcript');
    for(const s of [sb,sc])for(const word of ['Fix the login loop','callback keeps'])assert.ok(!s.raw.includes(word),word);
    // An update: the same again.
    st.report(users.ann.email,{source:'bridge:laptop',agents:[{...AGENT,transcript:[...AGENT.transcript,{role:'user',text:'Also add a test'}]}]});
    const [ua,ub,uc]=await Promise.all([ann,bo,cy].map(s=>next(s,'agents')));
    assert.equal(ua.data.agents[0].transcript.at(-1).text,'Also add a test');
    for(const u of [ub,uc])assert.ok(!u.raw.includes('Also add a test')&&!u.raw.includes('transcript'));
  }finally{for(const s of streams)s.res?.destroy();hub.close();st.close();server.close()}
});

// ---------- steering: messages and stops ----------
const STEERABLE={...AGENT,id:'host:t3:2',can:['message','stop','dance','STOP']};
test('can: only message and stop are kept, and only the owner sees them',()=>{
  const [a,b]=cleanReport({source:'s',agents:[STEERABLE,{id:'x',can:'message'}]}).agents;
  assert.deepEqual(a.can,['message','stop']);assert.equal(b.can,undefined);
  assert.deepEqual(viewAgent({...a,source:'s'},{owner:true}).can,['message','stop']);
  assert.deepEqual(viewAgent({...a,source:'s'},{full:true,key:()=>'k'}).can,[]);
  assert.equal(viewAgent({...a,source:'s'},{key:()=>'k'}).can,undefined);
});

test('steer: owner only, only what can allows, messages checked, stops not doubled, rate-limited, delivered once',async()=>{
  let t=1e6;const st=officeState({now:()=>t}),events=[];st.on(e=>events.push(e));
  const ann='ann@example.test',src='bridge:laptop';
  st.report(ann,{source:src,agents:[STEERABLE,{...AGENT,id:'cli'}]});
  const base={by:ann,owner:ann,source:src,agentId:STEERABLE.id};
  assert.throws(()=>st.steer({...base,by:'bo@example.test',kind:'message',text:'hi'}),{status:403,code:'not_owner'});
  assert.throws(()=>st.steer({...base,kind:'dance'}),{status:400});
  assert.throws(()=>st.steer({...base,kind:'message',text:'   '}),{status:400});
  assert.throws(()=>st.steer({...base,kind:'message',text:'x'.repeat(2001)}),{status:400});
  assert.throws(()=>st.steer({...base,kind:'message'}),{status:400});
  assert.throws(()=>st.steer({...base,agentId:'gone',kind:'stop'}),{status:404});
  assert.throws(()=>st.steer({...base,agentId:'cli',kind:'message',text:'hi'}),{status:409,code:'cannot_steer'},'a reporter that did not list it in can');
  const poll=st.wait(ann,src,5000);
  const m=st.steer({...base,kind:'message',text:'  Also add a test\r\nand keep it small \u0007 '});
  assert.deepEqual({kind:m.kind,text:m.text,requestId:m.requestId,decision:m.decision},{kind:'message',text:'Also add a test\nand keep it small',requestId:undefined,decision:undefined});
  assert.deepEqual((await poll).map(x=>[x.id,x.kind,x.text]),[[m.id,'message','Also add a test\nand keep it small']]);
  assert.deepEqual(st.report(ann,{source:src,agents:[STEERABLE]}).actions,[],'delivered once');
  const s=st.steer({...base,kind:'stop'});
  assert.deepEqual(Object.keys(s).sort(),['agentId','at','id','kind','source']);
  assert.throws(()=>st.steer({...base,kind:'stop'}),{code:'already_stopping'});
  st.result(ann,s.id,{ok:true,message:'Stopped in T3 Code.'});
  assert.equal(events.filter(e=>e.type==='result').at(-1).action.kind,'stop');
  assert.ok(events.every(e=>e.type==='agents'||e.email===ann),'only the owner hears of steering');
  // Rate limits: per agent (3 messages, then one per 10 s) and per person (10, then one per 6 s).
  st.steer({...base,kind:'message',text:'2'});st.steer({...base,kind:'message',text:'3'});
  assert.throws(()=>st.steer({...base,kind:'message',text:'4'}),{status:429,code:'rate_limited'});
  t+=10e3;st.steer({...base,kind:'message',text:'5'});
  assert.throws(()=>st.steer({...base,kind:'message',text:'6'}),{status:429});
  st.close();
  const per=officeState({now:()=>t});
  per.report(ann,{source:src,agents:Array.from({length:12},(_,i)=>({...STEERABLE,id:'a'+i}))});
  for(let i=0;i<10;i++)per.steer({...base,agentId:'a'+i,kind:'message',text:'hi'});
  assert.throws(()=>per.steer({...base,agentId:'a10',kind:'message',text:'hi'}),{status:429},'per person');
  per.close();
});

test('answers stay backward compatible: no kind is an answer, and answers say kind "answer"',async()=>{
  const st=officeState(),ann='ann@example.test',src='bridge:laptop';
  const waiting={...STEERABLE,status:'waiting',pending:{requestId:'req-1',kind:'approval',summary:'Run: npm test',can:['allow','deny']}};
  st.report(ann,{source:src,agents:[waiting]});
  const hub=officeHub({state:st,context:{env:async()=>({id:'e',name:'E',ownerEmail:ann,members:[{email:ann,name:'Ann'}],projects:[],agents:[]})},heartbeatMs:60e3});
  try{
    const a=hub.answer('e',{email:ann},{source:src,agentId:waiting.id,requestId:'req-1',decision:'allow'});
    assert.deepEqual({kind:a.kind,requestId:a.requestId,decision:a.decision},{kind:'answer',requestId:'req-1',decision:'allow'});
    assert.throws(()=>hub.answer('e',{email:ann},{kind:'answer',source:src,agentId:waiting.id,requestId:'req-1',decision:'deny'}),{code:'already_answered'});
    const m=hub.answer('e',{email:ann},{kind:'message',source:src,agentId:waiting.id,text:'Go ahead'});assert.equal(m.kind,'message');
    assert.throws(()=>hub.answer('e',{email:'bo@example.test'},{kind:'stop',source:src,agentId:waiting.id}),{status:404},'someone else has no such agent of their own');
    const got=await st.wait(ann,src,0);
    assert.deepEqual(got.map(x=>x.kind),['answer','message']);
  }finally{hub.close();st.close()}
});
