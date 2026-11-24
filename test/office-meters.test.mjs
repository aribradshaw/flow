// Room and office meters: today and week boundaries, points, visibility, the running-count
// sparkline, and the optional usage field. Counting is pure (public/office-meters-core.js).
// The hub test checks that the sparkline is public and usage is not.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {cleanReport,officeState,viewAgent,officeHub} from '../lib/office.mjs';
import {getOperation} from '../lib/registry.mjs';
import {SPARK_SLOTS,browserTimeZone,cardPoints,cardVisible,cardsForMember,cleanUsage,createSparkline,formatUsage,meterAnchors,meterCounts,sameLocalDay,sameLocalWeek,sumSeries,zonedParts} from '../public/office-meters-core.js';

const HST='Pacific/Honolulu';
const NOW=Date.parse('2026-06-03T20:00:00Z'); // 10:00 on Wednesday 3 June in Honolulu

test('today and this week follow the timezone, including the Honolulu midnight and Monday boundaries',()=>{
  assert.equal(sameLocalDay('2026-06-03T09:30:00Z',NOW,HST),false,'23:30 the day before');
  assert.equal(sameLocalDay('2026-06-03T10:00:00Z',NOW,HST),true,'midnight starts the day');
  assert.equal(sameLocalDay('not-a-date',NOW,HST),false);
  assert.equal(sameLocalWeek('2026-06-01T09:59:00Z',NOW,HST),false,'Sunday 23:59 is the previous week');
  assert.equal(sameLocalWeek('2026-06-01T10:00:00Z',NOW,HST),true,'Monday 00:00 starts the week');
  assert.equal(sameLocalWeek('2026-06-03T09:30:00Z',NOW,HST),true,'Tuesday evening is still this week');
  assert.equal(sameLocalDay('2026-06-03T09:30:00Z',NOW,'UTC'),true,'the same instant is today in UTC');
});

test('an hour of 24 at midnight counts as the next calendar day',()=>{
  for(let t=Date.parse('2026-03-08T00:00:00Z');t<Date.parse('2026-03-09T12:00:00Z');t+=15*60*1000){
    const p=zonedParts(t,'America/New_York');
    assert.notEqual(p.hour,'24');
    assert.match(ymd(p),/^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(typeof browserTimeZone(),'string');
});
const ymd=p=>`${p.year}-${p.month}-${p.day}`;

test('points use actual, including 0, and fall back to points',()=>{
  assert.equal(cardPoints({actual:5,points:3}),5);
  assert.equal(cardPoints({actual:null,points:3}),3);
  assert.equal(cardPoints({actual:0,points:8}),0);
  assert.equal(cardPoints({points:null}),0);
  assert.equal(cardPoints({actual:-2,points:4}),4);
  assert.equal(cardPoints({actual:Number.NaN,points:4}),4);
  assert.equal(cardPoints({actual:'5',points:4}),4);
  assert.equal(cardPoints(null),0);
});

const card=(id,extra)=>({id,column:'done',moved:'2026-06-03T12:00:00Z',project:'p1',assignees:[],points:1,actual:null,...extra});

test('shipped cards respect the window, and a card the viewer cannot see never counts',()=>{
  const cards=[
    card('today',{actual:5,points:3,assignees:[{node:'ann'}]}),
    card('yesterday',{moved:'2026-06-03T09:30:00Z',actual:2,assignees:[{node:'ann'}]}),
    card('monday',{moved:'2026-06-01T10:00:00Z',points:7,assignees:['ann']}),
    card('sunday',{moved:'2026-06-01T09:59:00Z',points:9,assignees:[{node:'ann'}]}),
    card('doing',{column:'doing',actual:100,assignees:[{node:'ann'}]}),
    card('hidden',{project:'p2',actual:50,assignees:[{node:'ann'}]}),
    card('shared',{actual:1,assignees:[{node:'ann'},{node:'bo'}]}),
    card('zero',{actual:0,points:8,assignees:[{node:'bo'}]}),
  ];
  const access={all:false,projectIds:new Set(['p1'])};
  const ann=meterCounts({cards:cardsForMember(cards,['ann']),access,now:NOW,timeZone:HST});
  assert.equal(ann.shippedToday,2,'today and the shared card; yesterday is the previous Honolulu day');
  assert.equal(ann.pointsWeek,5+2+7+1,'actual wins, Monday counts, Sunday and the hidden project do not');
  const bo=meterCounts({cards:cardsForMember(cards,new Set(['bo'])),access,now:NOW,timeZone:HST});
  assert.equal(bo.shippedToday,2);assert.equal(bo.pointsWeek,1,'actual 0 adds nothing, and the shared card counts in both rooms');
  const office=meterCounts({cards,access,now:NOW,timeZone:HST});
  assert.equal(office.shippedToday,3,'the shared card counts once for the office');
  assert.equal(office.pointsWeek,5+2+7+1);
  const byCard=meterCounts({cards,access:{all:false,cardIds:new Set(['today'])},now:NOW,timeZone:HST});
  assert.equal(byCard.shippedToday,1);assert.equal(byCard.pointsWeek,5);
  assert.equal(meterCounts({cards,access:{all:true},now:NOW,timeZone:HST}).pointsWeek,5+2+7+50+1,'Sunday is the previous week even when every project is visible');
  assert.equal(cardVisible(cards[5],null),true,'no access means the caller already filtered');
  assert.equal(cardVisible(cards[5],access),false);
});

test('running and waiting count every agent; model use skips private agents and children',()=>{
  const agents=[
    {status:'running',usage:{tokens:1000,costUsd:0.5}},
    {status:'waiting',private:true,usage:{tokens:424242,costUsd:9}},
    {status:'idle',usage:{tokens:0,costUsd:0}},
    {status:'running',children:[{status:'running',usage:{tokens:999,costUsd:9}}]},
  ];
  const m=meterCounts({agents,cards:[],now:NOW,timeZone:HST});
  assert.deepEqual({running:m.running,waiting:m.waiting},{running:2,waiting:1});
  assert.equal(m.usage.tokens,1000,'the private agent and the child do not add tokens');
  assert.equal(m.usage.costUsd,0.5);
  assert.equal(formatUsage(null),'—');
  assert.equal(formatUsage({tokens:0,costUsd:0}),'0 tok · $0.00');
  assert.equal(formatUsage({tokens:1500,costUsd:null}),'1.5k tok');
  assert.equal(meterCounts({agents:[{status:'waiting',private:true,usage:{tokens:1,costUsd:1}}]}).usage,null);
});

test('usage keeps finite non-negative numbers and a bad object does not fail the report',()=>{
  assert.equal(cleanUsage(null),null);
  assert.equal(cleanUsage(['no']),null);
  assert.equal(cleanUsage({tokens:'lots',costUsd:-1}),null);
  assert.equal(cleanUsage({tokens:Number.POSITIVE_INFINITY,costUsd:1}).tokens,null);
  assert.deepEqual(cleanUsage({tokens:0,costUsd:1.25}),{tokens:0,costUsd:1.25});
  assert.deepEqual(cleanUsage({tokens:10}),{tokens:10,costUsd:null});
  assert.equal(cleanUsage({tokens:1e15+1,costUsd:1e9+1}),null);
  const r=cleanReport({source:'s',agents:[
    {id:'ok',status:'running',usage:{tokens:424242,costUsd:1.5}},
    {id:'bad',status:'waiting',usage:{tokens:'lots',costUsd:-3}},
    {id:'zero',status:'idle',usage:{tokens:0,costUsd:0}},
  ]});
  assert.deepEqual(r.agents.map(a=>a.usage??null),[
    {tokens:424242,costUsd:1.5},null,{tokens:0,costUsd:0},
  ]);
  const own=viewAgent(r.agents[0],{owner:true});
  assert.deepEqual(own.usage,{tokens:424242,costUsd:1.5});
  const full=viewAgent(r.agents[0],{full:true,key:()=>'opaque'});
  assert.deepEqual(full.usage,{tokens:424242,costUsd:1.5});
  const priv=viewAgent(r.agents[0],{key:()=>'opaque'});
  assert.deepEqual(Object.keys(priv).sort(),['activityKind','children','id','private','status','vendor']);
  assert.equal(priv.usage,undefined);
  assert.equal(JSON.stringify(priv).includes('424242'),false);
});

test('the sparkline overwrites the current minute, reads gaps as zero, and drops data older than the window',()=>{
  let t=0;const step=60_000,slots=5;
  const s=createSparkline({now:()=>t,slots,stepMs:step});
  s.sample('a',2);s.sample('a',4.2);
  assert.deepEqual(s.series('a'),[0,0,0,0,4]);
  t=2*step;
  assert.deepEqual(s.series('a'),[0,0,4,0,0],'a gap reads as zero and does not change what is stored');
  s.sample('a',1);
  assert.deepEqual(s.series('a'),[0,0,4,0,1]);
  t=2*step+slots*step;
  s.sample('a',9);
  assert.deepEqual(s.series('a'),[0,0,0,0,9]);
  s.sample('b',3);
  const dumped=s.dump();
  const again=createSparkline({now:()=>t,slots,stepMs:step});
  again.sample('b',7);
  again.load(dumped);
  assert.equal(again.series('b').at(-1),7,'a key already sampled is left as it is');
  assert.equal(again.series('a').at(-1),9);
  again.load({series:{a:{minute:0,values:[1,2]}}});
  assert.equal(again.series('a').at(-1),9,'a series of the wrong length is ignored');
  assert.deepEqual(sumSeries([[1,2],[0,0,3]]),[1,2,3]);
  assert.equal(SPARK_SLOTS,24*60);
});

test('fallback mounts face the reader and stay out of the door and off the common board',()=>{
  const {room,office}=meterAnchors({roomD:9,commonRadius:10});
  const extra=room.ry-Math.PI;
  const zExtent=room.w/2*Math.abs(Math.sin(extra))+0.04;
  assert.ok(room.z+zExtent<9/2-0.1,'the screen sits inside the front wall');
  const xExtent=room.w/2*Math.abs(Math.cos(extra));
  const towardDoor=room.x>0?room.x-xExtent:room.x+xExtent;
  assert.ok(Math.abs(towardDoor)>1.5,'the screen stays clear of the door');
  assert.ok(room.x<0,'the room meter stays off the name sign, which sits at +x');
  assert.ok(Math.cos(room.ry)<0,'the room meter faces into the room');
  assert.equal(Math.sign(Math.sin(room.ry)),-Math.sign(room.x),'the room meter yaws toward the door');
  assert.ok(Math.cos(office.ry)>0.9,'the office meter faces the middle of the common area');
  assert.ok(office.x-office.w/2>4.4,'the office meter clears the common board');
});

test('the reporter contract accepts optional usage and does not require the bridge to send it',()=>{
  const usage=getOperation('office.agents.list').output.properties.agents.items.properties.usage;
  assert.deepEqual(usage.type,['object','null']);
  assert.equal(typeof usage.properties.tokens.description,'string');
  assert.equal(typeof usage.properties.costUsd.description,'string');
  const report=getOperation('office.agents.report');
  assert.ok(report.input.properties.agents.items.properties.usage);
  assert.match(report.description,/office bridge sends measured usage/);
  assert.equal(report.examples[0].input.agents[0].usage,undefined);
});

function sse(url){
  const events=[];let buf='',res;
  const ready=new Promise((ok,no)=>{const req=http.get(url,r=>{res=r;r.setEncoding('utf8');r.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\n\n'))>=0){const block=buf.slice(0,i);buf=buf.slice(i+2);
    const type=/^event: (.+)$/m.exec(block)?.[1],data=/^data: (.+)$/m.exec(block)?.[1];if(type)events.push({type,data:JSON.parse(data)})}});ok(r)});req.on('error',no)});
  const next=async(type,ms=2000)=>{for(const end=Date.now()+ms;Date.now()<end;){const i=events.findIndex(e=>e.type===type);if(i>=0)return events.splice(i,1)[0].data;await new Promise(r=>setTimeout(r,10))}throw Error('no '+type+' event')};
  return {ready,events,next,close:()=>res?.destroy()};
}

test('the hub sends one public sparkline per member and keeps usage off private agents',async()=>{
  let time=Date.parse('2026-06-03T10:00:00Z');
  const st=officeState({now:()=>time});
  const users={ann:{email:'ann@example.test',name:'Ann'},bo:{email:'bo@example.test',name:'Bo'}};
  const ctx={id:'env1',name:'Studio',ownerEmail:users.ann.email,members:Object.values(users).map(u=>({email:u.email,name:u.name})),
    projects:[{id:'p-flow',name:'Flow',repos:['acme/flow']}],agents:[]};
  const access={ann:{ok:true,all:true,projectIds:new Set()},bo:{ok:true,all:false,projectIds:new Set()}};
  const hub=officeHub({state:st,context:{env:async()=>ctx},now:()=>time,heartbeatMs:1e9});
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://x'),who=u.searchParams.get('as');
    if(u.pathname==='/events'){await hub.connect('env1',users[who],access[who],req,res);return}
    res.writeHead(404);res.end();
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const url=who=>`http://127.0.0.1:${server.address().port}/events?as=${who}`;
  st.report(users.ann.email,{source:'bridge',agents:[
    {id:'run',title:'Ship the meter',status:'running',usage:{tokens:424242,costUsd:1.25},children:[{id:'c',status:'running'}]},
    {id:'wait',title:'Ask first',status:'waiting',usage:{tokens:10,costUsd:0.1}},
  ]});
  st.report(users.bo.email,{source:'bridge',agents:[{id:'bo1',status:'running'}]});
  const ann=sse(url('ann')),bo=sse(url('bo'));
  try{
    await Promise.all([ann.ready,bo.ready]);
    const [sa,sb]=await Promise.all([ann.next('snapshot'),bo.next('snapshot')]);
    const annKey=sa.me.key,boKey=sb.me.key;
    assert.equal(sa.sparks[annKey].length,SPARK_SLOTS);
    assert.equal(sa.sparks[annKey].at(-1),1,'a running child is not another agent');
    assert.equal(sa.sparks[boKey].at(-1),1);
    assert.deepEqual(sb.sparks[annKey],sa.sparks[annKey],'the running count is the same for every viewer');
    assert.equal(JSON.stringify(sa).includes('@example.test'),false);
    assert.deepEqual(sa.live[annKey].map(a=>a.usage.tokens),[424242,10]);
    assert.ok(sb.live[annKey].every(a=>a.private&&!a.usage));
    assert.equal(JSON.stringify(sb).includes('424242'),false);
    await hub.sampleMeters();
    await new Promise(r=>setTimeout(r,40));
    assert.equal(ann.events.some(e=>e.type==='meters'),false,'the same minute does not push meters');
    time+=60_000;
    await hub.sampleMeters();
    const meters=await ann.next('meters');
    assert.equal(meters.sparks[annKey].at(-1),1);
    assert.equal(JSON.stringify(meters).includes('@'),false);
  }finally{ann.close();bo.close();hub.close();st.close();server.close()}
});
