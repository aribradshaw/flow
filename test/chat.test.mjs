// Chat with OneProfileID friends (docs/concepts/11-chat.md): the pure rules (card links in messages,
// merging and paging, times, the friend picker, card summaries and where a link opens) and the
// /api/chat routes against a fake OneProfileID client, in process. Synthetic example.test data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as core from '../public/chat-core.js';
import {chatRoutes,cleanThread,cleanConversations,friendHandles} from '../lib/chat.mjs';

const ORIGIN='https://flow.example.test';
const CARD={env:'env-1',kind:'card',id:'card-1'},NODE={env:'env-1',kind:'node',id:'n-1'};

test('card links: a deep link per card or mind map card, on this origin only',()=>{
  const url=core.linkFor(ORIGIN,CARD);
  assert.equal(url,`${ORIGIN}/?env=env-1&card=card-1`);
  assert.deepEqual(core.refFromUrl(url,ORIGIN),CARD);
  assert.deepEqual(core.refFromUrl(core.linkFor(ORIGIN+'/',NODE),ORIGIN),NODE);
  assert.deepEqual(core.refFromSearch('?env=env-1&node=n-1'),NODE);
  // Another origin, another path, both or neither kind, bad ids: not a Flow card link.
  for(const u of ['https://evil.example.test/?env=env-1&card=card-1','https://flow.example.test/x?env=env-1&card=card-1',`${ORIGIN}/?env=env-1&card=a&node=b`,`${ORIGIN}/?env=env-1`,
    `${ORIGIN}/?env=bad%20env&card=c`,`${ORIGIN}/?env=env-1&card=sh.x.y`,`${ORIGIN}/?env=env-1&card=${'a'.repeat(101)}`,'not a url'])assert.equal(core.refFromUrl(u,ORIGIN),null,u);
  assert.equal(core.refFromSearch(''),null);
});

test('a card message reads as text anywhere and parses back into a card bubble',()=>{
  const summary={kind:'card',title:'Fix the  sign-in\nloop',number:12};
  const body=core.cardMessage('  Can you look?  ',summary,core.linkFor(ORIGIN,CARD));
  assert.equal(body,`Can you look?\n\nFlow card #12: Fix the sign-in loop\n${ORIGIN}/?env=env-1&card=card-1`);
  assert.deepEqual(core.parseMessage(body,ORIGIN),{text:'Can you look?',cards:[{ref:CARD,url:`${ORIGIN}/?env=env-1&card=card-1`,title:'Fix the sign-in loop'}]});
  // Without a note, and for mind map cards.
  const p=core.parseMessage(core.cardMessage('',{kind:'node',type:'person',name:'Ana Example'},core.linkFor(ORIGIN,NODE)),ORIGIN);
  assert.deepEqual(p,{text:'',cards:[{ref:NODE,url:`${ORIGIN}/?env=env-1&node=n-1`,title:'Ana Example'}]});
  assert.equal(core.cardLine({kind:'node',type:'area',name:'Ops'}),'Flow project area: Ops');
  // A link typed into text stays in the text and still shows its card, with no title of its own.
  const inline=core.parseMessage(`see ${ORIGIN}/?env=env-1&card=card-1, thanks`,ORIGIN);
  assert.equal(inline.text,`see ${ORIGIN}/?env=env-1&card=card-1, thanks`);assert.deepEqual(inline.cards.map(c=>[c.ref,c.title]),[[CARD,null]]);
  // Links to another Flow stay plain text; a title line without a link is just text.
  const other=core.parseMessage('Flow card #3: Elsewhere\nhttps://other.example.test/?env=e&card=c',ORIGIN);
  assert.equal(other.cards.length,0);assert.match(other.text,/Elsewhere/);
  // The same card twice shows once; at most five cards.
  assert.equal(core.parseMessage(`${core.linkFor(ORIGIN,CARD)}\n${core.linkFor(ORIGIN,CARD)}`,ORIGIN).cards.length,1);
  assert.equal(core.parseMessage(Array.from({length:8},(_,i)=>core.linkFor(ORIGIN,{env:'e',kind:'card',id:'c'+i})).join('\n'),ORIGIN).cards.length,5);
  // The list preview.
  assert.equal(core.previewText({lastMessage:{body:core.cardMessage('',summary,core.linkFor(ORIGIN,CARD)),mine:true}},ORIGIN),'You: Card: Fix the sign-in loop');
  assert.equal(core.previewText({lastMessage:null},ORIGIN),'Start a conversation');
});

test('message bodies: 1 to 2000 characters, counted as OneProfileID counts them',()=>{
  assert.equal(core.validBody('hi'),true);assert.equal(core.validBody('   '),false);assert.equal(core.validBody(''),false);assert.equal(core.validBody(5),false);
  assert.equal(core.validBody('x'.repeat(2000)),true);assert.equal(core.validBody('x'.repeat(2001)),false);
  // Emoji are one character each, not two UTF-16 units.
  assert.equal(core.validBody('\u{1F600}'.repeat(2000)),true);
});

test('merging a poll and loading earlier pages',()=>{
  const m=(id,at,extra={})=>({id,createdAt:`2026-11-17T10:${String(at).padStart(2,'0')}:00Z`,body:id,mine:false,...extra});
  const cur=[m('a',1),m('b',2)];
  let r=core.mergeMessages(cur,{messages:[m('b',2,{read:true}),m('c',3)],more:false});
  assert.deepEqual(r.messages.map(x=>x.id),['a','b','c']);assert.equal(r.messages[1].read,true);assert.equal(r.reset,false);
  // A full page with no overlap: too much arrived, start over from it.
  r=core.mergeMessages(cur,{messages:[m('x',9),m('y',10)],more:true});
  assert.equal(r.reset,true);assert.deepEqual(r.messages.map(x=>x.id),['x','y']);
  assert.equal(core.mergeMessages([],{messages:[m('x',9)],more:true}).reset,false);
  // Same time: ordered by id.
  assert.deepEqual(core.mergeMessages([],{messages:[m('q',5),m('p',5)]}).messages.map(x=>x.id),['p','q']);
  assert.deepEqual(core.prependOlder(cur,[m('z',0),m('a',1)]).map(x=>x.id),['z','a','b']);
});

test('times: separators after an hour or a new day, groups within five minutes',()=>{
  const at=(iso,mine=false)=>({id:iso,createdAt:iso,mine});
  const t=core.timeline([at('2026-11-16T09:00:00Z'),at('2026-11-16T09:02:00Z'),at('2026-11-16T09:04:00Z'),at('2026-11-16T09:05:00Z',true),at('2026-11-16T10:30:00Z',true),at('2026-11-17T00:10:00Z',true),at('bad')],{timeZone:'UTC'});
  assert.deepEqual(t.map(e=>e.separator),[true,false,false,false,true,true,false]);
  assert.deepEqual(t.map(e=>e.group),['first','middle','last','single','single','single','single']);
  const now=new Date('2026-11-17T15:00:00Z'),o={now,locale:'en-US',timeZone:'UTC'};
  assert.equal(core.separatorLabel('2026-11-17T09:05:00Z',o),'9:05 AM');
  assert.equal(core.separatorLabel('2026-11-16T09:05:00Z',o),'Mon 9:05 AM');
  assert.equal(core.separatorLabel('2026-11-03T09:05:00Z',o),'Nov 3, 9:05 AM');
  assert.equal(core.separatorLabel('2025-11-03T09:05:00Z',o),'Nov 3, 2025, 9:05 AM');
  assert.equal(core.listTime('2026-11-17T09:05:00Z',o),'9:05 AM');
  assert.equal(core.listTime('2026-11-14T09:05:00Z',o),'Sat');
  assert.equal(core.listTime('2026-10-01T09:05:00Z',o),'Oct 1');
  assert.equal(core.listTime('2024-10-01T09:05:00Z',o),'Oct 1, 2024');
  assert.equal(core.separatorLabel('nope',o),'');assert.match(core.fullTime('2026-11-17T09:05:00Z',{locale:'en-US',timeZone:'UTC'}),/Tuesday, November 17, 2026/);
});

test('the friend picker: conversations first, then friends by name, each once, searchable',()=>{
  const conv=[{username:'zed-example',name:'Zed'},{username:'amy-example',name:'Amy'}],friends=[{username:'cy-example',name:'Cy'},{username:'amy-example',name:'Amy'},{username:'bo-example',name:'Bo'}];
  assert.deepEqual(core.pickerPeople(conv,friends).map(p=>[p.username,p.recent]),[['zed-example',true],['amy-example',true],['bo-example',false],['cy-example',false]]);
  assert.deepEqual(core.pickerPeople(conv,friends,'B').map(p=>p.username),['bo-example']);
  assert.deepEqual(core.pickerPeople(conv,friends,'cy-ex').map(p=>p.username),['cy-example']);
});

const db=()=>({environment:{id:'env-1'},projects:[{id:'p1',name:'Lantern',color:'#3b7dd8'}],
  charts:[{id:'c1',name:'Team',nodes:[{id:'n-1',name:'Ana Example',type:'person',image:'data:image/png;base64,AAAA'},{id:'n-2',name:'Bo',type:'person'},{id:'co',name:'Example LLC',type:'entity'},
    {id:'sh.s1.x',name:'Shared person',type:'person',linked:{share:'s1',id:'x',home:'env-2'}},{id:'sh.s1.stub',name:'Above',type:'entity',linked:{share:'s1',id:'stub',home:'env-2',stub:true}}],edges:[]}],
  devops:{columns:[{id:'doing',name:'In progress'}],labels:[{id:'l1',name:'Urgent',color:'red'},{id:'l2',name:'Odd',color:'not-a-colour'}],
    cards:[{id:'card-1',number:12,title:'Fix the sign-in loop',column:'doing',project:'p1',labels:['l1','l2','gone'],assignees:[{node:'n-1',role:'developer'},{node:'n-1',role:'tester'},{node:'n-2',role:'tester'},{node:'missing',role:'tester'}],due:'2026-12-01',points:3},
      {id:'sh.s1.card-9',number:4,title:'Shared card',column:'uat',labels:[],assignees:[],linked:{share:'s1',id:'card-9',home:'env-2'}}]},
  shares:[{id:'s1',ownerEnv:'env-2',members:[]}]});

test('summaries: what a card bubble shows, from data the viewer has',()=>{
  const s=core.summarize(db(),CARD);
  assert.equal(s.title,'Fix the sign-in loop');assert.equal(s.number,12);assert.deepEqual(s.column,{id:'doing',name:'In progress'});
  assert.deepEqual(s.labels,[{name:'Urgent',color:['#fdd5d2','#8e1f17']},{name:'Odd',color:['#e8e9eb','#3f4247']}]);
  assert.deepEqual(s.project,{name:'Lantern',color:'#3b7dd8'});
  assert.deepEqual(s.assignees.map(a=>[a.name,!!a.image]),[['Ana Example',true],['Bo',false]]);
  {const d=db();d.charts[0].nodes.push({id:'joe',type:'person',name:'Joe Basrawi',email:'joe@example.test'});
    d.shares[0].members=[{id:'@joe@example.test',email:'joe@example.test',name:'Joseph Basrawi',opidLinked:true}];
    d.devops.cards[0].assignees=[{node:'@joe@example.test',role:'developer'}];
    const card=core.summarize(d,{kind:'card',id:'card-1'});
    assert.deepEqual(card.assignees.map(a=>[a.id,a.name]),[['@joe@example.test','Joe Basrawi']]);
    const sharedOnly=db();sharedOnly.charts[0].nodes=[{id:'sh.s1.joe',type:'person',name:'Joseph Basrawi',email:'joe@example.test'}];
    sharedOnly.shares[0].members=[{id:'@joe@example.test',email:'joe@example.test',name:'Joseph Basrawi'}];
    sharedOnly.devops.cards[0].assignees=[{node:'@joe@example.test',role:'developer'}];
    assert.equal(core.summarize(sharedOnly,{kind:'card',id:'card-1'}).assignees[0].name,'Joseph Basrawi','a shared card with the same email is not the viewer\'s own');
  }
  assert.equal(s.due,'2026-12-01');assert.equal(s.points,3);assert.equal(s.actual,null);
  {const d=db();d.devops.cards[0].actual=5;assert.deepEqual([core.summarize(d,CARD).points,core.summarize(d,CARD).actual],[3,5])}
  // Default column names when the board has none of its own; a project colour that is not a colour is dropped.
  const d=db();d.devops.columns=[];d.projects[0].color='red;background:url(x)';
  assert.equal(core.summarize(d,CARD).column.name,'Doing');assert.equal(core.summarize(d,CARD).project.color,'');
  assert.deepEqual(core.summarize(db(),NODE),{kind:'node',type:'person',name:'Ana Example',image:'data:image/png;base64,AAAA'});
  assert.deepEqual(core.summarize(db(),{kind:'node',id:'co'}),{kind:'node',type:'entity',name:'Example LLC'});
  // A photo that is not an image URL never shows.
  const bad=db();bad.charts[0].nodes[0].image='javascript:alert(1)';assert.equal('image' in core.summarize(bad,NODE),false);
  assert.equal(core.summarize(db(),{kind:'card',id:'nope'}),null);
  // Read-only stubs above a share are not cards one can send or open.
  assert.equal(core.summarize(db(),{kind:'node',id:'sh.s1.stub'}),null);
});

test('where a link opens: the record here, or its linked copy from a share placed here',()=>{
  assert.equal(core.localTarget(db(),'env-1',CARD),'card-1');
  assert.equal(core.localTarget(db(),'env-other',CARD),null);
  assert.equal(core.localTarget(db(),'env-1',{env:'env-2',kind:'card',id:'card-9'}),'sh.s1.card-9');
  assert.equal(core.localTarget(db(),'env-1',{env:'env-2',kind:'node',id:'x'}),'sh.s1.x');
  assert.equal(core.localTarget(db(),'env-1',{env:'env-2',kind:'node',id:'stub'}),null);
  assert.equal(core.localTarget(db(),'env-1',{env:'env-3',kind:'card',id:'card-9'}),null);
  // Sending a linked copy links to its owner's record, so each reader resolves it with their own access.
  assert.deepEqual(core.refFor(db(),'env-1','card','sh.s1.card-9'),{env:'env-2',kind:'card',id:'card-9'});
  assert.deepEqual(core.refFor(db(),'env-1','card','card-1'),CARD);
  assert.equal(core.refFor(db(),'env-1','card','sh.unknown.c'),null);
});

test('OneProfileID answers are reduced to known fields',()=>{
  const t=cleanThread({person:{username:'amy-example',name:'Amy',photo:'javascript:x',email:'amy@example.test'},messages:[{id:'m1',body:'hi',createdAt:'2026-11-17T10:00:00Z',mine:true,read:'yes',extra:1,photoCount:2},{nope:true}],more:1});
  assert.deepEqual(t,{person:{username:'amy-example',name:'Amy',photo:null},messages:[{id:'m1',body:'hi',createdAt:'2026-11-17T10:00:00Z',mine:true,read:false,photoCount:2}],more:false});
  const c=cleanConversations({unread:-3,conversations:[{username:'Bad Name',name:'x'},{username:'bo-example',name:'',unread:2,lastMessage:{body:'yo',createdAt:'x',mine:1}}]});
  assert.deepEqual(c,{unread:0,conversations:[{username:'bo-example',name:'bo-example',photo:null,unread:2,lastMessage:{body:'yo',createdAt:'',mine:false}}]});
});

// ---------- routes, with a fake OneProfileID ----------
const ID1='0b9e7c4e-2f7a-4c1e-9a33-5b1d2c3e4f50',ID2='1c8d6b3a-1e69-4b0d-8a22-4a0c1b2d3e4f';
function harness({mode='opid',user={id:'u-ana',email:'ana@example.test',name:'Ana'},answer,officeDirect,chat={}}={}){
  const calls=[];
  const routes=chatRoutes({mode,officeDirect,...chat,userFor:async(req,{touch})=>{calls.push(['userFor',touch]);return typeof user==='function'?user(req):user},
    call:async(req,method,args)=>{calls.push([method,args,req.headers.cookie||'']);return answer?answer(method,args):{ok:true,status:200,payload:{},cookies:[]}},
    out:l=>l,trusted:req=>req.headers.origin!=='https://evil.example.test',
    readJson:(req,res,done)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{let v;try{v=JSON.parse(b)}catch{res.writeHead(400);res.end('{}');return}done(v)})},
    resolveCards:async(req,u,refs)=>{calls.push(['resolve',u.email,refs]);return refs.map(r=>r.id==='ok'?{access:true,card:{kind:'card',title:'T'},open:{env:r.env,id:r.id}}:{access:false})}});
  const server=http.createServer(async(req,res)=>{if(!await routes(req,res)){res.writeHead(418);res.end()}});
  return {calls,server,async go(method,path,body,headers={}){
    if(!server.listening)await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'content-type':'application/json',cookie:'oneprofileid.session_token=t-ana',...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
    let data=null;try{data=await r.json()}catch{}
    return {status:r.status,data,cookies:r.headers.getSetCookie()};
  },close:()=>server.close()};
}

test('routes: signed out is 401; other sites and API keys are refused; unknown routes 404',async()=>{
  const h=harness({user:null});
  try{
    assert.equal((await h.go('GET','/api/chat/status')).status,401);
    assert.equal((await h.go('POST','/api/chat/send',{username:'bo-example',body:'hi'})).status,401);
    assert.equal(h.calls.some(c=>c[0]==='sendMessage'),false);
    assert.equal((await h.go('GET','/api/chat/status',undefined,{origin:'https://evil.example.test'})).status,403);
    assert.equal((await h.go('GET','/api/chat/status',undefined,{authorization:'Bearer flow_x'})).status,403);
    assert.equal((await h.go('GET','/api/chat/nope')).status,404);
    assert.equal((await h.go('GET','/api/chat/send')).status,405);
    assert.equal((await h.go('GET','/api/other')).status,418);
  }finally{h.close()}
});

test('routes: local mode and "not enabled" read as unavailable, so the chat hides',async()=>{
  let h=harness({mode:'local',user:{id:'local',email:'owner@example.test',local:true}});
  try{
    assert.deepEqual((await h.go('GET','/api/chat/status')).data,{available:false,code:'chat_unavailable',error:'Chat is not available here.'});
    const r=await h.go('GET','/api/chat/conversations');assert.equal(r.status,403);assert.equal(r.data.available,false);
    assert.equal(h.calls.filter(c=>!['userFor'].includes(c[0])).length,0);
    // Card lookups still work in local mode (deep links use them).
    assert.equal((await h.go('POST','/api/chat/cards',{links:[{env:'e1',kind:'card',id:'ok'}]})).data.cards[0].access,true);
  }finally{h.close()}
  const off={ok:false,status:403,payload:{error:'Messages are not enabled for this application'},cookies:[]};
  h=harness({answer:()=>off});
  try{
    assert.equal((await h.go('GET','/api/chat/status')).data.available,false);
    for(const [m,p,b] of [['GET','/api/chat/conversations'],['GET','/api/chat/friends'],['POST','/api/chat/thread',{username:'bo-example'}],['POST','/api/chat/send',{username:'bo-example',body:'hi'}],['POST','/api/chat/read',{username:'bo-example'}]]){
      const r=await h.go(m,p,b);assert.equal(r.status,403,p);assert.equal(r.data.code,'chat_unavailable',p);
    }
  }finally{h.close()}
  // An outage keeps the chat, with the badge unknown.
  h=harness({answer:()=>({ok:false,status:503,payload:{error:'down'},cookies:[]})});
  try{const r=await h.go('GET','/api/chat/status');assert.equal(r.data.available,true);assert.equal(r.data.unread,null)}finally{h.close()}
});

test('routes: strict validation; no identity can be chosen by the page',async()=>{
  const h=harness();
  try{
    const bad=[
      ['/api/chat/thread',{username:'Bo Example'}],['/api/chat/thread',{username:'bo-example',before:'not-an-id'}],['/api/chat/thread',{username:'bo-example',userId:'u-bo'}],
      ['/api/chat/send',{username:'bo-example',body:''}],['/api/chat/send',{username:'bo-example',body:'   '}],['/api/chat/send',{username:'bo-example',body:'x'.repeat(2001)}],
      ['/api/chat/send',{username:'bo-example',body:'hi',from:'someone-else'}],['/api/chat/send',{username:'bo-example',body:7}],['/api/chat/send',['bo-example','hi']],
      ['/api/chat/read',{username:'bo-example',through:'x'}],['/api/chat/read',{username:'bo-example',as:'u-ana'}],
      ['/api/chat/cards',{links:[]}],['/api/chat/cards',{links:[{env:'e1',kind:'card',id:'c',owner:'x'}]}],['/api/chat/cards',{links:[{env:'e1',kind:'item',id:'c'}]}],
      ['/api/chat/cards',{links:Array.from({length:26},(_,i)=>({env:'e1',kind:'card',id:'c'+i}))}],
    ];
    for(const [p,b] of bad)assert.equal((await h.go('POST',p,b)).status,400,`${p} ${JSON.stringify(b).slice(0,80)}`);
    assert.equal((await h.go('POST','/api/chat/send','{not json')).status,400);
    assert.equal(h.calls.some(c=>['getThread','sendMessage','markRead','resolve'].includes(c[0])),false);
  }finally{h.close()}
});

test('routes: happy paths forward the browser cookie and return clean answers',async()=>{
  const answers={
    listConversations:{unread:3,conversations:[{username:'bo-example',name:'Bo',photo:null,unread:3,lastMessage:{body:'hey',createdAt:'2026-11-17T10:00:00Z',mine:false}}]},
    listFriends:{friends:[{username:'bo-example',name:'Bo',photo:'https://img.example.test/bo.png'}]},
    getThread:{person:{username:'bo-example',name:'Bo',photo:null},messages:[{id:ID1,body:'hey',createdAt:'2026-11-17T10:00:00Z',mine:false,read:false}],more:true},
    sendMessage:{message:{id:ID2,body:'hi there',createdAt:'2026-11-17T10:01:00Z',mine:true,read:false}},
    markRead:{ok:true},
  };
  const h=harness({answer:(m)=>({ok:true,status:m==='sendMessage'?201:200,payload:answers[m],cookies:['oneprofileid.session_token=t2; Path=/; HttpOnly']})});
  try{
    let r=await h.go('GET','/api/chat/status');assert.deepEqual(r.data,{available:true,unread:3});
    assert.deepEqual(r.cookies,['oneprofileid.session_token=t2; Path=/; HttpOnly']);
    r=await h.go('GET','/api/chat/conversations');assert.equal(r.data.conversations[0].username,'bo-example');assert.equal(r.data.unread,3);
    r=await h.go('GET','/api/chat/friends');assert.equal(r.data.friends[0].photo,'https://img.example.test/bo.png');
    r=await h.go('POST','/api/chat/thread',{username:'bo-example',before:ID1});assert.equal(r.data.more,true);assert.equal(r.data.messages[0].id,ID1);
    r=await h.go('POST','/api/chat/send',{username:'bo-example',body:'hi there'});assert.equal(r.status,201);assert.equal(r.data.message.id,ID2);
    r=await h.go('POST','/api/chat/read',{username:'bo-example',through:ID1});assert.deepEqual(r.data,{ok:true});
    r=await h.go('POST','/api/chat/cards',{links:[{env:'e1',kind:'card',id:'ok'},{env:'e1',kind:'node',id:'no'}]});
    assert.deepEqual(r.data.cards.map(c=>c.access),[true,false]);
    const sent=h.calls.filter(c=>c[0]!=='userFor'&&c[0]!=='resolve');
    assert.deepEqual(sent.map(c=>[c[0],c[1]]),[['listConversations',[]],['listConversations',[]],['listFriends',[]],['getThread',['bo-example',{before:ID1}]],['sendMessage',['bo-example','hi there']],['markRead',['bo-example',{through:ID1}]]]);
    // Only this browser's own cookie identifies the person.
    assert.ok(sent.every(c=>c[2]==='oneprofileid.session_token=t-ana'));
    // The card lookup runs as the signed-in viewer.
    assert.equal(h.calls.find(c=>c[0]==='resolve')[1],'ana@example.test');
    // Only sending counts as activity for the idle timeout.
    assert.deepEqual(h.calls.filter(c=>c[0]==='userFor').map(c=>c[1]),[false,false,false,false,true,false,false]);
  }finally{h.close()}
});

test('routes: not friends, rate limits and outages come back as clean errors',async()=>{
  const by={getThread:{ok:false,status:403,payload:{error:'You can only message friends who follow you back',code:'not_friends'}},
    sendMessage:{ok:false,status:429,payload:{error:'slow down',code:'rate_limited',retryAfter:42}},
    markRead:{ok:false,status:503,payload:{error:'OneProfileID is temporarily unavailable. Try again shortly.'}},
    listFriends:{ok:true,status:200,payload:null}};
  const h=harness({answer:m=>({cookies:[],...by[m]})});
  try{
    let r=await h.go('POST','/api/chat/thread',{username:'bo-example'});assert.equal(r.status,403);assert.equal(r.data.code,'not_friends');
    r=await h.go('POST','/api/chat/send',{username:'bo-example',body:'hi'});assert.equal(r.status,429);assert.equal(r.data.retryAfter,42);
    r=await h.go('POST','/api/chat/read',{username:'bo-example'});assert.equal(r.status,503);assert.match(r.data.error,/Can't reach/);
    r=await h.go('GET','/api/chat/friends');assert.equal(r.status,200);assert.deepEqual(r.data,{friends:[]});
  }finally{h.close()}
});

test('office Direct maps the recipient by stored OneProfileID account ID to a friend handle, then sends',async()=>{
  const office={env:'office-one',target:'mabcdefghijkl'},body='Message for a friend';
  const ANA='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',BO='bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',CY='cccccccc-3333-4333-8333-cccccccccccc';
  const stored={'bo@example.test':BO,'cy@example.test':CY};
  let clock=1_000_000,recipient={id:'session-id-ignored',email:'bo@example.test',name:'Bo'},sendAnswer={ok:true,status:201,cookies:['oneprofileid.session_token=fresh-send'],payload:{}};
  let friends={friends:[{username:'bo-example',name:'Bo',photo:null,userId:BO},{username:'dee-example',name:'Dee',photo:null}]};
  const h=harness({user:{id:ANA,email:'ana@example.test',name:'Ana'},
    answer:method=>method==='listFriends'?{ok:true,status:200,cookies:['oneprofileid.session_token=fresh-list'],payload:friends}:sendAnswer,
    officeDirect:async (user,dest,text,deliver)=>{assert.equal(user.id,ANA);assert.deepEqual(dest,office);return {ok:true,saved:await deliver(recipient,text)}},
    chat:{opidIdFor:async u=>stored[u.email]||'',now:()=>clock}});
  const sends=()=>h.calls.filter(c=>c[0]==='sendMessage'),lists=()=>h.calls.filter(c=>c[0]==='listFriends');
  try{
    // Bo is a friend and a Flow member: the message is sent by handle, with Ana's own cookie.
    const first=await h.go('POST','/api/chat/send',{office,body});
    assert.deepEqual(first.data,{ok:true,saved:true});
    assert.deepEqual(sends().at(-1),['sendMessage',['bo-example',body],'oneprofileid.session_token=t-ana']);
    assert.deepEqual(lists().at(-1),['listFriends',[],'oneprofileid.session_token=t-ana']);
    assert.deepEqual(first.cookies,['oneprofileid.session_token=fresh-list','oneprofileid.session_token=fresh-send']);
    // The friends list is cached: a second send asks OneProfileID only to send.
    clock+=30_000;
    assert.deepEqual((await h.go('POST','/api/chat/send',{office,body})).data,{ok:true,saved:true});
    assert.equal(lists().length,1);assert.equal(sends().length,2);
    // After the cache expires it asks again.
    clock+=31_000;
    await h.go('POST','/api/chat/send',{office,body});
    assert.equal(lists().length,2);
    // Cy is a Flow member but not a friend: no send at all, an unsaved office DM.
    recipient={email:'cy@example.test',name:'Cy'};
    assert.deepEqual((await h.go('POST','/api/chat/send',{office,body})).data,{ok:true,saved:false});
    assert.equal(sends().length,3);
    // A miss within FRIENDS_RETRY_MS uses the cache; after it, the list is fetched again (a new friendship).
    await h.go('POST','/api/chat/send',{office,body});assert.equal(lists().length,2);
    clock+=11_000;friends={friends:[...friends.friends,{username:'cy-example',name:'Cy',photo:null,userId:CY}]};
    assert.deepEqual((await h.go('POST','/api/chat/send',{office,body})).data,{ok:true,saved:true});
    assert.equal(lists().length,3);assert.deepEqual(sends().at(-1)[1],['cy-example',body]);
    // Unknown account ID (never signed in through OneProfileID): no lookup, no send.
    recipient={email:'new@example.test',name:'New'};
    const before=h.calls.length;
    assert.deepEqual((await h.go('POST','/api/chat/send',{office,body})).data,{ok:true,saved:false});
    assert.equal(h.calls.slice(before).some(c=>c[0]==='sendMessage'||c[0]==='listFriends'),false);
    // OneProfileID says not friends after all: unsaved, and the cached list is dropped.
    recipient={email:'bo@example.test',name:'Bo'};sendAnswer={ok:false,status:403,payload:{code:'not_friends'}};
    assert.deepEqual((await h.go('POST','/api/chat/send',{office,body})).data,{ok:true,saved:false});
    sendAnswer={ok:true,status:201,cookies:[],payload:{}};
    await h.go('POST','/api/chat/send',{office,body});assert.equal(lists().length,4);
    // An outage while sending is an error, not a silent fallback.
    sendAnswer={ok:false,status:503};
    assert.equal((await h.go('POST','/api/chat/send',{office,body})).status,503);
    assert.equal((await h.go('POST','/api/chat/send',{office,body,username:'somebody-else'})).status,400);
    // The browser never sees account IDs or emails from any of this.
    const leak=new RegExp([ANA,BO,CY,'@example\\.test'].join('|'),'i');
    for(const r of [first,await h.go('GET','/api/chat/friends')])assert.doesNotMatch(JSON.stringify(r.data),leak);
  }finally{h.close()}
});

test('office Direct falls back when OneProfileID friends cannot be read, and for the sender themself',async()=>{
  const office={env:'office-one',target:'mabcdefghijkl'},body='hi';
  const ANA='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  let list={ok:false,status:403,payload:{error:'Messages are not enabled for this application'}},recipient={email:'bo@example.test'};
  const h=harness({user:{id:ANA,email:'ana@example.test'},answer:m=>m==='listFriends'?list:{ok:true,status:201,payload:{}},
    officeDirect:async (u,d,text,deliver)=>({ok:true,saved:await deliver(recipient,text)}),
    chat:{opidIdFor:async u=>u.email==='ana@example.test'?ANA:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'}});
  try{
    assert.deepEqual((await h.go('POST','/api/chat/send',{office,body})).data,{ok:true,saved:false});
    recipient={email:'ana@example.test'};
    assert.deepEqual((await h.go('POST','/api/chat/send',{office,body})).data,{ok:true,saved:false});
    assert.equal(h.calls.some(c=>c[0]==='sendMessage'),false);
  }finally{h.close()}
  // Local mode never asks OneProfileID.
  const local=harness({mode:'local',user:{id:'local',email:'owner@example.test',local:true},officeDirect:async (u,d,text,deliver)=>({ok:true,saved:await deliver({email:'bo@example.test'},text)})});
  try{
    assert.deepEqual((await local.go('POST','/api/chat/send',{office,body})).data,{ok:true,saved:false});
    assert.equal(local.calls.some(c=>c[0]==='listFriends'||c[0]==='sendMessage'),false);
  }finally{local.close()}
});

test('friendHandles keeps only account ID + handle pairs that look right',()=>{
  const m=friendHandles({friends:[{username:'bo-example',userId:'BBBBBBBB-2222-4222-8222-BBBBBBBBBBBB'},{username:'Bad Name',userId:'cccccccc-3333-4333-8333-cccccccccccc'},{username:'dee-example',userId:'dee@example.test'},{username:'eve-example'},null]});
  assert.deepEqual([...m],[['bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb','bo-example']]);
  assert.equal(friendHandles(null).size,0);
});
