// The Flow app's server side (lib/app-device.mjs): who "me" is, the inbox's cards, which saves push to whom,
// the device store, and the pushes (against a fake sender).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {myAssigneeIds,inboxCards,cardEvents,pushDeviceStore,pushHub,DEVICE_SCOPE} from '../lib/app-device.mjs';
import {normScopes} from '../lib/apikeys.mjs';

const TOKEN='a'.repeat(64),TOKEN2='b'.repeat(64);
const chart=nodes=>({charts:[{id:'c1',name:'Map',nodes,edges:[]}]});
const person=(id,extra={})=>({id,type:'person',name:id,x:0,y:0,...extra});
const card=(id,column,assignees,extra={})=>({id,number:Number(id.replace(/\D/g,''))||1,title:'Card '+id,column,assignees,...extra});

test('the device scope stands alone: nothing implies it and it implies nothing',()=>{
  assert.deepEqual(normScopes(['admin']),['read','write','admin']);
  assert.deepEqual(normScopes(['write',DEVICE_SCOPE]),['read','write','device']);
  assert.deepEqual(normScopes([DEVICE_SCOPE]),['device']);
});

test('me: my person cards by email or OneProfileID, share members with my email, and @email',()=>{
  const db={...chart([person('ann',{email:'Ann@Example.test'}),person('bo',{email:'bo@example.test'}),person('me2',{opidUser:'opid-ann'})]),
    shares:[{id:'s1',members:[{id:'sh.s1.joe',email:'ann@example.test'},{id:'@bo@example.test',email:'bo@example.test'}]}]};
  assert.deepEqual([...myAssigneeIds(db,{email:'ann@example.test',opidId:'opid-ann'})].sort(),['@ann@example.test','ann','me2','sh.s1.joe'].sort());
  assert.deepEqual([...myAssigneeIds(db,{email:'cy@example.test'})],['@cy@example.test']);
});

test('inbox cards: only mine, never done, UAT first, with the project and my roles',()=>{
  const db={...chart([person('ann',{email:'ann@example.test'}),person('bo',{email:'bo@example.test'})]),projects:[{id:'p1',name:'Lantern',color:'#123456'}],
    devops:{cards:[card('k1','doing',[{node:'ann',role:'developer'}],{project:'p1'}),card('k2','uat',[{node:'ann',role:'tester'},{node:'ann',role:'tester'}]),
      card('k3','done',[{node:'ann'}]),card('k4','doing',[{node:'bo'}]),card('k5','requests',[{node:'@ann@example.test',role:'requester'}])]}};
  const out=inboxCards([{id:'e1',name:'Work',data:db}],{email:'ann@example.test'});
  assert.deepEqual(out.map(c=>c.id),['k2','k1','k5']);
  assert.deepEqual(out[0].roles,['tester']);
  assert.deepEqual(out[1].project,{id:'p1',name:'Lantern',color:'#123456'});
  assert.equal(out[1].envName,'Work');
});

test('card events: newly assigned, and moves of cards already mine; never for whoever saved',()=>{
  const nodes=[person('ann',{email:'ann@example.test'}),person('bo',{email:'bo@example.test'}),person('cy',{opidUser:'opid-cy'}),person('dee')];
  const before={...chart(nodes),devops:{cards:[card('k1','requests',[{node:'ann'}]),card('k2','doing',[{node:'bo'}]),card('sh.s1.x9','doing',[{node:'ann'}])]}};
  const after={...chart(nodes),devops:{cards:[
    card('k1','uat',[{node:'ann'},{node:'cy',role:'tester'},{node:'dee'}]),   // ann: moved; cy: assigned; dee: no email, nothing
    card('k2','doing',[{node:'bo'},{node:'ann'}]),                            // ann: assigned
    card('k3','requests',[{node:'@bo@example.test'}]),                         // new card, bo by member id
    card('sh.s1.x9','done',[{node:'ann'}])]}};                                 // a linked copy: its owner's save says so
  const ev=cardEvents(before,after,{by:'bo@example.test'});
  assert.deepEqual(ev.map(e=>[e.card.id,e.kind,e.to.email||e.to.opidUser]),[['k1','moved','ann@example.test'],['k1','assigned','opid-cy'],['k2','assigned','ann@example.test']]);
  assert.equal(ev[0].from,'requests');
  assert.equal(ev[0].card.column,'uat');
  assert.deepEqual(cardEvents(null,after,{}),[],'a first save pushes nothing');
});

test('device store (files): upsert, per owner, replace, remove only your own',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ff-push-devices-'));
  try{
    const st=pushDeviceStore({dir});
    await st.upsert({token:TOKEN,owner:'Ann@example.test',keyId:'key_1',environment:'sandbox',bundle:'com.example.flow',prefs:{cards:false}});
    await st.upsert({token:TOKEN,owner:'ann@example.test',keyId:'key_2',environment:'production',bundle:'com.example.flow'});
    await st.upsert({token:TOKEN2,owner:'bo@example.test',keyId:'key_3',environment:'nonsense',bundle:'com.example.flow'});
    const ann=await st.forOwner('ANN@example.test');
    assert.equal(ann.length,1);assert.equal(ann[0].keyId,'key_2');assert.equal(ann[0].environment,'production');assert.deepEqual(ann[0].prefs,{agents:true,cards:true});
    assert.equal((await st.forOwner('bo@example.test'))[0].environment,'production','anything else is production');
    assert.equal(await st.remove(TOKEN2,'ann@example.test'),false,'not Ann\'s device');
    assert.equal(await st.remove(TOKEN2,'bo@example.test'),true);
    assert.deepEqual(await st.forOwner('bo@example.test'),[]);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

function fixture({keys={},quiet=false,previews=true}={}){
  const devices=new Map(),sent=[];
  const store={forOwner:async e=>[...devices.values()].filter(d=>d.owner===e),remove:async t=>devices.delete(t)};
  const sender={topic:'com.example.flow',send:async(d,payload,opts)=>{sent.push({token:d.token,payload,opts});return d.token===TOKEN2?{ok:false,gone:true}:{ok:true}}};
  const apiKeys={get:async id=>keys[id]||null};
  const hub=pushHub({store,sender,apiKeys,isQuiet:()=>quiet,previews,emailOf:async o=>o==='opid-cy'?'cy@example.test':null});
  const add=(token,owner,keyId,extra={})=>devices.set(token,{token,owner,keyId,environment:'production',bundle:'com.example.flow',prefs:{agents:true,cards:true},...extra});
  return {hub,add,devices,sent};
}
const device={scopes:['read','write','device'],owner:'ann@example.test'};
const waiting={id:'t3:1',source:'bridge:mac',title:'Fix login',pending:{requestId:'r1',kind:'approval',summary:'Run: npm test',can:['allow','deny']}};

test('pushes: an agent waiting, with Allow / Deny, to live device keys only',async()=>{
  const f=fixture({keys:{k_ok:device,k_gone:{...device,revokedAt:'2026-01-01T00:00:00Z'},k_plain:{...device,scopes:['read','write']},k_other:{...device,owner:'bo@example.test'}}});
  f.add(TOKEN,'ann@example.test','k_ok');f.add('c'.repeat(64),'ann@example.test','k_gone');f.add('d'.repeat(64),'ann@example.test','k_plain');f.add('e'.repeat(64),'ann@example.test','k_other');
  assert.equal(await f.hub.agentWaiting('ann@example.test',waiting),1);
  assert.equal(f.sent.length,1);
  const {aps,flow}=f.sent[0].payload;
  assert.equal(aps.category,'FLOW_AGENT_APPROVAL');assert.equal(aps.alert.body,'Run: npm test');assert.match(aps.alert.title,/Fix login/);
  assert.deepEqual(flow,{type:'agent',source:'bridge:mac',agentId:'t3:1',requestId:'r1',kind:'approval'});
  assert.deepEqual([...f.devices.keys()],[TOKEN],'devices of revoked, non-device or someone else\'s keys are forgotten');
});

test('pushes: Do not disturb holds agent pushes; previews off hides the prompt; a question gets Reply',async()=>{
  const q=fixture({keys:{k:device},quiet:true});q.add(TOKEN,'ann@example.test','k');
  assert.equal(await q.hub.agentWaiting('ann@example.test',waiting),0);
  const p=fixture({keys:{k:device},previews:false});p.add(TOKEN,'ann@example.test','k');
  await p.hub.agentWaiting('ann@example.test',{...waiting,pending:{...waiting.pending,kind:'question',can:[]}});
  assert.equal(p.sent[0].payload.aps.alert.body,'Open Flow to answer.');
  assert.equal(p.sent[0].payload.aps.category,'FLOW_AGENT_QUESTION');
});

test('pushes: cards respect the device\'s preference, resolve OneProfileID links, and drop dead tokens',async()=>{
  const f=fixture({keys:{k:device,kc:{...device,owner:'cy@example.test'},kb:{...device,owner:'ann@example.test'}}});
  f.add(TOKEN,'ann@example.test','k');f.add(TOKEN2,'ann@example.test','kb');f.add('f'.repeat(64),'cy@example.test','kc',{prefs:{agents:true,cards:false}});
  const sent=await f.hub.cards({id:'e1',name:'Work'},[
    {to:{email:'ann@example.test'},kind:'moved',card:{id:'k1',number:12,title:'Build sign-up form',column:'uat'}},
    {to:{opidUser:'opid-cy'},kind:'assigned',card:{id:'k1',number:12,title:'Build sign-up form',column:'uat'}}]);
  assert.equal(sent,1,'Ann\'s live device; Cy turned card pushes off');
  assert.equal(f.sent[0].payload.aps.alert.title,'Moved to UAT');
  assert.equal(f.sent[0].payload.aps.alert.body,'#12 Build sign-up form');
  assert.deepEqual(f.sent[0].payload.flow,{type:'card',env:'e1',card:'k1',number:12});
  assert.ok(!f.devices.has(TOKEN2),'APNs said the token is gone');
});
