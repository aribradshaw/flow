import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chatDraft,chatTargets,officeChat,sendOfficeChat,directHint,DIRECT_HINT} from '../public/office-chat.js';
import {officeHub,officeState} from '../lib/office.mjs';

const people=[{key:'self',name:'Me'},{key:'p1',name:'Sam'},{key:'p2',name:'Sam Lee'}];
const live=[
  {id:'a1',source:'source-one',title:'Sam',mine:true,can:['message'],seat:{agent:'desk'}},
  {id:'a2',source:'source-two',title:'Other Sam',mine:false,can:['message'],seat:{agent:'other'}},
  {id:'a3',source:'source-one',title:'Stop only',mine:true,can:['stop']},
];
const targets=chatTargets({people,live,meKey:'self',agentflow:[{id:'desk',name:'Builder'},{id:'other',name:'Unavailable'}]});
const draft=(raw,channel='nearby')=>chatDraft(raw,{channel},targets);

test('channels parse across ordinary text, commands, ambiguous mentions and seated agents',()=>{
  assert.deepEqual(draft(' hello'),{channel:'nearby',text:'hello',target:undefined,both:false});
  assert.equal(draft('/o hello').channel,'office');
  assert.deepEqual(draft('@Sa').choices.map(t=>t.name),['Sam','Sam Lee','Sam']);
  assert.deepEqual(draft('@Sam go').choices.map(t=>t.channel),['direct','agent']);
  assert.equal(draft('@Sam Lee go').target.id,'p2');
  assert.equal(draft('@Sam go','direct').target.id,'p1');
  assert.equal(draft('@Sam go','agent').target.agentId,'a1');
  assert.equal(draft('@Builder repair it').target.agentId,'a1');
  assert.deepEqual(draft('@Other Sam repair it').choices,[]);
  assert.deepEqual(draft('@Unavailable repair it').choices,[]);
  assert.deepEqual(draft('@Stop only repair it').choices,[]);
  assert.deepEqual(draft('/o @Sam Lee go').choices,[],'Office does not fan out to a person');
  const extension={id:'example',label:'Example',color:'gold',prefix:'/example',async send(){}};
  const unregister=officeChat.registerChannel(extension);
  try{
    assert.equal(draft('/example @Sam hello').text,'@Sam hello');
    assert.equal(draft('/example @Sam hello').channel,'example');
    assert.throws(()=>officeChat.registerChannel({...extension,id:'copy'}),TypeError);
    assert.throws(()=>officeChat.registerChannel({...extension,id:'direct',prefix:'/direct'}),TypeError);
  }finally{unregister()}
  assert.equal(draft('/example hello').channel,'nearby');
});

test('Office plus mention fans out to the selected agent and the office with independent results',async()=>{
  const selected=draft('/o @Builder ship it'),calls=[];
  assert.equal(selected.both,true);
  await sendOfficeChat(selected,async (...args)=>{calls.push(args)},()=>assert.fail('unexpected direct send'));
  assert.deepEqual(calls,[
    ['say',{channel:'office',text:'ship it'}],
    ['steer',{kind:'message',source:'source-one',agentId:'a1',text:'ship it',officeChat:true}],
  ]);
  const result=await sendOfficeChat(selected,async name=>{if(name==='steer')throw Error('Agent is offline')});
  assert.match(result.warning,/Posted to Office.*Agent is offline/);
});

async function office(t){
  const users=Object.fromEntries(['owner','viewer','visitor','elsewhere'].map(name=>[name,{email:name+'@example.test',name}]));
  const access={ok:true,all:true,projectIds:new Set()};
  const ctx=id=>({id,name:id,ownerEmail:users.owner.email,members:Object.values(users),projects:[],agents:[],cards:[]});
  const state=officeState(),markers=[];
  const hub=officeHub({state,context:{env:async id=>ctx(id),access:async()=>access},now:()=>0,
    history:()=>({marker:(...args)=>markers.push(args),leave(){},sample(){}})});
  t.after(()=>hub.close());
  async function connect(env,user){
    const req=new EventEmitter(),res=new EventEmitter(),events=[];
    res.writeHead=()=>{};res.end=()=>res.emit('close');
    res.write=chunk=>{
      const type=/^event: (.*)$/m.exec(chunk)?.[1],data=/^data: (.*)$/m.exec(chunk)?.[1];
      if(type)events.push({type,data:JSON.parse(data)});
    };
    await hub.connect(env,user,access,req,res);
    return {events,key:hub.memberKey(user.email),messages:()=>events.filter(e=>e.type==='say').map(e=>e.data)};
  }
  return {hub,state,users,markers,connect};
}

test('Nearby text stays within 6 m and out of snapshots, Office reaches every stream',async t=>{
  const {hub,users,markers,connect}=await office(t);
  const a=await connect('here',users.owner),b=await connect('here',users.viewer),c=await connect('here',users.visitor);
  const dashboard=await connect('here',{...users.viewer,key:true});
  hub.move('here',users.owner,{x:0,y:0,z:0});
  hub.move('here',users.viewer,{x:6,y:0,z:0});
  hub.move('here',users.visitor,{x:6,y:0.5,z:0});
  hub.say('here',users.owner,'Nearby content',{channel:'nearby'});
  assert.equal(a.messages()[0].text,'Nearby content');
  assert.equal(b.messages()[0].text,'Nearby content');
  assert.deepEqual(c.messages(),[]);
  assert.deepEqual(dashboard.messages(),[]);
  const late=await connect('here',users.visitor);
  assert.deepEqual(late.events.find(e=>e.type==='snapshot').data.chat,[]);
  hub.say('here',users.owner,'Office content',{channel:'office'});
  for(const peer of [a,b,c,late,dashboard])assert.equal(peer.messages().at(-1).text,'Office content');
  assert.deepEqual(markers,[['here','message',a.key,'nearby'],['here','message',a.key,'office']]);
});

test('Direct text reaches session-authenticated sender and recipient only and is rate-limited per channel',async t=>{
  const {hub,users,markers,connect}=await office(t);
  const a=await connect('here',users.owner),b=await connect('here',users.viewer),c=await connect('here',users.visitor);
  const dashboard=await connect('here',{...users.viewer,key:true});
  const elsewhere=await connect('elsewhere',users.elsewhere);
  hub.move('here',users.viewer,{x:10,z:10});
  hub.move('elsewhere',users.elsewhere,{x:0,z:0});
  const local=async()=>false;
  await assert.rejects(hub.direct('here',users.owner,elsewhere.key,'Wrong room',local),{status:404});
  for(let i=0;i<5;i++)assert.deepEqual(await hub.direct('here',users.owner,b.key,'Private content',local),{ok:true,saved:false});
  await assert.rejects(hub.direct('here',users.owner,b.key,'Too many',local),{status:429});
  assert.equal(a.messages().length,5);
  assert.equal(b.messages().length,5);
  for(const peer of [c,dashboard,elsewhere])assert.equal(JSON.stringify(peer.events).includes('Private content'),false);
  assert.deepEqual(c.events.filter(e=>e.type==='chatHint')[0].data,{key:a.key,channel:'direct'});
  const late=await connect('here',users.viewer);
  assert.deepEqual(late.events.find(e=>e.type==='snapshot').data.chat,[]);
  assert.deepEqual(markers,Array.from({length:5},()=>['here','message',a.key,'direct']));
  assert.deepEqual(hub.say('here',users.owner,'Public content',{channel:'office'}),{ok:true});
});

test('Agent chat uses owner-only steer, respects can, and only shows a content-free hint to others',async t=>{
  const {hub,state,users,connect,markers}=await office(t);
  const a=await connect('here',users.owner),b=await connect('here',users.viewer);
  const keyed=await connect('here',{...users.owner,key:true});
  state.report(users.owner.email,{source:'bridge',agents:[
    {id:'builder',title:'Builder',can:['message']},{id:'observer',can:[]},
  ]});
  const action={source:'bridge',agentId:'builder',kind:'message',officeChat:true,text:'Private agent content'};
  assert.throws(()=>hub.answer('here',users.viewer,{...action,owner:users.owner.email}),{status:404});
  assert.throws(()=>hub.answer('here',users.owner,{...action,agentId:'observer'}),{status:409});
  hub.answer('here',users.owner,action);
  const [queued]=await state.wait(users.owner.email,'bridge',0);
  assert.equal(queued.text,action.text);
  assert.equal(a.messages()[0].text,action.text);
  assert.equal(a.messages()[0].to,'Builder');
  for(const peer of [b,keyed]){
    assert.equal(JSON.stringify(peer.events).includes(action.text),false);
    assert.deepEqual(peer.events.filter(e=>e.type==='chatHint').at(-1).data,{key:a.key,channel:'agent'});
  }
  assert.deepEqual(markers,[['here','message',a.key,'agent']]);
});

test('Direct hint: saved for OneProfileID friends, a plain warning when the last send was not saved',()=>{
  assert.equal(directHint(undefined),DIRECT_HINT);
  assert.match(DIRECT_HINT,/OneProfileID friends/);
  assert.equal(directHint(false),'Not OPID friends: messages here aren’t saved.');
  assert.match(directHint(true),/Saved in Flow chat/);
});
