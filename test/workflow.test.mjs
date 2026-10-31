import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanWorkflow,WORKFLOW_PRESETS} from '../public/workflow.js';
import {normalize} from '../lib/cleaners.mjs';
import {cleanDevops} from '../public/devops-core.js';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('old workspaces receive delivery labels; custom labels survive normalization',()=>{
  const db={projects:[],timeline:[{id:'i1',title:'Plan',kind:'feature',status:'active',start:''}],devops:{cards:[]}};
  normalize(db);
  assert.equal(db.workflow.statuses.active,'In progress');
  assert.equal(db.timeline[0].status,'active');
  db.workflow=cleanWorkflow({preset:'planning',statuses:{active:'Research',done:'Shipped'}});
  normalize(db);
  assert.equal(db.workflow.statuses.active,'Research');
  assert.equal(db.workflow.statuses.done,'Shipped');
  assert.equal(db.timeline[0].status,'active');
  assert.deepEqual(db.devops.columns.map(c=>c.id),Object.keys(WORKFLOW_PRESETS.delivery.columns));
});

test('editable status labels are escaped in timeline button attributes',()=>{
  const source=readFileSync(new URL('../public/timeline.js',import.meta.url),'utf8');
  const definition=source.match(/^const segBtn=.*$/m)?.[0];
  assert.ok(definition);
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const button=runInNewContext(`${definition}\nsegBtn`,{esc,icon:()=>''});
  const html=button('status','active',{label:'x"<img src=x onerror=alert(1)>&',icon:'active'},false);
  assert.ok(html.includes('data-tip="x&quot;&lt;img'));
  assert.ok(html.includes('aria-label="x&quot;&lt;img'));
  assert.ok(!html.includes('<img'));
});

test('a custom column name matching an old default is retained',()=>{
  const d=cleanDevops({columns:[{id:'requests',name:'Sprinted'}],namesCustomized:true,cards:[]});
  assert.equal(d.columns[0].name,'Sprinted');
  assert.equal(cleanDevops(d).columns[0].name,'Sprinted');
});
