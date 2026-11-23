// The threads sidebar and thread chat without the DOM (public/office-threads-core.js): sections like T3's sidebar,
// relative times, live lines, the Chief's bubble, work summaries, chat blocks and page merging.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sectionsOf,relTime,liveLine,chiefBubble,workSummary,blocksOf,mergeItems,projectHue} from '../public/office-threads-core.js';

const T0=Date.parse('2026-11-22T12:00:00Z'),at=m=>new Date(T0+m*60e3).toISOString();
const SOURCES=[{source:'bridge:a',counts:{snoozed:7,settled:231},items:[
  {id:'1',title:'Add a Shared 3D Agent Office',project:'Flow',state:'working',updatedAt:at(-1)},
  {id:'2',title:'Verify Card 306',project:'Flow',state:'woke',updatedAt:at(-30),branch:'main'},
  {id:'3',title:'Compare Phases',project:'SongBrain',state:'woke',updatedAt:at(-5)},
  {id:'4',title:'Chief of Staff',project:'Flow',state:'done',updatedAt:at(-2),unread:true},
  {id:'5',title:'Later',project:'Flow',state:'snoozed',updatedAt:at(-90)},
  {id:'6',title:'Old',project:'Campaign Baby',state:'settled',updatedAt:at(-900)},
  {id:'7',title:'Needs me',project:'Flow',state:'waiting',updatedAt:at(-3)}]}];

test('sections: Working, Waiting, Woke, Done, then Snoozed and Settled with their totals; search and hidden rows',()=>{
  const s=sectionsOf(SOURCES);
  assert.deepEqual(s.map(x=>[x.key,x.items.map(t=>t.id),x.count]),[['working',['1'],1],['waiting',['7'],1],['woke',['3','2'],2],['done',['4'],1],['snoozed',['5'],7],['settled',['6'],231]]);
  assert.equal(s[0].items[0].source,'bridge:a');
  assert.deepEqual(sectionsOf(SOURCES,{query:'songbrain'}).map(x=>[x.key,x.items.map(t=>t.id)]),[['woke',['3']]],'by project');
  assert.deepEqual(sectionsOf(SOURCES,{query:'main'}).map(x=>x.items.map(t=>t.id)),[['2']],'by branch');
  assert.ok(!sectionsOf(SOURCES,{hide:new Set(['4'])}).some(x=>x.key==='done'),'the pinned Chief is not listed twice');
  assert.deepEqual(sectionsOf([]),[]);
});

test('relative times, live lines and the Chief\'s bubble',()=>{
  assert.deepEqual([relTime(at(0),T0),relTime(at(-4),T0),relTime(at(-120),T0),relTime(at(-60*24*3),T0),relTime(at(-60*24*40),T0),relTime('x',T0)],['now','4m','2h','3d','6w','']);
  const thinking={phase:'thinking',text:'Listing what is in UAT',steps:[{kind:'tool',text:'Run: npm test'},{kind:'thinking',text:'Checking UAT cards'}]};
  assert.equal(liveLine(thinking),'Thinking: Checking UAT cards');
  assert.equal(chiefBubble(thinking),'Thinking: checking UAT cards…');
  assert.equal(liveLine({phase:'tool',text:'Run: npm test',steps:[{kind:'tool',text:'Run: npm test'}]}),'Run: npm test');
  assert.equal(chiefBubble({phase:'tool',steps:[{kind:'tool',text:'flow: cards list'}]}),'flow: cards list…');
  assert.equal(liveLine({phase:'writing',text:'There are'}),'Writing a reply…');
  assert.equal(liveLine({phase:'thinking',steps:[]}),'Thinking…');
  assert.equal(liveLine(null),'');
});

test('work summaries like T3: "Ran 2 commands and used 1 tool"',()=>{
  assert.equal(workSummary([{role:'tool',title:'Run: npm test'},{role:'tool',title:'Run: ls'},{role:'tool',title:'flow: cards list'}]),'Ran 2 commands and used 1 tool');
  assert.equal(workSummary([{role:'tool',title:'Edit: a.js'},{role:'reasoning',title:'x'},{role:'tool',title:'Run: x'},{role:'tool',title:'Read lib/a.mjs'}]),'Ran 1 command, edited 1 file and looked at 1 thing');
  assert.equal(workSummary([{role:'reasoning',title:'x'}]),'Thought for a moment');
});

test('chat blocks: messages on their own, the steps between them in one work block',()=>{
  const items=[{role:'user',text:'What is in UAT?'},{role:'reasoning',title:'Checking'},{role:'tool',title:'Run: flow cards list'},{role:'assistant',text:'18 cards.'},{role:'tool',title:'Run: x'}];
  const b=blocksOf(items);
  assert.deepEqual(b.map(x=>x.type),['user','work','assistant','work']);
  assert.equal(b[1].summary,'Ran 1 command');assert.equal(b[1].items.length,2);
});

test('pages merge by item id: older first, the newest page wins',()=>{
  const older=[{id:'1',text:'a'},{id:'2',text:'b'},{id:'3',text:'c'}],newer=[{id:'3',text:'c!'},{id:'4',text:'d'}];
  assert.deepEqual(mergeItems(older,newer).map(x=>x.id+x.text),['1a','2b','3c!','4d']);
  assert.deepEqual(mergeItems([],newer),newer);
  assert.equal(projectHue('Flow'),projectHue('Flow'));assert.ok(projectHue('Flow')<360);
});
