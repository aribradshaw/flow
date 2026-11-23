// The 3D office's voice without a browser (public/office-voice-core.js): proximity gain and pan, the meeting
// room's place, room membership with hysteresis, the room membership state machine, and whom to call.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {proximityMix,meetingAnchors,insideAnchor,roomAt,roomReduce,announce,ROOM_OUT,wantedPeers,roomCount,toLocal,toWorld,isPolite,
  PROXIMITY_RANGE,PROXIMITY_KEEP,MEETING} from '../public/office-voice-core.js';

const near=(a,b,eps=1e-3)=>assert.ok(Math.abs(a-b)<eps,`${a} ≈ ${b}`);

test('proximity: full volume up close, fading to silence at the range; panned by side',()=>{
  const me={x:0,z:0,heading:0}; // facing +z; your right is -x
  assert.equal(proximityMix(me,{x:0,z:1}).gain,1);
  assert.equal(proximityMix(me,{x:0,z:PROXIMITY_RANGE}).gain,0);assert.equal(proximityMix(me,{x:0,z:20}).gain,0);
  const g=[2,3,4,5].map(d=>proximityMix(me,{x:0,z:d}).gain);
  for(let i=1;i<g.length;i++)assert.ok(g[i]<g[i-1],'falls off with distance');
  assert.ok(g.every(x=>x>0&&x<1));
  near(proximityMix(me,{x:-3,z:0}).pan,1);near(proximityMix(me,{x:3,z:0}).pan,-1);near(proximityMix(me,{x:0,z:3}).pan,0);
  near(proximityMix(me,{x:0,z:-3}).pan,0,1e-9);
  // Facing -z (heading π, as the camera looks by default): your right is +x.
  near(proximityMix({x:0,z:0,heading:Math.PI},{x:3,z:0}).pan,1);
  near(proximityMix({x:0,z:0,heading:Math.PI/2},{x:0,z:2}).pan,1,1e-9); // facing +x: your right is +z
  // Diagonal: halfway between centre and side.
  near(proximityMix(me,{x:-2,z:2}).pan,Math.SQRT1_2);
  assert.equal(proximityMix(me,{x:0.1,z:0}).pan,0,'standing on top of you: centred');
  assert.equal(proximityMix({x:0,z:0},{x:-3,z:0}).pan,1,'no heading counts as facing +z');
});

test('the meeting room: the world\'s own anchor; with no world, a glass room in the widest gap of the ring',()=>{
  const lounge={id:'lounge',name:'Lounge',x:4,z:-8,w:6,d:5};
  assert.deepEqual(meetingAnchors({world:{meetingAnchors:()=>[lounge]}}),[{...MEETING,glass:false,facing:0,...lounge}]);
  assert.deepEqual(meetingAnchors({world:{meetingAnchors:()=>[]}}),[],'a world may have none');
  assert.deepEqual(meetingAnchors({world:{id:'yacht'},rooms:[{x:0,z:-20}]}),[],'a world without the hook: no meeting room, never one in the sea');
  const ring=(n,R)=>Array.from({length:n},(_,i)=>{const a=-Math.PI/2+i/n*Math.PI*2;return {x:Math.cos(a)*R,z:Math.sin(a)*R}});
  // One room (north): the meeting room is opposite it, door facing the middle.
  const [one]=meetingAnchors({rooms:ring(1,19.5)});
  near(one.x,0);near(one.z,19.5);assert.equal(one.glass,true);
  const door=toWorld(one,0,1);assert.ok(Math.hypot(door.x,door.z)<Math.hypot(one.x,one.z),'local +z (its door) faces the middle');
  for(const n of [2,3,5,8,14,30]){
    const R=Math.max(19.5,n*15/(2*Math.PI)+6),rooms=ring(n,R),[m]=meetingAnchors({rooms});
    // Never on top of a member's room (12 x 9, as a disc of their half diagonal).
    for(const r of rooms)assert.ok(Math.hypot(m.x-r.x,m.z-r.z)>7.5+5.7-0.5,`n=${n}: clear of rooms`);
    assert.ok(Math.hypot(m.x,m.z)>=R-0.01,'not in the common area');
  }
  assert.equal(meetingAnchors({})[0].glass,true,'no rooms yet: still somewhere');
});

test('room membership: in a little way past the wall, out a little way past it; turned rooms too',()=>{
  const a={id:'meeting',x:10,z:0,w:8,d:6,facing:Math.PI/2};
  const p=toLocal(a,...Object.values(toWorld(a,1.5,-2)));near(p.x,1.5);near(p.z,-2);
  assert.ok(insideAnchor(a,10,0));
  const at=(x,z)=>toWorld(a,x,z);
  assert.ok(insideAnchor(a,at(3.9,0).x,at(3.9,0).z));assert.ok(!insideAnchor(a,at(4.2,0).x,at(4.2,0).z));
  const list=[a];
  let room='';
  for(const [lz,expect] of [[4,''],[3.2,''],[2.4,'meeting'],[3.2,'meeting'],[3.4,'meeting'],[3.6,''],[3,'']]){
    const w=at(0,lz);room=roomAt(list,w.x,w.z,room);assert.equal(room,expect,`at local z=${lz}`);
  }
  assert.equal(roomAt(list,NaN,0,''),'');
});

test('the room membership state machine: ask for the mic once, listen when it is refused, leave on the way out',()=>{
  let s=ROOM_OUT;
  s=roomReduce(s,{type:'enter',room:'meeting'});assert.deepEqual(s,{phase:'asking',room:'meeting',mic:'unknown'});assert.equal(announce(s),'','not announced while asking');
  assert.equal(roomReduce(s,{type:'enter',room:'meeting'}),s,'still inside: nothing changes');
  s=roomReduce(s,{type:'mic',ok:true});assert.deepEqual(s,{phase:'in',room:'meeting',mic:'on'});assert.equal(announce(s),'meeting');
  s=roomReduce(s,{type:'exit'});assert.deepEqual(s,{phase:'out',room:'',mic:'on'});
  s=roomReduce(s,{type:'enter',room:'meeting'});assert.equal(s.phase,'in','the mic is already on: straight in');
  s=roomReduce(s,{type:'enter',room:'lounge'});assert.deepEqual(s,{phase:'in',room:'lounge',mic:'on'},'from one room to the next');
  s=roomReduce(s,{type:'enter',room:''});assert.equal(s.phase,'out');
  s=roomReduce(s,{type:'suspend'});assert.deepEqual(s,{phase:'out',room:'',mic:'unknown'},'suspended: the mic is released and asked for again');
  let d=roomReduce(ROOM_OUT,{type:'enter',room:'meeting'});d=roomReduce(d,{type:'mic',ok:false});
  assert.deepEqual(d,{phase:'in',room:'meeting',mic:'denied'},'refused: in the call, listening only');
  d=roomReduce(roomReduce(d,{type:'exit'}),{type:'enter',room:'meeting'});assert.equal(d.phase,'in','not asked again');
  assert.equal(roomReduce(d,{type:'nonsense'}),d);
});

test('whom to call: the same room, or nearby with proximity on and nobody in Do not disturb',()=>{
  const me={peer:'m',room:'',near:true,dnd:false};
  const peers=[me,{peer:'a',near:true},{peer:'b',near:true},{peer:'c',near:false},{peer:'d',near:true,dnd:true},{peer:'e',near:true,room:'meeting'},{peer:'f',near:true}];
  const dist={a:2,b:7,c:1,d:1,e:1,f:null};
  const want=(m,conn)=>[...wantedPeers(m,peers,p=>dist[p.peer],conn)].sort();
  assert.deepEqual(want(me),['a']);
  assert.deepEqual(want(me,new Set(['b'])),['a','b'],'a call already up stays up until '+PROXIMITY_KEEP+' m');
  dist.b=PROXIMITY_KEEP+0.5;assert.deepEqual(want(me,new Set(['b'])),['a']);
  assert.deepEqual(want({...me,dnd:true}),[],'you in Do not disturb: nobody');
  assert.deepEqual(want({...me,near:false}),[],'proximity off');
  const inRoom={peer:'m',room:'meeting',near:false};
  assert.deepEqual(want(inRoom),['e'],'in the room: everyone in it, however far, and only them');
  assert.equal(roomCount(peers,'meeting'),1);assert.equal(roomCount([...peers,inRoom],'meeting'),2);assert.equal(roomCount(peers,''),0);
  assert.notEqual(isPolite('a','b'),isPolite('b','a'),'exactly one side is polite');
});
