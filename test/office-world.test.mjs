// The 3D office's worlds (public/office-world-core.js): where rooms go for any number of members, that
// rails and bulkheads keep walkers on deck, that every part of the yacht can be walked to, and that
// someone in the water comes back on deck. Pure layout math: no browser, no Three.js.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classicWorld,yachtWorld,buildWorld,stepIn,pushOut,wallBox,wallsFrom,worldId,WORLDS,DEFAULT_WORLD,YACHT,ROOM_W,ROOM_D,BODY} from '../public/office-world-core.js';
import {cameraClearance,officeBox,createOfficeCharacter} from '../public/office-controls.js';
import {classicLayout,BACK_WALL_H,WALL_H} from '../public/office-layout.js';
import {orgTeams} from '../public/office-tables-core.js';
import {NAV_CELL,NAV_CLIMB} from '../public/office-nav.js';
import {cleanAgentflow} from '../public/agentflow-core.js';

const near=(a,b,eps=1e-9)=>Math.abs(a-b)<=eps;
// A room's own point in the world: lx along its width, lz towards its door (as office.js places rooms).
const inRoom=(r,lx,lz)=>({x:r.x+lx*Math.cos(r.facing)+lz*Math.sin(r.facing),z:r.z-lx*Math.sin(r.facing)+lz*Math.cos(r.facing)});
// The low walls office.js builds round a room: back, two sides, and the front either side of a 3-wide door.
function roomWalls(r){
  const w=(lx,lz,width,depth,h=WALL_H)=>{const p=inRoom(r,lx,lz);return officeBox(p.x,p.z,r.facing,width,depth,h+r.y)},side=(ROOM_W-3)/2;
  return [w(0,-ROOM_D/2,ROOM_W,0.2,BACK_WALL_H),w(-ROOM_W/2,0,0.2,ROOM_D),w(ROOM_W/2,0,0.2,ROOM_D),w(-(1.5+side/2),ROOM_D/2,side,0.2),w(1.5+side/2,ROOM_D/2,side,0.2)];
}
// Everywhere a walker can get to from `start`, on a grid, moving the way office.js moves people.
function reach(world,start,walls,cell=0.5){
  const key=p=>Math.round(p.x/cell)+','+Math.round(p.z/cell),seen=new Map([[key(start),start]]),todo=[start],wet=[];
  const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  while(todo.length){
    const p=todo.pop();
    for(const [dx,dz] of dirs){
      const q=world.step(p,{x:p.x+dx*cell,z:p.z+dz*cell},walls),k=key(q);
      if(seen.has(k))continue;
      if(world.ground(q.x,q.z)===null){wet.push(q);continue}
      seen.set(k,q);todo.push(q);
      assert.ok(seen.size<400000,'the walkable area is bounded');
    }
  }
  return {seen,wet,has:(p,slack=1.2)=>[...seen.values()].some(q=>Math.hypot(q.x-p.x,q.z-p.z)<=slack)};
}

test('worlds: ids are checked, and the office stays the default',()=>{
  assert.deepEqual(WORLDS.map(w=>w.id),['classic','yacht']);
  assert.equal(DEFAULT_WORLD,'classic');
  for(const v of [undefined,null,'','nope',7,{}])assert.equal(worldId(v),'classic');
  assert.equal(worldId('yacht'),'yacht');
  assert.equal(buildWorld('yacht',3).id,'yacht');assert.equal(buildWorld('whatever',3).id,'classic');
});

test('classic: the floor plan office-layout.js lays out, on one flat floor inside its outer walls',()=>{
  for(const keys of [[],['a'],['a','b','c'],Array.from({length:12},(_,i)=>'k'+i)]){
    const w=classicWorld(keys),l=classicLayout(keys);
    assert.deepEqual(w.rooms.map(({y,...r})=>r),l.rooms);assert.ok(w.rooms.every(r=>r.y===0));
    assert.deepEqual(w.mainWall,l.mainWall);assert.deepEqual(w.boardAnchors(),l.boardAnchors());assert.equal(w.radius,l.radius);
    assert.equal(w.terrain,undefined,'the flat office needs no terrain');
    // Its walls are the plan's, as boxes office-controls.js reads, each with how high it stops the camera.
    assert.equal(w.walls.length,l.walls.length);
    w.walls.forEach((b,i)=>{const p=l.walls[i];assert.ok(near(b.x,p.x)&&near(b.z,p.z)&&near(b.halfX,p.w/2)&&near(b.halfZ,p.d/2)&&near(b.height,p.h));assert.equal(b.cam,p.cam);assert.equal(b.kind,p.kind)});
    assert.equal(typeof w.doors,'function');assert.equal(typeof w.places,'function');assert.equal(typeof w.plan,'function');
  }
  assert.equal(classicWorld(3).rooms.length,3,'a count works too');
  const w=classicWorld(4),b=w.bounds;
  assert.equal(w.ground(0,0),0);assert.equal(w.ground(b.minX+0.5,b.minZ+0.5),0);assert.equal(w.ground(b.maxX+1,0),null);assert.equal(w.ground(0,b.minZ-1),null);assert.equal(w.ground(500,0),null);assert.equal(w.sea,-Infinity);
  assert.equal(w.ground(w.spawn.x,w.spawn.z),0);assert.deepEqual(w.respawn({x:900,z:900}),w.spawn);
  // The scenery is rebuilt only when its signature changes: the same members and org give the same one.
  const org=[{id:'a',name:'A'},{id:'b',name:'B',reportsTo:'a'}];
  assert.equal(classicWorld(4,{org}).sig,classicWorld(4,{org}).sig);assert.notEqual(classicWorld(4,{org}).sig,w.sig);assert.notEqual(classicWorld(7).sig,w.sig);
  // A walker cannot leave the floor, and the camera's walls leave out glass and the outer walls.
  const out=w.step({x:0,z:0},{x:0,z:b.minZ-30});assert.ok(out.z>b.minZ-0.5&&w.ground(out.x,out.z)===0);
  const side=w.step({x:0,z:0},{x:b.maxX+30,z:0});assert.ok(side.x<b.maxX&&w.ground(side.x,side.z)===0);
  const cam=wallsFrom(w.walls,0);assert.ok(cam.length&&cam.every(c=>c.height>0.12));assert.ok(cam.length<w.walls.length);
});

test('yacht: one hull however big the org is; a suite for every member in a single file, the owner on the bridge',()=>{
  // About 70 by 14 for one or two members, whatever the AgentFlow org's size (commonR is the classic office's measure).
  for(const opts of [{},{commonR:9},{commonR:60}])for(const n of [1,2]){
    const w=yachtWorld(n,opts),len=w.bounds.maxZ-w.bounds.minZ,beam=w.bounds.maxX-w.bounds.minX;
    assert.equal(beam,14);assert.ok(len>=60&&len<=80,`length ${len}`);assert.equal(w.plan.HB,YACHT.HB);
  }
  assert.deepEqual(yachtWorld(2,{commonR:60}).bounds,yachtWorld(2).bounds,'a big org changes nothing');
  for(const n of [1,2,3,4,7,12]){
    const w=yachtWorld(n),P=w.plan;
    assert.equal(w.rooms.length,n,`${n} members`);
    assert.equal(w.rooms[0].kind,'bridge');assert.ok(w.rooms.slice(1).every(r=>r.kind==='cabin'));
    assert.ok(w.rooms.slice(1).every(r=>r.z>w.rooms[0].z),'the bridge is the room furthest forward');
    assert.equal(w.rooms.length+w.spare.length,P.slots,'every place is a room or a sun terrace');
    for(const r of [...w.rooms,...w.spare]){
      // the whole footprint, and the corridor outside its door, is one flat deck
      for(const lx of [-ROOM_W/2,-3,0,3,ROOM_W/2])for(const lz of [-ROOM_D/2,0,ROOM_D/2,ROOM_D/2+1.2]){const p=inRoom(r,lx,lz);assert.equal(w.ground(p.x,p.z),YACHT.UPPER,`room at ${r.x},${r.z} corner ${lx},${lz}`)}
      for(const lx of [-1.5,0,1.5]){const p=inRoom(r,lx,ROOM_D/2+2.6);assert.equal(w.ground(p.x,p.z),YACHT.UPPER,'the corridor is wide and flat outside the door')}
      assert.equal(r.y,YACHT.UPPER);assert.equal(r.x,w.rooms[0].x,'in one file');assert.equal(r.facing,Math.PI/2,'every door on the starboard corridor');
    }
    const all=[...w.rooms,...w.spare];
    for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.ok(Math.abs(all[i].z-all[j].z)>=ROOM_W,`rooms ${i} and ${j} do not overlap`);
    assert.equal(w.bounds.maxX-w.bounds.minX,14,'more members make it longer, never wider');
  }
  assert.equal(yachtWorld(1).spare.length,1,'a solo owner has a sun terrace by the stair');assert.equal(yachtWorld(2).spare.length,0);
  assert.ok(near(yachtWorld(3).bounds.minZ,yachtWorld(2).bounds.minZ-ROOM_W-0.8),'a third member adds one suite\'s length');
});

test('yacht: two decks, terraced, with one height at each point and stairs between them',()=>{
  const w=yachtWorld(2),P=w.plan,{MAIN,SWIM,UPPER,FORE,SEA}=YACHT,sx=P.stairX+1;
  assert.equal(w.ground(0,0),MAIN);assert.equal(w.ground(0,P.zL1-1),MAIN);assert.equal(w.ground(-6,P.zL0+1),MAIN,'the lounge is one flat deck, rail to rail');
  assert.equal(w.ground(0,P.zL1+4),SWIM);assert.equal(w.ground(0,P.zL0-3),UPPER);assert.equal(w.ground(sx,P.zL0-P.upRamp-2),UPPER);
  assert.equal(w.ground(0,P.zB0-5),FORE);assert.equal(w.ground(0,w.rooms[0].z),UPPER);
  // stairs are ramps a walker and a path can climb: no step taller than a stair, none steeper than office-nav.js climbs
  const ramps=[[sx,P.zL0,P.zL0-P.upRamp,MAIN,UPPER],[sx,P.zB0,P.zB0-P.foreRamp,UPPER,FORE],[sx,P.zL1,P.zL1+P.swimRamp,MAIN,SWIM],[-sx,P.zL1,P.zL1+P.swimRamp,MAIN,SWIM]];
  for(const [x,z0,z1,y0,y1] of ramps){
    let last=y0;
    for(let i=0;i<=20;i++){const y=w.ground(x,z0+(z1-z0)*i/20);assert.ok(y!==null);assert.ok(Math.abs(y-last)<0.25,`a ramp at x=${x} has no step taller than a stair`);last=y}
    assert.ok(near(last,y1,1e-9));assert.ok(Math.abs(y1-y0)/Math.abs(z1-z0)*NAV_CELL<=NAV_CLIMB,'and paths can take it');
  }
  assert.equal(w.ground(-sx,P.zL0-2),UPPER,'one stair up, to starboard');
  // off the sides, ahead of the stem and astern there is only water
  for(const [x,z] of [[P.HB+0.1,0],[-P.HB-3,P.zB0+5],[0,P.zBow-1],[0,P.zSw+0.5],[5,P.zBow+2],[NaN,0]])assert.equal(w.ground(x,z),null,`${x},${z}`);
  assert.ok(w.halfBeam(P.zBow+2)<w.halfBeam(P.zB0-5)&&w.halfBeam(P.zB0-5)<P.HB,'the bow tapers');
  assert.equal(w.halfBeam(0),P.HB);
  assert.ok(SEA<SWIM&&SWIM<MAIN&&MAIN<FORE&&FORE<UPPER);
});

test('yacht: rails and bulkheads enclose the decks, and every deck, room and stair can be walked to',()=>{
  for(const n of [1,2,4]){
    const w=yachtWorld(n),P=w.plan,walls=[...w.rooms.flatMap(roomWalls),...w.walls];
    const r=reach(w,w.spawn,walls);
    // The only way into the water is off the aft end of the swim platform.
    assert.ok(r.wet.length>0,'the swim platform is open astern');
    for(const p of r.wet)assert.ok(w.open(p.x,p.z)&&p.z>P.zL1+P.swimRamp,`left the deck at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
    for(const p of r.seen.values())assert.ok(w.ground(p.x,p.z)!==null);
    const m=w.meetingAnchors()[0];
    const must={lounge:w.lounge[0],'the main board':{x:w.mainWall.x,z:w.mainWall.z+2},'the meeting room\'s door':{x:m.x,z:m.z-m.d/2-1},'swim platform':{x:0,z:P.zL1+4},'the top of the stair':{x:P.stairX+1,z:P.zL0-P.upRamp-1},
      'the corridor\'s end':{x:P.stairX+1,z:P.zB0+1.5},'sun deck':{x:-3,z:P.zB0-4},'the breakwater':{x:0,z:P.zBreak+1.2}};
    assert.ok(!r.has({x:0,z:P.zBreak-1.5},1),'the bow\'s tip is not walked on');
    for(const [name,p] of Object.entries(must))assert.ok(r.has(p),`${name} is reachable with ${n} members`);
    for(const p of w.places())assert.ok(r.has(p),`${p.name} is a place you can stand`);
    for(const p of w.lounge)assert.ok(r.has(p,0.6),'idle characters gather where they can stand');
    for(const room of w.rooms){
      assert.ok(r.has(inRoom(room,0,ROOM_D/2+1.2)),'outside a room\'s door');
      assert.ok(r.has(inRoom(room,0,0)),'inside a room');
      assert.ok(!r.has(inRoom(room,0,-ROOM_D/2-0.6),0.2),'nobody stands behind the back wall');
    }
    // nobody ends up inside a wall: every reached point is clear of every box
    for(const p of r.seen.values())for(const b of walls){const q={x:p.x,z:p.z};assert.ok(!pushOut(q,b,BODY-0.02),`standing in a ${b.kind||'room wall'} at ${p.x.toFixed(2)},${p.z.toFixed(2)}`)}
  }
});

test('yacht: a walker slides along a rail instead of stopping dead, and cannot be pushed through one',()=>{
  const w=yachtWorld(2),P=w.plan,edge=P.HB-YACHT.EDGE;
  // straight at the port bulwark from the lounge's aft end
  let p={x:-2,z:6};
  for(let i=0;i<200;i++)p=w.step(p,{x:p.x-0.26,z:p.z});
  assert.ok(p.x>-edge&&p.x<-(edge-BODY-0.3),'stopped at the rail');assert.equal(w.ground(p.x,p.z),YACHT.MAIN);
  // diagonally into it: keeps moving along it
  const z0=p.z;for(let i=0;i<10;i++)p=w.step(p,{x:p.x-0.2,z:p.z-0.2});
  assert.ok(p.z<z0-1.5,'slid forward along the rail');assert.ok(p.x>-edge);
  // one huge step (a frame hitch) does not tunnel through
  const far=w.step({x:0,z:6},{x:-60,z:6});assert.ok(far.x>-edge&&w.ground(far.x,far.z)!==null);
  const over=w.step({x:0,z:P.zL0-1.2},{x:0,z:P.zL0+30},w.walls);assert.equal(w.ground(over.x,over.z),YACHT.UPPER,'the upper deck\'s rail holds over the lounge');
  // random walks from all over the yacht never leave it except off the swim platform
  let seed=42;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  const starts=[w.spawn,{x:P.stairX+1,z:P.zL0-P.upRamp-2},{x:-3,z:P.zB0-4},{x:0,z:w.rooms[0].z},{x:0,z:P.zL1+2},{x:0,z:-7}];
  for(let k=0;k<400;k++){
    let q={...starts[k%starts.length]};
    for(let i=0;i<60;i++){const a=rnd()*Math.PI*2,d=0.1+rnd()*0.9;q=w.step(q,{x:q.x+Math.cos(a)*d,z:q.z+Math.sin(a)*d});
      if(w.ground(q.x,q.z)===null){assert.ok(w.open(q.x,q.z),`walked off at ${q.x.toFixed(2)},${q.z.toFixed(2)}`);break}}
  }
});

test('yacht: off the swim platform means in the water, and the water gives you back to the deck',()=>{
  const w=yachtWorld(3),P=w.plan;
  let p={x:0,z:P.zSw-2},wet=false;
  for(let i=0;i<40&&!wet;i++){p=w.step(p,{x:p.x,z:p.z+0.26});wet=w.ground(p.x,p.z)===null}
  assert.ok(wet,'walked off the aft end');assert.ok(w.open(p.x,p.z));
  const back=w.respawn(p);
  assert.equal(w.ground(back.x,back.z),YACHT.SWIM,'back on the swim platform');assert.equal(back.y,YACHT.SWIM);assert.ok(Number.isFinite(back.heading));
  // wherever someone turns up off the deck (a stale position after the yacht was rebuilt), they come back on a deck
  for(const q of [{x:0,z:P.zBow-40},{x:200,z:0},{x:-30,z:P.zB0+8},{x:0,z:P.zSw+90},{x:5,z:-9999}]){
    assert.equal(w.ground(q.x,q.z),null);
    const r=w.respawn(q);assert.equal(w.ground(r.x,r.z),r.y,'respawn points stand on their deck');
  }
  assert.notDeepEqual(w.respawn({x:0,z:P.zBow-40}),w.respawn({x:0,z:P.zSw+90}),'the nearest deck, not always the same one');
  assert.equal(w.ground(w.spawn.x,w.spawn.z),w.spawn.y);assert.equal(w.ground(w.entrance.x,w.entrance.z),YACHT.MAIN);
  assert.equal(w.arriveAtSpawn,true,'people arrive in the lounge');assert.ok(w.view.zoom>6.4&&w.view.pitch>0.4,'and see it from a little further out and higher');
  for(const s of w.signs)assert.ok(typeof s.text==='string'&&s.z>=w.bounds.minZ&&s.z<=w.bounds.maxZ);
  assert.deepEqual(['Lounge','Main board','Suites','Bridge'].filter(t=>!w.signs.some(s=>s.text.startsWith(t))),[],'the places you look for are signed');
});

test('walls for the camera are measured from the floor you stand on, and match what the camera rig reads',()=>{
  const w=yachtWorld(2),P=w.plan,{MAIN,UPPER,RAIL}=YACHT;
  const bulkhead=w.walls.find(b=>b.kind==='bulkhead');
  assert.ok(near(bulkhead.height,UPPER+RAIL));assert.equal(bulkhead.y,MAIN);
  const fromLounge=wallsFrom(w.walls,MAIN),fromUpper=wallsFrom(w.walls,UPPER+RAIL);
  assert.ok(fromLounge.length>fromUpper.length,'from above the rails nothing is in the way');
  assert.ok(fromLounge.every(b=>b.height>0.12&&b.kind===undefined));
  assert.ok(near(fromLounge.find(b=>b.z===bulkhead.z&&b.halfX===bulkhead.halfX).height,UPPER+RAIL-MAIN));
  // a camera boom from the lounge towards the bow is cut short by the bulkhead
  const cut=cameraClearance({x:0,y:1.1,z:P.zL0+2},{x:0,y:2.5,z:P.zL0-5},fromLounge);assert.ok(cut>0.1&&cut<0.5);
  // What hides you is cut away on the yacht, so its camera only keeps out of the solid masses: from the lounge, the
  // upper deck's block; from the upper deck, nothing.
  const masses=wallsFrom(w.masses,MAIN),from={x:0,y:1.1,z:P.zL0+2};
  const lowBoom=cameraClearance(from,{x:0,y:2.2,z:P.zL0-5},masses,0.18,true);assert.ok(lowBoom>0.1&&lowBoom<0.5,'a boom that ends inside the block stops where it went in');
  assert.equal(cameraClearance(from,{x:0,y:4.5,z:P.zL0-5},masses,0.18,true),1,'a boom that ends over the upper deck is free: what it passes through is cut away');
  assert.ok(cameraClearance(from,{x:0,y:4.5,z:P.zL0-5},masses)<0.5,'without cut-away the same boom stops at the wall');
  assert.equal(wallsFrom(w.masses,UPPER).length,0);
  // a box is office-controls.js's own, with its top measured from zero
  const b=wallBox(3,4,Math.PI/2,6,0.2,1.1,2,'rail'),o=officeBox(3,4,Math.PI/2,6,0.2,3.1);
  for(const k of Object.keys(o))assert.ok(near(b[k],o[k]),k);
  assert.equal(b.y,2);assert.equal(b.kind,'rail');
  // pushOut moves a body out by the nearest face, in the box's own frame
  const q={x:3.05,z:4};assert.ok(pushOut(q,b));assert.ok(near(q.x,3+0.1+BODY)&&near(q.z,4));
  assert.ok(!pushOut({x:9,z:4},b));
});

test('yacht: the character controller walks the decks and stairs, falls from where there is no deck, and can jump a rail',()=>{
  const w=yachtWorld(['o','a']),P=w.plan,{MAIN,UPPER,FORE,SWIM,SEA}=YACHT,walls=[...w.rooms.flatMap(roomWalls),...w.walls];
  const c=createOfficeCharacter(),still={x:0,z:0,sprint:false,jumpHeld:false},sx=P.stairX+1.1;
  // walk towards each point in turn; returns the state when done
  function walk(points,{sprint=false}={}){
    for(const [tx,tz] of points){
      for(let i=0;i<60*40;i++){
        const s=c.state,dx=tx-s.x,dz=tz-s.z,d=Math.hypot(dx,dz);if(d<0.25)break;
        c.advance(1/60,{x:dx/d,z:dz/d,sprint,jumpHeld:false},walls,w.terrain);
        assert.ok(i<60*40-1,`reached ${tx},${tz} (stuck at ${s.x.toFixed(1)},${s.z.toFixed(1)})`);
      }
    }
    for(let i=0;i<30;i++)c.advance(1/60,still,walls,w.terrain);
    return c.state;
  }
  c.reset(w.spawn,w.spawn.heading);
  assert.ok(near(walk([[0,-6]]).y,MAIN,1e-6),'down the centre aisle to the main board');
  // up the stair to the suites: always on the ground, never a jump or a fall
  walk([[sx,P.zL0+2]]);
  let air=0;for(let i=0;i<60*6&&c.state.z>P.zL0-P.upRamp-1;i++){c.advance(1/60,{x:0,z:-1,sprint:false,jumpHeld:false},walls,w.terrain);if(!c.state.grounded)air++}
  assert.ok(near(c.state.y,UPPER,1e-6),'at the top of the stair');assert.equal(air,0,'feet stay on the stair going up');
  // and back down it the same way
  for(let i=0;i<60*6&&c.state.z<P.zL0+1;i++){c.advance(1/60,{x:0,z:1,sprint:true,jumpHeld:false},walls,w.terrain);if(!c.state.grounded)air++}
  assert.ok(near(c.state.y,MAIN,1e-6));assert.equal(air,0,'and going down, even sprinting');
  // up again, along the corridor past both doors, down the few steps to the sun deck and back
  walk([[sx,P.zL0-P.upRamp-1],[sx,P.zB0+1]]);assert.ok(near(c.state.y,UPPER,1e-6));
  assert.ok(near(walk([[sx,P.zB0-P.foreRamp-1],[-3,P.zB0-4]]).y,FORE,1e-6),'on the sun deck');
  assert.ok(near(walk([[sx,P.zB0-P.foreRamp-1],[sx,P.zB0+1.5]]).y,UPPER,1e-6),'and back up');
  // into the owner's room through its door
  const bridge=w.rooms[0],door=inRoom(bridge,0,ROOM_D/2+1.2),inside=inRoom(bridge,0,0);
  assert.ok(near(walk([[door.x,door.z],[inside.x,inside.z]]).y,UPPER,1e-6));
  // walking into the rail over the lounge stops there; holding jump clears it and lands on the deck below
  c.reset({x:0,y:UPPER,z:P.zL0-0.9},0);
  for(let i=0;i<120;i++)c.advance(1/60,{x:0,z:1,sprint:false,jumpHeld:false},w.walls,w.terrain);
  assert.ok(c.state.z<P.zL0&&near(c.state.y,UPPER,1e-6),'the rail holds');
  c.reset({x:sx,y:UPPER,z:P.zL0-P.upRamp-3},0);
  walk([[sx,P.zL0+3],[sx,P.zL1-1]]);assert.ok(near(c.state.y,MAIN,1e-6),'down the stair and aft past the meeting room');
  // down to the swim platform, and off its open end: past the waterline, to be fished out by respawn
  assert.ok(near(walk([[sx,P.zL1+P.swimRamp+0.4],[0,P.zL1+2.6],[0,P.zL1+4]]).y,SWIM,1e-6),'on the swim platform');
  for(let i=0;i<240&&c.state.y>SEA-1.1;i++)c.advance(1/60,{x:0,z:1,sprint:false,jumpHeld:false},walls,w.terrain);
  assert.ok(c.state.y<SEA-1.1,'fell in');
  const back=w.respawn(c.state);assert.equal(back.y,SWIM);
  assert.ok(w.terrain.limit>-P.zBow,'the controller lets you reach the bow');
});

test('yacht: boards hang inside each room and on the lounge wall; the meeting room and doors stand on deck',()=>{
  const w=yachtWorld(['o','a','b']),P=w.plan,a=w.boardAnchors();
  assert.deepEqual(a.rooms.map(r=>r.key),['o','a','b']);
  for(const [i,m] of a.rooms.entries()){
    const r=w.rooms[i],back=inRoom(r,0,-ROOM_D/2),front=inRoom(r,0,ROOM_D/2);
    assert.ok(Math.hypot(m.x-back.x,m.z-back.z)<0.3,'on the back wall');
    assert.ok(near(m.nx*(front.x-back.x)+m.nz*(front.z-back.z),ROOM_D,1e-6),'facing into the room');
    assert.ok(m.y>r.y+1&&m.y+m.height/2<=r.y+BACK_WALL_H+0.05,'within the wall\'s height, on its deck');
  }
  assert.equal(w.mainWall.y,YACHT.MAIN);assert.equal(w.ground(w.mainWall.x,w.mainWall.z+1),YACHT.MAIN);
  assert.ok(a.main.nz===1&&a.main.z>w.mainWall.z&&a.main.z<P.zone.front-2,'the main board faces the tables from its forward wall');
  assert.ok(a.main.y+a.main.height/2<w.mainWall.height&&a.main.width<w.mainWall.width);
  assert.ok(w.mainWall.x+w.mainWall.width/2<P.stairX&&w.mainWall.planters===false,'its wall stays clear of the stair');
  // the meeting room: on the main deck, aft of the tables, a way past it on both sides
  const [m]=w.meetingAnchors();
  assert.equal(m.glass,true);assert.equal(m.y,YACHT.MAIN);assert.ok(m.z-m.d/2>P.zone.back+1&&m.z+m.d/2<P.zL1);
  for(const lx of [-m.w/2,m.w/2])for(const lz of [-m.d/2,m.d/2])assert.equal(w.ground(m.x+lx,m.z+lz),YACHT.MAIN);
  assert.ok(P.E-m.w/2>=1.6,'room to walk past it');assert.equal(Math.cos(m.facing),-1,'its door faces the tables');
  assert.deepEqual(w.doors([]),[]);assert.deepEqual(w.doors(null),[]);
  const doors=w.doors(Array.from({length:14},(_,i)=>({env:'e'+i,label:'Office '+i})));
  assert.equal(doors.length,12);
  for(const d of doors){
    assert.equal(w.ground(d.x,d.z),d.y,'a door stands on its deck');
    for(const o of doors)assert.ok(o===d||Math.hypot(o.x-d.x,o.z-d.z)>2.3,`doors do not overlap (${d.x.toFixed(1)},${d.z.toFixed(1)} and ${o.x.toFixed(1)},${o.z.toFixed(1)})`);
    assert.ok(!w.walls.some(b=>b.kind!=='block'&&b.kind!=='transom'&&b.y===d.y&&pushOut({x:d.x,z:d.z},b,0.8)),'clear of rails and furniture');
  }
  assert.equal(doors[0].y,YACHT.SWIM);assert.equal(doors[11].y,YACHT.FORE);
});

test('yacht: meters sit inside each door wall and beside the lounge board',()=>{
  const w=yachtWorld(['o','a','b']),a=w.meterAnchors();
  assert.deepEqual(a.rooms.map(r=>r.key),['o','a','b']);
  for(const [i,m] of a.rooms.entries()){
    const r=w.rooms[i],c=Math.cos(r.facing),s=Math.sin(r.facing);
    const dx=m.x-r.x,dz=m.z-r.z,lx=dx*c-dz*s,lz=dx*s+dz*c;
    const nlx=m.nx*c-m.nz*s,nlz=m.nx*s+m.nz*c;
    assert.ok(lx<-1.5&&lz<ROOM_D/2-0.1&&lz>ROOM_D/2-1.2,'inside the front wall, clear of the door, off the name sign');
    assert.ok(nlz<0&&nlx>0,'faces into the room and toward the door');
    assert.ok(near(m.y,r.y+2.15),'at eye height on that deck');
    assert.equal(w.ground(m.x,m.z),r.y,'on the suite deck, not over the side');
  }
  assert.equal(a.main.nz,1);assert.ok(a.main.z>w.mainWall.z,'on the lounge side of the forward wall');
  assert.equal(w.ground(a.main.x,a.main.z),YACHT.MAIN);
  assert.ok(Math.abs(a.main.x-w.mainWall.x)+a.main.width/2<=w.mainWall.width/2+1e-6,'on the wall, clear of the stair');
});

// ---------- the org at team tables (office-tables-core.js) ----------
const agent=(id,reportsTo='',kind='agent')=>({id,name:id,kind,reportsTo});
// Shaped like a real org: a founder, a chief of staff with helpers, a review panel (a team node, a chair and
// judges), company leads with a few reports each, and one manager with none.
function sampleOrg(judges=13){
  const list=[agent('founder','','human'),agent('cos','founder'),...[1,2,3,4,5].map(i=>agent('helper'+i,'cos')),agent('panel','cos','team'),agent('chair','panel'),
    ...Array.from({length:judges},(_,i)=>agent('judge'+i,'chair'))];
  for(const [gm,n] of [['a',3],['b',2],['c',2],['d',1]]){list.push(agent('gm-'+gm,'founder'));for(let i=0;i<n;i++)list.push(agent(`${gm}-${i}`,'gm-'+gm))}
  list.push(agent('manager','founder'));
  return list;
}

test('team tables: a team is a lead with its reports, a team node is a table, and the top of the org comes first',()=>{
  const list=sampleOrg(),teams=orgTeams(list);
  assert.equal(list.length,35);
  assert.deepEqual(teams.map(t=>[t.name,t.head,t.members.length]),[['founder','founder',1],['cos','cos',5],['panel','chair',13],['gm-a','gm-a',3],['gm-b','gm-b',2],['gm-c','gm-c',2],['gm-d','gm-d',1]]);
  assert.equal(teams[2].node,'panel','the team node is the table, its only lead the head');
  assert.deepEqual(teams[0].members,['manager'],'a report with no reports of its own sits with its lead');
  // everyone has exactly one seat (a team node is its table, not a seat)
  const seated=teams.flatMap(t=>[t.head,...t.members].filter(Boolean));
  assert.equal(seated.length,34);assert.equal(new Set(seated).size,34);
  // nobody reports to anyone: one table for the crew; a loop in reportsTo does not hang or drop anyone
  assert.deepEqual(orgTeams([agent('x'),agent('y'),agent('z')],{loose:'Crew'}).map(t=>[t.name,t.head,t.members]),[['Crew','',['x','y','z']]]);
  const loop=orgTeams([agent('p','q'),agent('q','p'),agent('r','p')]);
  assert.equal(new Set(loop.flatMap(t=>[t.head,...t.members].filter(Boolean))).size,3);
  // a team too big for one table carries on at the next
  const big=orgTeams([agent('lead'),...Array.from({length:40},(_,i)=>agent('w'+i,'lead'))]);
  assert.deepEqual(big.map(t=>t.members.length+(t.head?1:0)),[15,15,11]);assert.equal(big[1].name,'lead (2)');
  // a lead whose reports all lead: no table of their own, the head of their first report's, that report beside them
  const tall=orgTeams([agent('ceo','','human'),agent('vp1','ceo'),agent('a1','vp1'),agent('a2','vp1'),agent('vp2','ceo'),agent('b1','vp2')]);
  assert.deepEqual(tall.map(t=>[t.name,t.head,t.members]),[['vp1','ceo',['vp1','a1','a2']],['vp2','vp2',['b1']]]);
  const chain=orgTeams([agent('a'),agent('b','a'),agent('c','b'),agent('d','c')]);
  assert.deepEqual(chain.map(t=>[t.name,t.head,t.members]),[['c','a',['b','c','d']]]);
  // a team node with several reports, some of them leads: the leads get their own tables
  const mixed=orgTeams([agent('t','','team'),agent('m1','t'),agent('m2','t'),agent('sub','t'),agent('s1','sub')]);
  assert.deepEqual(mixed.map(t=>[t.name,t.node,t.head,t.members]),[['t','t','',['m1','m2']],['sub','','sub',['s1']]]);
});

test('team tables: a real org fits the lounge in three rows; a big one fits the same lounge, tighter',()=>{
  const w=yachtWorld(2),P=w.plan,s=w.seat(sampleOrg());
  assert.equal(s.pos.size,35);assert.equal(s.unseated.length,0);assert.equal(s.tables.length,7);
  assert.ok(s.rows<=3,`rows ${s.rows}`);
  const m=w.meetingAnchors()[0],clearOf=(p,r=0.3)=>!s.walls.some(b=>pushOut({x:p.x,z:p.z},b,r-0.05));
  for(const [id,p] of s.pos){
    assert.equal(w.ground(p.x,p.z),YACHT.MAIN,`${id} sits on the main deck`);
    assert.ok(Math.abs(p.x)<P.E-0.3&&p.z>w.mainWall.z+2.5&&p.z<m.z-m.d/2-0.8,`${id} is between the main board and the meeting room`);
    if(p.role==='table')continue;
    assert.ok(clearOf(p),`${id} is not inside a table`);assert.ok(Math.abs(p.x)>P.zone.aisle-0.4,'the centre aisle stays free');
    assert.ok(near(Math.hypot(p.out.x,p.out.z),1),'a seat knows which way is away from its table');
    const t=s.tables[p.table];assert.ok(Math.hypot(p.x+p.out.x-t.x,p.z+p.out.z-t.z)>Math.hypot(p.x-t.x,p.z-t.z),'and it is');
    // facing the table
    assert.ok(Math.sin(p.yaw)*(t.x-p.x)+Math.cos(p.yaw)*(t.z-p.z)>0,`${id} faces its table`);
  }
  // seats are apart from each other, and tables from tables
  const seats=[...s.pos.values()].filter(p=>p.role!=='table');
  for(let i=0;i<seats.length;i++)for(let j=i+1;j<seats.length;j++)assert.ok(Math.hypot(seats[i].x-seats[j].x,seats[i].z-seats[j].z)>0.5,'two seats in one place');
  for(const a of s.tables)for(const b of s.tables)assert.ok(a===b||Math.abs(a.x-b.x)>=(a.width+b.width)/2+0.3||Math.abs(a.z-b.z)>=a.depth+1.6,`${a.name} and ${b.name} overlap`);
  assert.deepEqual(s.tables.map(t=>t.name),['founder','cos','panel','gm-a','gm-b','gm-c','gm-d']);
  assert.equal(s.pos.get('founder').role,'head');assert.equal(s.pos.get('chair').role,'head');assert.equal(s.pos.get('panel').role,'table');
  assert.equal(s.tables[0].z,P.zone.front,'the top of the org sits nearest the main board');
  // the tables are walls, and the lounge can still be walked from end to end with them there
  assert.equal(s.walls.length,7);assert.ok(s.walls.every(b=>b.kind==='table'));
  const r=reach(w,w.spawn,[...w.walls,...s.walls]);
  assert.ok(r.has({x:w.mainWall.x,z:w.mainWall.z+2})&&r.has({x:P.stairX+1,z:P.zL0+1}),'past the tables to the board and the stair');
  for(const p of seats)assert.ok(r.has({x:p.x+p.out.x*0.9,z:p.z+p.out.z*0.9},1.3),'you can walk up behind every seat');
  // the same seats for the same org; a changed org moves the tables (rev) only when a table moved
  assert.equal(w.seat(sampleOrg()).rev,s.rev);assert.notEqual(w.seat(sampleOrg(3)).rev,s.rev);
  // 70 and 110 agents: the same hull, the same lounge
  for(const [n,most] of [[70,70],[110,110]]){
    const list=[agent('root','','human')];for(let i=0;i<8;i++){list.push(agent('lead'+i,'root'));for(let k=0;list.length<n&&k<Math.ceil((n-9)/8);k++)list.push(agent(`w${i}-${k}`,'lead'+i))}
    const big=w.seat(list);
    assert.equal(big.pos.size,most,`${n} agents all have a seat`);assert.ok(big.rows<=4);
    for(const p of big.pos.values())assert.ok(w.ground(p.x,p.z)===YACHT.MAIN&&p.z<m.z-m.d/2-0.5&&p.z>w.mainWall.z+2,'inside the lounge');
    const bs=[...big.pos.values()].filter(p=>p.role!=='table');
    for(let i=0;i<bs.length;i++)for(let j=i+1;j<bs.length;j++)assert.ok(Math.hypot(bs[i].x-bs[j].x,bs[i].z-bs[j].z)>0.45,'two seats in one place');
  }
  // far more than the lounge holds: the rest are listed, never seated in the sea or on top of each other
  const crowd=w.seat(Array.from({length:200},(_,i)=>agent('c'+i)));
  assert.ok(crowd.pos.size>=100&&crowd.pos.size+crowd.unseated.length===200);
  // an empty org: nothing to seat, nothing in the way
  const none=w.seat([]);assert.equal(none.pos.size,0);assert.deepEqual(none.walls,[]);
});

test('the world is kept with the environment\'s AgentFlow data: yacht is stored, the default and junk are not',()=>{
  assert.deepEqual(cleanAgentflow({agents:[],office:{world:'yacht'}}).office,{world:'yacht'});
  for(const o of [undefined,null,{},{world:'classic'},{world:'moon'},{world:['yacht']},'yacht'])assert.equal('office' in cleanAgentflow({agents:[],office:o}),false,JSON.stringify(o));
  assert.deepEqual(Object.keys(cleanAgentflow({agents:[],workflows:[],runners:[]})),['agents','workflows','runners'],'older saves read the same');
});
