// Split view rules (public/split-core.js): the hash, the divider ratio and which pane a click changes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHash,hashFor,clampRatio,openSplit,closePane,clickTab,revealTab,cleanSplit,MIN_PANE,DIVIDER} from '../public/split-core.js';

test('parseHash reads split hashes and keeps every older hash working', ()=>{
  assert.deepEqual(parseHash('#devops|agentflow'),{tab:'devops',tabs:['devops','agentflow']});
  assert.deepEqual(parseHash('#chart|timeline'),{tab:'chart',tabs:['chart','timeline']});
  assert.deepEqual(parseHash(''),{tab:'chart',tabs:null});
  assert.deepEqual(parseHash('#timeline'),{tab:'timeline',tabs:null});
  assert.deepEqual(parseHash('#agentflow'),{tab:'agentflow',tabs:null});
  assert.deepEqual(parseHash('#devops/card/12'),{tab:'devops',tabs:null});
  assert.deepEqual(parseHash('#nope'),{tab:'chart',tabs:null});
  // A split needs two different known tabs; otherwise the first part is a single view.
  assert.deepEqual(parseHash('#devops|devops'),{tab:'devops',tabs:null});
  assert.deepEqual(parseHash('#timeline|nope'),{tab:'timeline',tabs:null});
  assert.deepEqual(parseHash('#a|b|c'),{tab:'chart',tabs:null});
});

test('hashFor round-trips through parseHash', ()=>{
  assert.equal(hashFor('chart',null),'');
  assert.equal(hashFor('devops',null),'#devops');
  assert.equal(hashFor('agentflow',['devops','agentflow']),'#devops|agentflow');
  for(const tabs of [['chart','timeline'],['agentflow','chart'],['timeline','devops']])assert.deepEqual(parseHash(hashFor(tabs[1],tabs)).tabs,tabs);
  for(const t of ['chart','timeline','devops','agentflow'])assert.equal(parseHash(hashFor(t,null)).tab,t);
});

test('clampRatio keeps both panes at least the minimum width', ()=>{
  const w=1500,avail=w-DIVIDER;
  assert.equal(clampRatio(.5,w),.5);
  assert.equal(clampRatio(.01,w),MIN_PANE/avail);
  assert.equal(clampRatio(.99,w),1-MIN_PANE/avail);
  assert.equal(clampRatio(NaN,w),.5);
  // Too narrow for two minimum panes: an even split.
  assert.equal(clampRatio(.2,600),.5);
  assert.equal(clampRatio(.3,0),.3);
});

test('the notch opens the clicked tab on the right, focused; the current tab stays left', ()=>{
  assert.deepEqual(openSplit('devops','agentflow'),{tabs:['devops','agentflow'],focus:1});
  assert.equal(openSplit('chart','chart'),null);
  assert.equal(openSplit('chart','nope'),null);
});

test('closing a pane leaves the other one alone', ()=>{
  const l={tabs:['chart','timeline'],focus:1};
  assert.deepEqual(closePane(l,'timeline'),{tabs:null,focus:0,tab:'chart',closed:'timeline'});
  assert.deepEqual(closePane(l,'chart'),{tabs:null,focus:0,tab:'timeline',closed:'chart'});
  assert.equal(closePane(l,'devops'),null);
  assert.equal(closePane({tabs:null,focus:0},'chart'),null);
});

test('a tab click focuses a shown pane, or replaces the focused pane', ()=>{
  const l={tabs:['chart','timeline'],focus:0};
  assert.deepEqual(clickTab(l,'timeline'),{tabs:['chart','timeline'],focus:1,tab:'timeline'});
  assert.deepEqual(clickTab(l,'chart'),{tabs:['chart','timeline'],focus:0,tab:'chart'});
  assert.deepEqual(clickTab(l,'devops'),{tabs:['devops','timeline'],focus:0,tab:'devops',replaced:'chart'});
  assert.deepEqual(clickTab({...l,focus:1},'agentflow'),{tabs:['chart','agentflow'],focus:1,tab:'agentflow',replaced:'timeline'});
  assert.deepEqual(clickTab({tabs:null,focus:0},'devops'),{tabs:null,focus:0,tab:'devops'});
});

test('a cross-link opens its target in the other pane so the source stays in view', ()=>{
  const l={tabs:['chart','timeline'],focus:0};
  assert.deepEqual(revealTab(l,'devops'),{tabs:['chart','devops'],focus:1,tab:'devops',replaced:'timeline'});
  assert.deepEqual(revealTab(l,'timeline'),{tabs:['chart','timeline'],focus:1,tab:'timeline'});
  assert.deepEqual(revealTab({...l,focus:1},'agentflow'),{tabs:['agentflow','timeline'],focus:0,tab:'agentflow',replaced:'chart'});
  assert.deepEqual(revealTab({tabs:null,focus:0},'devops'),{tabs:null,focus:0,tab:'devops'});
});

test('cleanSplit accepts only a valid stored split', ()=>{
  assert.deepEqual(cleanSplit({tabs:['devops','agentflow'],ratio:.6}),{tabs:['devops','agentflow'],ratio:.6});
  assert.deepEqual(cleanSplit(null),{tabs:null,ratio:.5});
  assert.deepEqual(cleanSplit({tabs:['chart','chart'],ratio:'x'}),{tabs:null,ratio:.5});
  assert.deepEqual(cleanSplit({tabs:['chart','nope','timeline'],ratio:5}),{tabs:null,ratio:.9});
});
