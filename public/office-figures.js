// Figures for the 3D office (office.js): people (drawn by office-avatar.js from a look, office-look-core.js),
// and instanced robots, team tables and automations for the AgentFlow org in the common area.
// Geometries and materials are shared (one material per colour), and the org is drawn with one
// InstancedMesh per part, so forty agents cost a handful of draw calls. A person is one draw call.
import * as THREE from './vendor/three/three.module.min.js';
import {createAvatar,animateAvatar,disposeAvatars,paceAvatars} from './office-avatar.js';
import {defaultLook,hashOf} from './office-look-core.js';

const ROBOT=['#5fa8d3','#7cb980','#e9a23b','#c86b5c','#8f7cc3','#4fb3a5','#d97fa0','#9aa63a'];
export {hashOf};
// The look of someone who has not chosen one: the same for a key every time.
export const lookFor=key=>defaultLook(key);

const mats=new Map();
export function matOf(color,{dim=false,basic=false}={}){
  const k=color+(dim?'d':'')+(basic?'b':'');let m=mats.get(k);
  if(!m){m=basic?new THREE.MeshBasicMaterial({color}):new THREE.MeshLambertMaterial({color,flatShading:true,...(dim?{transparent:true,opacity:.42,depthWrite:false}:{})});mats.set(k,m)}
  return m;
}
export const disposeFigures=()=>{for(const m of mats.values())m.dispose();mats.clear();for(const g of Object.values(G))g.dispose?.();disposeAvatars()};
const G={};
const geo=()=>{if(!G.box)Object.assign(G,{box:new THREE.BoxGeometry(1,1,1),ball:new THREE.IcosahedronGeometry(1,1),gem:new THREE.IcosahedronGeometry(1,0),cyl:new THREE.CylinderGeometry(1,1,1,8),disc:new THREE.CircleGeometry(1,14)});return G};
const mesh=(g,m,[x,y,z],[sx,sy,sz])=>{const o=new THREE.Mesh(g,m);o.position.set(x,y,z);o.scale.set(sx,sy,sz);return o};
const SHADOW=()=>matOf('#000000',{basic:true});

// ---------- people ----------
// A person about 1.75 tall facing +z (office-avatar.js). dim: someone who is not here. shadow: a blob under them.
//   figure.userData.update(t, {speed, grounded, jumping, emote:{kind, at}, phase, cycle})   once per frame
//   figure.userData.setLook(look)   figure.userData.dispose()
export function makeHuman(look,{dim=false,shadow=true}={}){
  const g=geo(),root=createAvatar(look,{dim});
  if(shadow){const sh=mesh(g.disc,SHADOW(),[0,0.02,0],[0.42,0.42,0.42]);sh.rotation.x=-Math.PI/2;sh.material.transparent=true;sh.material.opacity=.14;sh.material.depthWrite=false;root.add(sh)}
  return root;
}
// animateHuman(rig, t, state): the same as figure.userData.update(t, state), for callers that keep the rig.
export const animateHuman=animateAvatar;
// Once per drawn frame, with its length in seconds: on a slow device people further off use their light meshes.
export const paceFigures=paceAvatars;

// ---------- the AgentFlow org: robots, team tables, automations (instanced) ----------
// items: [{id, kind:'agent'|'team'|'automation', x, z, dim}] -> {group, pick(object, instanceId) -> id,
//   move(id, x, y, z, yaw, scale)} — move puts one robot somewhere else (office-npc.js walks them).
export function orgField(items){
  const g=geo(),group=new THREE.Group(),meshes=[],ids=new Map(),parts=[];
  const part=(list,geometry,material,place,colorOf)=>{
    if(!list.length)return;
    const im=new THREE.InstancedMesh(geometry,material,list.length),o=new THREE.Object3D(),c=new THREE.Color(),offs=[];
    list.forEach((it,i)=>{const p=place(it),[x,y,z,sx,sy,sz,ry=0]=p;offs.push(p);o.position.set(it.x+x,y,it.z+z);o.rotation.set(0,ry,0);o.scale.set(sx,sy,sz);o.updateMatrix();im.setMatrixAt(i,o.matrix);
      if(colorOf){c.set(colorOf(it));if(it.dim)c.lerp(new THREE.Color('#c7ccca'),.65);im.setColorAt(i,c)}});
    im.instanceMatrix.needsUpdate=true;if(im.instanceColor)im.instanceColor.needsUpdate=true;
    im.userData.kind='af';ids.set(im,list.map(it=>it.id));group.add(im);meshes.push(im);
    parts.push({im,offs,index:new Map(list.map((it,i)=>[it.id,i]))});
  };
  const white=new THREE.MeshLambertMaterial({color:'#ffffff',flatShading:true});
  const robots=items.filter(i=>i.kind==='agent'),teams=items.filter(i=>i.kind==='team'),autos=items.filter(i=>i.kind==='automation');
  const tint=it=>ROBOT[hashOf(it.id)%ROBOT.length];
  // Robots: a rounded body in their colour, a white head with a dark visor and glowing eyes, an antenna.
  part(robots,g.ball,white,()=>[0,0.5,0,0.27,0.3,0.24],tint);
  part(robots,g.box,white,()=>[0,0.98,0,0.46,0.34,0.36],it=>it.dim?'#e2e4e3':'#f4f6f5');
  part(robots,g.box,matOf('#22302c'),()=>[0,0.99,0.17,0.36,0.2,0.04]);
  part(robots,g.box,matOf('#7fe3ff',{basic:true}),()=>[-0.08,1.0,0.195,0.07,0.07,0.02]);
  part(robots,g.box,matOf('#7fe3ff',{basic:true}),()=>[0.08,1.0,0.195,0.07,0.07,0.02]);
  part(robots,g.cyl,matOf('#4a5652'),()=>[0,1.24,0,0.02,0.16,0.02]);
  part(robots,g.gem,white,()=>[0,1.35,0,0.06,0.06,0.06],tint);
  part(robots,g.box,matOf('#4a5652'),()=>[0,0.12,0,0.34,0.14,0.26]);
  part(robots,g.box,white,()=>[-0.31,0.6,0,0.08,0.3,0.1],tint);
  part(robots,g.box,white,()=>[0.31,0.6,0,0.08,0.3,0.1],tint);
  // Teams: a round table with stools.
  part(teams,g.cyl,matOf('#c79a6b'),()=>[0,0.7,0,0.8,0.08,0.8],null);
  part(teams,g.cyl,matOf('#8b6a48'),()=>[0,0.35,0,0.1,0.7,0.1],null);
  for(let k=0;k<5;k++){const a=k/5*Math.PI*2;part(teams,g.cyl,white,()=>[Math.cos(a)*1.1,0.24,Math.sin(a)*1.1,0.2,0.48,0.2],it=>ROBOT[(hashOf(it.id)+k)%ROBOT.length])}
  // Automations: a little machine with a gear on top.
  part(autos,g.box,white,()=>[0,0.4,0,0.6,0.8,0.5],()=> '#8d9894');
  part(autos,g.cyl,matOf('#f0b23e'),()=>[0,0.86,0,0.24,0.1,0.24]);
  part(autos,g.box,matOf('#22302c'),()=>[0,0.5,0.26,0.36,0.22,0.02]);
  part(autos,g.box,matOf('#7cb980',{basic:true}),()=>[0,0.5,0.275,0.1,0.06,0.01]);
  const sh=new THREE.InstancedMesh(g.disc,(()=>{const m=matOf('#000000',{basic:true});m.transparent=true;m.opacity=.14;m.depthWrite=false;return m})(),items.length||1);
  const o=new THREE.Object3D();items.forEach((it,i)=>{o.position.set(it.x,0.02,it.z);o.rotation.set(-Math.PI/2,0,0);const r=it.kind==='team'?1.4:0.45;o.scale.set(r,r,r);o.updateMatrix();sh.setMatrixAt(i,o.matrix)});
  sh.count=items.length;group.add(sh);
  const shadowAt=new Map(items.map((it,i)=>[it.id,i])),last=new Map(),q=new THREE.Object3D();
  // One robot's new pose: every part turned about its centre by yaw, the shadow left on the floor. Unchanged
  // poses cost nothing.
  function move(id,x,y,z,yaw=0,scale=1){
    const key=x*1e6+y*1e4+z*1e2+yaw+scale*7,prev=last.get(id);if(prev===key)return;last.set(id,key);
    const c=Math.cos(yaw),s=Math.sin(yaw);
    for(const p of parts){
      const i=p.index.get(id);if(i===undefined)continue;
      const [ox,oy,oz,sx,sy,sz,ry=0]=p.offs[i];
      q.position.set(x+(ox*c+oz*s)*scale,y+oy*scale,z+(-ox*s+oz*c)*scale);q.rotation.set(0,ry+yaw,0);q.scale.set(sx*scale,sy*scale,sz*scale);q.updateMatrix();
      p.im.setMatrixAt(i,q.matrix);p.im.instanceMatrix.needsUpdate=true;p.im.boundingSphere=null;
    }
    const k=shadowAt.get(id);
    if(k!==undefined){q.position.set(x,0.02,z);q.rotation.set(-Math.PI/2,0,0);const r=0.45*scale;q.scale.set(r,r,r);q.updateMatrix();sh.setMatrixAt(k,q.matrix);sh.instanceMatrix.needsUpdate=true}
  }
  return {group,meshes,move,pick:(obj,i)=>ids.get(obj)?.[i]??null,dispose(){white.dispose();for(const m of meshes)m.dispose();sh.dispose()}};
}

// Org chart positions: managers above their reports; reports that have none of their own are packed in a
// small grid under their manager. -> {pos: Map(id -> {x, z}), radius}
export function orgLayout(list,{sx=2.5,sz=2.9,gz=2.1}={}){
  const ids=new Set(list.map(a=>a.id)),kids=new Map(),parent=new Map();
  for(const a of list){let p=a.reportsTo&&ids.has(a.reportsTo)&&a.reportsTo!==a.id?a.reportsTo:'';
    // no loops: walk up from p; if we reach a, drop the link
    for(let x=p,n=0;x&&n<500;x=parent.get(x),n++)if(x===a.id){p='';break}
    parent.set(a.id,p);if(p)(kids.get(p)||kids.set(p,[]).get(p)).push(a.id)}
  const size=new Map();
  const measure=id=>{const k=kids.get(id)||[];k.forEach(measure);
    const leaves=k.length>3&&k.every(c=>!(kids.get(c)||[]).length);
    const s=leaves?{w:Math.min(4,Math.ceil(Math.sqrt(k.length*1.4))),grid:true}:{w:Math.max(1,k.reduce((n,c)=>n+size.get(c).w,0)),grid:false};
    if(leaves)s.rows=Math.ceil(k.length/s.w);size.set(id,s)};
  const roots=list.filter(a=>!parent.get(a.id)).map(a=>a.id);roots.forEach(measure);
  const pos=new Map();
  const place=(id,x0,z)=>{const s=size.get(id),k=kids.get(id)||[];pos.set(id,{x:(x0+s.w/2)*sx,z:z*1});
    if(s.grid)k.forEach((c,i)=>pos.set(c,{x:(x0+s.w/2-(Math.min(s.w,k.length)-1)/2+i%s.w)*sx,z:z+sz+Math.floor(i/s.w)*gz}));
    else{let x=x0;for(const c of k){place(c,x,z+sz);x+=size.get(c).w}}};
  // Lone roots (no reports) sit in a row of their own after the trees.
  const trees=roots.filter(r=>(kids.get(r)||[]).length),loners=roots.filter(r=>!(kids.get(r)||[]).length);
  let x=0;for(const r of trees){place(r,x,0);x+=size.get(r).w+0.4}
  const maxZ=Math.max(0,...[...pos.values()].map(p=>p.z));
  loners.forEach((r,i)=>pos.set(r,{x:(i%8+0.5)*sx,z:maxZ+sz+Math.floor(i/8)*gz}));
  if(!pos.size)return {pos,radius:9};
  const xs=[...pos.values()].map(p=>p.x),zs=[...pos.values()].map(p=>p.z),cx=(Math.min(...xs)+Math.max(...xs))/2,cz=(Math.min(...zs)+Math.max(...zs))/2;
  let radius=0;for(const p of pos.values()){p.x-=cx;p.z-=cz;radius=Math.max(radius,Math.hypot(p.x,p.z))}
  return {pos,radius:Math.max(9,radius+3)};
}
