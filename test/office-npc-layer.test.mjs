// The 3D office's NPC layer (public/office-npc.js) with real Three.js objects and a fake office: nobody ever
// snaps (no frame moves a character further than its top speed allows, except a fade-over), new sessions
// come in at their room's door, seated ones walk to the AgentFlow desk, gone ones wave, walk out and fade,
// and 60 characters cost little per frame.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../public/vendor/three/three.module.min.js';
import {createNpcs} from '../public/office-npc.js';
import {officeBox} from '../public/office-controls.js';

const ROOM_W=12,ROOM_D=9;
// One room at (0, -10), its door facing +z (towards the common area round the origin).
function fakeOffice({people=new Map()}={}){
  const scene=new THREE.Scene(),world=new THREE.Group();scene.add(world);
  const layer=new THREE.Group();world.add(layer);
  const room=new THREE.Group();room.position.set(0,0,-10);world.add(room);
  const seats=new THREE.Group();world.add(seats);
  const boxes=[],wall=(x,z,w,d)=>boxes.push(officeBox(x,z-10,0,w,d,1.1));
  wall(0,-ROOM_D/2,ROOM_W,0.2);wall(-ROOM_W/2,0,0.2,ROOM_D);wall(ROOM_W/2,0,0.2,ROOM_D);
  const side=(ROOM_W-3)/2;wall(-(1.5+side/2),ROOM_D/2,side,0.2);wall(1.5+side/2,ROOM_D/2,side,0.2);
  const labels=new Set();
  const office={THREE,world,layer,settleMs:20,
    navWorld:()=>({boxes}),person:k=>people.get(k),isQuiet:()=>false,
    room:k=>k==='ann'?{door:{x:0,z:-10+ROOM_D/2+1.3},lounge:{x:-4,z:-7}}:undefined,
    boardSpot:k=>k==='ann'?{x:0,z:-12.8,yaw:0}:{x:0,z:-1,yaw:0},entrance:()=>({x:0,z:6}),commonRadius:()=>5,player:()=>({x:30,z:30}),
    label:(obj,html)=>{const l={obj,html};labels.add(l);return l},unlabel:l=>labels.delete(l)};
  return {office,world,room,seats,layer,labels,scene};
}
// A desk in the room (like office.js makeDesk): a group at (x, z) with the mascot 0.85 in front, facing it.
function desk(parent,x,z,scale=1){
  const d=new THREE.Group();d.position.set(x,0,z);d.scale.setScalar(scale);parent.add(d);
  const m=new THREE.Group();m.position.set(0,0,0.85);m.rotation.y=Math.PI;d.add(m);
  m.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshLambertMaterial({color:'#d97857'})));
  return {d,m};
}
const where=(m)=>{const v=new THREE.Vector3();m.getWorldPosition(v);return v};
// Agents there when the office opens are at their desks; ones that come later walk in (20 ms here).
const spin=ms=>{const end=performance.now()+ms;while(performance.now()<end);};
function run(npcs,seconds,{dt=1/60,t0=0,each}={}){let t=t0;for(let i=0;i<Math.round(seconds/dt);i++){t+=dt;npcs.tick(dt,t);each?.(t)}return t}

test('a seated Chief follows its person, then waits outside a meeting',()=>{
  const obj=new THREE.Group(),people=new Map([['ann',{obj}]]);
  const {office,world}=fakeOffice({people});
  office.meetingAt=(x,z)=>z>3;
  office.inMeeting=()=>office.meetingAt(obj.position.x,obj.position.z);
  const npcs=createNpcs(office),anchor=new THREE.Group();
  world.add(anchor);
  npcs.org({move(){}},[{id:'chief',chief:true,x:-2,z:-1,anchor,still:true}],[]);
  npcs.setFollow('af:chief','ann');
  let t=run(npcs,2);
  assert.equal(npcs.following('af:chief'),true);
  const settled=anchor.position.clone();
  t=run(npcs,3,{t0:t,each:()=>assert.ok(anchor.position.distanceTo(settled)<.15,'the Chief stays beside a stationary owner')});
  obj.position.z=2.5;t=run(npcs,2,{t0:t});
  assert.ok(Math.abs(anchor.position.z-2.5)<1.2,'the Chief settles beside its owner');
  obj.position.z=7;run(npcs,3,{t0:t});
  assert.ok(anchor.position.z<=3&&anchor.position.z>1,'the Chief holds outside the meeting');
  npcs.dispose();
});

test('a new session walks in through its room door to its desk, never faster than a jog',()=>{
  const {office,room}=fakeOffice(),npcs=createNpcs(office);
  // An agent already there when the office opens is simply at its desk.
  const first=desk(room,-3.2,-3.1);npcs.mascot('a1',first.m,{a:{id:'1',status:'running'},member:'ann'});
  run(npcs,0.1);
  const settledAt=where(first.m);assert.ok(Math.abs(settledAt.x+3.2)<0.05&&Math.abs(settledAt.z-(-10-3.1+0.85))<0.05,'the first one sits at its desk');
  // A new one comes in later.
  spin(25);
  const late=desk(room,3.2,-3.1);npcs.mascot('a2',late.m,{a:{id:'2',status:'running'},member:'ann'});
  let p=where(late.m);
  assert.ok(Math.abs(p.x)<0.2&&Math.abs(p.z-(-10+ROOM_D/2+1.3))<0.2,'it appears at the door, not at its desk: '+p.x.toFixed(2)+','+p.z.toFixed(2));
  let prev=p.clone(),maxStep=0,inside=false,t=0.1;
  t=run(npcs,12,{t0:t,each:()=>{const q=where(late.m);maxStep=Math.max(maxStep,q.distanceTo(prev));prev.copy(q);if(q.z<-10+ROOM_D/2-0.5)inside=true;
    // It never walks through the front wall beside the door.
    if(Math.abs(q.z-(-10+ROOM_D/2))<0.15)assert.ok(Math.abs(q.x)<1.5,'through the door at x='+q.x.toFixed(2))}});
  assert.ok(inside,'it went in');
  assert.ok(maxStep<3.6/60+0.02,'no snapping: the largest step in a frame was '+maxStep.toFixed(3));
  p=where(late.m);assert.ok(Math.abs(p.x-3.2)<0.05&&Math.abs(p.z-(-10-3.1+0.85))<0.05,'and it sat down at its desk: '+p.x.toFixed(2)+','+p.z.toFixed(2));
  assert.ok(npcs.working('a2'),'working once seated');
  npcs.dispose();
});

test('getting seated walks to the AgentFlow desk; a finished session waves, walks out and fades',()=>{
  const {office,room,seats,layer,labels}=fakeOffice(),npcs=createNpcs(office);
  const a={id:'1',status:'running'};
  let {d,m}=desk(room,0,-3.1);npcs.mascot('s',m,{a,member:'ann'});
  let t=run(npcs,0.5);
  // Seated: office.js drops its room desk and builds a half-size one beside the agent in the common area.
  d.removeFromParent();
  const at=new THREE.Group();at.position.set(2,0,0);at.rotation.y=-Math.PI/2;seats.add(at);
  const seat=desk(at,0,0,0.5);
  npcs.mascot('s',seat.m,{a:{...a,seat:{agent:'af1',card:{number:3,column:'doing'}}},member:'ann',seated:true,wander:false});
  let p=where(seat.m),prev=p.clone(),maxStep=0;
  assert.ok(p.z<-5,'it starts from where it was, in the room: '+p.z.toFixed(2));
  t=run(npcs,20,{t0:t,each:()=>{const q=where(seat.m);maxStep=Math.max(maxStep,q.distanceTo(prev));prev.copy(q)}});
  assert.ok(maxStep<0.08,'no snapping on the way: '+maxStep.toFixed(3));
  p=where(seat.m);const home=new THREE.Vector3(0,0,0.85).applyMatrix4(seat.d.matrixWorld);
  assert.ok(p.distanceTo(home)<0.06,'at the AgentFlow desk: '+p.toArray().map(x=>x.toFixed(2)));
  assert.ok(Math.abs(seat.m.getWorldScale(new THREE.Vector3()).x-0.5)<0.03,'grown into its half-size desk');
  // Its session ends: office.js clears the desk.
  seat.d.removeFromParent();
  t=run(npcs,0.7,{t0:t});
  assert.equal(seat.m.parent,layer,'its figure stays to walk out');
  assert.ok([...labels].some(l=>l.html.includes('👋')),'it waves');
  t=run(npcs,25,{t0:t});
  assert.equal(npcs.alive('s'),false,'and is gone after walking out');
  assert.equal(seat.m.parent,null,'its figure is removed');
  assert.equal(labels.size,0,'no labels left behind');
  npcs.dispose();
});

test('waiting: it jogs to its person and comes back after',()=>{
  const people=new Map([['ann',{obj:{position:new THREE.Vector3(6,0,2)}}]]);
  const {office,room}=fakeOffice({people}),npcs=createNpcs(office);
  const {m}=desk(room,0,-3.1);npcs.mascot('w',m,{a:{id:'1',status:'running'},member:'ann'});
  let t=run(npcs,0.5);
  npcs.mascot('w',m,{a:{id:'1',status:'waiting'},member:'ann'});
  t=run(npcs,10,{t0:t});
  const p=where(m);assert.ok(p.distanceTo(new THREE.Vector3(6,p.y,2))<1.6,'beside its person: '+p.toArray().map(x=>x.toFixed(2)));
  npcs.mascot('w',m,{a:{id:'1',status:'running'},member:'ann'});
  t=run(npcs,14,{t0:t});
  assert.ok(where(m).distanceTo(new THREE.Vector3(0,0,-10-3.1+0.85))<0.06,'back at its desk');
  npcs.dispose();
});

test('a far layout change fades over instead of sliding or snapping',()=>{
  const {office,room}=fakeOffice(),npcs=createNpcs(office);
  const {m}=desk(room,0,-3.1);npcs.mascot('f',m,{a:{id:'1',status:'running'},member:'ann'});
  let t=run(npcs,0.5),maxStep=0,prev=where(m),hidden=false;
  room.position.set(30,0,-10);room.updateMatrixWorld(true);
  npcs.mascot('f',m,{a:{id:'1',status:'running'},member:'ann'});
  t=run(npcs,3,{t0:t,each:()=>{const q=where(m),mat=m.children[0].material;if(mat.transparent&&mat.opacity<0.05){hidden=true;prev.copy(q)}maxStep=Math.max(maxStep,q.distanceTo(prev));prev.copy(q)}});
  assert.ok(hidden,'it faded out before moving');
  assert.ok(maxStep<0.2,'nothing moved visibly far in one frame: '+maxStep.toFixed(3));
  assert.ok(where(m).distanceTo(new THREE.Vector3(30,0,-10-3.1+0.85))<0.1,'at its desk in the moved room');
  assert.equal(m.children[0].material.opacity??1,1,'fully back');
  npcs.dispose();
});

test('60 characters: a frame of the NPC layer stays cheap',()=>{
  const {office,room,world}=fakeOffice(),npcs=createNpcs(office);
  for(let i=0;i<16;i++){const {m}=desk(room,(i%4-1.5)*2.6,-3.1+Math.floor(i/4)*2.1);npcs.mascot('m'+i,m,{a:{id:String(i),status:i%3?'idle':'running'},member:'ann'})}
  // 44 robots and people in the common area, most of them idle: wandering, chatting, at the board.
  const moves=new Map(),field={move:(id,x,y,z)=>moves.set(id,x+z)},robots=[],humans=[];
  for(let i=0;i<34;i++)robots.push({id:'r'+i,x:(i%7-3)*2.5,z:4+Math.floor(i/7)*2.2,busy:i%4===0});
  for(let i=0;i<10;i++){const f=new THREE.Group();f.userData.rig=null;world.add(f);humans.push({id:'h'+i,obj:f,x:-12+i*2.6,z:16})}
  npcs.org(field,robots,humans);
  let t=run(npcs,30); // let them get going
  const t0=performance.now(),frames=600;t=run(npcs,frames/60,{t0:t});
  const ms=(performance.now()-t0)/frames,s=npcs.stats();
  console.log(`# NPC layer: ${s.npcs} characters, ${s.walking} walking, ${ms.toFixed(3)} ms per frame (grid ${s.nav.w}x${s.nav.h})`);
  assert.equal(s.npcs,60);
  assert.ok(ms<2.5,`${ms.toFixed(3)} ms per frame`);
  assert.ok(moves.size===34,'every robot is placed by the field');
  npcs.dispose();
});

test('a person standing in the way is walked round, not pushed against',()=>{
  const {office,room,seats}=fakeOffice();
  // The player stands right on the line between the room's door and the AgentFlow desk.
  office.player=()=>({x:0,z:-2.5});
  const npcs=createNpcs(office);
  const a={id:'1',status:'running'};
  let {d,m}=desk(room,0,-3.1);npcs.mascot('p',m,{a,member:'ann'});
  let t=run(npcs,0.5);
  d.removeFromParent();
  const at=new THREE.Group();at.position.set(0,0,4);at.rotation.y=-Math.PI/2;seats.add(at);
  const seat=desk(at,0,0,0.5);
  npcs.mascot('p',seat.m,{a:{...a,seat:{agent:'af1'}},member:'ann',seated:true,wander:false});
  t=run(npcs,25,{t0:t});
  const home=new THREE.Vector3(0,0,0.85).applyMatrix4(seat.d.matrixWorld);
  assert.ok(where(seat.m).distanceTo(home)<0.06,'it reached the desk: '+where(seat.m).toArray().map(x=>x.toFixed(2)));
  npcs.dispose();
});

test('several at one spot: each settles close by instead of jostling for it',()=>{
  const {office,room}=fakeOffice(),npcs=createNpcs(office);
  // Three robots that all want the same board spot, and a fourth standing on it.
  const robots=[0,1,2,3].map(i=>({id:'r'+i,x:-3+i*2,z:3,busy:false}));
  npcs.org({move(){}},robots,[]);
  let t=run(npcs,0.5);
  for(const n of npcs.npcs.values()){n.intent.goal='board';n.intent.spot=0.5;n.intent.rev+=100;n.brain.update=()=>n.intent}
  t=run(npcs,20,{t0:t});
  for(const n of npcs.npcs.values()){assert.ok(n.arrived&&!n.walking,n.key+' settled');assert.ok(Math.hypot(n.x,n.z-(-1))<2,n.key+' near the board: '+n.x.toFixed(2)+','+n.z.toFixed(2))}
  npcs.dispose();
});
