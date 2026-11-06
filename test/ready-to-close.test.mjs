// When a timeline item suggests being marked complete (public/devops-core.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readyToClose} from '../public/devops-core.js';

const db=(...columns)=>({devops:{cards:columns.map((column,i)=>({id:'k'+i,item:'i1',column}))}});
const item=(status='planned')=>({id:'i1',status});

test('an open item is ready once every linked card is done',()=>{
  assert.equal(readyToClose(db('done','done'),item()),2);
  assert.equal(readyToClose(db('done'),item('active')),1);
  assert.equal(readyToClose(db('done'),item('blocked')),1);
});
test('an open card, or no cards at all, means not ready',()=>{
  assert.equal(readyToClose(db('done','doing'),item()),0);
  assert.equal(readyToClose(db(),item()),0);
  assert.equal(readyToClose({devops:{cards:[{id:'k',item:'other',column:'done'}]}},item()),0);
});
test('an item already closed never asks',()=>{
  assert.equal(readyToClose(db('done'),item('done')),0);
  assert.equal(readyToClose(db('done'),item('cancelled')),0);
});
