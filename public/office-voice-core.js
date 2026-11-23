// The 3D office's voice (office-voice.js), the parts without a browser: where the meeting room is, who is in
// it, whom to call, and how loud and from which side a nearby voice sounds. Tested by node.
//
//   meetingAnchors({world, rooms, commonR, roomW, roomD})  -> [{id, name, x, y, z, facing, w, d, glass}]
//       The world's own (world.meetingAnchors(): the classic office's glass room beside reception;
//       glass:false when the world draws the room itself). A world without them has no meeting room (proximity
//       voice still works there). With no world at all: one glass room in the widest gap of the ring of rooms.
//   insideAnchor(anchor, x, z, margin)    in that room's floor (a margin > 0 grows it, < 0 shrinks it)
//   roomAt(anchors, x, z, current)        which room's call someone standing there is in, with hysteresis
//   roomReduce(state, event)              the room membership state machine (below)
//   wantedPeers(me, peers, distance, connected, opts)   the peers to be in a call with
//   proximityMix(listener, source, opts)  -> {gain, pan, distance} for a nearby voice
//   roomCount(peers, room)                how many connections are in a room's call

export const PROXIMITY_RANGE=6;   // metres: nearby voices fade out to nothing here
export const PROXIMITY_KEEP=8;    // an open proximity call stays up until this far, so walking the edge does not flap
export const PROXIMITY_FULL=1.5;  // full volume this close
export const MEETING={id:'meeting',name:'Meeting room',w:9,d:7};
const EDGE=0.45;                  // metres of hysteresis at a meeting room's walls

// Rooms sit in a ring around the common area (office.js layout): the meeting room goes in the widest gap,
// just outside the ring when the gap is too narrow for it, with its door towards the middle.
export function meetingAnchors({world,rooms=[],commonR=10,roomW=12,roomD=9}={}){
  if(world&&typeof world.meetingAnchors!=='function')return [];
  const own=world?world.meetingAnchors():null;
  if(Array.isArray(own))return own.filter(a=>a&&Number.isFinite(a.x)&&Number.isFinite(a.z)).map(a=>({...MEETING,glass:false,facing:0,...a}));
  const {w,d}=MEETING;
  const ring=rooms.length?Math.hypot(rooms[0].x,rooms[0].z):Math.max(17,commonR+roomD/2+5);
  const angles=rooms.map(r=>Math.atan2(r.z,r.x)).sort((a,b)=>a-b);
  let at=Math.PI/2,gap=2*Math.PI;
  if(angles.length===1)at=angles[0]+Math.PI;
  else if(angles.length>1){
    gap=0;
    angles.forEach((a,i)=>{const b=i+1<angles.length?angles[i+1]:angles[0]+2*Math.PI;if(b-a>gap){gap=b-a;at=(a+b)/2}});
  }
  // The gap's width where the ring's inner wall is, less a room on each side.
  const inner=ring-roomD/2,free=angles.length<2?Infinity:2*inner*Math.sin(Math.min(Math.PI/2,gap/2))-roomW;
  const r=free>=w+3?ring:ring+roomD/2+d/2+2;
  const x=Math.cos(at)*r,z=Math.sin(at)*r;
  return [{...MEETING,x:round(x),z:round(z),facing:Math.atan2(-x,-z),glass:true}];
}
const round=n=>Math.round(n*1000)/1000;
// Room-local coordinates: the group is turned by facing about y (as office.js turns rooms), its door at local +z.
export function toLocal(a,x,z){
  const dx=x-a.x,dz=z-a.z,c=Math.cos(a.facing||0),s=Math.sin(a.facing||0);
  return {x:dx*c-dz*s,z:dx*s+dz*c};
}
export function toWorld(a,x,z){
  const c=Math.cos(a.facing||0),s=Math.sin(a.facing||0);
  return {x:a.x+x*c+z*s,z:a.z-x*s+z*c};
}
export function insideAnchor(a,x,z,margin=0){
  if(!a||!Number.isFinite(x)||!Number.isFinite(z))return false;
  const p=toLocal(a,x,z);
  return Math.abs(p.x)<=a.w/2+margin&&Math.abs(p.z)<=a.d/2+margin;
}
// You join a room's call a little way inside its walls and leave it a little way outside them.
export function roomAt(anchors,x,z,current=''){
  const here=current&&anchors.find(a=>a.id===current);
  if(here&&insideAnchor(here,x,z,EDGE))return current;
  return anchors.find(a=>insideAnchor(a,x,z,-EDGE))?.id||'';
}

// The room membership state machine. state: {phase, room, mic}
//   phase  'out'     not in a room's call
//          'asking'  walked in; waiting for the microphone (the browser may be asking permission)
//          'in'      in the call (mic 'on', or 'denied': listening only)
//   events {type:'enter', room}  {type:'exit'}  {type:'mic', ok}  {type:'suspend'} (tab hidden too long, office closing)
// announce(state) is the room to tell the others about ('' unless in): peers call you once you are in.
export const ROOM_OUT={phase:'out',room:'',mic:'unknown'};
export function roomReduce(s=ROOM_OUT,ev={}){
  switch(ev.type){
    case 'enter':
      if(!ev.room)return roomReduce(s,{type:'exit'});
      if(s.phase!=='out'&&s.room===ev.room)return s;
      return {phase:s.mic==='on'||s.mic==='denied'?'in':'asking',room:ev.room,mic:s.mic};
    case 'mic':
      if(s.phase==='out')return {...s,mic:ev.ok?'on':'denied'};
      return {phase:'in',room:s.room,mic:ev.ok?'on':'denied'};
    case 'exit':return s.phase==='out'?s:{phase:'out',room:'',mic:s.mic};
    case 'suspend':return {phase:'out',room:'',mic:s.mic==='on'?'unknown':s.mic};
    default:return s;
  }
}
export const announce=s=>s.phase==='in'?s.room:'';

// me / peers: voice states {peer, key, room, near, dnd}; distance(peer) -> metres or null (not in sight).
// A room's call: everyone in the same room. Proximity: both have it on, both outside rooms, nobody in Do not
// disturb, nearer than range (or keep, for a call already up).
export function wantedPeers(me,peers,distance,connected=new Set(),{range=PROXIMITY_RANGE,keep=PROXIMITY_KEEP}={}){
  const out=new Set();if(!me)return out;
  for(const p of peers){
    if(!p||p.peer===me.peer||p.key&&p.key===me.key)continue; // never your own other tab: it would echo
    if(me.room||p.room){if(me.room&&p.room===me.room)out.add(p.peer);continue}
    if(!me.near||!p.near||me.dnd||p.dnd)continue;
    const d=distance(p);if(d==null||!Number.isFinite(d))continue;
    if(d<range||connected.has(p.peer)&&d<keep)out.add(p.peer);
  }
  return out;
}

// How a nearby voice sounds: full volume within PROXIMITY_FULL, fading to silence at range; pan -1 (left) to
// 1 (right) by where they stand relative to where you face. listener {x, z, heading}: facing (sin h, cos h),
// as office-interact.js reads headings; your right is then (-cos h, sin h).
export function proximityMix(listener,source,{range=PROXIMITY_RANGE,full=PROXIMITY_FULL}={}){
  const dx=source.x-listener.x,dz=source.z-listener.z,d=Math.hypot(dx,dz);
  const t=Math.min(1,Math.max(0,(d-full)/Math.max(0.01,range-full))),gain=d>=range?0:(1-t)*(1-t);
  const h=Number.isFinite(listener.heading)?listener.heading:0;
  const pan=d<0.25?0:Math.max(-1,Math.min(1,(dx*-Math.cos(h)+dz*Math.sin(h))/d));
  return {gain:round(gain),pan:round(pan),distance:d};
}
export const roomCount=(peers,room)=>room?peers.filter(p=>p.room===room).length:0;
// Polite peer in "perfect negotiation": on an offer collision the polite side yields. The other side opens calls.
export const isPolite=(mine,theirs)=>String(mine)>String(theirs);
