// Undo and redo against changes that arrive from the server (agents, other devices), and the rule
// that card numbers only grow. store.js is browser code, so it loads from a temp copy with its
// browser-only imports swapped out.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {keepCounters} from '../public/sync-core.js';

async function loadStore(){
  globalThis.localStorage??={getItem:()=>null,setItem(){}};globalThis.window??={addEventListener(){}};
  globalThis.fetch=async()=>({ok:true}); // the disk backup retries forever if this fails
  const pub=new URL('../public/',import.meta.url),dir=mkdtempSync(join(tmpdir(),'flow-undo-'));
  let src=readFileSync(new URL('store.js',pub),'utf8').replace("import {uid,clone} from './ui.js';","const uid=()=>crypto.randomUUID(),clone=x=>structuredClone(x);");
  for(const f of ['devops-core.js','demo-seed.js','workflow.js','agentflow-core.js','sync-core.js'])src=src.replace(`from './${f}'`,`from ${JSON.stringify(new URL(f,pub).href)}`);
  writeFileSync(join(dir,'store.mjs'),src);
  try{return await import(pathToFileURL(join(dir,'store.mjs')).href)}finally{rmSync(dir,{recursive:true,force:true})}
}
const S=await loadStore(),{store,adoptRemote,change,step,snapshot,commit}=S;
const clone=x=>structuredClone(x);
const card=(n,title=`Card ${n}`)=>({id:`k${n}`,number:n,title,column:'requests'});
function reset(cards=[card(1)]){
  const d=S.defaults?.()??clone(store.db);
  d.environment={...(d.environment||{}),id:'env-a'};
  d.devops={...d.devops,cards:clone(cards),nextNumber:cards.length+1};
  store.db=null;store.undo=[];store.redo=[];
  store.db=d;adoptRemote(d);store.undo=[];store.redo=[];
}
// What the server sends after someone else adds these cards.
function remoteAdds(...cards){
  const d=clone(store.db);d.devops.cards.push(...cards);
  d.devops.nextNumber=Math.max(...d.devops.cards.map(c=>c.number))+1;
  adoptRemote(d);
}
const numbers=()=>store.db.devops.cards.map(c=>c.number).sort((a,b)=>a-b);
const titled=n=>store.db.devops.cards.find(c=>c.number===n)?.title;

test('undo takes back my edit and keeps cards that arrived from the server meanwhile',()=>{
  reset();
  change(()=>{store.db.devops.cards[0].title='Mine'});
  remoteAdds(card(2),card(3));
  step(-1);
  assert.equal(titled(1),'Card 1','my edit is undone');
  assert.deepEqual(numbers(),[1,2,3],'the server\'s cards are still there');
  assert.ok(store.db.devops.nextNumber>=4,'and the next number does not fall back');
});

test('redo also keeps what arrived from the server',()=>{
  reset();
  change(()=>{store.db.devops.cards[0].title='Mine'});
  step(-1);
  remoteAdds(card(2));
  step(1);
  assert.equal(titled(1),'Mine');
  assert.deepEqual(numbers(),[1,2]);
});

test('a server edit to another field or card survives undo',()=>{
  reset([card(1),card(2)]);
  change(()=>{store.db.devops.cards[0].title='Mine'});
  const d=clone(store.db);d.devops.cards[1].title='Theirs';adoptRemote(d);
  step(-1);
  assert.equal(titled(1),'Card 1');
  assert.equal(titled(2),'Theirs');
});

test('when the server changed the same field, undo and redo keep the server\'s value',()=>{
  reset();
  change(()=>{store.db.devops.cards[0].title='Mine'});
  const d=clone(store.db);d.devops.cards[0].title='Theirs';adoptRemote(d);
  step(-1);assert.equal(titled(1),'Theirs','undo');
  step(1);assert.equal(titled(1),'Theirs','redo');
  reset();
  change(()=>{store.db.devops.cards[0].title='Mine'});
  step(-1);
  const e=clone(store.db);e.devops.cards[0].title='Theirs';adoptRemote(e);
  step(1);assert.equal(titled(1),'Theirs','redo after undo');
});

test('a card the server deleted stays deleted through undo',()=>{
  reset([card(1),card(2)]);
  change(()=>{store.db.devops.cards[0].title='Mine'});
  const d=clone(store.db);d.devops.cards=d.devops.cards.filter(c=>c.number!==2);adoptRemote(d);
  step(-1);
  assert.deepEqual(numbers(),[1]);
  assert.equal(titled(1),'Card 1');
});

test('undoing several steps walks back only my own changes',()=>{
  reset();
  change(()=>{store.db.devops.cards[0].title='One'});
  change(()=>{store.db.devops.cards[0].title='Two'});
  remoteAdds(card(2));
  step(-1);assert.equal(titled(1),'One');
  step(-1);assert.equal(titled(1),'Card 1');
  assert.deepEqual(numbers(),[1,2]);
});

test('undoing a card I created does not free its number',()=>{
  reset();
  change(()=>{store.db.devops.cards.push(card(2));store.db.devops.nextNumber=3});
  step(-1);
  assert.deepEqual(numbers(),[1]);
  assert.equal(store.db.devops.nextNumber,3);
});

test('editing after undo does not leak into the undo stack',()=>{
  reset();
  change(()=>{store.db.devops.cards[0].title='One'});
  remoteAdds(card(2));
  change(()=>{store.db.devops.cards[0].title='Two'});
  remoteAdds(card(3));
  step(-1);assert.equal(titled(1),'One');
  store.db.devops.cards.find(c=>c.number===2).title='Edited in place';
  step(-1);assert.equal(titled(1),'Card 1');
  assert.equal(titled(2),'Card 2','the older snapshot was not changed by that in-place edit');
  assert.deepEqual(numbers(),[1,2,3]);
});

test('switching environment drops undo history, so undo cannot write one environment into another',()=>{
  reset();
  change(()=>{store.db.devops.cards[0].title='Mine'});
  const other=clone(store.db);other.environment.id='env-b';other.devops.cards=[card(9)];
  adoptRemote(other);
  assert.equal(store.undo.length,0);
  assert.equal(store.redo.length,0);
});

test('a drag that spans a server update cannot erase what arrived',()=>{
  reset();
  const before=snapshot();
  remoteAdds(card(2));
  store.db.devops.cards[0].title='Dragged';commit(before);
  assert.equal(store.undo.length,0,'that undo step is skipped');
  step(-1);
  assert.deepEqual(numbers(),[1,2]);
  assert.equal(titled(1),'Dragged','the drag itself stands');
});

test('a drag that spans a server update still clears redo, so redo cannot undo the drag',()=>{
  reset();
  change(()=>{store.db.devops.cards[0].title='Mine'});
  step(-1);
  const before=snapshot();
  remoteAdds(card(2));
  store.db.devops.cards[0].title='Dragged';commit(before);
  assert.equal(store.redo.length,0);
  step(1);
  assert.equal(titled(1),'Dragged');
});

test('a drag with no server update in between is undoable as usual',()=>{
  reset();
  const before=snapshot();
  store.db.devops.cards[0].title='Dragged';commit(before);
  step(-1);
  assert.equal(titled(1),'Card 1');
});

test('undo lands on a chart that still exists when its chart was deleted elsewhere',()=>{
  reset();
  const b={id:'chart-b',name:'B',nodes:[{id:'b1',name:'B1',type:'entity',x:0,y:0}],edges:[]};
  const two=clone(store.db);two.charts.push(b);two.active='chart-b';adoptRemote(two);
  const keep=store.db.charts.find(c=>c.id!=='chart-b').id;
  change(()=>{store.db.devops.cards[0].title='Mine'});
  store.db.active=keep;
  const gone=clone(store.db);gone.charts=gone.charts.filter(c=>c.id!=='chart-b');adoptRemote(gone);
  step(-1);
  assert.equal(store.db.active,keep);
  assert.ok(store.db.charts.some(c=>c.id===store.db.active));
});

test('keepCounters: a save can never lower the next card number',()=>{
  const stored={devops:{nextNumber:50,cards:[]}};
  const low={devops:{nextNumber:40,cards:[]}},high={devops:{nextNumber:60,cards:[]}};
  assert.equal(keepCounters(stored,low).devops.nextNumber,50);
  assert.equal(low.devops.nextNumber,40,'the input is left alone');
  assert.equal(keepCounters(stored,high),high);
  assert.equal(keepCounters(null,low),low);
  const noDevops={charts:[]};assert.equal(keepCounters(stored,noDevops),noDevops);
});
