import {test} from 'node:test';
import assert from 'node:assert/strict';
import {officeOverlayActions} from '../public/office-overlays-core.js';

test('hosted editor cross-links stay on the office overlay stack',()=>{
  const calls=[];
  const actions=officeOverlayActions((kind,id)=>calls.push([kind,id]));
  actions.openCard('card-id');
  actions.openItem('item-id');
  actions.openAgent('agent-id');
  actions.openQueue('agent-id');
  actions.openLink('https://example.test');
  assert.deepEqual(calls,[
    ['card','card-id'],
    ['item','item-id'],
    ['agent','agent-id'],
    ['queue','agent-id'],
    ['link','https://example.test'],
  ]);
});
