// public/demo-seed.js: the fictional starter chart and demo workspace pass the app's own validation
// and show every feature. store.js needs a browser, so it is loaded with small stand-ins.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {starterChart,demoWorkspace} from '../public/demo-seed.js';
import {isSeed} from '../public/sync-core.js';
import {cleanDevops,COLUMNS,ROLES,LINK_KINDS,gateFor,dueTone} from '../public/devops-core.js';

async function loadStore(){
  globalThis.localStorage??={getItem:()=>null,setItem(){}};globalThis.window??={addEventListener(){}};
  globalThis.fetch=()=>Promise.reject(Error('offline'));
  const pub=new URL('../public/',import.meta.url),dir=mkdtempSync(join(tmpdir(),'flow-store-'));
  const src=readFileSync(new URL('store.js',pub),'utf8')
    .replace("import {uid,clone} from './ui.js';","const uid=()=>crypto.randomUUID(),clone=x=>structuredClone(x);")
    .replace("from './devops-core.js'",`from ${JSON.stringify(new URL('devops-core.js',pub).href)}`)
    .replace("from './demo-seed.js'",`from ${JSON.stringify(new URL('demo-seed.js',pub).href)}`)
    .replace("from './workflow.js'",`from ${JSON.stringify(new URL('workflow.js',pub).href)}`)
    .replace("from './agentflow-core.js'",`from ${JSON.stringify(new URL('agentflow-core.js',pub).href)}`)
    .replace("from './sync-core.js'",`from ${JSON.stringify(new URL('sync-core.js',pub).href)}`);
  writeFileSync(join(dir,'store.mjs'),src);
  try{return await import(pathToFileURL(join(dir,'store.mjs')).href)}finally{rmSync(dir,{recursive:true,force:true})}
}
const store=await loadStore(),today='2026-11-02';

test('the starter chart is a drop-in for the old seed (what verify.mjs relies on)',()=>{
  const c=starterChart('s1');
  assert.ok(store.validChart(c));
  assert.equal(c.nodes.length,7);
  assert.equal(c.edges.filter(e=>e.percent==='50').length,3);
  assert.equal(c.nodes.find(n=>n.id==='flygon')?.type,'entity');
  assert.ok(c.nodes.some(n=>n.id==='campaign'));
  assert.ok(!c.edges.some(e=>e.from==='flygon'&&e.to==='campaign'),'verify.mjs draws this edge itself');
  assert.equal(c.nodes.find(n=>n.id==='flygon')?.name,'Kestrel Group');
});

test('the fictional starter remains an untouched sample for sync',()=>{
  const c=starterChart('s1'),db={charts:[c],projects:[],timeline:[],devops:{cards:[]}};
  assert.equal(isSeed(db),true);
  assert.equal(isSeed({...db,charts:[{...c,nodes:[...c.nodes,{id:'new',name:'My work',type:'note',x:0,y:0}]}]}),false);
});

test('the demo workspace passes validation unchanged',()=>{
  const w=demoWorkspace({today});
  assert.ok(store.validDb(w));
  for(const p of w.projects)assert.deepEqual(store.cleanProject(p),p);
  for(const i of w.timeline)assert.deepEqual(store.cleanItem(i,w.projects),i,i.title);
  const cleaned=cleanDevops(structuredClone(w.devops),w);
  assert.deepEqual(cleaned.cards.map(c=>[c.number,c.project,c.item,c.labels,c.assignees,c.due,c.points]),w.devops.cards.map(c=>[c.number,c.project,c.item,c.labels,c.assignees,c.due,c.points]));
  assert.deepEqual(cleaned.labels,w.devops.labels);
  assert.deepEqual(store.cleanEnvironment(w.environment),w.environment);
  assert.deepEqual(demoWorkspace({today}),w,'deterministic for a given day');
  assert.ok(w.charts.some(c=>c.nodes.some(n=>n.name==='Kestrel Group')));
});

test('the demo workspace shows every feature',()=>{
  const w=demoWorkspace({today}),nodes=w.charts.flatMap(c=>c.nodes),edges=w.charts.flatMap(c=>c.edges),cards=w.devops.cards;
  assert.ok(w.charts.length>=2);
  for(const t of ['entity','person','area','note'])assert.ok(nodes.some(n=>n.type===t),t);
  assert.ok(edges.some(e=>e.type==='group')&&edges.some(e=>e.type==='ownership'&&e.percent==='')&&edges.some(e=>e.type==='ownership'&&e.percent!==''));
  const area=nodes.find(n=>n.id==='rnd');
  assert.ok(nodes.some(n=>n.type!=='area'&&n.x>=area.x&&n.y>=area.y&&n.x+176<=area.x+area.w&&n.y+48<=area.y+area.h),'an area holds a card');
  assert.ok(w.projects.some(p=>p.entity)&&w.projects.some(p=>!p.entity));
  for(const k of store.ITEM_KINDS)assert.ok(w.timeline.some(i=>i.kind===k),k);
  for(const s of store.ITEM_STATUS)assert.ok(w.timeline.some(i=>i.status===s),s);
  for(const p of store.ITEM_PRIORITY)assert.ok(w.timeline.some(i=>i.priority===p),p);
  assert.ok(w.timeline.some(i=>i.start==='')&&w.timeline.some(i=>i.release&&w.timeline.some(r=>r.kind==='release'&&r.title===i.release)));
  for(const [col] of COLUMNS)assert.ok(cards.some(c=>c.column===col),col);
  for(const r of ROLES)assert.ok(cards.some(c=>c.assignees.some(a=>a.role===r)),r);
  for(const k of Object.keys(LINK_KINDS))assert.ok(cards.some(c=>c.links.some(l=>l.kind===k)),k);
  assert.ok(cards.some(c=>dueTone(c,today)==='overdue')&&cards.some(c=>dueTone(c,today)==='soon'));
  assert.ok(cards.some(c=>c.checklist.some(x=>x.done))&&cards.some(c=>c.item)&&cards.some(c=>c.points));
  // Each gate has a card to show it on.
  const by=id=>cards.find(c=>c.id===id);
  assert.equal(gateFor(by('c-copy'),'doing'),'pick-dev');
  assert.equal(gateFor(by('c-audit'),'requests'),'confirm-reopen');
  assert.equal(gateFor(by('c-form'),'done'),'confirm-done');
  // Assignees are person cards on a chart.
  for(const c of cards)for(const a of c.assignees)assert.equal(nodes.find(n=>n.id===a.node)?.type,'person',a.node);
});
