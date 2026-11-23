// Getting about the 3D office (public/office-travel-core.js): what "Go to…" lists and finds, the route there along
// real paths (never through a wall, up the stairs), when a long way fades, and the minimap's frame. No browser.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {placeList,filterPlaces,planRoute,pointAlong,standable,mapFit,TELEPORT_OVER,ARRIVE_WALK} from '../public/office-travel-core.js';
import {buildNav} from '../public/office-nav.js';
import {yachtWorld,classicWorld,YACHT,ROOM_W,ROOM_D} from '../public/office-world-core.js';
import {officeBox,createOfficeCharacter,cameraClearance,createOfficeCamera,WALK_SPEED,RUN_SPEED} from '../public/office-controls.js';
import {WALL_H,BACK_WALL_H} from '../public/office-layout.js';

const near=(a,b,eps=1e-9)=>Math.abs(a-b)<=eps;
const inRoom=(r,lx,lz)=>({x:r.x+lx*Math.cos(r.facing)+lz*Math.sin(r.facing),z:r.z-lx*Math.sin(r.facing)+lz*Math.cos(r.facing)});
// The walls office.js builds round a room: back, two sides, and the front either side of a 3-wide door.
function roomWalls(r){
  const w=(lx,lz,width,depth,h=WALL_H)=>{const p=inRoom(r,lx,lz);return officeBox(p.x,p.z,r.facing,width,depth,h+r.y)},side=(ROOM_W-3)/2;
  return [w(0,-ROOM_D/2,ROOM_W,0.2,BACK_WALL_H),w(-ROOM_W/2,0,0.2,ROOM_D),w(ROOM_W/2,0,0.2,ROOM_D),w(-(1.5+side/2),ROOM_D/2,side,0.2),w(1.5+side/2,ROOM_D/2,side,0.2)];
}
const agent=(id,reportsTo='',kind='agent')=>({id,name:id,kind,reportsTo});
// The yacht as the office has it: two members, an org of 35 at its tables, the meeting room's glass.
function yacht(){
  const w=yachtWorld(['owner','bo']),list=[agent('founder','','human'),agent('cos','founder'),...Array.from({length:5},(_,i)=>agent('h'+i,'cos')),agent('panel','cos','team'),agent('chair','panel'),
    ...Array.from({length:13},(_,i)=>agent('judge'+i,'chair')),...['a','b','c','d'].flatMap(g=>[agent('gm-'+g,'founder'),agent(g+'1','gm-'+g),agent(g+'2','gm-'+g)]),agent('manager','founder')];
  const seating=w.seat(list),m=w.meetingAnchors()[0],H=2.3,T=0.1,door=2.4,side=(m.w-door)/2;
  const at=(lx,lz,ww,dd)=>{const p=inRoom(m,lx,lz);return officeBox(p.x,p.z,m.facing,ww,dd,H)};
  const glass=[at(0,-m.d/2,m.w,T),at(-m.w/2,0,T,m.d),at(m.w/2,0,T,m.d),at(-(door/2+side/2),m.d/2,side,T),at(door/2+side/2,m.d/2,side,T)];
  const boxes=[...w.rooms.flatMap(roomWalls),...w.walls,...seating.walls,...glass,officeBox(w.mainWall.x,w.mainWall.z,0,w.mainWall.width+0.3,w.mainWall.depth+0.3,w.mainWall.height)];
  return {w,seating,m,boxes,nav:buildNav({bounds:w.bounds,boxes,ground:w.ground,radius:0.36}),list};
}
// Walk a planned route with the character controller, as office.js does: point by point. -> {seconds, state}
function walkRoute(w,boxes,from,plan,{fast=false}={}){
  const c=createOfficeCharacter();c.reset({x:from.x,y:w.ground(from.x,from.z)??0,z:from.z},0);
  const pts=plan.points;let i=2,t=0,fell=false;
  for(;t<120;t+=1/60){
    const s=c.state;while(i<pts.length-2&&Math.hypot(pts[i]-s.x,pts[i+1]-s.z)<0.5)i+=2;
    const dx=pts[i]-s.x,dz=pts[i+1]-s.z,d=Math.hypot(dx,dz);if(i>=pts.length-2&&d<0.25)break;
    c.advance(1/60,{x:dx/d,z:dz/d,sprint:fast,jumpHeld:false},boxes,w.terrain);
    if(w.ground(c.state.x,c.state.z)===null)fell=true;
  }
  return {seconds:t,state:c.state,fell};
}

test('"Go to…" lists places, rooms, people, live agents and the org, each with where to stand',()=>{
  const list=placeList({places:[{id:'lounge',name:'Lounge',x:0,z:6}],names:{room:'suite',owner:'Bridge'},board:{x:-1,z:-6},meeting:{name:'Meeting room',x:0,z:9},
    rooms:[{key:'me',name:'Rin Ota',x:1,z:-28,me:true,owner:true},{key:'bo',name:'Bo Marsh',x:1,z:-15}],
    people:[{key:'bo',name:'Bo Marsh',x:2,z:3}],agents:[{id:'a1',name:'Researcher',title:'Finds sources',x:3,z:0},{id:'bad',name:'Nowhere',x:NaN,z:0}],
    sessions:[{id:'s1',member:'me',mine:true,name:'Fix login',x:4,z:1,waiting:true},{id:'s2',member:'bo',owner:'Bo Marsh',name:'Tidy page',x:1,z:-14},{id:'s3',member:'bo',owner:'Bo Marsh',name:'Build',x:1,z:-13,waiting:true}]});
  assert.deepEqual(list.map(p=>p.id),['place:lounge','place:board','place:meeting','room:me','room:bo','person:bo','session:me:s1','session:bo:s2','session:bo:s3','agent:a1'],'something with no place is left out');
  const by=Object.fromEntries(list.map(p=>[p.id,p]));
  assert.equal(by['room:me'].name,'My suite · Bridge');assert.equal(by['room:bo'].name,"Bo Marsh's suite");
  assert.equal(by['session:me:s1'].sub,'Waiting on you');assert.equal(by['session:bo:s3'].sub,'Waiting on Bo Marsh');assert.equal(by['session:bo:s2'].sub,'Bo Marsh’s agent');
  assert.ok(by['person:bo'].stop>1&&by['agent:a1'].stop>1&&by['place:board'].stop===0,'you stop short of people and agents, not of places');
  // the classic office's words
  const classic=placeList({rooms:[{key:'me',name:'Rin',x:0,z:0,me:true,owner:true},{key:'bo',name:'Bo',x:5,z:5}]});
  assert.deepEqual(classic.map(p=>p.name),['My room',"Bo's room"]);
  assert.deepEqual(placeList(),[]);

  // With nothing typed: waiting agents first, then places, rooms, people, live agents, the org.
  assert.deepEqual(filterPlaces(list).map(p=>p.id),['session:me:s1','session:bo:s3','place:lounge','place:board','place:meeting','room:me','room:bo','person:bo','session:bo:s2','agent:a1']);
  // Typing filters by name, the start of a name first, then a word's start, then anywhere, then what it is.
  assert.deepEqual(filterPlaces(list,'bo').map(p=>p.id),['room:bo','person:bo','place:board','session:bo:s3','session:bo:s2']);
  assert.deepEqual(filterPlaces(list,'  MEET ').map(p=>p.id),['place:meeting']);
  assert.deepEqual(filterPlaces(list,'sources').map(p=>p.id),['agent:a1'],'a title finds its agent');
  assert.deepEqual(filterPlaces(list,'my').map(p=>p.id),['room:me']);
  assert.deepEqual(filterPlaces(list,'zzz'),[]);
});

test('a route follows the paths: up the stair to a suite, never through a wall, a table or the glass',()=>{
  const {w,seating,m,boxes,nav}=yacht(),P=w.plan,from={x:w.spawn.x,z:w.spawn.z};
  const targets={
    'the main board':{x:w.mainWall.x,z:w.mainWall.z+2.6},
    'the meeting room':inRoom(m,0,m.d/2-1.9),
    "Bo's suite":inRoom(w.rooms[1],0,ROOM_D/2+1.3),
    'my suite, the bridge':inRoom(w.rooms[0],0,ROOM_D/2-1.6),
    'the sun deck':w.places().find(p=>p.id==='sundeck'),
    'the beach club':w.places().find(p=>p.id==='beach'),
    'the head of a table':{...seating.pos.get('founder'),stop:1.3},
    'a judge at the far table':{...seating.pos.get('judge12'),stop:1.3},
  };
  const times={};
  for(const [name,to] of Object.entries(targets)){
    const plan=planRoute(nav,from,to,{far:Infinity});
    assert.ok(plan.reached,`${name}: there is a way`);assert.equal(plan.jump,null);
    for(let i=2;i<plan.points.length;i+=2)assert.ok(nav.clear(plan.points[i-2],plan.points[i-1],plan.points[i],plan.points[i+1]),`${name}: leg ${i/2} is clear`);
    const end={x:plan.points.at(-2),z:plan.points.at(-1)},want=to.stop||0;
    assert.ok(Math.abs(Math.hypot(end.x-to.x,end.z-to.z)-want)<0.9,`${name}: ends ${want} from it`);
    // the same route walked by the character controller: it gets there, stays on deck, at the right height
    const walked=walkRoute(w,boxes,from,plan),ran=walkRoute(w,boxes,from,plan,{fast:true});
    assert.ok(!walked.fell&&!ran.fell,`${name}: nobody falls in`);
    assert.ok(Math.hypot(walked.state.x-end.x,walked.state.z-end.z)<0.4&&Math.hypot(ran.state.x-end.x,ran.state.z-end.z)<0.4,`${name}: arrived`);
    assert.ok(near(walked.state.y,w.ground(end.x,end.z),1e-6),`${name}: on its deck`);
    assert.ok(ran.seconds<=walked.seconds);
    times[name]={metres:plan.cost,walk:walked.seconds,run:ran.seconds};
  }
  // Everything important is within about ten seconds' walk of where you arrive; running, as "Go to…" does, about six.
  for(const [name,t] of Object.entries(times)){assert.ok(t.walk<=10.5,`${name}: ${t.walk.toFixed(1)} s walking`);assert.ok(t.run<=6.5,`${name}: ${t.run.toFixed(1)} s running`)}
  assert.ok(times['the main board'].walk<4&&times['the meeting room'].walk<2.5&&times["Bo's suite"].walk<7);
  // a walk is about its length over the walking speed (a little more: starting, turning, the last step)
  for(const t of Object.values(times))assert.ok(t.walk>=t.metres/WALK_SPEED-0.3&&t.walk<t.metres/WALK_SPEED+2.5&&t.run>=t.metres/RUN_SPEED-0.3);
  // straight at a wall: the route goes round. From the lounge to the upper deck just behind the bulkhead is a long way round.
  const behind=planRoute(nav,{x:0,z:P.zL0+2},{x:1,z:P.zL0-1.2},{far:Infinity});
  assert.ok(behind.reached&&behind.cost>12,'no way through the bulkhead');
  // somewhere you cannot stand (in the sea): the route ends at the nearest place you can
  for(const [x,z] of [[30,0],[0,300],[-7.2,-20],[0,P.zBow+0.5]]){
    const sea=planRoute(nav,from,{x,z},{far:Infinity}),end={x:sea.points.at(-2),z:sea.points.at(-1)};
    assert.ok(w.ground(end.x,end.z)!==null&&nav.open(end.x,end.z),`a click at ${x},${z} ends on deck`);
    const far=planRoute(nav,from,{x,z},{far:5});assert.ok(far.jump&&w.ground(far.jump.x,far.jump.z)!==null,'and a fade never lands in the sea');
  }
  // a table: beside it
  const t=seating.tables[2],by=standable(nav,t.x,t.z);assert.ok(nav.open(by.x,by.z)&&Math.hypot(by.x-t.x,by.z-t.z)<2.5);
  assert.deepEqual(standable(nav,0,6),{x:0,z:6},'somewhere you can stand already is itself');
});

test('a long way fades to a few metres short and walks the rest; stopping short stays on the path',()=>{
  const pts=[0,0,10,0,10,10];
  assert.deepEqual(pointAlong(pts,4),{x:4,z:0,i:2});assert.deepEqual(pointAlong(pts,13),{x:10,z:3,i:4});assert.deepEqual(pointAlong(pts,99),{x:10,z:10,i:4});
  // no paths to follow (nav null): a straight line
  const line=planRoute(null,{x:0,z:0},{x:20,z:0});
  assert.deepEqual(line.points,[0,0,20,0]);assert.equal(line.jump,null);assert.equal(line.cost,20);
  const short=planRoute(null,{x:0,z:0},{x:20,z:0,stop:1.5});
  assert.ok(near(short.points.at(-2),18.5)&&near(short.cost,18.5),'stops short of a person');
  assert.ok(planRoute(null,{x:0,z:0},{x:1,z:0,stop:1.5}).cost<=1,'right beside them already: hardly a step');
  const far=planRoute(null,{x:0,z:0},{x:TELEPORT_OVER+30,z:0});
  assert.ok(far.jump&&near(far.jump.x,TELEPORT_OVER+30-ARRIVE_WALK),'fades to a few metres short');
  assert.ok(near(far.jump.heading,Math.PI/2),'facing the way it goes on');
  assert.deepEqual(far.points.slice(0,2),[far.jump.x,far.jump.z]);assert.equal(far.points.at(-2),TELEPORT_OVER+30);
  // on the compact yacht nothing is that far; a yacht with many members is long enough for the bridge to be
  const {w,boxes,nav}=yacht(),from={x:w.spawn.x,z:w.spawn.z};
  for(const p of w.places())assert.equal(planRoute(nav,from,p).jump,null);
  assert.equal(planRoute(nav,from,inRoom(w.rooms[0],0,ROOM_D/2-1.6)).jump,null,'two members: you run to the bridge');
  const big=yachtWorld(['o','a','b','c','d']),bigNav=buildNav({bounds:big.bounds,boxes:[...big.rooms.flatMap(roomWalls),...big.walls],ground:big.ground,radius:0.36});
  const toBridge=planRoute(bigNav,{x:big.spawn.x,z:big.spawn.z},inRoom(big.rooms[0],0,ROOM_D/2-1.6));
  assert.ok(toBridge.jump,'five members: the bridge is a fade away');
  assert.equal(big.ground(toBridge.jump.x,toBridge.jump.z),YACHT.UPPER,'and you land on its deck, in the corridor');
  assert.ok(Math.abs(toBridge.jump.x)<big.plan.E);
});

test('the classic office: routes go round walls and in through doors, to every place its plan lists',()=>{
  const w=classicWorld(['a','b','c','d']),boxes=[...w.rooms.flatMap(r=>roomWalls({...r,y:0})),...w.walls];
  const nav=buildNav({bounds:w.bounds,boxes,radius:0.36}),from={x:w.spawn.x,z:w.spawn.z};
  const places=w.places();
  assert.ok(places.some(p=>p.kind==='board')&&places.some(p=>p.kind==='meeting')&&places.filter(p=>p.kind==='office').length===4);
  for(const p of places){
    const plan=planRoute(nav,from,p,{far:Infinity});
    assert.ok(plan.reached,`${p.id}: there is a way`);
    for(let i=2;i<plan.points.length;i+=2)assert.ok(nav.clear(plan.points[i-2],plan.points[i-1],plan.points[i],plan.points[i+1]),`${p.id}: leg ${i/2} is clear`);
    assert.ok(Math.hypot(plan.points.at(-2)-p.x,plan.points.at(-1)-p.z)<1.2,`${p.id}: ends there`);
  }
  // from inside one office to inside another: out one door and in the other, not through the walls between them
  const [r1,r2]=places.filter(p=>p.kind==='office'),round=planRoute(nav,r1,r2,{far:Infinity});
  assert.ok(round.reached&&round.cost>Math.hypot(r2.x-r1.x,r2.z-r1.z)+0.5);
  // outside the building: the route ends inside it
  const out=planRoute(nav,from,{x:w.bounds.maxX+40,z:0},{far:Infinity});
  assert.ok(out.points.at(-2)<w.bounds.maxX&&nav.open(out.points.at(-2),out.points.at(-1)));
});

test('the minimap: a square office is drawn upright, a long yacht on its side with the bow to the left',()=>{
  const sq=mapFit({minX:-30,maxX:30,minZ:-30,maxZ:30},{maxW:340,maxH:210});
  assert.equal(sq.turned,false);assert.ok(sq.h<=210&&sq.w<=340&&Math.abs(sq.w-sq.h)<=1);
  const c=sq.toMap(0,0);assert.ok(near(c.x,sq.w/2,1)&&near(c.y,sq.h/2,1));
  assert.ok(sq.toMap(10,0).x>c.x&&sq.toMap(0,10).y>c.y,'+x right, +z down');
  const w=yachtWorld(2),f=mapFit(w.bounds,{maxW:430,maxH:210});
  assert.equal(f.turned,true);assert.ok(f.w<=430&&f.h<=210&&f.w>f.h*3,'a long strip');
  const bow=f.toMap(0,w.bounds.minZ),stern=f.toMap(0,w.bounds.maxZ);
  assert.ok(bow.x<stern.x&&near(bow.y,stern.y),'bow to the left');
  assert.ok(f.toMap(5,0).y<f.toMap(-5,0).y,'starboard up');
  // there and back
  for(const fit of [sq,f])for(const [x,z] of [[0,0],[3,-20],[-6,15]]){const m=fit.toMap(x,z),b=fit.toWorld(m.x,m.y);assert.ok(near(b.x,x,1e-6)&&near(b.z,z,1e-6))}
  // which way the "you" arrow points: heading 0 faces +z
  assert.ok(near(Math.sin(sq.turn(0)),0,1e-9)&&Math.cos(sq.turn(0))<0,'upright: facing +z points down the map');
  assert.ok(near(f.turn(Math.PI),-Math.PI/2),'on its side: facing the bow (-z) points left');
  assert.ok(near(f.turn(Math.PI/2),0),'facing starboard points up');
  // a small screen gets a small map
  const small=mapFit(w.bounds,{maxW:210,maxH:130});assert.ok(small.w<=210&&small.scale<f.scale);
});

test('the camera: a world can lay the overview on its side, and let the boom pass through what is cut away',()=>{
  const cam={position:{set(x,y,z){this.x=x;this.y=y;this.z=z}},lookAt(){},fov:45,aspect:1.6};
  const rig=createOfficeCamera(cam),at={x:0,y:0,z:0};
  const settle=(radius=12)=>{for(let i=0;i<240;i++)rig.update(1/60,at,0,0,0,[],radius)};
  rig.reset(at,0);settle();
  const d0=Math.hypot(cam.position.x,cam.position.y-1.1,cam.position.z),h0=cam.position.y;
  rig.frame({zoom:7.6,pitch:0.5});settle();
  const d1=Math.hypot(cam.position.x,cam.position.y-1.1,cam.position.z);
  assert.ok(near(d0,6.4,0.05)&&near(d1,7.6,0.05)&&cam.position.y>h0,'further out and higher');
  // the overview on its side: the boom's yaw turns for it, and turns back after
  const yaw=rig.yaw;
  assert.equal(rig.toggleOverview(-Math.PI/2),true);settle(30);assert.ok(near(Math.cos(rig.yaw+Math.PI/2),1,1e-3),'the boom is on -x: the bow lies to the left');
  assert.equal(rig.toggleOverview(),false);settle();assert.ok(near(Math.cos(rig.yaw-yaw),1,1e-3),'back where it looked');
  assert.equal(rig.toggleOverview(),true);settle(30);assert.ok(near(Math.cos(rig.yaw-yaw),1,1e-3),'without one, the overview keeps your yaw');rig.toggleOverview();
  // through: a box the boom only passes through does not stop it; one it ends in does
  const box=[{x:0,z:5,c:1,s:0,halfX:3,halfZ:1,height:2}];
  assert.ok(cameraClearance({x:0,y:1,z:0},{x:0,y:1.5,z:10},box)<0.5,'a wall stops the boom');
  assert.equal(cameraClearance({x:0,y:1,z:0},{x:0,y:1.5,z:10},box,0.18,true),1,'cut away: it passes');
  assert.ok(cameraClearance({x:0,y:1,z:0},{x:0,y:1.2,z:5},box,0.18,true)<0.85,'but the camera is never left inside it');
});
