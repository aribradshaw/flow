import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {officeState} from '../lib/office.mjs';
import {createOfficeHistory,historyDay,openOfficeHistoryStore} from '../lib/office-history.mjs';

const day='2026-11-22',base=Date.parse(day+'T12:00:00Z'),env='fixture';
const owner='owner@example.test',other='guest@example.test';
const full={ok:true,all:true},limited={ok:true,projectIds:new Set(['unrelated']),cardIds:new Set()};

async function file(t,options){
  const dir=await mkdtemp(join(tmpdir(),'flow-office-history-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return {dir,store:await openOfficeHistoryStore({dir,...options})};
}

test('local days handle DST, midnight boundaries and retention',()=>{
  const spring=historyDay('2026-03-08','America/New_York',Date.parse('2026-03-09T12:00Z'));
  assert.equal(new Date(spring.start).toISOString(),'2026-03-08T05:00:00.000Z');
  assert.equal(spring.end-spring.start,23*3600000);
  const fall=historyDay('2026-11-01','America/New_York',Date.parse('2026-11-02T12:00Z'));
  assert.equal(fall.end-fall.start,25*3600000);
  assert.equal(historyDay(day,'Asia/Kathmandu',base).start,Date.parse('2026-11-21T18:15Z'));
  for(const [d,tz] of [['2026-02-30','UTC'],[day,'Not/AZone'],['2026-11-23','UTC'],['2026-11-08','UTC']]){
    assert.throws(()=>historyDay(d,tz,base),RangeError);
  }
});

test('records text-free replay even with nobody watching and redacts stored states at read time',async t=>{
  const {store,dir}=await file(t);
  let time=base,errors=[];
  const now=()=>time;
  const state=officeState({now});
  const ctx={id:env,members:[{email:owner},{email:other}],projects:[{id:'visible',repos:['example/repo']}],
    agents:[{id:'builder',name:'Builder',projects:['visible'],cards:['card']}],
    cards:[{id:'card',title:'DO_NOT_STORE_CARD',number:31,project:'visible',column:'doing'}]};
  const memberKey=email=>email===owner?'m1':'m2',agentKey=(_email,a)=>a.id==='id-1'?'a1':'a2';
  const history=createOfficeHistory({store,state,environments:async()=>[ctx],context:async()=>ctx,memberKey,agentKey,now,onError:e=>errors.push(e)});
  const report={source:'DO_NOT_STORE_SOURCE',agents:[{id:'id-1',title:'DO_NOT_STORE_TITLE',status:'waiting',
    activity:'DO_NOT_STORE_ACTIVITY',activityKind:'test',repo:{name:'example/repo'},
    agentflow:{agent:'builder',card:31},pending:{requestId:'DO_NOT_STORE_REQUEST',summary:'DO_NOT_STORE_PROMPT',can:['allow']},
    transcript:[{role:'user',text:'DO_NOT_STORE_TRANSCRIPT'}],can:['message']}]};
  await state.report(owner,report);
  await state.answer({by:owner,owner,source:report.source,agentId:'id-1',requestId:'DO_NOT_STORE_REQUEST',decision:'allow'});
  state.steer({by:owner,owner,source:report.source,agentId:'id-1',kind:'message',text:'DO_NOT_STORE_STEER'});
  const p={key:'m1',name:'DO_NOT_STORE_NAME',status:'DO_NOT_STORE_STATUS',x:0,y:0,z:2,heading:0,moving:true};
  await history.sample(env,p);
  await history.marker(env,'message','m1','DO_NOT_STORE_CHAT');
  await history.marker(env,'emote','m1','wave');
  time+=1000;await history.sample(env,{...p,x:1});
  time+=1000;await history.sample(env,{...p,x:2});
  await history.cards(env,{devops:{cards:ctx.cards}},{devops:{cards:[{...ctx.cards[0],column:'done'}]}});
  time+=1000;await state.report(owner,{...report,agents:[{...report.agents[0],status:'running'}]});
  time+=1000;await state.report(owner,{...report,agents:[]});
  await history.leave(env,'m1');
  await history.close();
  assert.deepEqual(errors,[]);
  const files=await readdir(join(dir,'_office-history'));
  const raw=await readFile(join(dir,'_office-history',files[0]),'utf8');
  assert.doesNotMatch(raw,/DO_NOT_STORE|example|requestId|transcript|title|summary/);
  const page=user=>history.page(env,{email:user},limited,day,'UTC');
  const mine=await page(owner),redacted=await page(other);
  const hidden=redacted.events.find(e=>e.type==='agent');
  assert.deepEqual(hidden,{type:'agent',at:base,member:'m1',agent:'a1',vendor:'other',status:'waiting',activityKind:'test',private:true,wait:'start'});
  assert.deepEqual(mine.events.find(e=>e.type==='agent').seat,{agent:'builder',card:{number:31,column:'doing'}});
  assert.deepEqual(mine.events.filter(e=>e.wait).map(e=>e.wait),['start','end']);
  assert.deepEqual(mine.events.filter(e=>e.type==='pose').map(e=>e.x),[2]);
  assert.equal(mine.events.find(e=>e.type==='answer').decision,'allow');
  assert.deepEqual(mine.events.filter(e=>e.type==='agent-leave').map(e=>e.agent),['a1']);
  assert.ok(!redacted.events.some(e=>e.type==='card'));
  const visible=await history.page(env,{email:other},full,day,'UTC');
  assert.equal(visible.events.find(e=>e.type==='card').column,'done');
  assert.equal(visible.events.find(e=>e.type==='agent').private,false);
  assert.equal(await history.page(env,{email:other},{ok:false},day,'UTC'),null);
  ctx.members.pop();
  assert.equal(await history.page(env,{email:other},full,day,'UTC'),null);
});

test('bounded hourly buckets preserve transitions separately from samples and prune old files',async t=>{
  const {store,dir}=await file(t,{hourLimits:[2,2]});
  const hour=Math.floor(base/3600000)*3600000;
  const move=at=>({type:'pose',at});
  const mark=at=>({type:'message',at});
  assert.equal(await store.append(env,hour,1,[move(base),move(base+1),move(base+2)]),2);
  assert.equal(await store.append(env,hour,1,[move(base+3)]),0);
  assert.equal(await store.append(env,hour,0,[mark(base+4),mark(base+5),mark(base+6)]),2);
  const first=await store.read(env,base,base+10,[base-1,'0'],2);
  const tail=await store.read(env,base,base+10,[first[1].at,first[1].id],3);
  assert.deepEqual(tail.map(e=>e.type),['message','message']);
  const restarted=await openOfficeHistoryStore({dir,hourLimits:[2,2]});
  assert.equal(await restarted.append(env,hour,0,[mark(base+10)]),0);
  assert.equal(await restarted.append(env,hour+3600000,1,[move(base+3600000)]),1);
  await restarted.prune(base+3600000);
  assert.deepEqual(await restarted.read(env,base,base+3600000,[base-1,'0'],10),[]);
  assert.equal((await restarted.read(env,base+3600000,base+7200000,[base,'0'],10)).length,1);
});
