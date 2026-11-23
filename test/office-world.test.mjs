// The 3D office's worlds (public/office-world-core.js): where rooms go for any number of members, that
// rails and bulkheads keep walkers on deck, that every part of the yacht can be walked to, and that
// someone in the water comes back on deck. Pure layout math: no browser, no Three.js.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classicWorld,yachtWorld,buildWorld,stepIn,pushOut,wallBox,wallsFrom,worldId,WORLDS,DEFAULT_WORLD,YACHT,ROOM_W,ROOM_D,BODY} from '../public/office-world-core.js';
import {cameraClearance,officeBox,createOfficeCharacter} from '../public/office-controls.js';
import {classicLayout,BACK_WALL_H,WALL_H} from '../public/office-layout.js';
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

test('classic: the office as office-layout.js lays it out, on one flat floor with nothing added',()=>{
  for(const keys of [[],['a'],['a','b','c'],Array.from({length:12},(_,i)=>'k'+i)]){
    const w=classicWorld(keys),l=classicLayout(keys);
    assert.deepEqual(w.rooms.map(({y,...r})=>r),l.rooms);assert.ok(w.rooms.every(r=>r.y===0));
    assert.deepEqual(w.mainWall,l.mainWall);assert.deepEqual(w.boardAnchors(),l.boardAnchors());assert.equal(w.radius,l.radius);
    assert.deepEqual(w.walls,[]);assert.equal(w.terrain,undefined,'the flat office needs no terrain');assert.equal(w.doors,undefined);
  }
  assert.deepEqual(classicWorld(['a'],{commonR:22}).rooms[0].z,classicLayout(['a'],{commonR:22}).rooms[0].z);
  assert.equal(classicWorld(3).rooms.length,3,'a count works too');
  const w=classicWorld(4);
  assert.equal(w.ground(3,-40),0);assert.equal(w.ground(500,0),null);assert.equal(w.sea,-Infinity);
  assert.equal(w.ground(w.spawn.x,w.spawn.z),0);assert.deepEqual(w.respawn({x:900,z:900}),w.spawn);
});

test('yacht: a room for every member, on deck, apart from each other; the owner has the bridge',()=>{
  for(const n of [1,2,3,4,7,12,25]){
    const w=yachtWorld(n),P=w.plan;
    assert.equal(w.rooms.length,n,`${n} members`);
    assert.equal(w.rooms[0].kind,'bridge');assert.equal(w.rooms[0].x,0);
    assert.ok(w.rooms.slice(1).every(r=>r.kind==='cabin'));
    assert.equal(w.rooms.length-1+w.spare.length,P.pairs*2,'cabin places come in pairs, port and starboard');
    assert.ok(w.rooms.slice(1).every(r=>r.z>w.rooms[0].z),'the bridge is the room furthest forward');
    for(const r of w.rooms){
      // the whole footprint, and the way to its door, is one flat deck
      for(const lx of [-ROOM_W/2,-3,0,3,ROOM_W/2])for(const lz of [-ROOM_D/2,0,ROOM_D/2,ROOM_D/2+1.5]){const p=inRoom(r,lx,lz);assert.equal(w.ground(p.x,p.z),r.y,`room at ${r.x},${r.z} corner ${lx},${lz}`)}
      assert.equal(r.y,YACHT.UPPER);
    }
    const all=[...w.rooms,...w.spare];
    for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++){
      const a=all[i],b=all[j],dx=Math.abs(a.x-b.x),dz=Math.abs(a.z-b.z);
      assert.ok(dx>=ROOM_D||dz>=ROOM_W,`rooms ${i} and ${j} do not overlap`);
    }
    // a bigger crew gets a longer yacht, never a wider one
    assert.equal(P.HB,14);assert.ok(w.bounds.maxZ-w.bounds.minZ>=130);
  }
  assert.ok(yachtWorld(12).bounds.minZ<yachtWorld(3).bounds.minZ,'more cabins, more yacht');
  // A big AgentFlow org widens the lounge, and the beam with it.
  const big=yachtWorld(3,{commonR:18});assert.ok(big.plan.px>=18&&big.plan.HB>=22);
  assert.equal(big.ground(17,0),YACHT.PIT,'the org stands in the sunken seating');
});

test('yacht: decks are terraced, with one height at each point and stairs between them',()=>{
  const w=yachtWorld(4),P=w.plan,{PIT,MAIN,SWIM,UPPER,SUN,FORE}=YACHT;
  assert.equal(w.ground(0,0),PIT);assert.equal(w.ground(0,P.pz+2),MAIN);assert.equal(w.ground(0,P.zL1+3),SWIM);
  assert.equal(w.ground(0,P.zL0-3),UPPER);assert.equal(w.ground(6,P.zS0+2),SUN);assert.equal(w.ground(0,P.pool.z),SUN-0.5);
  assert.equal(w.ground(0,P.pad.z),FORE);assert.equal(w.ground(0,w.rooms[0].z),UPPER);
  // stairs are ramps: height changes smoothly along them
  const ramps=[[P.HB-2,P.zL0,P.zL0-P.upRamp,MAIN,UPPER],[0,P.zS1,P.zS1-P.sunRamp,UPPER,SUN],[P.HB-2.4,P.zB0,P.zB0-P.foreRamp,UPPER,FORE],[P.HB-3.2,P.zL1,P.zL1+P.swimRamp,MAIN,SWIM]];
  for(const [x,z0,z1,y0,y1] of ramps){
    let last=y0;
    for(let i=0;i<=20;i++){const y=w.ground(x,z0+(z1-z0)*i/20);assert.ok(y!==null);assert.ok(Math.abs(y-last)<0.25,`a ramp at x=${x} has no step taller than a stair`);last=y}
    assert.ok(near(last,y1,1e-9));assert.ok(near(w.ground(-x,(z0+z1)/2),w.ground(x,(z0+z1)/2)),'port and starboard match');
  }
  // off the sides, ahead of the stem and astern there is only water
  for(const [x,z] of [[P.HB+0.1,0],[-P.HB-3,P.zC0],[0,P.zBow-1],[0,P.zSw+0.5],[9,P.zBow+3],[NaN,0]])assert.equal(w.ground(x,z),null,`${x},${z}`);
  assert.ok(w.halfBeam(P.zBow+2)<w.halfBeam(P.zB0-10)&&w.halfBeam(P.zB0-10)<P.HB,'the bow tapers');
  assert.equal(w.halfBeam(0),P.HB);
  assert.ok(w.sea<SWIM&&SWIM<PIT&&PIT<MAIN&&MAIN<FORE&&FORE<UPPER&&UPPER<SUN);
});

test('yacht: rails and bulkheads enclose the decks, and every deck, room and stair can be walked to',()=>{
  for(const n of [1,4,9]){
    const w=yachtWorld(n),P=w.plan,walls=[...w.rooms.flatMap(roomWalls),...w.walls];
    const r=reach(w,w.spawn,walls);
    // The only way into the water is off the aft end of the swim platform.
    assert.ok(r.wet.length>0,'the swim platform is open astern');
    for(const p of r.wet)assert.ok(w.open(p.x,p.z)&&p.z>P.zL1+P.swimRamp,`left the deck at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
    for(const p of r.seen.values())assert.ok(w.ground(p.x,p.z)!==null);
    const must={lounge:w.lounge,'swim platform':{x:0,z:P.zL1+4},terrace:{x:0,z:P.zL0-3},sundeck:{x:5,z:P.zS0+8},pool:P.pool,helipad:P.pad,'bridge wing':{x:P.HB-2,z:P.zB0+3},'bow':{x:0,z:P.zBow+6}};
    for(const [name,p] of Object.entries(must))assert.ok(r.has(p),`${name} is reachable with ${n} members`);
    for(const room of w.rooms){
      assert.ok(r.has(inRoom(room,0,ROOM_D/2+1.2)),'outside a room\'s door');
      assert.ok(r.has(inRoom(room,0,0)),'inside a room');
      assert.ok(!r.has(inRoom(room,0,-ROOM_D/2-0.6),0.2)||room.kind==='bridge','nobody stands in the back wall');
    }
    // nobody ends up inside a wall: every reached point is clear of every box
    for(const p of r.seen.values())for(const b of walls){const q={x:p.x,z:p.z};assert.ok(!pushOut(q,b,BODY-0.02),`standing in a ${b.kind||'room wall'}`)}
  }
});

test('yacht: a walker slides along a rail instead of stopping dead, and cannot be pushed through one',()=>{
  const w=yachtWorld(4),P=w.plan,edge=P.HB-YACHT.EDGE;
  // straight at the port bulwark from the lounge's side deck
  let p={x:-(P.px+1),z:P.pz+2};
  for(let i=0;i<200;i++)p=w.step(p,{x:p.x-0.26,z:p.z});
  assert.ok(p.x>-edge&&p.x<-(edge-BODY-0.3),'stopped at the rail');assert.equal(w.ground(p.x,p.z),YACHT.MAIN);
  // diagonally into it: keeps moving along it
  const z0=p.z;for(let i=0;i<10;i++)p=w.step(p,{x:p.x-0.2,z:p.z-0.2});
  assert.ok(p.z<z0-1.5,'slid forward along the rail');assert.ok(p.x>-edge);
  // one huge step (a frame hitch) does not tunnel through
  const far=w.step({x:0,z:P.pz+2},{x:-60,z:P.pz+2});assert.ok(far.x>-edge&&w.ground(far.x,far.z)!==null);
  const over=w.step({x:0,z:P.zL0-3},{x:0,z:P.zL0+30});assert.equal(w.ground(over.x,over.z),YACHT.UPPER,'the terrace rail holds over the lounge');
  // random walks from all over the yacht never leave it except off the swim platform
  let seed=42;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  const starts=[w.spawn,{x:0,z:P.zL0-3},{x:5,z:P.zS0+8},{x:0,z:P.pad.z},{x:0,z:w.rooms[0].z},{x:0,z:P.zL1+2}];
  for(let k=0;k<400;k++){
    let q={...starts[k%starts.length]};
    for(let i=0;i<60;i++){const a=rnd()*Math.PI*2,d=0.1+rnd()*0.9;q=w.step(q,{x:q.x+Math.cos(a)*d,z:q.z+Math.sin(a)*d});
      if(w.ground(q.x,q.z)===null){assert.ok(w.open(q.x,q.z),`walked off at ${q.x.toFixed(2)},${q.z.toFixed(2)}`);break}}
  }
});

test('yacht: off the swim platform means in the water, and the water gives you back to the deck',()=>{
  const w=yachtWorld(5),P=w.plan;
  let p={x:0,z:P.zSw-2},wet=false;
  for(let i=0;i<40&&!wet;i++){p=w.step(p,{x:p.x,z:p.z+0.26});wet=w.ground(p.x,p.z)===null}
  assert.ok(wet,'walked off the aft end');assert.ok(w.open(p.x,p.z));
  const back=w.respawn(p);
  assert.equal(w.ground(back.x,back.z),YACHT.SWIM,'back on the swim platform');assert.equal(back.y,YACHT.SWIM);assert.ok(Number.isFinite(back.heading));
  // wherever someone turns up off the deck (a stale position after the yacht was rebuilt), they come back on a deck
  for(const q of [{x:0,z:P.zBow-40},{x:200,z:0},{x:-30,z:P.zS0},{x:0,z:P.zSw+90},{x:5,z:-9999}]){
    assert.equal(w.ground(q.x,q.z),null);
    const r=w.respawn(q);assert.equal(w.ground(r.x,r.z),r.y,'respawn points stand on their deck');
  }
  assert.notDeepEqual(w.respawn({x:0,z:P.zBow-40}),w.respawn({x:0,z:P.zSw+90}),'the nearest deck, not always the same one');
  assert.equal(w.ground(w.spawn.x,w.spawn.z),w.spawn.y);assert.equal(w.ground(w.lounge.x,w.lounge.z),w.lounge.y);
  for(const s of w.signs)assert.ok(typeof s.text==='string'&&s.z>=w.bounds.minZ&&s.z<=w.bounds.maxZ);
});

test('walls for the camera are measured from the floor you stand on, and match what the camera rig reads',()=>{
  const w=yachtWorld(4),P=w.plan,{MAIN,UPPER,SUN,RAIL}=YACHT;
  const bulkhead=w.walls.find(b=>b.kind==='bulkhead');
  assert.ok(near(bulkhead.height,UPPER+RAIL));assert.equal(bulkhead.y,MAIN);
  const fromLounge=wallsFrom(w.walls,MAIN),fromSun=wallsFrom(w.walls,SUN);
  assert.ok(fromLounge.length>fromSun.length,'from the sundeck most rails are below you');
  assert.ok(fromLounge.every(b=>b.height>0.12&&b.kind===undefined));
  assert.ok(near(fromLounge.find(b=>b.z===bulkhead.z&&b.halfX===bulkhead.halfX).height,UPPER+RAIL-MAIN));
  // a camera boom from the lounge towards the bow is cut short by the bulkhead; from the sundeck, looking aft, nothing is in the way
  const cut=cameraClearance({x:9,y:1.1,z:P.zL0+2},{x:9,y:2.5,z:P.zL0-5},fromLounge);assert.ok(cut>0.1&&cut<0.5);
  assert.equal(cameraClearance({x:6,y:1.1,z:P.zS0+8},{x:6,y:4,z:P.zS0+30},fromSun),1);
  // a box is office-controls.js's own, with its top measured from zero
  const b=wallBox(3,4,Math.PI/2,6,0.2,1.1,2,'rail'),o=officeBox(3,4,Math.PI/2,6,0.2,3.1);
  for(const k of Object.keys(o))assert.ok(near(b[k],o[k]),k);
  assert.equal(b.y,2);assert.equal(b.kind,'rail');
  // pushOut moves a body out by the nearest face, in the box's own frame
  const q={x:3.05,z:4};assert.ok(pushOut(q,b));assert.ok(near(q.x,3+0.1+BODY)&&near(q.z,4));
  assert.ok(!pushOut({x:9,z:4},b));
});

test('yacht: the character controller walks the decks and stairs, falls from where there is no deck, and can jump a rail',()=>{
  const w=yachtWorld(['o','a','b','c']),P=w.plan,{MAIN,UPPER,SUN,SWIM,SEA}=YACHT,walls=[...w.rooms.flatMap(roomWalls),...w.walls];
  const c=createOfficeCharacter(),still={x:0,z:0,sprint:false,jumpHeld:false};
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
  assert.ok(near(walk([[0,P.pz+2.2]]).y,MAIN,1e-6));
  // into the sunken seating by its steps, and out again
  assert.ok(near(walk([[0,P.pz-3]]).y,0,1e-6));assert.ok(near(walk([[0,P.pz+2]]).y,MAIN,1e-6));
  // up the port stairs to the terrace: always on the ground, never a jump or a fall
  const xs=-(P.HB-2.1);walk([[0,P.pz+1],[xs,P.pz+1],[xs,P.zL0+1]]);
  let air=0;for(let i=0;i<60*6&&c.state.z>P.zL0-P.upRamp-1;i++){c.advance(1/60,{x:0,z:-1,sprint:false,jumpHeld:false},walls,w.terrain);if(!c.state.grounded)air++}
  assert.ok(near(c.state.y,UPPER,1e-6),'at the top of the stairs');assert.equal(air,0,'feet stay on the stairs going up');
  // and back down them the same way
  for(let i=0;i<60*6&&c.state.z<P.zL0+1;i++){c.advance(1/60,{x:0,z:1,sprint:true,jumpHeld:false},walls,w.terrain);if(!c.state.grounded)air++}
  assert.ok(near(c.state.y,MAIN,1e-6));assert.equal(air,0,'and going down, even sprinting');
  // up again, along the promenade, round the sundeck block's stair and onto the sundeck
  walk([[xs,P.zL0-P.upRamp-1],[0,P.zT0],[0,P.zS1+1],[0,P.zS1-P.sunRamp-1.5]]);
  assert.ok(near(c.state.y,SUN,1e-6),'on the sundeck');
  assert.ok(near(walk([[P.pool.x,P.pool.z]]).y,SUN-0.5,1e-6),'in the pool');
  assert.ok(near(walk([[0,P.pool.z+P.pool.halfZ+1]]).y,SUN,1e-6),'and out of it');
  // walking into a rail stops there; holding jump clears it and lands on the deck below
  c.reset({x:0,y:UPPER,z:P.zL0-3},Math.PI);
  for(let i=0;i<120;i++)c.advance(1/60,{x:0,z:1,sprint:false,jumpHeld:false},walls,w.terrain);
  assert.ok(c.state.z<P.zL0&&near(c.state.y,UPPER,1e-6),'the terrace rail holds');
  c.reset({x:9.5,y:UPPER,z:P.zL0-2.5},0);
  for(let i=0;i<70;i++){if(i===8||i===30)c.jump();c.advance(1/60,{x:0,z:1,sprint:true,jumpHeld:true},walls,w.terrain)}
  for(let i=0;i<90;i++)c.advance(1/60,still,walls,w.terrain);
  assert.ok(c.state.z>P.zL0+0.5&&c.state.y<=MAIN+0.5+1e-6&&c.state.grounded,`jumped the rail and came down in the lounge (at z ${c.state.z.toFixed(1)}, y ${c.state.y.toFixed(2)})`);
  // off the swim platform's open end: down past the waterline, to be fished out by respawn
  c.reset({x:0,y:SWIM,z:P.zSw-2},0);
  for(let i=0;i<180&&c.state.y>SEA-1.1;i++)c.advance(1/60,{x:0,z:1,sprint:false,jumpHeld:false},walls,w.terrain);
  assert.ok(c.state.y<SEA-1.1,'fell in');
  const back=w.respawn(c.state);assert.equal(back.y,SWIM);
  // the world is longer than the flat office's limit, and the controller lets you reach its bow
  assert.ok(-P.zBow>110&&w.terrain.limit>-P.zBow);
  c.reset({x:0,y:YACHT.FORE,z:P.pad.z},Math.PI);
  assert.ok(walk([[0,P.zBow+6]]).z<-110);assert.equal(w.ground(c.state.x,c.state.z),YACHT.FORE);
});

test('yacht: boards hang inside each room and on the lounge wall; doors stand on deck',()=>{
  const w=yachtWorld(['o','a','b']),P=w.plan,a=w.boardAnchors();
  assert.deepEqual(a.rooms.map(r=>r.key),['o','a','b']);
  for(const [i,m] of a.rooms.entries()){
    const r=w.rooms[i],back=inRoom(r,0,-ROOM_D/2),front=inRoom(r,0,ROOM_D/2);
    assert.ok(Math.hypot(m.x-back.x,m.z-back.z)<0.3,'on the back wall');
    assert.ok(near(m.nx*(front.x-back.x)+m.nz*(front.z-back.z),ROOM_D,1e-6),'facing into the room');
    assert.ok(m.y>r.y+1&&m.y+m.height/2<=r.y+BACK_WALL_H+0.05,'within the wall\'s height, on its deck');
  }
  assert.equal(w.mainWall.y,YACHT.MAIN);assert.equal(w.ground(w.mainWall.x,w.mainWall.z+1),YACHT.MAIN);
  assert.ok(a.main.nz===1&&a.main.z>w.mainWall.z&&a.main.z<-P.pz,'the main board faces the seating from its forward wall');
  assert.ok(w.mainWall.width/2+0.75+0.43<P.HB-3.6,'its planters stay clear of the stairs');
  assert.deepEqual(w.doors([]),[]);assert.deepEqual(w.doors(null),[]);
  const doors=w.doors(Array.from({length:14},(_,i)=>({env:'e'+i,label:'Office '+i})));
  assert.equal(doors.length,12);
  for(const d of doors){assert.equal(w.ground(d.x,d.z),d.y,'a door stands on its deck');for(const o of doors)assert.ok(o===d||Math.hypot(o.x-d.x,o.z-d.z)>2.4,'doors do not overlap')}
  assert.equal(doors[0].y,YACHT.SWIM);assert.equal(doors[11].y,YACHT.MAIN);
});

test('the world is kept with the environment\'s AgentFlow data: yacht is stored, the default and junk are not',()=>{
  assert.deepEqual(cleanAgentflow({agents:[],office:{world:'yacht'}}).office,{world:'yacht'});
  for(const o of [undefined,null,{},{world:'classic'},{world:'moon'},{world:['yacht']},'yacht'])assert.equal('office' in cleanAgentflow({agents:[],office:o}),false,JSON.stringify(o));
  assert.deepEqual(Object.keys(cleanAgentflow({agents:[],workflows:[],runners:[]})),['agents','workflows','runners'],'older saves read the same');
});
