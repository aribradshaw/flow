// The Chief of Staff in the 3D office: the follow behaviour (public/office-brain.js, office-npc.js behind), who walks
// with whom, its "needs you" lines (debounced, held in Do not disturb), the Waiting on you list, card links, and
// the /cos chat channel wired to the conductor through the owner-only steer path (public/office-chief.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBrain} from '../public/office-brain.js';
import {behind,FOLLOW_BACK,FOLLOW_SIDE} from '../public/office-npc.js';
import {chiefAgent,chiefFigures,chiefChannel,chiefModelItems,conductorOf,createMentions,esc,replyHtml,replySig,waitingOnYou,CHIEF_COLOR} from '../public/office-chief-core.js';
import {mascotGeometry,mascotKind} from '../public/office-mascots.js';
import {chatPrefix,chatChannel} from '../public/office-chat.js';
import {createChief} from '../public/office-chief.js';

const base={status:'idle',kind:'',card:null,ownerHere:false,gone:false,arrived:true,partner:'',wander:true,board:true,still:false};
const step=(b,t,over={})=>b.update(t,{...base,...over});

test('follow: an idle or working Chief walks after its person, jogs when they are far, and goes home when they leave',()=>{
  const b=createBrain('af:chief',{now:0});
  let it=step(b,0);assert.equal(it.state,'idle');
  it=step(b,0.1,{follow:true});
  assert.deepEqual([it.state,it.goal,it.pace,it.pose],['follow','follow','walk','stand']);
  const rev=it.rev;
  it=step(b,0.2,{follow:true,far:true});assert.equal(it.pace,'jog','far ahead: it jogs');assert.equal(it.rev,rev,'the same goal: no new path');
  it=step(b,0.3,{follow:true});assert.equal(it.pace,'walk');
  // They left the office: follow is false and it goes back to its desk.
  it=step(b,0.4,{follow:false});assert.equal(it.state,'idle');assert.equal(it.goal,'home');
  // A working one follows too, and sits down at its desk again afterwards.
  const w=createBrain('af:chief2',{now:0});
  assert.equal(step(w,0,{status:'running'}).state,'work');
  assert.equal(step(w,1,{status:'running',follow:true}).state,'follow');
  const back=step(w,2,{status:'running',follow:false});assert.deepEqual([back.state,back.goal,back.pose],['work','home','sit']);
});

test('follow: a Chief keeps following while waiting on its person; leaving still wins',()=>{
  const b=createBrain('cos',{now:0});
  step(b,0,{follow:true});
  let it=step(b,1,{follow:true,status:'waiting',ownerHere:true});assert.deepEqual([it.state,it.goal],['follow','follow']);
  it=step(b,2,{follow:true,status:'idle'});assert.equal(it.state,'follow','answered: back to following');
  const still=createBrain('still',{now:0});
  assert.notEqual(step(still,0,{follow:true,still:true}).state,'follow');
  it=step(b,3,{follow:true,gone:true});assert.equal(it.state,'leave','a conductor that stopped reporting walks out');
});

test('Cursor Auto gets a rover and a named model keeps its own mascot',()=>{
  assert.equal(mascotKind('cursor','Cursor Auto'),'cursor');
  assert.equal(mascotKind('cursor','Sonnet 5.5'),'claude');
  assert.notEqual(mascotGeometry('cursor'),mascotGeometry('orb'));
  assert.notEqual(mascotGeometry('chief'),mascotGeometry('cursor'));
});

test('the Chief model picker uses the project provider accounts and keeps older bridges compatible',()=>{
  const providers=[{id:'cursor_personal',label:'Cursor Personal',models:[{id:'cursor_personal:default',label:'Auto'}]}];
  const runners=[{models:[
    {id:'cursor_personal:grok',label:'Cursor Personal · Grok',billing:'included'},
    {id:'cursor_work:grok',label:'Grok'},
  ]}];
  assert.deepEqual(chiefModelItems(providers,runners),[
    {value:'cursor_personal:default',label:'Auto',group:'Cursor Personal',sub:''},
    {value:'cursor_personal:grok',label:'Grok',group:'Cursor Personal',sub:'Included'},
  ]);
  assert.deepEqual(chiefModelItems([],runners),[]);
  assert.equal(chiefModelItems(undefined,runners).length,2);
});

test('a Chief model switch reconciles its T3 result after a UI timeout and before the request returns',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const entry={id:'chief',role:'conductor',source:'desk',status:'idle',can:['message','model'],modelId:'codex:one'};
  const live=new Map([['me',[entry]]]);
  let click,select,resolvePost;
  const toast=[];
  const chief=createChief({root:{querySelector:()=>null,addEventListener:(_,fn)=>{click=fn},removeEventListener(){}},
    meKey:()=>'me',live:()=>live,models:()=>[{models:[{id:'codex:one',label:'One'},{id:'codex:two',label:'Two'}]}],
    cards:()=>[],refs:()=>[],myName:()=>'',openPicker:(_,options)=>{select=options.onChange},
    post:()=>new Promise(resolve=>{resolvePost=resolve}),toast:(...args)=>toast.push(args)});
  try{
    click({target:{closest:s=>s==='[data-picker="cos-model"]'?{}:null},preventDefault(){},stopPropagation(){}});
    const choosing=select(['codex:two']);
    assert.match(chief.panelHtml(),/Waiting for T3 Code to confirm/);
    assert.match(chief.panelHtml(),/codex · One/);
    await assert.rejects(chief.send('hello'),/finish switching models/);
    t.mock.timers.tick(45000);
    assert.match(chief.panelHtml(),/hasn’t confirmed the switch/);
    const event={kind:'model',agentId:'chief',source:'desk',text:'codex:two',id:'action',result:{ok:true}};
    assert.equal(chief.modelResult({...event,id:'previous',result:{ok:false}}),true);
    assert.equal(chief.modelResult(event),true);
    resolvePost({id:'action'});
    await choosing;
    assert.match(chief.panelHtml(),/codex · Two/);
    assert.equal(toast[0][1],true);
    assert.deepEqual(toast[1],['Model updated for the next message.',false]);
  }finally{chief.dispose()}
});

test('follow: a card picked up while following is not fetched afterwards (old news)',()=>{
  const b=createBrain('card',{now:0});
  step(b,0,{card:{number:1,column:'doing'}});
  step(b,1,{follow:true,card:{number:1,column:'doing'}});
  step(b,2,{follow:true,card:{number:2,column:'doing'}});
  const it=step(b,3,{follow:false,card:{number:2,column:'doing'}});
  assert.notEqual(it.state,'fetch');
});

test('behind: 1.5-2 m behind the person, a little to their right, whichever way they face',()=>{
  for(const h of [0,Math.PI/2,Math.PI,-2.3]){
    const p=behind(10,-4,h),d=Math.hypot(p.x-10,p.z+4);
    assert.ok(d>=1.5&&d<=2,`distance ${d}`);
    // Behind: against their heading.
    const along=(p.x-10)*Math.sin(h)+(p.z+4)*Math.cos(h);assert.ok(Math.abs(along+FOLLOW_BACK)<1e-9);
    const side=(p.x-10)*Math.cos(h)-(p.z+4)*Math.sin(h);assert.ok(Math.abs(Math.abs(side)-FOLLOW_SIDE)<1e-9);
  }
});

test('who walks with whom: the Chief of Staff robot with the owner, everyone else with their own conductor\'s mascot',()=>{
  const af=[{id:'r1',kind:'agent',name:'Researcher'},{id:'cos',kind:'agent',name:' chief of staff '}];
  assert.equal(chiefAgent(af).id,'cos');assert.equal(chiefAgent([{id:'x',kind:'human',name:'Chief of Staff'}]),null);
  const conductor=(source,id)=>({id,source,role:'conductor',status:'idle'});
  const live=new Map([['ann',[{id:'a1',source:'s'},conductor('desk','t1')]],['sam',[conductor('bridge:sam','t2')]],['kim',[{id:'k1',source:'s'}]]]);
  const members=[{key:'sam'},{key:'ann',owner:true},{key:'kim'}];
  const deskKey=(m,a)=>JSON.stringify([m,a.source,a.id]);
  assert.deepEqual([...chiefFigures({members,live,af,deskKey})],[['sam',deskKey('sam',conductor('bridge:sam','t2'))],['ann','af:cos']]);
  // No Chief of Staff agent: every conductor is its owner's mascot. The owner has none: the first member who has one gets the robot.
  assert.deepEqual([...chiefFigures({members,live,af:[],deskKey}).values()],[deskKey('sam',conductor('bridge:sam','t2')),deskKey('ann',conductor('desk','t1'))]);
  live.delete('ann');
  assert.deepEqual([...chiefFigures({members,live,af,deskKey})],[['sam','af:cos']]);
  assert.equal(conductorOf([{id:'x'}]),null);
});

test('"needs you": once per new wait, at most one line per gap, several at once together, nothing in Do not disturb until it ends',()=>{
  let t=0;const m=createMentions({now:()=>t,gapMs:20000});
  const wait=(id,req='r',seat)=>({id,source:'s',title:'Thread '+id,status:'waiting',pending:{requestId:req},...(seat?{seat:{agent:seat}}:{})});
  const nameOf=id=>({b1:'Web Builder'})[id]||'';
  assert.equal(m.observe([wait('a')],{nameOf}),'','the first look is how things are');
  assert.equal(m.observe([wait('a'),wait('b',undefined,'b1')],{nameOf}),'Web Builder needs you');
  assert.equal(m.observe([wait('a'),wait('b',undefined,'b1')],{nameOf}),'','said once');
  t+=5000;
  assert.equal(m.observe([wait('a'),wait('b',undefined,'b1'),wait('c')],{nameOf}),'','within the gap: held');
  t+=16000;
  assert.equal(m.observe([wait('a'),wait('b',undefined,'b1'),wait('c'),wait('d')],{nameOf}),'Thread c and Thread d need you','after the gap: both, in one line');
});

test('"needs you": the gap, merging, Do not disturb and answered-meanwhile, step by step',()=>{
  let t=0;const m=createMentions({now:()=>t,gapMs:20000});
  const w=id=>({id,source:'s',title:id,status:'waiting',pending:{requestId:'r'}});
  m.observe([]);
  assert.equal(m.observe([w('A')]),'A needs you');
  t+=1000;assert.equal(m.observe([w('A'),w('B')]),'','in the gap');
  t+=1000;assert.equal(m.observe([w('A'),w('B'),w('C')]),'');
  t+=20000;assert.equal(m.observe([w('A'),w('B'),w('C')]),'B and C need you','what queued in the gap comes together');
  // Do not disturb: nothing, then what still waits once it ends; what was answered meanwhile is dropped.
  t+=30000;assert.equal(m.observe([w('A'),w('B'),w('C'),w('D'),w('E')],{quiet:true}),'');
  t+=1000;assert.equal(m.observe([w('A'),w('B'),w('C'),w('E')],{quiet:true}),'');
  t+=1000;assert.equal(m.observe([w('A'),w('B'),w('C'),w('E')]),'E needs you');
  // A new prompt on the same agent is a new wait; the conductor itself is never mentioned.
  t+=30000;assert.equal(m.observe([{...w('A'),pending:{requestId:'r2'}},{...w('Z'),role:'conductor'}]),'A needs you');
  t+=30000;assert.equal(m.observe([w('1'),w('2'),w('3'),w('4')]),'1 and 3 others need you');
});

test('waiting on you: your waiting agents, then UAT cards assigned to you or that ask for you by name',()=>{
  const cards=[
    {id:'c1',number:1,title:'Logo',column:'uat',description:'Needs Avery: pick one of the two'},
    {id:'c2',number:2,title:'Mine',column:'uat',assignees:[{node:'p-me',role:'reviewer'}]},
    {id:'c3',number:3,title:'Someone else',column:'uat',description:'Needs Sam: sign'},
    {id:'c4',number:4,title:'Not UAT',column:'doing',description:'Needs Avery'},
    {id:'c5',number:5,title:'You',column:'uat',description:'needs you: approve'},
  ];
  const out=waitingOnYou({agents:[{id:'a',source:'s',title:'Fix login',status:'waiting',pending:{summary:'Run: npm test'}},{id:'b',status:'running'},{id:'cos',status:'waiting',role:'conductor'}],
    cards,refs:['p-me'],name:'Avery Stone'});
  assert.deepEqual(out.map(x=>x.kind==='agent'?x.id:'#'+x.number),['a','#1','#2','#5']);
  assert.equal(out[0].detail,'Run: npm test');
});

test('replies: card numbers become links for cards this viewer can open, the rest stays text (escaped)',()=>{
  const html=replyHtml('Routed #461 and #9 <b>now</b> · a&#12 stays',n=>n===461?'card-461':null,esc);
  assert.match(html,/<button type="button" class="of-cos-card" data-cos-card="card-461">#461<\/button>/);
  assert.match(html,/ #9 /);assert.match(html,/&lt;b&gt;now&lt;\/b&gt;/);assert.ok(!html.includes('data-cos-card="null"'));
  assert.notEqual(replySig({text:'a',at:'1'}),replySig({text:'a',at:'2'}));assert.equal(replySig(null),'');
});

test('/cos: a gold Chief channel; its send goes to your conductor through the steer path, owner-only, and shows "on it" at once',async()=>{
  const ch=chiefChannel(()=>{});
  assert.deepEqual([ch.id,ch.label,ch.prefix,ch.color],['cos','Chief','/cos',CHIEF_COLOR]);
  const posts=[],labels=[],live=new Map([['me',[{id:'t-cos',source:'desk',role:'conductor',status:'idle',can:['message'],mine:true,reply:{text:'Hi',at:'2026-11-22T10:00:00Z',cards:[]}}]]]);
  const fig={isObject3D:true};
  const chief=createChief({meKey:()=>'me',members:()=>[{key:'me',owner:true,me:true}],live:()=>live,af:()=>[{id:'cos',kind:'agent',name:'Chief of Staff'}],
    deskKey:(m,a)=>JSON.stringify([m,a.source,a.id]),npc:{setFollow:(k,m)=>posts.push(['follow',k,m]),figure:k=>k==='af:cos'?fig:null},
    label:(obj,html)=>{const l={obj,html};labels.push(l);return l},unlabel:()=>{},interact:{register(){},unregister(){}},openPanel:()=>({}),
    post:async body=>{posts.push(['steer',body]);return {id:'act_1'}},toast:()=>{},isQuiet:()=>false,cardId:()=>null,openCard(){},cards:()=>[],refs:()=>[],myName:()=>'Me',afName:()=>'',lines:()=>null,showAgent(){}});
  try{
    assert.ok(chatChannel('cos'),'registered with officeChat');
    assert.deepEqual(chatPrefix('/cos what is in UAT?'),{channel:'cos',text:'what is in UAT?'});
    chief.update();
    assert.deepEqual(posts.shift(),['follow','af:cos','me'],'the Chief of Staff robot follows its owner');
    chief.agents('me',live.get('me'));
    const started=Date.now();
    await chatChannel('cos').send('What is in UAT?',{});
    assert.deepEqual(posts.shift(),['steer',{kind:'message',source:'desk',agentId:'t-cos',text:'What is in UAT?'}]);
    assert.ok(Date.now()-started<1000);
    assert.equal(chief.debug().bubble.kind,'pending');assert.match(labels.at(-1).html,/Chief is on it…/);
    // The reply arrives with the next report: a bubble with the answer.
    live.set('me',[{...live.get('me')[0],reply:{text:'Two in UAT: #12, #40',at:'2026-11-22T10:01:00Z',cards:[12,40]}}]);
    chief.agents('me',live.get('me'));
    assert.equal(chief.debug().pending,false);assert.match(chief.debug().bubble.html,/Two in UAT/);
    // Someone else's agents never move your Chief's bubble; no conductor, no sending.
    live.set('me',[]);
    await assert.rejects(chatChannel('cos').send('hello',{}),/No Chief of Staff is reporting/);
  }finally{chief.dispose()}
  assert.equal(chatChannel('cos'),undefined,'unregistered when the office closes');
});
