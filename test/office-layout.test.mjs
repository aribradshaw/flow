// The classic office's floor plan (public/office-layout.js): offices along two wings, the main board's wall
// and reception facing each other across the open-plan core, team pods either side of a clear spine. Pure
// layout math: nothing overlaps, every door opens onto clear floor, and every place can be walked to, for
// any number of members and any size of org.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classicLayout,orgPods,toWorld,PLAN,ROOM_W,ROOM_D,DOOR_W,BACK_WALL_H,MAIN_WALL_H,MAIN_WALL_T,MEETING_W,MEETING_D} from '../public/office-layout.js';
import {classicWorld,wallsFrom} from '../public/office-world-core.js';
import {officeBox,RUN_SPEED} from '../public/office-controls.js';
import {buildNav} from '../public/office-nav.js';
import {meterAnchors} from '../public/office-meters-core.js';
import {DOOR_REACH} from '../public/office-portals.js';

const local=(frame,p)=>{const dx=p.x-frame.x,dz=p.z-frame.z,c=Math.cos(frame.facing),s=Math.sin(frame.facing);return {x:dx*c-dz*s,z:dx*s+dz*c}};
const keys=n=>Array.from({length:n},(_,i)=>'m'+i);
// An org of about `n`: one person on top, leads under them, one lead with a team node over a big team (the
// shape real orgs have), and a couple of agents nobody manages.
function orgOf(n){
  const out=[];if(!n)return out;
  const add=(id,reportsTo='',kind='agent')=>{out.push({id,name:'Agent '+id,kind,reportsTo});return id};
  const root=add('root','','human');
  const sizes=n>=60?[9,6,5,5,4,3,2]:n>=35?[5,3,2,2,1]:[3,2];
  sizes.forEach((leaves,i)=>{const lead=add('lead'+i,root);for(let k=0;k<leaves;k++)add(`a${i}-${k}`,lead)});
  if(n>=35){const team=add('team','lead0','team'),tl=add('teamlead',team);for(let k=0;out.length<n-2;k++)add('t'+k,tl)}
  while(out.length<n)add('solo'+out.length);
  return out;
}
const SIZES=[1,2,6,12,20],ORGS=[0,10,35,60];
const each=f=>{for(const n of SIZES)for(const a of ORGS)f(classicWorld(keys(n),{org:orgOf(a)}),n,a,`${n} members, ${a} agents`)};
const rectOf=(x,z,w,d)=>({x0:x-w/2,x1:x+w/2,z0:z-d/2,z1:z+d/2});
const overlap=(a,b,gap=0)=>a.x0<b.x1-gap&&b.x0<a.x1-gap&&a.z0<b.z1-gap&&b.z0<a.z1-gap;
const roomRect=r=>rectOf(r.x,r.z,ROOM_W,ROOM_D); // rooms face north or south, so their footprints are axis-aligned
// Everything that stops a walker: the plan's own boxes, the main board's wall with its planters, and the
// meeting room's glass and table as office-voice.js builds them.
function boxes(w){
  const out=[...w.walls],m=w.mainWall,at=(f,lx,lz,ww,dd)=>{const p=toWorld(f,lx,lz);out.push(officeBox(p.x,p.z,f.facing,ww,dd,2))};
  at(m,0,0,m.width+0.3,m.depth+0.3);for(const x of [-m.width/2-0.75,m.width/2+0.75])at(m,x,0.4,0.85,0.85);
  const [a]=w.meetingAnchors(),side=(a.w-2.4)/2;
  at(a,0,-a.d/2,a.w,0.1);at(a,-a.w/2,0,0.1,a.d);at(a,a.w/2,0,0.1,a.d);at(a,-(1.2+side/2),a.d/2,side,0.1);at(a,1.2+side/2,a.d/2,side,0.1);at(a,0,0.4,3.2,1.3);
  return out;
}
const navOf=w=>buildNav({bounds:w.bounds,boxes:boxes(w),ground:null});

test('the org becomes pods: a lead with the agents under it, a team node sharing its lead\'s pod, the rest together',()=>{
  const pods=orgPods([{id:'ceo',name:'Ceo',kind:'human'},{id:'eng',name:'Eng lead',reportsTo:'ceo'},{id:'e1',reportsTo:'eng'},{id:'e2',reportsTo:'eng'},
    {id:'team',name:'Build team',kind:'team',reportsTo:'eng'},{id:'tl',name:'Build lead',reportsTo:'team'},{id:'b1',reportsTo:'tl'},{id:'b2',reportsTo:'tl'},{id:'b3',reportsTo:'tl'},
    {id:'cfo',name:'Cfo',reportsTo:'ceo'},{id:'solo',name:'Solo'}]);
  const by=Object.fromEntries(pods.map(p=>[p.name,p]));
  assert.deepEqual(Object.keys(by).sort(),['Build team','Ceo','Eng lead','Unassigned']);
  assert.deepEqual([by.Ceo.heads,by.Ceo.members,by.Ceo.root],[['ceo'],['cfo'],true],'the top of the org, with the report that has no reports');
  assert.deepEqual([by['Eng lead'].heads,by['Eng lead'].members],[['eng'],['e1','e2']]);
  assert.deepEqual([by['Build team'].heads,by['Build team'].members],[['team','tl'],['b1','b2','b3']],'the team node and its lead head one pod, named for the team');
  assert.deepEqual(by.Unassigned.members,['solo']);
  // Everyone has one spot, in their pod; nobody stands on anybody else; bench rows face each other.
  for(const p of pods){
    const spots=[...p.spots.values()];assert.equal(p.spots.size,p.heads.length+p.members.length);
    for(const s of spots)assert.ok(Math.abs(s.x)<=p.w/2-0.4&&s.z>0&&s.z<p.d,`${p.name}: a spot inside the pod`);
    spots.forEach((a,i)=>spots.slice(i+1).forEach(b=>assert.ok(Math.hypot(a.x-b.x,a.z-b.z)>=1.9,`${p.name}: room between two agents`)));
    for(const t of p.tables)assert.ok(Math.abs(t.x)+t.w/2<=p.w/2&&t.z+t.d/2<p.d);
  }
  // No agents, a flat list, and a loop in reportsTo all lay out.
  assert.deepEqual(orgPods([]),[]);assert.deepEqual(orgPods(null),[]);
  const flat=orgPods([{id:'a',name:'A'},{id:'b',name:'B'},{id:'c',name:'C'}]);assert.equal(flat.length,1);assert.equal(flat[0].name,'Agents');assert.equal(flat[0].members.length,3);
  const loop=orgPods([{id:'a',reportsTo:'b'},{id:'b',reportsTo:'a'},{id:'c',reportsTo:'a'}]);
  assert.equal(loop.reduce((n,p)=>n+p.spots.size,0),3,'a loop is cut, everyone is still placed');
});

test('rooms line the two wings in member order, apart from each other and from every other place, inside the outer walls',()=>{
  each((w,n,a,what)=>{
    assert.deepEqual(w.rooms.map(r=>r.key),keys(n),what);
    const b=w.bounds,[meet]=w.meetingAnchors(),places=[['meeting',rectOf(meet.x,meet.z,meet.w,meet.d)],['lounge',rectOf(w.loungeZone.x,w.loungeZone.z,w.loungeZone.w,w.loungeZone.d)],
      ['reception',rectOf(0,w.zFront+ROOM_D/2,PLAN.CENTER,ROOM_D)],['the main board\'s bay',rectOf(0,-w.zFront-ROOM_D/2,PLAN.CENTER,ROOM_D)],...w.bays.map(x=>[x.id,roomRect(x)])];
    w.rooms.forEach((r,i)=>{
      const rect=roomRect(r);
      assert.ok(rect.x0>=b.minX-1e-6&&rect.x1<=b.maxX+1e-6&&rect.z0>=b.minZ-1e-6&&rect.z1<=b.maxZ+1e-6,`${what}: room ${i} is on the floor`);
      assert.ok(Math.abs(Math.abs(r.z)-(w.zFront+ROOM_D/2))<1e-6,`${what}: room ${i} backs onto an outer wall`);
      for(const o of w.rooms.slice(i+1))assert.ok(!overlap(rect,roomRect(o)),`${what}: two rooms overlap`);
      for(const [name,p] of places)assert.ok(!overlap(rect,p),`${what}: room ${i} overlaps ${name}`);
    });
    // The owner is beside the main board; the first rooms are in the north wing.
    if(n){assert.ok(w.rooms[0].z<0&&Math.abs(w.rooms[0].x)<PLAN.CENTER/2+PLAN.SLOT,`${what}: the owner's room is by the main board`)}
    assert.equal(w.rooms.length+w.bays.length,Math.round((w.halfWidth-PLAN.CENTER/2)/PLAN.SLOT)*4-2,`${what}: every slot is a room or an open bay`);
  });
});

test('every door opens onto clear floor: no wall, pod or furniture in front of it',()=>{
  each((w,n,a,what)=>{
    const all=boxes(w),blocked=(p,r=0.5)=>all.some(b=>{const dx=p.x-b.x,dz=p.z-b.z,lx=dx*b.c-dz*b.s,lz=dx*b.s+dz*b.c;return Math.abs(lx)<b.halfX+r&&Math.abs(lz)<b.halfZ+r});
    const [meet]=w.meetingAnchors();
    for(const frame of [...w.rooms.map(r=>({...r,d:ROOM_D})),meet]){
      for(const out of [0.9,1.6,2.4,3]){
        const p=toWorld(frame,0,frame.d/2+out);
        assert.ok(!blocked(p),`${what}: something stands ${out} m outside a door`);
        assert.ok(Math.abs(p.z)<w.zFront,`${what}: a door opens onto the corridor`);
      }
      for(const lx of [-0.8,0,0.8])assert.ok(!blocked(toWorld(frame,lx,frame.d/2),0.3),`${what}: the doorway is open`);
    }
  });
});

test('room boards hang flush on each back wall, inside the room and facing in; the main board faces reception across the floor',()=>{
  each((w,n,a,what)=>{
    const {rooms,main}=w.boardAnchors();
    assert.deepEqual(rooms.map(r=>r.key),keys(n));
    for(const board of rooms){
      const room=w.rooms.find(r=>r.key===board.key),p=local(room,board);
      assert.ok(Math.abs(p.x)<1e-9,'centred on the back wall');
      assert.ok(p.z>-ROOM_D/2&&p.z<-ROOM_D/2+0.3,'just off the back wall, inside: '+p.z);
      assert.ok(Math.abs(board.nx-Math.sin(room.facing))<1e-9&&Math.abs(board.nz-Math.cos(room.facing))<1e-9,'faces into the room');
      assert.ok(board.width<ROOM_W-1&&board.y+board.height/2<BACK_WALL_H&&board.y-board.height/2>0.9,'fits its wall above the desks');
    }
    const wall=w.mainWall;
    assert.ok(main.width>=6&&main.y+main.height/2<MAIN_WALL_H&&main.width<=wall.width);
    assert.ok(Math.abs(main.nx)<1e-9&&Math.abs(main.nz-1)<1e-9,`${what}: the main board faces south, to reception`);
    assert.ok(Math.abs(wall.x)<1e-9&&w.spawn.x===0&&w.spawn.z>wall.z,`${what}: reception is straight across from it`);
    // Nothing taller than a desk stands between where you arrive and the board: the spine is clear.
    for(const b of boxes(w)){
      if(b.height<=1.2||b.kind==='outer'||b.kind==='core')continue;
      const inSpine=Math.abs(b.x)-Math.max(b.halfX,b.halfZ)<PLAN.SPINE/2&&b.z>wall.z+1&&b.z<w.spawn.z;
      assert.ok(!inSpine,`${what}: a ${b.kind||'box'} stands in the spine at ${b.x},${b.z}`);
    }
    // The wall itself: its ends (and the planters beside it) stay off the rooms either side.
    for(const room of w.rooms)assert.ok(Math.abs(room.x)-ROOM_W/2>wall.width/2+1.2,`${what}: the main wall is clear of the rooms beside it`);
  });
});

test('room meters sit inside the front wall, opposite the name sign, clear of the door',()=>{
  const fb=meterAnchors({roomD:ROOM_D});
  for(const n of [1,3,8]){
    const world=classicLayout(keys(n)),{rooms,main}=world.meterAnchors();
    assert.deepEqual(rooms.map(r=>r.key),keys(n));
    for(const a of rooms){
      const room=world.rooms.find(r=>r.key===a.key),p=local(room,a);
      const nrm=local(room,{x:room.x+a.nx,z:room.z+a.nz});
      assert.ok(Math.abs(p.x-fb.room.x)<1e-9&&Math.abs(p.z-fb.room.z)<1e-9,'the same local spot as the fallback');
      assert.ok(Math.abs(Math.atan2(nrm.x,nrm.z)-fb.room.ry)<1e-9,'the same turn as the fallback, into the room and toward the door');
      assert.ok(p.x<0&&p.z<ROOM_D/2-0.1,'inside the front wall, off the name sign');
      const extra=fb.room.ry-Math.PI,edge=p.x+a.width/2*Math.abs(Math.cos(extra));
      assert.ok(edge<-DOOR_W/2,'clear of the door');
    }
    const wall=world.mainWall,q=local(wall,main);
    assert.ok(Math.abs(main.nx-Math.sin(wall.facing))<1e-9&&Math.abs(main.nz-Math.cos(wall.facing))<1e-9,'faces with the main board');
    assert.ok(Math.abs(q.x)+main.width/2<=wall.width/2+1e-6,'stays on the feature wall');
    assert.ok(q.z>wall.depth/2,'on the core side of the wall');
  }
});

test('the meeting room is a glass room beside reception, its door on the corridor',()=>{
  each((w,n,a,what)=>{
    const [m]=w.meetingAnchors();
    assert.deepEqual([m.id,m.w,m.d,m.glass],['meeting',MEETING_W,MEETING_D,true]);
    assert.ok(m.z>0&&Math.abs(m.x)<PLAN.CENTER/2+PLAN.SLOT,`${what}: in the south wing, beside reception`);
    const door=toWorld(m,0,m.d/2+1);assert.ok(Math.abs(door.z)<w.zFront,`${what}: its door faces the core`);
    assert.ok(m.z+m.d/2<w.bounds.maxZ-1,`${what}: clear of the outer wall behind it`);
  });
});

test('pods stand in the core either side of a clear spine, clear of the corridors and of each other, and everyone has a place',()=>{
  each((w,n,a,what)=>{
    const org=orgOf(a),{pos,pods}=w.org;
    assert.equal(pos.size,org.length,`${what}: every agent has a place`);
    const depth=w.coreDepth-2*PLAN.CORRIDOR;
    pods.forEach((p,i)=>{
      const rect=rectOf(p.x,p.z,p.w,p.d);
      assert.ok(Math.abs(p.x)-p.w/2>=PLAN.SPINE/2-1e-6,`${what}: pod ${p.name} keeps off the spine`);
      assert.ok(Math.abs(p.x)+p.w/2<=w.halfWidth-PLAN.EDGE+1e-6,`${what}: pod ${p.name} keeps off the windows`);
      assert.ok(rect.z0>=-depth/2-1e-6&&rect.z1<=depth/2+1e-6,`${what}: pod ${p.name} keeps off the corridors`);
      for(const o of pods.slice(i+1))assert.ok(!overlap(rect,rectOf(o.x,o.z,o.w+1.6,o.d+1.6)),`${what}: pods ${p.name} and ${o.name} leave an aisle`);
      for(const id of [...p.heads,...p.members]){const q=pos.get(id);assert.ok(q.x>rect.x0&&q.x<rect.x1&&q.z>rect.z0&&q.z<rect.z1,`${what}: ${id} stands in its pod`)}
      assert.match(p.color,/^#[0-9a-f]{6}$/);
    });
    // Nobody stands inside furniture, and the benches' two rows face each other.
    const all=boxes(w);
    for(const [id,q] of pos)for(const b of all){const dx=q.x-b.x,dz=q.z-b.z;assert.ok(Math.abs(dx*b.c-dz*b.s)>b.halfX+0.2||Math.abs(dx*b.s+dz*b.c)>b.halfZ+0.2,`${what}: ${id} stands in a ${b.kind}`)}
    assert.ok(w.coreDepth>=PLAN.POD_MIN_DEPTH+2*PLAN.CORRIDOR);
  });
});

test('more members widen the floor, never deepen it; a bigger org adds pods and keeps the core shallow',()=>{
  const org=orgOf(35);
  const sizes=SIZES.map(n=>classicLayout(keys(n),{org}));
  for(let i=1;i<sizes.length;i++){
    assert.ok(sizes[i].halfWidth>=sizes[i-1].halfWidth);
    assert.equal(sizes[i].coreDepth,sizes[0].coreDepth,'the same org, the same depth');
    assert.deepEqual(sizes[i].pods.map(p=>[p.id,p.x,p.z]),sizes[0].pods.map(p=>[p.id,p.x,p.z]),'the pods stay where they are when someone joins');
  }
  assert.ok(sizes.at(-1).halfWidth>sizes[0].halfWidth);
  const small=classicLayout(keys(2),{org:orgOf(10)}),big=classicLayout(keys(2),{org:orgOf(60)});
  assert.ok(big.pods.length>small.pods.length);
  for(const w of [small,sizes[1],big])assert.ok(w.coreDepth<=Math.max(PLAN.POD_MAX_DEPTH,...w.pods.map(p=>p.d))+2*PLAN.CORRIDOR+1e-6,'the pods spread sideways before the core gets deep');
  // No org at all: still a floor, with the core at its least depth.
  const empty=classicLayout(keys(3));assert.equal(empty.pods.length,0);assert.equal(empty.coreDepth,PLAN.POD_MIN_DEPTH+2*PLAN.CORRIDOR);
  // The overview frames the whole floor.
  for(const w of sizes)assert.ok(w.radius+8>=(w.bounds.maxZ-w.bounds.minZ)/2&&(w.radius+8)*1.5>=w.halfWidth);
});

test('every place can be walked to from reception, and nothing important is far',()=>{
  each((w,n,a,what)=>{
    const nav=navOf(w),from=w.spawn,far=[];
    const go=(name,p)=>{const path=nav.path(from.x,from.z,p.x,p.z);assert.ok(path.reached,`${what}: cannot walk to ${name} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);far.push([name,path.cost]);return path.cost};
    assert.equal(w.ground(from.x,from.z),0);assert.ok(nav.open(from.x,from.z),`${what}: you arrive on open floor`);
    for(const p of w.places())go(p.id,p);
    for(const r of w.rooms){go('inside a room',toWorld(r,0,0));go('a room\'s back',toWorld(r,-4,-3))}
    for(const x of w.bays)go(x.id,toWorld(x,0,2.2));
    for(const s of w.lounge)go('the lounge',s);
    for(const [id,q] of w.org.pos){const near=nav.nearest(q.x,q.z,3);assert.ok(near&&Math.hypot(near.x-q.x,near.z-q.z)<1,`${what}: ${id} has open floor at its place`);go(id,near)}
    for(const d of w.doors(Array.from({length:12},(_,i)=>({env:'e'+i})))){const front={x:d.x+Math.sin(d.facing)*0.8,z:d.z+Math.cos(d.facing)*0.8};go('a door to another office',front)}
    go('where characters come in',w.entrance);
    // At sprint, the main board, the meeting room, the lounge and every pod are seconds from reception.
    const cost=name=>far.filter(f=>f[0]===name||f[0].startsWith(name)).reduce((m,f)=>Math.max(m,f[1]),0);
    for(const name of ['board','meeting','lounge','pod:'])assert.ok(cost(name)/RUN_SPEED<=8,`${what}: ${name} is ${(cost(name)/RUN_SPEED).toFixed(1)} s away`);
    if(n<=12)assert.ok(cost('office:')/RUN_SPEED<=8,`${what}: the farthest office is ${(cost('office:')/RUN_SPEED).toFixed(1)} s away`);
  });
});

test('doors to other offices stand in reception, apart, off the walls, and not where you arrive',()=>{
  each((w,n,a,what)=>{
    const doors=w.doors(Array.from({length:14},(_,i)=>({env:'e'+i,label:'Office '+i})));
    assert.equal(doors.length,12);assert.deepEqual(w.doors(null),[]);assert.deepEqual(w.doors([{nope:1}]),[]);
    doors.forEach((d,i)=>{
      assert.ok(Math.abs(d.x)<PLAN.CENTER/2&&d.z>w.zFront&&d.z<w.bounds.maxZ,`${what}: door ${i} is in reception`);
      assert.ok(Math.hypot(d.x-w.spawn.x,d.z-w.spawn.z)>DOOR_REACH+1.5,`${what}: you do not arrive in door ${i}`);
      for(const o of doors.slice(i+1))assert.ok(Math.hypot(d.x-o.x,d.z-o.z)>=2.3,`${what}: doors ${i} and ${doors.indexOf(o)} are apart`);
    });
    // The first ones are ahead of you as you arrive (north of the spawn), where the camera shows them.
    assert.ok(doors[0].z<=w.spawn.z+1&&doors[1].z<w.spawn.z);
  });
});

test('places and the plan name everything: reception, the main board, the meeting room, the lounge, each office and each pod',()=>{
  each((w,n,a,what)=>{
    const places=w.places(),ids=places.map(p=>p.id);
    assert.equal(new Set(ids).size,ids.length,'ids are unique');
    for(const id of ['reception','board','meeting','lounge'])assert.ok(ids.includes(id),`${what}: ${id}`);
    assert.deepEqual(places.filter(p=>p.kind==='office').map(p=>p.key),keys(n));
    assert.deepEqual(places.filter(p=>p.kind==='pod').map(p=>p.id),w.pods.map(p=>'pod:'+p.id));
    for(const p of places){assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.z)&&Number.isFinite(p.heading)&&p.name,`${what}: ${p.id}`);assert.equal(w.ground(p.x,p.z),0)}
    // Standing at the board's place you face it; at an office's, you are inside it.
    const board=places.find(p=>p.id==='board');assert.ok(board.z>w.mainWall.z&&board.z-w.mainWall.z<8&&Math.abs(board.heading-Math.PI)<1e-9);
    for(const p of places.filter(p=>p.kind==='office')){const r=w.rooms.find(r=>r.key===p.key),l=local(r,p);assert.ok(Math.abs(l.x)<ROOM_W/2&&Math.abs(l.z)<ROOM_D/2)}
    const plan=w.plan(),b=plan.bounds;
    assert.deepEqual(b,w.bounds);
    for(const z of plan.zones)assert.ok(z.x-z.w/2>=b.minX-1e-6&&z.x+z.w/2<=b.maxX+1e-6&&z.z-z.d/2>=b.minZ-1e-6&&z.z+z.d/2<=b.maxZ+1e-6&&z.name&&z.kind,`${what}: zone ${z.id} is on the floor`);
    assert.equal(plan.zones.filter(z=>z.kind==='office').length,n);assert.equal(plan.zones.filter(z=>z.kind==='pod').length,w.pods.length);
    for(const s of w.signs)assert.ok(typeof s.text==='string'&&s.text&&w.ground(s.x,s.z)===0);
  });
});

test('a route between two places bends at the corridors and every leg is clear',()=>{
  for(const n of [2,6,12]){
    const w=classicWorld(keys(n),{org:orgOf(35)}),nav=navOf(w),places=w.places(),[meet]=w.meetingAnchors();
    const door=toWorld(meet,0,meet.d/2+1.6);
    for(const from of places.filter(p=>p.kind==='office'||p.id==='reception'||p.id==='lounge')){
      const route=w.route(from,door);
      assert.ok(route.length>=1&&Math.hypot(route.at(-1).x-door.x,route.at(-1).z-door.z)<0.01);
      let at=from;
      for(const p of route){assert.ok(nav.clear(at.x,at.z,p.x,p.z),`${n}: the leg from ${at.x},${at.z} to ${p.x},${p.z} (${from.id}) crosses something`);at=p}
    }
  }
});

test('the camera is stopped by solid walls, never by glass or the outer walls (they fade)',()=>{
  const w=classicWorld(keys(4),{org:orgOf(35)}),cam=wallsFrom(w.walls,0);
  const kinds=new Set(w.walls.map(b=>b.kind));
  for(const k of ['outer','glass','core','bench'])assert.ok(kinds.has(k),k);
  assert.equal(w.walls.filter(b=>b.kind==='outer').length,4);
  assert.ok(w.walls.filter(b=>b.kind==='outer'||b.kind==='glass').every(b=>b.cam===0&&b.height>2.5),'too tall to jump, no bar to the camera');
  assert.ok(cam.length>0&&cam.length<w.walls.length);
  const core=w.walls.find(b=>b.kind==='core');assert.ok(cam.some(b=>b.x===core.x&&b.z===core.z&&b.height===MAIN_WALL_H),'the service core behind the main board is solid');
  // The service core fills the bay behind the main board's wall.
  assert.ok(Math.abs(core.z+core.halfZ-(w.mainWall.z-MAIN_WALL_T/2))<1e-6&&Math.abs(core.z-core.halfZ-w.bounds.minZ)<1e-6);
  assert.deepEqual(w.roomWalls,{glass:PLAN.GLASS_H,back:false});assert.equal(w.arriveAtSpawn,true);
});
