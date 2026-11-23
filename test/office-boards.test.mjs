import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cardsInOffice,cardsForOfficeBoard,workingCards,officeMemberRefs} from '../public/office-boards-core.js';

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
  const a={id:'agent',status:'active',cards:['req','work','hidden','unrelated']};
  const result=cardsForOfficeBoard(cards,{delegated:new Set(a.cards)});
  assert.deepEqual([...result.values()].map(list=>list.map(c=>c.id)),[['sh.team.req'],['sh.team.work']]);
  assert.equal(workingCards(cards,[a]).get(a.id).id,'sh.team.work');
  assert.equal(workingCards(cards,[{...a,status:'paused'}]).size,0);
});

test('office member keys resolve only to projected contacts and person ids',()=>{
  const db=fixture([]);
  db.shares[0].members=[{id:'@team@example.test',officeKey:'team'},{id:'@other@example.test',officeKey:'other'}];
  assert.deepEqual(officeMemberRefs(db,{key:'team',personIds:['sh.team.person']}),['sh.team.person','@team@example.test']);
});
