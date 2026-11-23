// Layout math for the 3D office's worlds (docs/concepts/12-office.md). No Three.js here, so node can
// import it for tests; public/office-world.js and office-world-yacht.js draw what this file lays out.
//
// A world lays out the same things whatever it looks like (the shape office-layout.js gives the classic
// office): rooms [{key, x, y, z, facing}], the main board's wall, boardAnchors(), and a radius. A world
// with decks adds: ground(x, z) (the floor's height at a point, null where there is none), walls (the
// boxes that stop people and the camera), spawn, respawn(pos), signs and doors(portals).
//
// Every world is a heightfield: a point (x, z) has one floor height or none. Decks are terraced, never
// stacked. So a box is solid from its top down, a wall between two heights stops walkers on both of
// them, and office-controls.js needs only ground() to walk the decks and the stairs between them.
import {officeBox} from './office-controls.js';
import {classicLayout,toWorld,ROOM_W,ROOM_D,WALL_T,BACK_WALL_H,ROOM_BOARD,MAIN_WALL_H,MAIN_WALL_T} from './office-layout.js';
export {ROOM_W,ROOM_D};

export const WORLDS=[{id:'classic',name:'Office'},{id:'yacht',name:'Yacht'}];
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
  for(const b of walls){const h=b.height-floor;if(h>0.12)out.push({x:b.x,z:b.z,c:b.c,s:b.s,halfX:b.halfX,halfZ:b.halfZ,height:h})}
  return out;
}
const nearest=(points,p)=>points.reduce((best,q)=>Math.hypot(q.x-p.x,q.z-p.z)<Math.hypot(best.x-p.x,best.z-p.z)?q:best);

// ---------- classic: office-layout.js, on one flat floor ----------
const keysOf=n=>Array.isArray(n)?n:Array.from({length:Math.max(0,n|0)},(_,i)=>'m'+i);
export function classicWorld(members,opts={}){
  const layout=classicLayout(keysOf(members),opts),spawn={x:0,y:0,z:6,heading:Math.PI};
  return {...layout,id:'classic',rooms:layout.rooms.map(r=>({...r,y:0})),walls:[],signs:[],sea:-Infinity,center:{x:0,z:0},spawn,
    ground:(x,z)=>Math.hypot(x,z)<=110?0:null,open:()=>false,respawn:()=>({...spawn})};
}

// ---------- yacht ----------
// Bow at -z, stern at +z, the lounge's sunken seating centred on the origin at height 0 (so the AgentFlow
// org, laid out round the origin, stands in it). From the stern forward: swim platform, main-deck lounge,
// upper deck with a cabin per member, the sundeck on its block with the pool, the bridge (the owner's
// room), then the foredeck and helipad in the tapering bow.
export const YACHT={PIT:0,MAIN:0.45,SWIM:-2.2,UPPER:3.6,SUN:6.8,FORE:1.5,SEA:-3.3,RAIL:1.05,EDGE:0.6};
export function yachtWorld(members,{commonR=10}={}){
  const keys=keysOf(members),n=Math.max(1,keys.length),roomW=ROOM_W,roomD=ROOM_D;
  const {PIT,MAIN,SWIM,UPPER,SUN,FORE,SEA,RAIL,EDGE}=YACHT;
  const R=clamp(commonR,9,24),HB=Math.max(14,R+4);          // half beam
  const px=R+0.6,pz=R+0.6;                                   // the sunken seating's half size
  const zL0=-(pz+4),zL1=pz+4.4;                               // lounge: forward bulkhead, aft rail
  const swimRamp=5.2,zSw=zL1+8.5;                            // swim platform's aft edge
  const upRamp=7.2,zT0=zL0-upRamp-2;                         // aft terrace ends, cabins begin
  const pairs=Math.max(1,Math.ceil((n-1)/2)),pitch=roomW+1.6;
  const zC0=zT0-pairs*pitch-0.8;                             // forward end of the cabins
  const SB=HB-4.4,sunLen=24,sunRamp=7.6,slot=2.1;            // sundeck block: half width, length, stair slot
  const zS1=zC0-3,zS0=zS1-sunLen;
  const zB1=zS0-8,zB0=zB1-roomD-1.6;                         // bridge: door line, front
  const bow=34,zBow=zB0-bow,foreRamp=5.4;
  const pool={x:0,z:zS1-sunRamp-5.6,halfX:3.6,halfZ:2.5};
  const pad={x:0,z:zB0-foreRamp-9,r:7};
  // Half beam of the hull at z: full amidships, fining to the stem, a little tumblehome at the stern.
  const halfBeam=z=>z<zBow||z>zSw?0:z<zB0?HB*(1-((zB0-z)/bow)**2.2):z>zL1?HB-1.6*((z-zL1)/(zSw-zL1))**2:HB;
  const inSwimRamp=(ax,z)=>ax>=HB-4.8&&ax<=HB-1.6&&z>=zL1&&z<=zL1+swimRamp;
  const inUpRamp=(ax,z)=>ax>=HB-3.6&&z<=zL0&&z>=zL0-upRamp;
  const inForeRamp=(ax,z)=>ax>=HB-4.2&&z<=zB0&&z>=zB0-foreRamp;
  function ground(x,z){
    if(!Number.isFinite(x)||!Number.isFinite(z))return null;
    const ax=Math.abs(x),edge=halfBeam(z)-EDGE;
    if(ax>edge)return null;
    if(z>zL1){
      if(z>zSw-0.2||(z<=zL1+swimRamp&&ax>HB-1.6))return null;
      return inSwimRamp(ax,z)?lerp(MAIN,SWIM,(z-zL1)/swimRamp):SWIM;
    }
    if(z>=zL0){
      if(ax>px||Math.abs(z)>pz)return MAIN;
      // steps into the sunken seating, in the middle of each side
      if(ax<=1.7&&Math.abs(z)>pz-1.3)return lerp(PIT,MAIN,(Math.abs(z)-(pz-1.3))/1.3);
      if(Math.abs(z)<=1.7&&ax>px-1.3)return lerp(PIT,MAIN,(ax-(px-1.3))/1.3);
      return PIT;
    }
    if(z>=zB0){
      if(inUpRamp(ax,z))return lerp(MAIN,UPPER,(zL0-z)/upRamp);
      if(ax<=SB&&z>=zS0&&z<=zS1){
        if(ax<slot&&z>zS1-sunRamp)return lerp(UPPER,SUN,(zS1-z)/sunRamp);
        if(Math.abs(x-pool.x)<pool.halfX&&Math.abs(z-pool.z)<pool.halfZ)return SUN-0.5;
        return SUN;
      }
      return UPPER;
    }
    if(edge<0.5)return null;
    return inForeRamp(ax,z)?lerp(UPPER,FORE,(zB0-z)/foreRamp):FORE;
  }
  // Stepping off is possible only from the aft end of the swim platform, which has no rail.
  const open=(x,z)=>z>zL1+swimRamp+0.2;

  // ----- rooms: the owner (first) has the bridge, everyone else a cabin, port and starboard in turn -----
  const rooms=[{key:keys[0],x:0,y:UPPER,z:zB1-roomD/2,facing:0,kind:'bridge'}],cx=HB-1.2-roomD/2;
  for(let i=0;i<n-1;i++){const port=i%2===0,row=Math.floor(i/2);rooms.push({key:keys[i+1],x:port?-cx:cx,y:UPPER,z:zT0-0.8-roomW/2-row*pitch,facing:port?Math.PI/2:-Math.PI/2,kind:'cabin'})}
  // Cabin places nobody has: open deck with loungers.
  const spare=[];for(let i=n-1;i<pairs*2;i++){const port=i%2===0,row=Math.floor(i/2);spare.push({x:port?-cx:cx,y:UPPER,z:zT0-0.8-roomW/2-row*pitch,facing:port?Math.PI/2:-Math.PI/2})}

  // ----- collision: rails, bulkheads and the big furniture -----
  const walls=[],T=0.24;
  // Between two cabins on the same side the deckhouse wall carries on, so from the sea it is one long house.
  for(let i=2;i<n-1;i++){const r=rooms[i+1],prev=rooms[i-1];walls.push(wallBox(r.x+Math.sign(r.x)*roomD/2,(r.z+prev.z)/2,0,WALL_T,pitch-roomW,BACK_WALL_H,UPPER,'infill'))}
  // slope: the heights a handrail starts and ends at, where it follows stairs (for drawing).
  const rail=(x1,z1,x2,z2,y,kind='rail',tall=RAIL,slope=null)=>walls.push(Object.assign(along(x1,z1,x2,z2,T,tall,y,kind),slope?{slope}:{}));
  for(const s of [-1,1]){
    const e=HB-EDGE+T/2;
    // hull sides, by level
    rail(s*e,zL0,s*e,zL1,MAIN,'bulwark');
    rail(s*e,zB0,s*e,zL0,UPPER);
    // the bow, following the taper
    const seg=9;for(let i=0;i<seg;i++){
      const za=zB0-(bow-1.2)*i/seg,zb=zB0-(bow-1.2)*(i+1)/seg;
      rail(s*(halfBeam(za)-EDGE+T/2),za,s*Math.max(0.2,halfBeam(zb)-EDGE+T/2),zb,FORE,'bulwark');
    }
    // swim stairs: hull side outboard, a rail inboard; the transom between them
    rail(s*(HB-1.6+T/2),zL1,s*(HB-1.6+T/2),zL1+swimRamp,SWIM,'wing',MAIN-SWIM+RAIL-0.2);
    rail(s*(HB-4.8-T/2),zL1,s*(HB-4.8-T/2),zL1+swimRamp-1.2,SWIM,'rail',MAIN-SWIM+RAIL-0.6,[MAIN,lerp(MAIN,SWIM,1-1.2/swimRamp)]);
    rail(s*(HB-1.6),zL1,s*(HB-EDGE),zL1,MAIN,'bulwark');
    // stairs up from the lounge: a trench in the upper deck, railed along its inboard side and its head
    rail(s*(HB-3.6-T/2),zL0-upRamp,s*(HB-3.6-T/2),zL0,MAIN,'rail',UPPER-MAIN+RAIL);
    // sundeck block: sides, aft face either side of its stair, the stair slot
    rail(s*SB,zS0,s*SB,zS1,UPPER,'block',SUN-UPPER+RAIL);
    rail(s*slot,zS1,s*SB,zS1,UPPER,'block',SUN-UPPER+RAIL);
    rail(s*(slot+T/2),zS1-sunRamp+0.2,s*(slot+T/2),zS1,UPPER,'rail',SUN-UPPER+RAIL);
    // foredeck stairs: railed inboard, the bridge front outboard of them
    rail(s*(HB-4.2-T/2),zB0-foreRamp+1.2,s*(HB-4.2-T/2),zB0,FORE,'rail',UPPER-FORE+RAIL,[lerp(UPPER,FORE,1-1.2/foreRamp),UPPER]);
    // the radar arch's legs on the sundeck
    walls.push(wallBox(s*(SB-0.55),zS0+4.2,0,1.1,2.2,3.2,SUN,'arch'));
  }
  rail(-(HB-4.8),zL1,HB-4.8,zL1,SWIM,'transom',MAIN-SWIM+RAIL);            // lounge's aft rail over the swim platform
  rail(-(HB-3.6),zL0,HB-3.6,zL0,MAIN,'bulkhead',UPPER-MAIN+RAIL);          // lounge's forward bulkhead, the terrace rail on top
  rail(-SB,zS0,SB,zS0,UPPER,'block',SUN-UPPER+RAIL);                       // sundeck block's forward face
  rail(-(HB-4.2),zB0,HB-4.2,zB0,FORE,'block',UPPER-FORE+RAIL);             // bridge front over the foredeck
  rail(-0.9,zBow+1.3,0.9,zBow+1.3,FORE,'bulwark');                         // the stem
  // the sunken seating: sofas along its rim, open at the steps
  for(const s of [-1,1]){
    for(const t of [-1,1]){
      walls.push(wallBox(t*(px+1.7)/2,s*(pz-0.5),0,px-1.7,1,MAIN+0.5,PIT,'sofa'));
      walls.push(wallBox(s*(px-0.5),t*(pz+1.7)/2,0,1,pz-1.7,MAIN+0.5,PIT,'sofa'));
    }
  }
  for(const s of [-1,1]){
    walls.push(wallBox(s*6,zL1-1.32,0,5.4,2.4,0.56,MAIN,'pad'));               // sun pads aft
    walls.push(wallBox(s*(HB-1.15),zL1-0.75,0,1,1,0.8,MAIN,'planter'));      // palms
  }
  walls.push(wallBox(0,zS0+3,0,7,1,1.15,SUN,'bar'));                       // the sundeck bar
  walls.push(wallBox(pad.x,pad.z+0.4,0,2.3,5.2,2.3,FORE,'heli'));          // the helicopter on its pad
  for(const s of [-1,1])walls.push(wallBox(s*(HB-4.6),zL1+swimRamp+1.9,0,1.3,2.7,0.95,SWIM,'jetski'));

  // The main board hangs on a wall at the forward end of the lounge, facing the seating; each room's board
  // hangs on its tall back wall (the cabin's outboard side, the bridge's front).
  const OFF=0.07,wallW=Math.min(15.5,(HB-3.6)*2-5.2);
  const mainWall={x:0,y:MAIN,z:zL0+0.5,facing:0,width:wallW,depth:MAIN_WALL_T,height:MAIN_WALL_H};
  const mount=(frame,lx,lz,size)=>{const p=toWorld(frame,lx,lz);return {x:p.x,y:frame.y+size.y,z:p.z,nx:Math.sin(frame.facing),nz:Math.cos(frame.facing),width:size.width,height:size.height}};
  const boardAnchors=()=>({rooms:rooms.map(r=>({key:r.key,...mount(r,0,-roomD/2+WALL_T/2+OFF,ROOM_BOARD)})),
    main:mount(mainWall,0,MAIN_WALL_T/2+OFF,{width:Math.min(14,wallW-1.4),height:3.9,y:2.5})});
  // Doors to other offices: along the transom on the swim platform (you arrive by tender), then the lounge's sides.
  function doors(portals){
    const list=(Array.isArray(portals)?portals:[]).filter(p=>p&&typeof p.env==='string'&&p.env).slice(0,12),out=[];
    const aft=Math.min(list.length,5);
    list.forEach((portal,i)=>{
      if(i<aft)out.push({portal,x:(i-(aft-1)/2)*3,y:SWIM,z:zL1+1.3,facing:0});
      else{const k=i-aft,side=k%2?1:-1;out.push({portal,x:side*(HB-1.7),y:MAIN,z:-pz+3+Math.floor(k/2)*3.4,facing:side>0?-Math.PI/2:Math.PI/2})}
    });
    return out;
  }
  const mid=(zBow+zSw)/2;
  const spots=[{x:0,y:SWIM,z:zL1+3.6,heading:Math.PI},{x:0,y:MAIN,z:pz+2.2,heading:Math.PI},{x:0,y:UPPER,z:zL0-3.5,heading:0},
    {x:0,y:UPPER,z:zS1+1.5,heading:Math.PI},{x:0,y:SUN,z:zS1-sunRamp-1.5,heading:Math.PI},{x:0,y:FORE,z:pad.z-4.6,heading:Math.PI}];
  const world={id:'yacht',rooms,spare,walls,mainWall,boardAnchors,doors,sea:SEA,center:{x:0,z:mid},radius:(zSw-zBow)/2+6,
    bounds:{minX:-HB,maxX:HB,minZ:zBow,maxZ:zSw},spawn:spots[1],lounge:{x:px-2.2,y:PIT,z:pz-2.2},
    signs:[{x:0,y:UPPER+4.7,z:zB1-roomD,text:'Bridge'},{x:0,y:SUN+2.9,z:zS0+3,text:'Sundeck bar'},{x:0,y:FORE+4,z:pad.z,text:'Helipad'},
      {x:0,y:SWIM+2.4,z:zL1+0.3,text:'Beach club'}],
    ground,open,halfBeam,
    step:(from,to,all=walls)=>stepIn(world,from,to,all),
    // What office-controls.js walks on: the deck's height, the sea bed where there is none, and how far out is still the world.
    terrain:{ground,floor:SEA-6,limit:Math.hypot(HB,Math.max(zSw,-zBow))+40},
    // Back on deck: the nearest safe spot, so a swimmer comes back up the swim platform.
    respawn:p=>({...nearest(spots,p||spots[1])}),
    plan:{R,HB,px,pz,zL0,zL1,zSw,swimRamp,upRamp,zT0,pairs,pitch,zC0,SB,sunLen,sunRamp,slot,zS0,zS1,zB0,zB1,bow,zBow,foreRamp,pool,pad,cx,roomW,roomD}};
  return world;
}
export const buildWorld=(id,members,opts)=>worldId(id)==='yacht'?yachtWorld(members,opts):classicWorld(members,opts);
