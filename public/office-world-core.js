// Layout math for the 3D office's worlds (docs/concepts/12-office.md). No Three.js here, so node can
// import it for tests; public/office-world.js and office-world-yacht.js draw what this file lays out.
//
// A world lays out the same things whatever it looks like (the shape office-layout.js gives the classic
// office): rooms [{key, x, y, z, facing}], the main board's wall, boardAnchors(), meterAnchors(), and a radius. A world
// with decks adds: ground(x, z) (the floor's height at a point, null where there is none), walls (the
// boxes that stop people and the camera), spawn, respawn(pos), signs and doors(portals).
//
// Every world is a heightfield: a point (x, z) has one floor height or none. Decks are terraced, never
// stacked. So a box is solid from its top down, a wall between two heights stops walkers on both of
// them, and office-controls.js needs only ground() to walk the decks and the stairs between them.
import {officeBox} from './office-controls.js';
import {classicLayout,toWorld,roomMeterMount,officeMeterMount,ROOM_W,ROOM_D,WALL_T,ROOM_BOARD,MAIN_WALL_T} from './office-layout.js';
import {orgTeams,seatTables,TABLE} from './office-tables-core.js';
export {ROOM_W,ROOM_D};

export const WORLDS=[{id:'classic',name:'🏢 Office'},{id:'yacht',name:'🛥️ Yacht'}];
export const DEFAULT_WORLD='classic';
export const worldId=v=>WORLDS.some(w=>w.id===v)?v:DEFAULT_WORLD;
export const BODY=0.38;

const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const lerp=(a,b,t)=>a+(b-a)*clamp(t,0,1);

// An oriented box as office-controls.js reads it (officeBox: height is its top, measured from zero), plus
// the height it stands on (y), what it is (kind) and its turn (yaw), which the yacht draws its rails from.
export function wallBox(x,z,yaw,width,depth,tall,y=0,kind='wall'){
  return Object.assign(officeBox(x,z,yaw,width,depth,y+tall),{y,kind,yaw});
}
// A box along the segment (x1,z1)-(x2,z2), `thick` wide.
function along(x1,z1,x2,z2,thick,height,y,kind){
  const dx=x2-x1,dz=z2-z1;return wallBox((x1+x2)/2,(z1+z2)/2,Math.atan2(-dz,dx),Math.hypot(dx,dz),thick,height,y,kind);
}
// Push a standing body (a circle of radius r) out of a box, along the side it is least far into.
export function pushOut(p,b,r=BODY){
  const ox=p.x-b.x,oz=p.z-b.z,lx=ox*b.c-oz*b.s,lz=ox*b.s+oz*b.c,ex=b.halfX+r,ez=b.halfZ+r;
  if(Math.abs(lx)>=ex||Math.abs(lz)>=ez)return false;
  let nx=lx,nz=lz;
  if(ex-Math.abs(lx)<ez-Math.abs(lz))nx=(lx<0?-1:1)*ex;else nz=(lz<0?-1:1)*ez;
  p.x=b.x+nx*b.c+nz*b.s;p.z=b.z-nx*b.s+nz*b.c;return true;
}
// A reference walker for tests: from `from` towards `to`, sliding along boxes whatever their height
// (the app walks with office-controls.js, which also jumps). world.open(x,z) says where stepping off is allowed.
export function stepIn(world,from,to,walls=world.walls,r=BODY){
  const dist=Math.hypot(to.x-from.x,to.z-from.z),n=Math.max(1,Math.ceil(dist/0.3)),dx=(to.x-from.x)/n,dz=(to.z-from.z)/n;
  let p={x:from.x,z:from.z};
  for(let i=0;i<n;i++){
    const q={x:p.x+dx,z:p.z+dz};
    for(let k=0;k<3;k++){let hit=false;for(const b of walls)hit=pushOut(q,b,r)||hit;if(!hit)break}
    // Off the deck: only where the world leaves it open, and the walk ends there (they fall).
    if(world.ground(q.x,q.z)===null&&world.ground(p.x,p.z)!==null){if(world.open(q.x,q.z))p=q;break}
    p=q;
  }
  return p;
}
// Walls as the camera sees them from a floor height: a box only matters for what stands above that floor.
export function wallsFrom(walls,floor){
  const out=[];
  for(const b of walls){const h=(b.cam??b.height)-floor;if(h>0.12)out.push({x:b.x,z:b.z,c:b.c,s:b.s,halfX:b.halfX,halfZ:b.halfZ,height:h})}
  return out;
}
const nearest=(points,p)=>points.reduce((best,q)=>Math.hypot(q.x-p.x,q.z-p.z)<Math.hypot(best.x-p.x,best.z-p.z)?q:best);

// ---------- classic: office-layout.js's floor plan, on one flat floor ----------
const keysOf=n=>Array.isArray(n)?n:Array.from({length:Math.max(0,n|0)},(_,i)=>'m'+i);
// opts.org: the AgentFlow agents, for the pods in the open-plan core; opts.name: the office's name, for its sign.
export function classicWorld(members,opts={}){
  const layout=classicLayout(keysOf(members),opts),b=layout.bounds,spawn=layout.spawn;
  // cam: how high a box stops the camera (glass and the fading outer walls: not at all).
  const walls=layout.walls.map(w=>Object.assign(wallBox(w.x,w.z,w.yaw,w.w,w.d,w.h,0,w.kind),{cam:w.cam}));
  const inside=(x,z)=>x>=b.minX&&x<=b.maxX&&z>=b.minZ&&z<=b.maxZ;
  const world={...layout,id:'classic',rooms:layout.rooms.map(r=>({...r,y:0})),walls,plain:layout.walls,sea:-Infinity,
    // What the scenery is built from: when this is the same, nothing moved.
    sig:JSON.stringify([String(opts.name||''),layout.halfWidth,layout.coreDepth,layout.rooms.map(r=>[r.x,r.z]),layout.bays.map(x=>x.type),layout.pods.map(p=>[p.id,p.name,p.x,p.z,p.w,p.d,p.tables.map(t=>t.seats)])]),
    ground:(x,z)=>Number.isFinite(x)&&Number.isFinite(z)&&inside(x,z)?0:null,open:()=>false,respawn:()=>({...spawn})};
  world.step=(from,to,all=walls)=>stepIn(world,from,to,all);
  return world;
}

// ---------- yacht ----------
// A compact superyacht: about 68 long and 14 in the beam, the same hull however big the AgentFlow org is.
// Bow at -z, stern at +z, starboard at +x. Two decks people use:
//   main deck (height 0)  the lounge: the main board on the forward bulkhead, the org at team tables either
//                         side of a centre aisle (office-tables-core.js), the glass meeting room aft, and the
//                         swim platform astern, down a few steps
//   upper deck            one stair up from the lounge's starboard forward corner: a suite per member in a
//                         single file, each door on the one starboard corridor, the owner's bridge furthest
//                         forward; the corridor ends in a few steps down to the sun deck on the bow
// Only more members make it longer: one suite's length each, from the third member on.
export const YACHT={MAIN:0,SWIM:-1.5,UPPER:2.6,FORE:1.3,SEA:-2.4,RAIL:1.05,EDGE:0.6,HB:7};
export function yachtWorld(members,opts={}){
  const keys=keysOf(members),n=Math.max(1,keys.length),roomW=ROOM_W,roomD=ROOM_D;
  const {MAIN,SWIM,UPPER,FORE,SEA,RAIL,EDGE,HB}=YACHT,T=0.24,E=HB-EDGE;
  const zL0=-9.5,zL1=14.6;                                   // lounge: forward bulkhead, aft rail
  const swimRamp=2.8,zSw=zL1+6.2;                            // steps down to the swim platform, its aft edge
  const stairX=4.2,upRamp=4.8;                               // the stair up: its inboard edge, its length
  const pitch=roomW+0.8,slots=Math.max(2,n);                 // suites in a file; a solo owner has a sun terrace in the first place
  const zC1=zL0-0.4,zB0=zC1-(slots-1)*pitch-roomW-0.4;       // suites' aft end; the bridge's front
  const foreRamp=2.6,bow=13,zBow=zB0-bow;
  const cx=-(E-0.2-roomD/2);                                 // rooms stand to port, their tall back walls on the hull side
  const meet={x:0,z:10.7,w:9,d:7};                           // the meeting room, its door forward
  const zone={aisle:1.1,reach:E-0.35,front:-3.5,back:5.2,forward:1};
  // Half beam of the hull at z: full amidships, fining to the stem, a little tumblehome at the stern.
  const halfBeam=z=>z<zBow||z>zSw?0:z<zB0?HB*(1-((zB0-z)/bow)**2.2):z>zL1?HB-1.2*((z-zL1)/(zSw-zL1))**2:HB;
  function ground(x,z){
    if(!Number.isFinite(x)||!Number.isFinite(z))return null;
    const ax=Math.abs(x),edge=halfBeam(z)-EDGE;
    if(ax>edge)return null;
    if(z>zL1){
      if(z>zSw-0.2)return null;
      return ax>=stairX&&z<=zL1+swimRamp?lerp(MAIN,SWIM,(z-zL1)/swimRamp):SWIM;
    }
    if(z>=zL0)return MAIN;
    if(z>=zB0)return x>=stairX&&z>=zL0-upRamp?lerp(MAIN,UPPER,(zL0-z)/upRamp):UPPER;
    if(edge<0.5)return null;
    return x>=stairX&&z>=zB0-foreRamp?lerp(UPPER,FORE,(zB0-z)/foreRamp):FORE;
  }
  // Stepping off is possible only from the aft end of the swim platform, which has no rail.
  const open=(x,z)=>z>zL1+swimRamp+0.2;

  // ----- rooms: the owner (first) has the bridge, furthest forward; everyone else a suite, from the stair forward -----
  const slotZ=i=>zC1-roomW/2-i*pitch,place=(key,i,kind)=>({key,x:cx,y:UPPER,z:slotZ(i),facing:Math.PI/2,kind});
  const rooms=[place(keys[0],slots-1,'bridge')];
  for(let i=1;i<n;i++)rooms.push(place(keys[i],i-1,'cabin'));
  // A suite place nobody has: an open sun terrace.
  const spare=[];for(let i=n-1;i<slots-1;i++)spare.push({x:cx,y:UPPER,z:slotZ(i),facing:Math.PI/2});

  // ----- collision: rails, bulkheads and the big furniture -----
  const walls=[];
  // slope: the heights a handrail starts and ends at, where it follows stairs (for drawing).
  const rail=(x1,z1,x2,z2,y,kind='rail',tall=RAIL,slope=null)=>walls.push(Object.assign(along(x1,z1,x2,z2,T,tall,y,kind),slope?{slope}:{}));
  const e=E+T/2,hb=z=>halfBeam(z)-EDGE+T/2;
  for(const s of [-1,1]){
    rail(s*e,zL0,s*e,zL1,MAIN,'bulwark');                                                   // lounge sides
    rail(s*e,zB0,s*e,zL0,UPPER);                                                            // upper deck sides
    // the bow, following the taper
    const seg=7;for(let i=0;i<seg;i++){
      const za=zB0-(bow-1.2)*i/seg,zb=zB0-(bow-1.2)*(i+1)/seg;
      rail(s*hb(za),za,s*Math.max(0.2,hb(zb)),zb,FORE,'bulwark');
    }
    // steps down to the swim platform: the hull's side outboard, a rail inboard
    rail(s*e,zL1,s*hb(zL1+swimRamp),zL1+swimRamp,SWIM,'wing',MAIN-SWIM+RAIL-0.2);
    rail(s*(stairX-T/2),zL1,s*(stairX-T/2),zL1+swimRamp-1,SWIM,'rail',MAIN-SWIM+RAIL-0.5,[MAIN,lerp(MAIN,SWIM,1-1/swimRamp)]);
  }
  rail(-stairX,zL1,stairX,zL1,SWIM,'transom',MAIN-SWIM+RAIL);                                // the lounge's aft rail over the swim platform
  rail(-e,zL0,stairX,zL0,MAIN,'bulkhead',UPPER-MAIN+RAIL);                                   // the lounge's forward bulkhead, the upper deck's rail on top
  rail(stairX-T/2,zL0-upRamp,stairX-T/2,zL0,MAIN,'rail',UPPER-MAIN+RAIL);                    // the stair's inboard side
  rail(-e,zB0,stairX,zB0,FORE,'block',UPPER-FORE+RAIL);                                      // the bridge front over the sun deck
  rail(stairX-T/2,zB0-foreRamp+0.9,stairX-T/2,zB0,FORE,'rail',UPPER-FORE+RAIL,[lerp(UPPER,FORE,1-0.9/foreRamp),UPPER]);
  rail(hb(zB0),zB0,hb(zB0-foreRamp),zB0-foreRamp,FORE,'rail',UPPER-FORE+RAIL,[UPPER,FORE]);  // and its outboard side, as high as the stair
  const zBreak=zB0-10;rail(-hb(zBreak),zBreak,hb(zBreak),zBreak,FORE,'bulwark');              // a breakwater: the bow's tip, ahead of it, is for sunbathing
  // between two suites: a low hedge, so the gap is not a blind alley
  for(let i=0;i<slots-1;i++)walls.push(wallBox(cx,zC1-i*pitch-roomW-(pitch-roomW)/2,0,roomD,pitch-roomW-0.22,1.2,UPPER,'hedge'));
  const sofa={x:-(E-0.75),z:zL0+2.6,w:1,d:3.2};
  walls.push(wallBox(sofa.x,sofa.z,0,sofa.w,sofa.d,0.9,MAIN,'sofa'));                         // a sofa to port of the main board
  const tub={x:0.2,z:zB0-6.3,r:1.3};
  walls.push(wallBox(tub.x,tub.z,0,tub.r*2,tub.r*2,0.75,FORE,'tub'));                         // the sun deck's hot tub
  for(const s of [-1,1])walls.push(wallBox(s*1.9,zSw-1.6,0,1.2,2.5,0.9,SWIM,'jetski'));

  // The main board hangs on its own wall in front of the forward bulkhead, facing the tables; each room's
  // board hangs on its tall back wall (the hull side).
  const OFF=0.07,wallW=10.3,wallH=4.3,boardW=8.2;
  const mainWall={x:(stairX-0.2-E)/2+0.02,y:MAIN,z:zL0+0.45,facing:0,width:wallW,depth:MAIN_WALL_T,height:wallH,planters:false};
  const mount=(frame,lx,lz,size)=>{const p=toWorld(frame,lx,lz);return {x:p.x,y:frame.y+size.y,z:p.z,nx:Math.sin(frame.facing),nz:Math.cos(frame.facing),width:size.width,height:size.height}};
  const boardAnchors=()=>({rooms:rooms.map(r=>({key:r.key,...mount(r,0,-roomD/2+WALL_T/2+OFF,ROOM_BOARD)})),
    main:mount(mainWall,0,MAIN_WALL_T/2+OFF,{width:boardW,height:3.25,y:2.3})});
  const meterAnchors=()=>({rooms:rooms.map(r=>({key:r.key,...roomMeterMount(r)})),main:officeMeterMount(mainWall,boardW)});
  // The glass meeting room at the lounge's aft end (office-voice.js draws it), its door towards the tables.
  const meetingAnchors=()=>[{id:'meeting',name:'Meeting room',x:meet.x,y:MAIN,z:meet.z,facing:Math.PI,w:meet.w,d:meet.d,glass:true}];
  // Doors to other offices: along the transom on the swim platform (you arrive by tender), then on the sun deck:
  // under the bridge front, then down its sides.
  const side=(s,off)=>{const z=zB0-off;return {x:s*(halfBeam(z)-EDGE-1.3),y:FORE,z,facing:-s*Math.PI/2}};
  const fore=[...[-4.6,-2.1,0.4].map(x=>({x,y:FORE,z:zB0-0.75,facing:Math.PI})),side(-1,3.3),side(1,4.4),side(-1,5.65),side(1,6.6),side(-1,8),side(1,8.7)];
  function doors(portals){
    const list=(Array.isArray(portals)?portals:[]).filter(p=>p&&typeof p.env==='string'&&p.env).slice(0,12);
    const aft=Math.min(list.length,3);
    return list.map((portal,i)=>i<aft?{portal,x:(i-(aft-1)/2)*2.7,y:SWIM,z:zL1+1.1,facing:0}:{portal,...fore[i-aft]});
  }
  const mid=(zBow+zSw)/2;
  const spots=[{x:0,y:SWIM,z:zL1+4,heading:Math.PI},{x:0,y:MAIN,z:6.1,heading:Math.PI},{x:stairX+1,y:UPPER,z:zL0-upRamp-1.5,heading:Math.PI},{x:stairX+1,y:UPPER,z:zB0+2,heading:0},{x:2.6,y:FORE,z:zB0-4,heading:Math.PI}];
  // Where to stand at each place, for "Go to…" and the minimap (office-travel.js), in the shape office-layout.js
  // gives the classic office. The places office.js knows itself (rooms, the main board, the meeting room) are not
  // listed. at: where its name goes on the minimap; short: a shorter name for it there.
  const places=()=>[{id:'lounge',kind:'lounge',name:'Lounge',x:0,z:6.1,heading:Math.PI,at:{x:0,z:0.6}},{id:'sundeck',kind:'deck',name:'Sun deck',x:2.6,z:zB0-4,heading:Math.PI,at:{x:0,z:zB0-7.5}},
    {id:'beach',kind:'deck',name:'Beach club',short:'Beach',x:0,z:zL1+4.2,heading:0}];
  const world={id:'yacht',rooms,spare,walls,mainWall,boardAnchors,meterAnchors,meetingAnchors,doors,sea:SEA,center:{x:0,z:mid},radius:(zSw-zBow)/2+3,
    bounds:{minX:-HB,maxX:HB,minZ:zBow,maxZ:zSw},spawn:spots[1],entrance:{x:spots[1].x,z:spots[1].z},places,names:{room:'suite',owner:'Bridge'},
    // People arrive in the lounge, not at their own door; the camera starts further out and higher than usual.
    arriveAtSpawn:true,view:{zoom:7.6,pitch:0.5},
    // Idle characters of the common area gather by the sofa and at the lounge's aft end (office-npc.js).
    lounge:[...[-1.1,0,1.1].map(dz=>({x:sofa.x+1.25,z:sofa.z+dz,fx:sofa.x,fz:sofa.z+dz})),...[-3.4,3.4].map(x=>({x,z:zone.back+1,fx:x,fz:zL0}))],
    signs:[{x:stairX+1.1,y:2.35,z:zL0+2.6,text:'Lounge'},{x:mainWall.x,y:wallH+0.55,z:mainWall.z,text:'Main board'},{x:stairX+1.1,y:UPPER+2.5,z:zL0-upRamp,text:'Suites ↑'},
      {x:cx+roomD/2+0.2,y:UPPER+3.2,z:slotZ(slots-1),text:'Bridge'},{x:2,y:FORE+2.6,z:zB0-foreRamp-1.5,text:'Sun deck'},{x:0,y:SWIM+3,z:zL1+0.3,text:'Beach club'}],
    // The solid parts a camera must not be inside: the upper deck's block and the bow under the sun deck.
    masses:[wallBox(0,(zB0+zL0)/2,0,HB*2,zL0-zB0,UPPER-0.2,0,'mass'),wallBox(0,(zBow+zB0)/2,0,HB*2,zB0-zBow,FORE-0.2,0,'mass')],
    ground,open,halfBeam,
    step:(from,to,all=walls)=>stepIn(world,from,to,all),
    // What office-controls.js walks on: the deck's height, the sea bed where there is none, and how far out is still the world.
    terrain:{ground,floor:SEA-6,limit:Math.hypot(HB,Math.max(zSw,-zBow))+40},
    // Back on deck: the nearest safe spot, so a swimmer comes back up the swim platform.
    respawn:p=>({...nearest(spots,p||spots[1])}),
    // The AgentFlow org at team tables in the lounge (office-tables-core.js); their boxes stop walkers too.
    seat(list,opts){
      const s=seatTables(orgTeams(list,opts),zone);
      return {...s,walls:s.tables.map(t=>wallBox(t.x,t.z,0,t.width,t.depth,TABLE.height,MAIN,'table'))};
    },
    plan:{HB,E,zL0,zL1,zSw,swimRamp,stairX,upRamp,pitch,slots,zC1,zB0,bow,zBow,zBreak,foreRamp,cx,roomW,roomD,meet,zone,sofa,tub,wallW,wallH}};
  return world;
}
export const buildWorld=(id,members,opts)=>worldId(id)==='yacht'?yachtWorld(members,opts):classicWorld(members,opts);
