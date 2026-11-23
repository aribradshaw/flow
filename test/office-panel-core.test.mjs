import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentGlance} from '../public/office-panel-core.js';

test('the agent panel is a status dot and chips, with the meaning in the tooltip',()=>{
  const html=agentGlance({title:'Chief of Staff: first triage',status:'running',statusLabel:'Running',
    model:'Cursor · grok-4.7',host:'homebox',repo:'aribradshaw/flygonlc',project:'Flow',desk:'Chief of Staff',
    cardNumber:449,cardTitle:'first triage pass',cardId:'card-449',subs:'2',subsTip:'Researcher, Brain Keeper',
    owner:'Ari',mine:true,steer:true});
  assert.match(html,/aria-label="Running"/);
  assert.match(html,/data-tip="Running"/);
  assert.match(html,/data-tip="Model">Cursor · grok-4\.7/);
  assert.match(html,/data-agent-card="card-449">#449/);
  assert.match(html,/data-tip="Researcher, Brain Keeper">2/);
  assert.doesNotMatch(html,/>Status<|>Doing<|>Belongs to<|>Where<|>Repo</);
  assert.match(html,/of-steer-slot/);
  assert.doesNotMatch(html,/>Ari</);
});

test('a private agent shows no repo',()=>{
  const html=agentGlance({private:true,title:'secret',status:'idle',statusLabel:'Idle',model:'Claude',repo:'hidden/repo',owner:'Joe',mine:false});
  assert.match(html,/>Private project</);
  assert.match(html,/data-tip="Belongs to">Joe/);
  assert.doesNotMatch(html,/hidden\/repo/);
});
