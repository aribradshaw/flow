// Doors between offices (public/office-portals.js): where they stand and which one you walk into.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {doorSpots,doorAt,MAX_DOORS} from '../public/office-portals.js';

const room=a=>({center:{x:Math.cos(a)*20,z:Math.sin(a)*20}});
test('doors stand on the ring of rooms, in the gaps between them, facing the middle',()=>{
  const rooms=[room(-Math.PI/2),room(Math.PI/2)],spots=doorSpots([{env:'a',label:"Avery's office"},{env:'b',label:'Your office',own:true}],{rooms,ringRadius:20});
  assert.equal(spots.length,2);
  for(const s of spots){
    assert.ok(Math.abs(Math.hypot(s.x,s.z)-20)<1e-9,'on the ring');
    for(const r of rooms)assert.ok(Math.hypot(s.x-r.center.x,s.z-r.center.z)>10,'clear of the rooms');
    assert.ok(Math.abs(Math.atan2(-s.x,-s.z)-s.facing)<1e-9,'facing the middle');
  }
  assert.deepEqual(spots.map(s=>s.portal.env).sort(),['a','b']);
});
test('no doors without portals; at most MAX_DOORS; bad entries are left out',()=>{
  assert.deepEqual(doorSpots([],{rooms:[room(0)]}),[]);
  assert.equal(doorSpots(Array.from({length:20},(_,i)=>({env:'e'+i})),{rooms:[room(0)]}).length,MAX_DOORS);
  assert.equal(doorSpots([{env:''},null,{label:'x'},{env:'ok'}],{}).length,1);
});
test('doorAt finds the door within reach, the nearest first',()=>{
  const spots=[{portal:{env:'a'},x:0,z:0},{portal:{env:'b'},x:0.5,z:0}];
  assert.equal(doorAt(spots,0.4,0).portal.env,'b');
  assert.equal(doorAt(spots,5,5),null);
});
