// Plain words for Settings › Sharing (public/share-words.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {additionSentence,recordWords,addsHelp,summaryWords} from '../public/share-words.js';

test('an addition names every record it holds, a mind map card and its connection alike',()=>{
  const p=[{kind:'node',id:'n',title:'Crosslist',detail:'entity'},{kind:'edge',id:'e',title:'Kestrel Holdings LLC → Crosslist',detail:'ownership'}];
  assert.equal(additionSentence(p),'Added a mind map card “Crosslist” and a connection Kestrel Holdings LLC → Crosslist.');
  assert.equal(additionSentence([{kind:'item',title:'Launch'}]),'Added a timeline item “Launch”.');
  assert.equal(additionSentence([]),'Nothing left to add.');
});

test('past three records an addition is counted by kind, none left out',()=>{
  const cards=n=>Array.from({length:n},(_,i)=>({kind:'card',title:'C'+i}));
  assert.equal(additionSentence([...cards(5),{kind:'project',title:'P'},{kind:'node',title:'N'},{kind:'edge',title:'A → N'}]),'Added a mind map card, a connection, a project and 5 DevOps cards.');
});

test('preview rows read in the app’s words',()=>{
  assert.deepEqual(recordWords({kind:'node',title:'Crosslist',detail:'entity'}),{kind:'Mind map card',title:'Crosslist',detail:'Entity'});
  assert.equal(recordWords({kind:'edge',title:'A → B',detail:'50% ownership'}).detail,'owns 50%');
  assert.equal(recordWords({kind:'edge',title:'A → B',detail:'groups'}).detail,'groups');
  assert.equal(recordWords({kind:'card',title:'Ship',detail:'Studio launch'}).detail,'Studio launch');
});

test('what "New things they add" means, and the share counts',()=>{
  assert.match(addsHelp('approve'),/until you approve/);
  assert.match(addsHelp('direct'),/straight into/);
  assert.match(addsHelp('approve','view'),/Only people who can edit/);
  assert.equal(summaryWords({nodes:73,projects:1,cards:451,stubs:0}),'73 mind map cards · 1 project · 451 DevOps cards');
  assert.equal(summaryWords({nodes:1,projects:0,cards:1,stubs:2}),'1 mind map card · 0 projects · 1 DevOps card · names of 2 co-owners');
});
