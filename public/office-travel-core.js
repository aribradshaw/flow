// Getting about the 3D office (docs/concepts/12-office.md "Getting about"): the list behind "Go to…", the route
// there, and the minimap's plan. Plain math, no Three.js or DOM, so node can test it; office-travel.js draws it,
// office.js walks it. Nothing here knows which world it is in: places and floors come from the world's layout.
//
//   placeList(office)            -> [{id, kind, name, sub, x, z, stop, waiting}]  everything you can go to
//   filterPlaces(list, query)    -> the ones that match what was typed, best first
//   planRoute(nav, from, to, o)  -> {points, cost, reached, jump}  a walk along office-nav.js paths that stops
//                                   `stop` short of the target; jump: where a far walk fades to (or null)
//   standable(nav, x, z)         -> the nearest place to (x, z) where someone can stand
//   pointAlong(points, d)        -> {x, z, i} the point d metres along a path, and the next index after it
//   mapFit(bounds, box)          -> the minimap's frame: a long world lies on its side, bow to the left
export const TELEPORT_OVER=55;   // metres of path: a longer walk fades to a few metres short of the place
export const ARRIVE_WALK=7;      // and walks this much of it

const KIND_ORDER={place:0,room:1,person:2,session:3,agent:4};
// office: {places:[{id,name,x,z,short}], rooms:[{key,name,x,z,me,owner}], names:{room,owner}, board:{x,z}|null,
//   meeting:{name,x,z}|null, people:[{key,name,x,z}], agents:[{id,name,title,x,z}],
//   sessions:[{id,member,name,owner,mine,x,z,waiting}]}
export function placeList({places=[],rooms=[],names={},board=null,meeting=null,people=[],agents=[],sessions=[]}={}){
  const room=names.room||'room',cap=s=>s.charAt(0).toUpperCase()+s.slice(1),out=[];
  for(const p of places)out.push({id:'place:'+p.id,kind:'place',name:p.name,sub:'',x:p.x,z:p.z,stop:0});
  if(board)out.push({id:'place:board',kind:'place',name:'Main board',sub:'DevOps',x:board.x,z:board.z,stop:0});
  if(meeting)out.push({id:'place:meeting',kind:'place',name:meeting.name||'Meeting room',sub:'Voice',x:meeting.x,z:meeting.z,stop:0});
  const mine=rooms.find(r=>r.me);
  if(mine)out.push({id:'room:'+mine.key,kind:'room',name:mine.owner&&names.owner?`My ${room} · ${names.owner}`:`My ${room}`,sub:'',x:mine.x,z:mine.z,stop:0,mine:true});
  for(const r of rooms)if(!r.me)out.push({id:'room:'+r.key,kind:'room',name:r.owner&&names.owner?`${names.owner} · ${r.name}`:`${r.name}'s ${room}`,sub:cap(room),x:r.x,z:r.z,stop:0});
  for(const p of people)out.push({id:'person:'+p.key,kind:'person',name:p.name,sub:'Here now',x:p.x,z:p.z,stop:1.6});
  for(const s of sessions)out.push({id:'session:'+s.member+':'+s.id,kind:'session',name:s.name,sub:s.waiting?'Waiting on '+(s.mine?'you':s.owner||'its person'):s.mine?'Your agent':s.owner?s.owner+'’s agent':'Agent',x:s.x,z:s.z,stop:1.5,waiting:!!s.waiting});
  for(const a of agents)out.push({id:'agent:'+a.id,kind:'agent',name:a.name,sub:a.title||'AgentFlow',x:a.x,z:a.z,stop:1.3});
  return out.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.z));
}
const fold=s=>String(s||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'');
// Waiting agents first, then places, rooms, people, sessions, agents; with a query, names that start with it first.
export function filterPlaces(list,query=''){
  const q=fold(query).trim(),rank=p=>(p.waiting?-1:KIND_ORDER[p.kind]??9);
  const scored=[];
  list.forEach((p,i)=>{
    let score=0;
    if(q){
      const name=fold(p.name),sub=fold(p.sub);
      if(name.startsWith(q))score=0;else if(name.split(/[\s·'’]+/).some(w=>w.startsWith(q)))score=1;else if(name.includes(q))score=2;else if(sub.includes(q))score=3;else return;
    }
    scored.push({p,score,rank:rank(p),i});
  });
  scored.sort((a,b)=>a.score-b.score||a.rank-b.rank||a.i-b.i);
  return scored.map(s=>s.p);
}

const length=pts=>{let d=0;for(let i=2;i<pts.length;i+=2)d+=Math.hypot(pts[i]-pts[i-2],pts[i+1]-pts[i-1]);return d};
export function pointAlong(pts,d){
  for(let i=2;i<pts.length;i+=2){
    const l=Math.hypot(pts[i]-pts[i-2],pts[i+1]-pts[i-1]);
    if(d<=l||i===pts.length-2){const t=l>1e-9?Math.max(0,Math.min(1,d/l)):1;return {x:pts[i-2]+(pts[i]-pts[i-2])*t,z:pts[i-1]+(pts[i+1]-pts[i-1])*t,i}}
    d-=l;
  }
  return {x:pts[0],z:pts[1],i:2};
}
// The place nearest (x, z) where someone can stand: inside the plan, on a floor, clear of what stops people.
export function standable(nav,x,z){
  const b=nav.bounds,h=nav.cell/2,cx=Math.max(b.minX+h,Math.min(b.maxX-h,x)),cz=Math.max(b.minZ+h,Math.min(b.maxZ-h,z));
  if(cx===x&&cz===z&&nav.open(x,z))return {x,z};
  return nav.nearest(cx,cz,60)||{x:cx,z:cz};
}
// nav: office-nav.js buildNav (or null: a straight line). to: {x, z, stop}. far: the walk that fades instead.
// The route always ends where you can stand: a place in the sea, a wall or a table ends beside it.
export function planRoute(nav,from,to,{far=TELEPORT_OVER,walk=ARRIVE_WALK}={}){
  if(nav){const at=standable(nav,to.x,to.z);to={...to,x:at.x,z:at.z}}
  const p=nav?nav.path(from.x,from.z,to.x,to.z):{points:[from.x,from.z,to.x,to.z],reached:true,cost:Math.hypot(to.x-from.x,to.z-from.z)};
  let points=p.points.slice(),cost=length(points);
  // Stop short of a person or an agent: back along the path, never off it.
  const stop=Math.min(to.stop||0,Math.max(0,cost-0.2));
  if(stop>0&&points.length>=4){
    const end=pointAlong(points,cost-stop);
    points=points.slice(0,end.i);points.push(end.x,end.z);cost-=stop;
  }
  let jump=null;
  if(cost>far&&points.length>=4){
    const at=pointAlong(points,cost-walk),next={x:points[at.i],z:points[at.i+1]};
    jump={x:at.x,z:at.z,heading:Math.atan2(next.x-at.x,next.z-at.z)};
    points=[at.x,at.z,...points.slice(at.i)];
  }
  return {points,cost,reached:p.reached,jump};
}

// The minimap's frame. bounds: {minX, maxX, minZ, maxZ}; box: the most it may take, in CSS px. A world much longer
// than it is wide (a yacht) lies on its side: its -z end (the bow) to the left, +x (starboard) up.
export function mapFit(bounds,{maxW=340,maxH=210,pad=6}={}){
  const dx=Math.max(1,bounds.maxX-bounds.minX),dz=Math.max(1,bounds.maxZ-bounds.minZ),turned=dz>dx*1.6;
  const wide=turned?dz:dx,tall=turned?dx:dz,scale=Math.min((maxW-2*pad)/wide,(maxH-2*pad)/tall);
  const w=Math.round(wide*scale+2*pad),h=Math.round(tall*scale+2*pad);
  const toMap=turned?(x,z)=>({x:pad+(z-bounds.minZ)*scale,y:pad+(bounds.maxX-x)*scale}):(x,z)=>({x:pad+(x-bounds.minX)*scale,y:pad+(z-bounds.minZ)*scale});
  const toWorld=turned?(mx,my)=>({x:bounds.maxX-(my-pad)/scale,z:bounds.minZ+(mx-pad)/scale}):(mx,my)=>({x:bounds.minX+(mx-pad)/scale,z:bounds.minZ+(my-pad)/scale});
  // A heading (0 faces +z) as an angle on the map, clockwise from "up" on screen.
  const turn=turned?h0=>Math.PI/2-h0:h0=>Math.PI-h0;
  return {w,h,scale,turned,toMap,toWorld,turn};
}
