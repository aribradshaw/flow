// Where things go in the classic 3D office (docs/concepts/12-office.md). Plain math, no Three.js, so node
// can test it; office.js and office-world-classic.js draw what this lays out.
//
// The office is one rectangular floor, north (-z) at the top:
//
//     ┌────────┬────────┬═══ main board ═══┬────────┬────────┐   north wing: member offices either side of
//     │ office │ office │   (service core)  │ office │ office │   the main board's wall, doors facing south
//     ├──door──┴──door──┘                   └──door──┴──door──┤
//     │  pods    pods    │      spine       │   pods    pods  │   the open-plan core: the AgentFlow org in
//     │  pods    pods    │                  │   pods    pods  │   team pods either side of a clear spine
//     ├────────┬────────┐                   ┌────────┬────────┤
//     │ office │meeting │    reception      │ lounge │ office │   south wing: reception in the middle (you
//     └────────┴────────┴── doors to others ┴────────┴────────┘   arrive here), meeting room, lounge, offices
//
// Each wing has k slots either side of the centre bay. The owner has the slot left of the main board, the
// next member the one right of it, and so on outwards, north before south; the meeting room and the lounge
// have the two south slots beside reception. More members add slots (the floor grows wider, never deeper);
// a bigger org adds pods, and widens the floor too once the pods would make the core too deep. A slot
// nobody has is an open bay with seats by the windows.
//
// classicLayout(keys, {org}) -> the plan:
//   rooms [{key, x, z, facing}], mainWall, radius (what the overview frames), center, bounds, spawn, entrance
//   boardAnchors(), meterAnchors(), meetingAnchors(), doors(portals)     as every world answers them (below)
//   org {pos: Map(agent id -> {x, z, yaw}), pods: [{id, name, x, z, w, d, color}]}   where the AgentFlow org stands
//   walls [{x, z, yaw, w, d, h, cam, kind}]   what stops people (cam: how high it stops the camera; 0 for glass
//                                             and for the outer walls, which fade instead)
//   props [{t, x, z, …}]                      furniture and plants, for drawing
//   lounge [{x, z, fx, fz}]                   where idle characters stand about, and what they face
//   places() -> [{id, kind, name, x, z, heading, key?}]   somewhere to stand at each place, for "Go to…"
//   plan()   -> {bounds, zones: [{id, kind, name, x, z, w, d, key?, color?}]}   the floor as rectangles, for a minimap
//   route(from, to) -> [{x, z}]               corner points of a walk between two points, along the corridors
//
// Meeting anchors. Every world answers meetingAnchors(): [{id, name, x, z, facing, w, d, glass}], the rooms whose
// call you join by walking in (office-voice-core.js), glass: office-voice.js draws its glass walls and table.
//
// Board anchors. Every world answers boardAnchors(): {rooms:[{key, ...mount}], main: mount}, where a mount
// is {x, y, z (the board's centre in world space), nx, nz (the unit normal it faces: into its room, or the
// common area), width, height (the most its wall takes)}. A mount sits just off its wall's face, so a board
// on it is flush and never stands in the walk path. Rooms are keyed by member key, in the order given.
// meterAnchors() is the same shape: a small screen inside each room's door wall (opposite the name sign,
// clear of the door) and one on the common-area face of the main board's wall. nx, nz is the way the
// screen faces. The room screen's turn matches meterAnchors() in office-meters-core.js.
export const ROOM_W=12,ROOM_D=9,WALL_T=0.2,WALL_H=1.1,BACK_WALL_H=3.9,DOOR_W=3;
export const MAIN_WALL_H=5.2,MAIN_WALL_T=0.4;
export const ROOM_BOARD={width:9.2,height:2.6,y:2.42};
export const MEETING_W=9,MEETING_D=7;
// The floor plan's measures. SLOT: a room and its share of wall. CENTER: the bay the main board and
// reception stand in. CORRIDOR: clear floor along the room fronts. SPINE: clear floor from reception to the
// main board. GLASS_H: the top of the glass over the rooms' low walls. OUTER_H: the outer walls.
export const PLAN={SLOT:12.3,CENTER:18,CORRIDOR:3.2,SPINE:5,EDGE:1.6,RECESS:2.6,GLASS_H:2.6,OUTER_H:4,OUTER_T:0.3,
  POD_COL:2.5,POD_HEAD:2.4,POD_PITCH:4,POD_AISLE_X:1.8,POD_AISLE_Z:2,POD_MAX_DEPTH:16.5,POD_MIN_DEPTH:10};
export const POD_COLORS=['#cfe0d0','#cfdcea','#eadfc8','#ecd5d2','#d9d4ea','#c9e3e0'];
// Same local pose as the fallback in office-meters-core.js: inside the front wall, at −x (the name
// sign is at +x), yawed so a +z-facing plane looks into the room and toward the door.
const ROOM_METER={width:1.62,height:0.9,y:2.15,x:-2.5,yaw:Math.PI-0.42};
const OFFICE_METER={width:1.98,height:1.1,y:2.08};
const OFF=0.07; // a board's face this far off its wall: the frame's depth
const round=n=>Math.round(n*1000)/1000;

// A point in a room-like group's own frame (x across, z towards the middle) to world space.
export function toWorld({x,z,facing},lx,lz){
  const c=Math.cos(facing),s=Math.sin(facing);
  return {x:x+lx*c+lz*s,z:z-lx*s+lz*c};
}

// ---------- the AgentFlow org as team pods ----------
// A pod is a lead (or a team's table, or both) with the agents who report to it and have no reports of their
// own. Its lead stands at the head; the others stand at benches, two rows facing each other across a table.
// list: [{id, name, kind, reportsTo}] -> [{id, name, heads:[id], members:[id], cols, benches, w, d, root, spots: Map(id -> {x, z, yaw})}]
// Spots are in the pod's own frame: x across from its centre, z from its head edge (north) down.
export function orgPods(list){
  const {POD_COL:COL,POD_HEAD:HEAD,POD_PITCH:PITCH}=PLAN;
  const all=(Array.isArray(list)?list:[]).filter(a=>a&&a.id),ids=new Set(all.map(a=>a.id)),byId=new Map(all.map(a=>[a.id,a])),kids=new Map(),parent=new Map();
  for(const a of all){
    let p=a.reportsTo&&ids.has(a.reportsTo)&&a.reportsTo!==a.id?a.reportsTo:'';
    for(let x=p,n=0;x&&n<500;x=parent.get(x),n++)if(x===a.id){p='';break} // no loops
    parent.set(a.id,p);if(p)(kids.get(p)||kids.set(p,[]).get(p)).push(a.id);
  }
  const kidsOf=id=>kids.get(id)||[],leaf=id=>!kidsOf(id).length;
  const pods=[],loners=[];
  // A lead whose only report is itself a lead (a team node over its lead) shares that pod's head.
  const open=(id,heads,root)=>{
    heads=[...heads,id];
    const k=kidsOf(id);
    if(k.length===1&&!leaf(k[0])){open(k[0],heads,root);return}
    const first=byId.get(heads[0]),team=heads.map(h=>byId.get(h)).find(a=>a.kind==='team');
    pods.push({id:heads[0],name:String((team||first).name||'Team'),heads,members:k.filter(leaf),root});
    for(const c of k)if(!leaf(c))open(c,[],false);
  };
  for(const a of all){if(parent.get(a.id))continue;if(leaf(a.id))loners.push(a.id);else open(a.id,[],true)}
  if(loners.length)pods.push({id:'pod:'+loners[0],name:pods.length?'Unassigned':'Agents',heads:[],members:loners,root:!pods.length});
  for(const pod of pods){
    const m=pod.members.length,h=pod.heads.length;
    const cols=m<=2?1:m<=4?2:m<=12?3:m<=24?4:5,benches=Math.ceil(m/(cols*2));
    Object.assign(pod,{cols,benches,w:Math.max(cols,h,1)*COL+1,d:(h?HEAD:0.4)+(m?benches*PITCH:0.6),spots:new Map(),tables:[]});
    pod.heads.forEach((id,i)=>pod.spots.set(id,{x:(i-(h-1)/2)*COL,z:1.2,yaw:0}));
    pod.members.forEach((id,i)=>{
      const b=Math.floor(i/(cols*2)),j=i%(cols*2),col=Math.floor(j/2),south=j%2,tz=(h?HEAD:0.4)+b*PITCH+PITCH/2;
      pod.spots.set(id,{x:(col-(cols-1)/2)*COL,z:tz+(south?1:-1),yaw:south?Math.PI:0});
    });
    for(let b=0;b<benches&&m;b++){
      const seats=Math.min(cols*2,m-b*cols*2),used=Math.ceil(seats/2);
      pod.tables.push({x:(used-cols)*COL/2,z:(h?HEAD:0.4)+b*PITCH+PITCH/2,w:used*COL-0.5,d:0.9,seats});
    }
  }
  return pods;
}
// Pods in shelves either side of the spine, each side `width` wide: a shelf is a row of pods, the next
// shelf is north of it. -> {depth, sides:[east, west]: [[{depth, used, pods:[{pod, at}]}]]}, depth Infinity when one is too wide.
function packPods(pods,width){
  const {POD_AISLE_X:AX,POD_AISLE_Z:AZ}=PLAN,sides=[[],[]];
  const depthOf=s=>s.reduce((n,sh)=>n+sh.depth,0)+Math.max(0,s.length-1)*AZ;
  const order=[...pods.filter(p=>p.root),...pods.filter(p=>!p.root).sort((a,b)=>b.d-a.d||b.w-a.w)];
  for(const pod of order){
    if(pod.w>width+1e-6)return {depth:Infinity,sides};
    let best=null;
    const offer=c=>{if(!best||c.total<best.total-1e-6||(Math.abs(c.total-best.total)<1e-6&&c.grow<best.grow-1e-6))best=c};
    sides.forEach((s,si)=>{
      const other=depthOf(sides[1-si]),mine=depthOf(s);
      for(const sh of s)if(sh.used+AX+pod.w<=width+1e-6){const grow=Math.max(0,pod.d-sh.depth);offer({si,sh,grow,total:Math.max(mine+grow,other)})}
      offer({si,sh:null,grow:pod.d+(s.length?AZ:0),total:Math.max(mine+(s.length?AZ:0)+pod.d,other)});
    });
    let sh=best.sh;
    if(!sh){sh={depth:0,used:0,pods:[]};sides[best.si].push(sh)}
    const at=sh.used+(sh.pods.length?AX:0);sh.pods.push({pod,at});sh.used=at+pod.w;sh.depth=Math.max(sh.depth,pod.d);
  }
  return {depth:Math.max(depthOf(sides[0]),depthOf(sides[1])),sides};
}

export function classicLayout(keys,{org=[]}={}){
  const P=PLAN,n=keys.length,pods=orgPods(org);
  // Slots per wing side: enough for the members, the meeting room and the lounge. The pods keep close to the
  // spine: they are packed as if the floor were one slot wide, and only wider (widening the floor when it
  // must) while that would make the core too deep.
  let k=Math.max(1,Math.ceil((n+2)/4)),pack,width;
  for(let i=1;;i++){
    width=P.CENTER/2+i*P.SLOT-P.SPINE/2-P.EDGE;pack=packPods(pods,width);
    if(pack.depth<=P.POD_MAX_DEPTH||i>=9){k=Math.max(k,i);break}
  }
  const HW=P.CENTER/2+k*P.SLOT,podDepth=Math.max(P.POD_MIN_DEPTH,pack.depth),DC=podDepth+2*P.CORRIDOR;
  const zFront=DC/2,zN=-(zFront+ROOM_D),zS=zFront+ROOM_D;         // room fronts (±), the outer walls north and south
  const slotX=i=>P.CENTER/2+(i-0.5)*P.SLOT;                          // centre of slot i (1 is beside the centre bay)
  const slot=(wing,side,i)=>({wing,side,i,x:side*slotX(i),z:wing*(zFront+ROOM_D/2),facing:wing<0?0:Math.PI});
  // Members go outwards from the centre, west then east, north before south.
  const order=[];for(let i=1;i<=k;i++){order.push(slot(-1,-1,i),slot(-1,1,i));if(i>1)order.push(slot(1,1,i),slot(1,-1,i))}
  const rooms=keys.map((key,i)=>({key,...order[i]})),bays=order.slice(n).map((s,i)=>({...s,id:'bay'+(i+1),type:['nook','games','library','focus'][i%4]}));
  const meetSlot=slot(1,-1,1),loungeSlot=slot(1,1,1);
  const meeting={id:'meeting',name:'Meeting room',x:meetSlot.x,z:round(zFront+0.5+MEETING_D/2),facing:Math.PI,w:MEETING_W,d:MEETING_D,glass:true};
  const lounge={x:loungeSlot.x,z:loungeSlot.z,w:P.SLOT,d:ROOM_D};
  // The main board's wall stands a little back from the room fronts, the service core behind it.
  const mainWall={x:0,z:round(-zFront-P.RECESS),facing:0,width:15,depth:MAIN_WALL_T,height:MAIN_WALL_H};
  const mainBoard={width:Math.min(14,mainWall.width-1.4),height:3.9,y:2.5};
  const spawn={x:0,y:0,z:round(zFront+4.6),heading:Math.PI},entrance={x:0,z:round(zS-1.5)};

  // ----- the org -----
  const pos=new Map(),placed=[],x0=P.SPINE/2;
  pack.sides.forEach((shelves,si)=>{
    const sx=si?-1:1;let south=podDepth/2;
    for(const sh of shelves){
      const north=south-sh.depth,off=Math.min(40,width-sh.used)/2;
      for(const {pod,at} of sh.pods){
        const cx=sx*(x0+Math.max(0,off)+at+pod.w/2);
        const p={id:pod.id,name:pod.name,x:round(cx),z:round(north+pod.d/2),north:round(north),w:pod.w,d:pod.d,root:pod.root,heads:pod.heads,members:pod.members,
          tables:pod.tables.map(t=>({x:round(cx+t.x),z:round(north+t.z),w:t.w,d:t.d,seats:t.seats}))};
        placed.push(p);
        for(const [id,s] of pod.spots)pos.set(id,{x:round(cx+s.x),z:round(north+s.z),yaw:s.yaw});
      }
      south=north-P.POD_AISLE_Z;
    }
  });
  // In the order the org lists them, so a pod keeps its colour when another one grows.
  const podOrder=new Map(pods.map((p,i)=>[p.id,i]));
  placed.sort((a,b)=>podOrder.get(a.id)-podOrder.get(b.id));placed.forEach((p,i)=>{p.color=POD_COLORS[i%POD_COLORS.length]});

  // ----- furniture and plants: what is drawn, and what stops people -----
  const props=[],walls=[];
  const box=(x,z,w,d,h,kind,o={})=>walls.push({x:round(x),z:round(z),yaw:o.yaw||0,w,d,h,cam:o.cam??h,kind});
  const prop=(t,x,z,o={})=>{props.push({t,x:round(x),z:round(z),...o})};
  const plant=(x,z,s=1)=>{prop('plant',x,z,{s});box(x,z,0.7*s,0.7*s,0.6,'planter')};
  // The outer walls fade when the camera is beyond them, so they never stop it.
  const T=P.OUTER_T;
  box(0,zN-T/2,2*HW+2*T,T,P.OUTER_H,'outer',{cam:0});box(0,zS+T/2,2*HW+2*T,T,P.OUTER_H,'outer',{cam:0});
  box(-HW-T/2,0,T,zS-zN,P.OUTER_H,'outer',{cam:0});box(HW+T/2,0,T,zS-zN,P.OUTER_H,'outer',{cam:0});
  // The service core behind the main board.
  const coreD=mainWall.z-MAIN_WALL_T/2-zN;box(0,zN+coreD/2,P.CENTER-0.5,coreD,MAIN_WALL_H,'core');
  // Glass over each room's low walls: it stops people, never the camera.
  for(const r of rooms){
    const g=(lx,lz,w,d)=>{const p=toWorld(r,lx,lz);box(p.x,p.z,w,d,P.GLASS_H+0.1,'glass',{yaw:r.facing,cam:0})};
    const side=(ROOM_W-DOOR_W)/2;
    g(-ROOM_W/2,0,WALL_T,ROOM_D);g(ROOM_W/2,0,WALL_T,ROOM_D);g(-(DOOR_W/2+side/2),ROOM_D/2,side,WALL_T);g(DOOR_W/2+side/2,ROOM_D/2,side,WALL_T);
  }
  for(const p of placed)for(const t of p.tables)box(t.x,t.z,t.w,t.d,0.76,'bench');
  // Reception: a desk to one side of the way in, a bench to the other, plants at the corners.
  const rz=zFront;
  prop('desk',5.4,rz+4.4,{w:1,d:3.4});box(5.4,rz+4.4,1,3.4,1.08,'desk');
  prop('benchseat',-3.4,zS-0.65,{w:3,d:0.7});box(-3.4,zS-0.65,3,0.7,0.5,'seat');
  plant(-5.6,rz+0.7,1.2);plant(5.6,rz+0.7,1.2);plant(-8,zS-0.9);plant(8,zS-0.9);
  // The meeting room's slot: plants in the strips beside and behind the glass.
  plant(meeting.x-MEETING_W/2-0.75,rz+1.2);plant(meeting.x+MEETING_W/2+0.75,rz+1.2);plant(meeting.x-3,zS-0.8);plant(meeting.x+3,zS-0.8);
  // The lounge: a kitchen counter with the coffee machine on the outer wall, a high table to stand at, sofas.
  const lx=lounge.x,counter={x:lx-0.6,z:zS-0.5,w:6.4,d:0.75},island={x:lx-0.6,z:rz+4.3,w:2.6,d:0.95};
  // A sofa is `w` long and `d` deep, and faces its own +z (turned by yaw).
  const sofa=(x,z,w,yaw,color)=>{prop('sofa',x,z,{w,d:0.95,yaw,color});box(x,z,w,0.95,0.8,'sofa',{yaw})};
  prop('counter',counter.x,counter.z,{w:counter.w,d:counter.d});box(counter.x,counter.z,counter.w,counter.d,0.95,'counter');
  prop('island',island.x,island.z,{w:island.w,d:island.d});box(island.x,island.z,island.w,island.d,1.05,'island');
  sofa(lx+4.9,rz+3.6,3.2,-Math.PI/2);sofa(lx+2.9,rz+0.75,2.6,0);
  prop('coffeetable',lx+3.1,rz+3.5,{w:1.3,d:0.8});box(lx+3.1,rz+3.5,1.3,0.8,0.42,'table');
  plant(lx-P.SLOT/2+0.7,rz+0.9,1.1);plant(lx+P.SLOT/2-0.7,zS-0.8,1.1);plant(lx-4.6,zS-0.8);
  const loungeSpots=[];
  for(const s of [-1,1])for(const dx of [-0.75,0.75])loungeSpots.push({x:round(island.x+dx),z:round(island.z+s*1.05),fx:island.x,fz:island.z});
  for(const dx of [-1.9,1.5])loungeSpots.push({x:round(counter.x+dx),z:round(counter.z-1),fx:round(counter.x+dx),fz:counter.z});
  loungeSpots.push({x:round(lx+3.1),z:round(rz+2.1),fx:round(lx+3.1),fz:round(rz+3.5)});
  // Open bays: what stands in a slot nobody has. A bay's own frame is a room's: +z towards the corridor.
  for(const b of bays){
    const at=(ax,az)=>toWorld(b,ax,az);
    const seat=(ax,az,w,yaw)=>{const p=at(ax,az);sofa(p.x,p.z,w,b.facing+yaw,b.type==='nook'?'#e2b04a':'#4f9fb8')};
    const tbl=(ax,az,w,d,h,t='coffeetable')=>{const p=at(ax,az);prop(t,p.x,p.z,{w,d,yaw:b.facing});box(p.x,p.z,w,d,h,'table',{yaw:b.facing})};
    const pl=(ax,az,s)=>{const p=at(ax,az);plant(p.x,p.z,s)};
    const rug=at(0,-0.5);prop('rug',rug.x,rug.z,{w:ROOM_W-2.4,d:ROOM_D-3,color:{nook:'#eadfc8',games:'#cfe0d0',library:'#d9d4ea',focus:'#cfdcea'}[b.type]});
    pl(-ROOM_W/2+0.7,ROOM_D/2-0.8,1.1);pl(ROOM_W/2-0.7,ROOM_D/2-0.8,1.1);
    if(b.type==='nook'){seat(-2.3,-3.5,2.8,0);seat(2.3,-3.5,2.8,0);tbl(0,-1.7,2.2,0.9,0.42);seat(-4.4,-1.5,2.2,Math.PI/2);seat(4.4,-1.5,2.2,-Math.PI/2)}
    else if(b.type==='games'){tbl(0,-0.8,2.74,1.52,0.78,'pingpong');seat(-4.6,-0.8,2.6,Math.PI/2)}
    else if(b.type==='library'){for(const ax of [-3.4,0,3.4])tbl(ax,-ROOM_D/2+0.45,2.6,0.5,2,'shelf');seat(-1.7,-1.2,0.95,Math.PI/2);seat(1.7,-1.2,0.95,-Math.PI/2);tbl(0,-1.2,0.8,0.8,0.45)}
    else for(const ax of [-3.6,0,3.6])tbl(ax,-2.9,1.5,1.5,2.2,'booth');
  }
  // A wide floor has open core beyond the pods: tables to gather at and sofas, in turn, with a rug each.
  for(const s of [-1,1]){
    let i=s>0?0:1;
    for(let x=P.SPINE/2+width+5.5;x+4.2<=HW-P.EDGE;x+=10.5,i++){
      const cx=s*x;
      if(i%2){prop('rug',cx,0,{w:6.4,d:5,color:'#d9d4ea'});prop('table',cx,0,{w:3.4,d:1.3});box(cx,0,3.4,1.3,0.76,'table');
        for(const dz of [-1.15,1.15])for(const dx of [-1.1,0,1.1])prop('stool',cx+dx,dz)}
      else{prop('rug',cx,0,{w:6.4,d:5,color:'#c9e3e0'});sofa(cx,-1.75,2.8,0,'#e2b04a');sofa(cx,1.75,2.8,Math.PI,'#4f9fb8');prop('coffeetable',cx,0,{w:1.5,d:0.8});box(cx,0,1.5,0.8,0.42,'table')}
      plant(cx+3.7,-podDepth/2+1.4);plant(cx-3.7,podDepth/2-1.4);
    }
  }
  // Plants along the windows at the core's two ends.
  for(const s of [-1,1])for(const f of [-0.3,0.3])plant(s*(HW-0.75),f*DC,1.15);

  function mount(room,lx,lz,size){
    const p=toWorld(room,lx,lz);
    return {x:p.x,y:size.y,z:p.z,nx:Math.sin(room.facing),nz:Math.cos(room.facing),width:size.width,height:size.height};
  }
  // Doors to other offices: along reception's west side first, where you see them as you arrive, then on its
  // outer wall behind you, then along its east side.
  function doors(portals){
    const list=(Array.isArray(portals)?portals:[]).filter(p=>p&&typeof p.env==='string'&&p.env).slice(0,12);
    const sx=P.CENTER/2-1,south=x=>({x,z:round(zS-0.7),facing:Math.PI}),side=(s,dz)=>({x:s*sx,z:round(zFront+dz),facing:s>0?-Math.PI/2:Math.PI/2});
    const spots=[side(-1,5.4),side(-1,2.9),side(-1,7.9),south(-5.4),south(5.4),south(-2.7),south(2.7),south(0),side(1,7.9),side(1,5.4),side(1,2.9),side(-1,0.45)];
    return list.map((portal,i)=>({portal,y:0,...spots[i]}));
  }
  const roomPlace=r=>{const p=toWorld(r,0,ROOM_D/2-1.6);return {x:round(p.x),z:round(p.z),heading:r.facing+Math.PI}};
  function places(){
    const mp=toWorld(meeting,0,MEETING_D/2-1.6);
    return [
      {id:'reception',kind:'reception',name:'Reception',x:spawn.x,z:spawn.z,heading:Math.PI},
      {id:'board',kind:'board',name:'Main board',x:0,z:round(mainWall.z+4.5),heading:Math.PI},
      {id:'meeting',kind:'meeting',name:'Meeting room',x:round(mp.x),z:round(mp.z),heading:0},
      {id:'lounge',kind:'lounge',name:'Lounge',x:round(lounge.x-0.6),z:round(zFront+2.4),heading:0},
      ...rooms.map(r=>({id:'office:'+r.key,kind:'office',key:r.key,name:'Office',...roomPlace(r)})),
      ...placed.map(p=>({id:'pod:'+p.id,kind:'pod',name:p.name,x:p.x,z:round(p.north-0.9),heading:0})),
    ];
  }
  const bounds={minX:-HW,maxX:HW,minZ:zN,maxZ:zS};
  function plan(){
    return {bounds,zones:[
      {id:'core',kind:'core',name:'Open plan',x:0,z:0,w:2*HW,d:DC},
      {id:'reception',kind:'reception',name:'Reception',x:0,z:zFront+ROOM_D/2,w:P.CENTER,d:ROOM_D},
      {id:'board',kind:'board',name:'Main board',x:0,z:round(zN+(ROOM_D)/2),w:P.CENTER,d:ROOM_D},
      {id:'meeting',kind:'meeting',name:'Meeting room',x:meeting.x,z:meeting.z,w:MEETING_W,d:MEETING_D},
      {id:'lounge',kind:'lounge',name:'Lounge',x:lounge.x,z:lounge.z,w:lounge.w,d:lounge.d},
      ...rooms.map(r=>({id:'office:'+r.key,kind:'office',key:r.key,name:'Office',x:r.x,z:r.z,w:ROOM_W,d:ROOM_D})),
      ...bays.map(b=>({id:b.id,kind:'bay',name:{nook:'Window seats',games:'Games',library:'Library',focus:'Focus booths'}[b.type],x:b.x,z:b.z,w:ROOM_W,d:ROOM_D})),
      ...placed.map(p=>({id:'pod:'+p.id,kind:'pod',name:p.name,x:p.x,z:p.z,w:p.w,d:p.d,color:p.color})),
    ]};
  }
  // A walk from a to b bends at the corridors: out of a's door, along the room fronts (crossing the core by
  // the spine), in at b's door. A point in the open core joins at the nearer corridor.
  function route(a,b){
    const lane=p=>p.z<0?-(zFront-P.CORRIDOR/2):zFront-P.CORRIDOR/2;
    const inWing=p=>Math.abs(p.z)>zFront-0.2,out=[];
    const la=lane(a),lb=lane(b);
    if(inWing(a))out.push({x:a.x,z:la});
    if(la!==lb&&(inWing(a)||inWing(b))){out.push({x:0,z:la},{x:0,z:lb})}
    if(inWing(b))out.push({x:b.x,z:lb});
    out.push({x:b.x,z:b.z});
    return out.filter((p,i)=>!i||Math.hypot(p.x-out[i-1].x,p.z-out[i-1].z)>0.05).map(p=>({x:round(p.x),z:round(p.z)}));
  }
  const signs=[
    {x:5.4,y:2.75,z:round(zFront+4.4),text:'Reception',near:24},
    {x:round(lounge.x),y:2.9,z:round(zFront+0.3),text:'Lounge',near:22},
    ...bays.map(b=>({x:b.x,y:2.7,z:round(b.z-(b.wing)*(ROOM_D/2-0.3)),text:{nook:'Window seats',games:'Games',library:'Library',focus:'Focus booths'}[b.type],near:16})),
    ...placed.map(p=>({x:round(p.x-p.w/2+0.35),y:2.45,z:round(p.north+0.35),text:p.name,near:15,pod:p.id})),
  ];
  return {
    rooms,mainWall,bays,meeting,loungeZone:lounge,pods:placed,props,walls,signs,
    // What the overview frames: the whole floor on a screen wider than it is tall.
    radius:round(Math.max((zS-zN)/2+1,HW/1.45)-6),halfWidth:HW,coreDepth:DC,zFront,
    center:{x:0,z:0},bounds,spawn,entrance,lounge:loungeSpots,arriveAtSpawn:true,
    // How the camera looks when you arrive: lower and further back than the default, so the main board shows across the floor.
    view:{pitch:0.29,zoom:7.2},
    roomWalls:{glass:P.GLASS_H,back:false},
    org:{pos,pods:placed},
    doors,places,plan,route,
    meetingAnchors:()=>[{...meeting}],
    boardAnchors:()=>({
      rooms:rooms.map(r=>({key:r.key,...mount(r,0,-ROOM_D/2+WALL_T/2+OFF,ROOM_BOARD)})),
      main:mount(mainWall,0,MAIN_WALL_T/2+OFF,mainBoard),
    }),
    meterAnchors:()=>({
      rooms:rooms.map(r=>({key:r.key,...roomMeterMount(r)})),
      main:officeMeterMount(mainWall,mainBoard.width),
    }),
  };
}

// A room meter's mount. Local +z is out the door, so the screen sits just inside that wall.
// Its normal is the fallback yaw, added to the room's facing: into the room and toward the door.
export function roomMeterMount(room){
  const lz=ROOM_D/2-0.55,ry=(room.facing||0)+ROOM_METER.yaw,p=toWorld(room,ROOM_METER.x,lz);
  return {x:p.x,y:(room.y||0)+ROOM_METER.y,z:p.z,nx:Math.sin(ry),nz:Math.cos(ry),width:ROOM_METER.width,height:ROOM_METER.height};
}
// The office meter, on the common-area face of the main wall, as far toward +x as the wall allows
// so it stays off the planters beside the wall. It faces the same way as the main board.
export function officeMeterMount(mainWall,boardWidth){
  const w=OFFICE_METER.width,half=mainWall.width/2;
  const want=(boardWidth||Math.min(14,mainWall.width-1.4))/2+0.25+w/2;
  const lx=Math.min(want,half-w/2-0.08);
  const p=toWorld(mainWall,lx,MAIN_WALL_T/2+OFF+0.04);
  const facing=mainWall.facing||0;
  return {x:p.x,y:(mainWall.y||0)+OFFICE_METER.y,z:p.z,nx:Math.sin(facing),nz:Math.cos(facing),width:w,height:OFFICE_METER.height};
}
