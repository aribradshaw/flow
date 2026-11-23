// Doors between offices (docs/concepts/12-office.md). The server lists, per viewer, the other offices
// sharing connects them to and that they can enter (snapshot.portals: [{env, label, sub, own}]): the offices of
// environments shared with them ("<owner>'s office"), their own shared environments' offices, and, while
// visiting, their own office. Each is a glowing door on the ring of rooms, in a gap between two rooms, facing
// the middle. Walk through it or click it to go to that office. Pure geometry here; office.js draws the labels.
//
//   doorSpots(portals, {rooms, ringRadius})   -> [{portal, x, z, facing}]   where each door stands
//   buildDoors(THREE, spots, {box, mat})      -> {group, spots:[{portal, anchor, hit, x, z}]}
//   doorAt(spots, x, z, reach)                -> the spot within reach of (x, z), or null
export const MAX_DOORS=12,DOOR_REACH=0.9;
// rooms: [{center:{x,z}}] (their angles around the middle); ringRadius: the distance of the rooms from the middle.
export function doorSpots(portals,{rooms=[],ringRadius=17}={}){
  const list=(Array.isArray(portals)?portals:[]).filter(p=>p&&typeof p.env==='string'&&p.env).slice(0,MAX_DOORS);
  if(!list.length)return [];
  const angles=rooms.map(r=>Math.atan2(r.center.z,r.center.x)).sort((a,b)=>a-b),out=[];
  // The gaps between neighbouring rooms, widest first; with no rooms, the whole ring is one gap.
  const gaps=angles.length?angles.map((a,i)=>{const b=i+1<angles.length?angles[i+1]:angles[0]+Math.PI*2;return {from:a,size:b-a}}).sort((x,y)=>y.size-x.size):[{from:Math.PI/2,size:Math.PI*2}];
  // Share the doors out over the gaps by size, then space them evenly inside each gap.
  const per=gaps.map(()=>0);
  for(let k=0;k<list.length;k++){let best=0;for(let i=1;i<gaps.length;i++)if(gaps[i].size/(per[i]+1)>gaps[best].size/(per[best]+1))best=i;per[best]++}
  let k=0;
  gaps.forEach((g,i)=>{for(let j=0;j<per[i];j++){
    const a=g.from+g.size*(j+1)/(per[i]+1),x=Math.cos(a)*ringRadius,z=Math.sin(a)*ringRadius;
    out.push({portal:list[k++],x,z,facing:Math.atan2(-x,-z)});
  }});
  return out;
}
// The meshes: two posts, a lintel and a glowing pane per door. mat(color, opts) makes a material, box is a unit box.
export function buildDoors(THREE,spots,{box,mat}){
  const group=new THREE.Group(),frame=mat('#5b6b7a'),own=mat('#7cb980',{transparent:true,opacity:.55,side:THREE.DoubleSide,depthWrite:false}),theirs=mat('#3d6fb6',{transparent:true,opacity:.5,side:THREE.DoubleSide,depthWrite:false});
  // userData.own: office.js clear() disposes these materials with the doors.
  const part=(m,[x,y,z],[sx,sy,sz])=>{const o=new THREE.Mesh(box,m);o.position.set(x,y,z);o.scale.set(sx,sy,sz);o.userData.own=true;return o};
  const out=spots.map(s=>{
    const g=new THREE.Group();g.position.set(s.x,0,s.z);g.rotation.y=s.facing;
    g.add(part(frame,[-1,1.3,0],[0.22,2.6,0.22]),part(frame,[1,1.3,0],[0.22,2.6,0.22]),part(frame,[0,2.65,0],[2.22,0.22,0.22]));
    const pane=part(s.portal.own?own:theirs,[0,1.25,0],[1.78,2.5,0.04]);pane.userData={kind:'portal',id:s.portal.env,portal:s.portal,own:true};g.add(pane);
    const anchor=new THREE.Object3D();anchor.position.set(0,0,0);g.add(anchor);
    group.add(g);
    return {portal:s.portal,anchor,hit:pane,x:s.x,z:s.z};
  });
  return {group,spots:out};
}
export function doorAt(spots,x,z,reach=DOOR_REACH){
  let hit=null,best=reach;
  for(const s of spots||[]){const d=Math.hypot(s.x-x,s.z-z);if(d<best){best=d;hit=s}}
  return hit;
}
