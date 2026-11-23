import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cardsInOffice,cardsForOfficeBoard,workingCards,officeMemberRefs,planOfficeDrop} from '../public/office-boards-core.js';

import {allows,applyRecipientEdit} from '../lib/sharing-core.mjs';
import {cleanAgentflow} from '../public/agentflow-core.js';

const card=(id,column,assignees=[],more={})=>({id,column,assignees:assignees.map(node=>({node,role:'developer'})),...more});
const fixture=cards=>({environment:{id:'home'},devops:{cards},shares:[{id:'team',ownerEnv:'other'}]});

test('room boards pick the first three visible assigned cards in each lane',()=>{
  const db=fixture([
    card('one','doing',['person']),card('another','doing',['someone']),card('three','doing',['person']),
    card('snoozed','doing',['person'],{snoozedUntil:'2099-01-01'}),card('four','doing',['person']),card('five','doing',['person']),
    card('sh.team.separate','doing',['person']),card('uat','uat',['person']),card('blocked','blocked',['person']),card('done','done',['person']),
  ]);
  const result=cardsForOfficeBoard(cardsInOffice(db,'home'),{member:{personIds:['person']}});
  assert.deepEqual([...result].map(([col,list])=>[col,list.map(c=>c.id)]),[
    ['doing',['one','three','four']],['uat',['uat']],['blocked',['blocked']],
  ]);
});

test('shared common boards use the agent queues but keep projected card ids and never invent unseen cards',()=>{
  const cards=cardsInOffice(fixture([
    card('unrelated','requests'),card('sh.team.req','requests'),card('sh.team.work','doing'),card('sh.team.undel','requests'),
  ]),'other');
  const a={id:'agent',status:'active',boardCards:['sh.team.req','sh.team.work','sh.team.hidden','unrelated']};
  const result=cardsForOfficeBoard(cards,{delegated:new Set(a.boardCards)});
  assert.deepEqual([...result.values()].map(list=>list.map(c=>c.id)),[['sh.team.req'],['sh.team.work']]);
  assert.equal(workingCards(cards,[a]).get(a.id).id,'sh.team.work');
  assert.equal(workingCards(cards,[{...a,status:'paused'}]).size,0);
});

test('office member keys resolve only to projected contacts and person ids',()=>{
  const db=fixture([]);
  db.shares[0].members=[{id:'@team@example.test',officeKey:'team'},{id:'@other@example.test',officeKey:'other'}];
  assert.deepEqual(officeMemberRefs(db,{key:'team',personIds:['sh.team.person']}),['sh.team.person','@team@example.test']);
});

test('delegating appends to the AgentFlow queues, or replaces while Shift is held',()=>{
  const c=card('c','doing');
  const db={agentflow:{agents:[{id:'first',cards:['c']},{id:'second',cards:[]}]}};
  const target={type:'agent',id:'second'};
  assert.deepEqual(planOfficeDrop(db,c,target,{editable:true,local:true}),{type:'delegate',agents:['first','second']});
  assert.deepEqual(planOfficeDrop(db,c,target,{editable:true,local:true,replace:true}),{type:'delegate',agents:['second']});
  assert.equal(planOfficeDrop(db,c,{type:'agent',id:'first'},{editable:true,local:true}),null);
  assert.equal(planOfficeDrop(db,c,target,{editable:true,local:false}),null);
  db.agentflow.agents[1].cards=Array.from({length:100},(_,i)=>'card-'+i);
  assert.equal(planOfficeDrop(db,c,target,{editable:true,local:true}),null);
});

test('drop plans assign only eligible developers and move only to another real column',()=>{
  const c=card('c','doing');
  const target={type:'person',refs:['private-id','eligible']};
  const decide=(dest,personIds=[])=>planOfficeDrop({},c,dest,{editable:true,personIds});
  assert.deepEqual(decide(target,['eligible']),{type:'assign',node:'eligible',role:'developer'});
  assert.equal(decide(target,['someone']),null);
  c.assignees.push({node:'eligible',role:'developer'});
  assert.equal(decide(target,['eligible']),null);
  assert.deepEqual(decide({type:'column',id:'uat'}),{type:'move',column:'uat'});
  assert.equal(decide({type:'column',id:'doing'}),null);
  assert.equal(decide({type:'column',id:'unknown'}),null);
});

test('view-only recipients cannot drop linked cards and cleaning retains linked agent queue entries',()=>{
  const owner=fixture([card('c','doing')]);
  const c=card('sh.team.c','doing');
  const recipient={email:'reader@example.test'};
  const share={id:'team',ownerEnv:'home',recipientEmail:recipient.email,scope:{kind:'environment'},permission:'view'};
  const target={type:'column',id:'uat'};
  assert.equal(planOfficeDrop({},c,target,{editable:allows(share,'edit')}),null);
  assert.equal(applyRecipientEdit(owner,share,{kind:'card',id:c.id,fields:{column:'uat'}},recipient).error,'permission');
  assert.deepEqual(planOfficeDrop({},c,target,{editable:allows({...share,permission:'edit'},'edit')}),{type:'move',column:'uat'});
  const cleaned=cleanAgentflow({agents:[{id:'a',name:'Agent',cards:[c.id,'missing']}]},{});
  assert.deepEqual(cleaned.agents[0].cards,[c.id]);
});

test('board lanes count every card, keep the first ones in board order, and show only recent Done',async()=>{
  const {boardLanes,MAIN_COLUMNS}=await import('../public/office-boards-core.js');
  const now=Date.parse('2026-11-20T12:00:00Z'),day=864e5,iso=t=>new Date(t).toISOString();
  const db=fixture([
    ...Array.from({length:7},(_,i)=>card('r'+i,'requests')),
    card('d1','doing',['person']),card('d2','doing',['someone']),card('z','doing',['person'],{snoozedUntil:iso(now+day)}),
    card('old','done',[],{moved:iso(now-30*day)}),card('done1','done',[],{moved:iso(now-3*day)}),card('done2','done',[],{moved:iso(now-day)}),
  ]);
  const cards=cardsInOffice(db,'home');
  const lanes=boardLanes(cards,{columns:MAIN_COLUMNS,limit:4,now});
  assert.deepEqual(lanes.map(l=>[l.id,l.total,l.cards.map(c=>c.id)]),[
    ['requests',7,['r0','r1','r2','r3']],['doing',2,['d1','d2']],['blocked',0,[]],['uat',0,[]],['done',2,['done2','done1']],
  ]);
  const mine=boardLanes(cards,{columns:['doing'],member:{personIds:['person']},now});
  assert.deepEqual(mine.map(l=>[l.total,l.cards.map(c=>c.id)]),[[1,['d1']]]);
});
