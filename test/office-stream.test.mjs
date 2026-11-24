import test from 'node:test';
import assert from 'node:assert/strict';
import {officeStream,officeDiff,mergeOfficeChat} from '../public/office-stream.js';

test('office stream keeps the cursor and measures downtime across retries',()=>{
  let time=0;
  const stream=officeStream({now:()=>time,random:()=>0.5});
  stream.received('process:14');
  assert.equal(stream.disconnected(),250);
  assert.equal(stream.stale,true);
  time=250;
  assert.equal(stream.disconnected(),1000);
  time=1250;
  assert.equal(stream.disconnected(),2000);
  time=7999;
  assert.equal(stream.phase,'stale');
  time=8000;
  assert.equal(stream.phase,'reconnecting');
  time=60000;
  assert.equal(stream.phase,'unreachable');
  assert.equal(stream.disconnected({restart:true}),500);
  assert.equal(stream.phase,'unreachable');
  stream.connected();
  assert.equal(stream.stale,false);
  assert.equal(stream.cursor,'process:14');
  assert.equal(stream.disconnected(),250);
});

test('retries are jittered and capped at ten seconds',()=>{
  const stream=officeStream({random:()=>1});
  assert.deepEqual(Array.from({length:8},()=>stream.disconnected()),[300,1200,2400,4800,9600,10000,10000,10000]);
});

test('snapshot diff keeps identical entries and identifies changed and missing entries',()=>{
  const old=[{id:'same',x:1},{id:'move',x:1},{id:'left',x:1}];
  const next=[{id:'same',x:1},{id:'move',x:2},{id:'new',x:1}];
  assert.deepEqual(officeDiff(old,next,p=>p.id),{upsert:[next[1],next[2]],remove:['left']});
});

test('chat keeps recent local messages and merges missed lines without duplicates',()=>{
  const line=i=>({id:String(i),at:new Date(i*1000).toISOString()});
  const old=Array.from({length:50},(_,i)=>line(i));
  assert.deepEqual(mergeOfficeChat(old,[line(49),line(50),line(48)]),[...old.slice(1),line(50)]);
  assert.deepEqual(mergeOfficeChat(old,[]),old);
});
