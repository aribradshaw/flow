// The inbox patch format (public/inbox-core.js): applying the same patch twice changes nothing (card #674).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyPatch} from '../public/inbox-core.js';

const db=()=>({charts:[{id:'c',name:'C',nodes:[],edges:[]}],active:'c',projects:[],timeline:[],devops:{cards:[],labels:[],nextNumber:1}});
const patch=ops=>({version:1,source:'test',createdAt:'2026-11-23T00:00:00Z',ops});

test('upsertItem with projects[] finds the item it made the first time',()=>{
  const d=db(),p=patch([{op:'upsertItem',title:'Launch',projects:['Lantern','Quill'],start:'2026-12-01'}]);
  assert.equal(applyPatch(d,p).counts.items.added,1);
  const again=applyPatch(d,p);
  assert.equal(d.timeline.length,1,'no duplicate');assert.equal(again.counts.items?.added||0,0);
  // project and projects together, and project alone, still match as before.
  applyPatch(d,patch([{op:'upsertItem',title:'Beta',project:'Lantern'}]));applyPatch(d,patch([{op:'upsertItem',title:'Beta',project:'Lantern'}]));
  assert.equal(d.timeline.filter(i=>i.title==='Beta').length,1);
  // The same title in another project is another item.
  applyPatch(d,patch([{op:'upsertItem',title:'Launch',projects:['Ember']}]));
  assert.equal(d.timeline.filter(i=>i.title==='Launch').length,2);
});
