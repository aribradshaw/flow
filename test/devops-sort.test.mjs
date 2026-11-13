// DevOps column sorts (public/devops-core.js sortCards): a view over board order.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SORTS,sortKey,sortCards,priorityRank,seedDevops} from '../public/devops-core.js';

const labels=seedDevops().labels;   // Urgent (urgency), High, Medium, Low (priority), then areas
let n=0;
const card=(id,over={})=>({id,number:++n,title:id,labels:[],points:null,due:'',created:'2026-01-01T00:00:00.000Z',updated:'2026-01-01T00:00:00.000Z',...over});
const ids=list=>list.map(c=>c.id).join();

test('manual (and unknown sorts) keep board order and return a copy',()=>{
  const cards=[card('a'),card('b'),card('c')];
  const out=sortCards(cards,'manual',labels);
  assert.equal(ids(out),'a,b,c');assert.notEqual(out,cards);
  assert.equal(ids(sortCards(cards,'bogus',labels)),'a,b,c');
  assert.equal(sortKey('bogus'),'manual');assert.equal(sortKey('due'),'due');
  assert.equal(SORTS[0][0],'manual');
});

test('sorting never changes the input array or the cards',()=>{
  const cards=[card('a',{points:1}),card('b',{points:5})],before=JSON.stringify(cards);
  sortCards(cards,'points-high',labels);
  assert.equal(JSON.stringify(cards),before);
});

test('created and updated dates',()=>{
  const cards=[card('a',{created:'2026-02-01T00:00:00Z',updated:'2026-03-05T00:00:00Z'}),card('b',{created:'2026-03-01T00:00:00Z',updated:'2026-03-01T00:00:00Z'}),card('c',{created:'2026-01-01T00:00:00Z',updated:'2026-03-09T00:00:00Z'})];
  assert.equal(ids(sortCards(cards,'newest',labels)),'b,a,c');
  assert.equal(ids(sortCards(cards,'oldest',labels)),'c,a,b');
  assert.equal(ids(sortCards(cards,'updated',labels)),'c,a,b');
});

test('due dates: no due date goes last in both directions',()=>{
  const cards=[card('none1'),card('late',{due:'2026-12-01'}),card('none2'),card('soon',{due:'2026-11-20'}),card('mid',{due:'2026-11-25'})];
  assert.equal(ids(sortCards(cards,'due',labels)),'soon,mid,late,none1,none2');
  assert.equal(ids(sortCards(cards,'due-late',labels)),'late,mid,soon,none1,none2');
});

test('points: no points go last in both directions; 0 is a value',()=>{
  const cards=[card('none'),card('p3',{points:3}),card('p0',{points:0}),card('p8',{points:8})];
  assert.equal(ids(sortCards(cards,'points-high',labels)),'p8,p3,p0,none');
  assert.equal(ids(sortCards(cards,'points-low',labels)),'p0,p3,p8,none');
});

test('priority: urgency outranks priority, listed order within a section, unlabelled last',()=>{
  const cards=[card('plain',{labels:['l-frontend']}),card('low',{labels:['l-low']}),card('urgent',{labels:['l-low','l-urgent']}),card('high',{labels:['l-high']}),card('med',{labels:['l-medium','l-backend']})];
  assert.equal(ids(sortCards(cards,'priority',labels)),'urgent,high,med,low,plain');
  const rank=priorityRank(labels);
  assert.equal(rank({labels:['l-high','l-low']}),rank({labels:['l-high']}),'a card ranks by its highest label');
  assert.equal(rank({labels:[]}),Infinity);
});

test('card number and title',()=>{
  const cards=[card('x',{number:12,title:'item 10'}),card('y',{number:3,title:'Item 9'}),card('z',{number:7,title:'apple'})];
  assert.equal(ids(sortCards(cards,'number',labels)),'y,z,x');
  assert.equal(ids(sortCards(cards,'title',labels)),'z,y,x','case-insensitive and numeric-aware');
});

test('ties keep board order (stable), for every sort',()=>{
  const same={due:'2026-11-20',points:2,labels:['l-high'],title:'Same',created:'2026-05-01T00:00:00Z',updated:'2026-05-01T00:00:00Z'};
  const cards=['d','b','e','a','c'].map(id=>card(id,same));
  for(const [k] of SORTS.filter(([k])=>k!=='number'))assert.equal(ids(sortCards(cards,k,labels)),'d,b,e,a,c',k);
  // Missing values tie with each other in board order too.
  const missing=['q','p','r'].map(id=>card(id));
  for(const k of ['due','due-late','points-high','points-low','priority'])assert.equal(ids(sortCards(missing,k,labels)),'q,p,r',k);
});
