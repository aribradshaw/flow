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
