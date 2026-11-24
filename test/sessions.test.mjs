// lib/sessions.mjs: cached sessions past their maximum age leave memory (card #677).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionStore} from '../lib/sessions.mjs';

test('the in-memory session cache drops sessions past their maximum age',async()=>{
  const s=sessionStore({max:1000});const now=Date.now();
  await s.set('new',{user:{id:'u2'},created:now,last:now});
  await s.set('old',{user:{id:'u1'},created:now-5000,last:now-5000});
  assert.equal(s.size(),2);s.prune(now);
  assert.equal(s.size(),1);assert.equal(await s.get('old'),null);assert.ok(await s.get('new'));
});
