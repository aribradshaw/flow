// DevOps right-click menu helpers (public/devops-core.js): priority labels, move targets, long lists.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {priorityLabels,withPriority,moveTargets,capList,seedDevops} from '../public/devops-core.js';

const labels=seedDevops().labels;   // Urgent (urgency), High, Medium, Low (priority), then areas

test('priority labels are the Urgency then Priority sections, in list order',()=>{
  assert.deepEqual(priorityLabels(labels).map(l=>l.id),['l-urgent','l-high','l-medium','l-low']);
  assert.deepEqual(priorityLabels([]),[]);
  const mixed=[{id:'p',section:'priority'},{id:'a',section:'area'},{id:'u',section:'urgency'}];
  assert.deepEqual(priorityLabels(mixed).map(l=>l.id),['u','p']);
});

test('setting a priority replaces any Urgency or Priority label and keeps the rest',()=>{
  const before=['l-frontend','l-high','l-urgent','l-design'];
  assert.deepEqual(withPriority(before,labels,'l-low'),['l-frontend','l-design','l-low']);
  assert.deepEqual(withPriority(before,labels,''),['l-frontend','l-design']);
  assert.deepEqual(before,['l-frontend','l-high','l-urgent','l-design'],'the input is not changed');
  // An id that is not a priority label (or a deleted one) only clears.
  assert.deepEqual(withPriority(['l-high'],labels,'l-frontend'),[]);
  assert.deepEqual(withPriority(['l-high'],labels,'gone'),[]);
  assert.deepEqual(withPriority(undefined,labels,'l-high'),['l-high']);
});

test('move targets list every column and check the current one',()=>{
  const cols=seedDevops().columns,t=moveTargets(cols,{column:'uat'});
  assert.deepEqual(t.map(x=>x.id),cols.map(c=>c.id));
  assert.deepEqual(t.filter(x=>x.current).map(x=>x.id),['uat']);
  assert.equal(t.find(x=>x.id==='done').name,'Done');
  assert.ok(!moveTargets(cols,null).some(x=>x.current));
});

test('long lists are capped, always keeping the checked entries in order',()=>{
  const list=Array.from({length:20},(_,i)=>i);
  assert.deepEqual(capList(list.slice(0,5),()=>false,15),{shown:[0,1,2,3,4],more:false});
  const r=capList(list,x=>x===18,5);
  assert.deepEqual(r.shown,[0,1,2,3,18]);assert.equal(r.more,true);
  assert.deepEqual(capList(list,x=>x>=16,3).shown,[16,17,18,19],'more checked entries than room: all of them stay');
});
