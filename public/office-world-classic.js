// The classic office's scenery (docs/concepts/12-office.md): the floor plan office-layout.js lays out, drawn
// as a low-poly interior. Everything that never moves is merged into a handful of meshes with a colour per
// vertex: the floor with its zones, the four outer walls (each fades when the camera is beyond it, so you can
// always see yourself), the furniture and plants, all the glass, the light panels and the skyline outside.
// office.js still draws the rooms' own floors and low walls (a member's colours and theme), the main board's
// wall, people and agents.
import * as THREE from './vendor/three/three.module.min.js';
import {classicWorld} from './office-world-core.js';
import {ROOM_W,ROOM_D,WALL_H,DOOR_W,MAIN_WALL_H,MAIN_WALL_T,PLAN,toWorld} from './office-layout.js';

const C={concrete:'#e2e5e2',spine:'#eceeeb',stage:'#d9dee2',terrazzo:'#d6dadd',rug:'#9fb9c4',rugEdge:'#7f9dab',wood:'#d8b98c',wood2:'#cfae80',
  wall:'#f4f5f3',trim:'#3d4c56',frame:'#5b6b7a',white:'#f4f2ee',desk:'#b98d63',dark:'#27302d',screen:'#8fd3e8',pot:'#b5835a',pot2:'#e9e6df',
  leaf:'#5f9e6e',leaf2:'#74b283',teal:'#4f9fb8',mustard:'#e2b04a',core:'#e7eae8',roof:'#c7d0cc',roof2:'#d6ddda',slab:'#aab4b0',glass:'#cfe9f2'};

// A batch: boxes, prisms and floor quads with a colour each, as one geometry (flat shaded: a normal per face).
function batch(){
  const pos=[],nor=[],col=[],c=new THREE.Color();
  const tri=(a,b,d,n)=>{pos.push(a[0],a[1],a[2],b[0],b[1],b[2],d[0],d[1],d[2]);for(let i=0;i<3;i++){nor.push(n[0],n[1],n[2]);col.push(c.r,c.g,c.b)}};
  const quad=(a,b,d,e,n)=>{tri(a,b,d,n);tri(a,d,e,n)};
  const api={
    count:()=>pos.length/9,
    // A box standing on y0, w wide (its own x) and d deep, turned by yaw. top: another colour for its top face, or false for none.
    box(x,z,w,d,y0,y1,color,yaw=0,{top=null,bottom=false}={}){
      const cs=Math.cos(yaw),sn=Math.sin(yaw),hx=w/2,hz=d/2;
      const p=(lx,lz,y)=>[x+lx*cs+lz*sn,y,z-lx*sn+lz*cs],n=(lx,lz)=>[lx*cs+lz*sn,0,-lx*sn+lz*cs];
      c.set(color);
      quad(p(-hx,hz,y0),p(hx,hz,y0),p(hx,hz,y1),p(-hx,hz,y1),n(0,1));quad(p(hx,-hz,y0),p(-hx,-hz,y0),p(-hx,-hz,y1),p(hx,-hz,y1),n(0,-1));
      quad(p(hx,hz,y0),p(hx,-hz,y0),p(hx,-hz,y1),p(hx,hz,y1),n(1,0));quad(p(-hx,-hz,y0),p(-hx,hz,y0),p(-hx,hz,y1),p(-hx,-hz,y1),n(-1,0));
      if(bottom)quad(p(-hx,-hz,y0),p(hx,-hz,y0),p(hx,hz,y0),p(-hx,hz,y0),[0,-1,0]);
      if(top===false)return api;
      if(top)c.set(top);
      quad(p(-hx,hz,y1),p(hx,hz,y1),p(hx,-hz,y1),p(-hx,-hz,y1),[0,1,0]);
      return api;
    },
    // A flat rectangle on the floor.
    flat(x,z,w,d,y,color,yaw=0){
      const cs=Math.cos(yaw),sn=Math.sin(yaw),hx=w/2,hz=d/2,p=(lx,lz)=>[x+lx*cs+lz*sn,y,z-lx*sn+lz*cs];
      c.set(color);quad(p(-hx,hz),p(hx,hz),p(hx,-hz),p(-hx,-hz),[0,1,0]);return api;
    },
    // A rectangle with a border of another colour (no overlap, so nothing flickers).
    framed(x,z,w,d,y,color,edge,bw=0.14,yaw=0){
      const cs=Math.cos(yaw),sn=Math.sin(yaw),at=(lx,lz)=>[x+lx*cs+lz*sn,z-lx*sn+lz*cs];
      api.flat(x,z,w-2*bw,d-2*bw,y,color,yaw);
      for(const s of [-1,1]){const a=at(0,s*(d-bw)/2);api.flat(a[0],a[1],w,bw,y,edge,yaw);const b=at(s*(w-bw)/2,0);api.flat(b[0],b[1],bw,d-2*bw,y,edge,yaw)}
      return api;
    },
    // A prism or cone standing on y0: radius r0 at the bottom, r1 at the top.
    prism(x,z,y0,y1,r0,r1,sides,color,top=null){
      c.set(color);
      for(let i=0;i<sides;i++){
        const a=i/sides*Math.PI*2,b=(i+1)/sides*Math.PI*2,m=(a+b)/2,nn=[Math.sin(m),0.35,Math.cos(m)];
        const A=[x+Math.sin(a)*r0,y0,z+Math.cos(a)*r0],B=[x+Math.sin(b)*r0,y0,z+Math.cos(b)*r0],D=[x+Math.sin(b)*r1,y1,z+Math.cos(b)*r1],E=[x+Math.sin(a)*r1,y1,z+Math.cos(a)*r1];
        if(r1>0)quad(A,B,D,E,nn);else tri(A,B,[x,y1,z],nn);
      }
      if(r1>0){c.set(top||color);for(let i=0;i<sides;i++){const a=i/sides*Math.PI*2,b=(i+1)/sides*Math.PI*2;tri([x,y1,z],[x+Math.sin(a)*r1,y1,z+Math.cos(a)*r1],[x+Math.sin(b)*r1,y1,z+Math.cos(b)*r1],[0,1,0])}}
      return api;
    },
    mesh(material){
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
      const m=new THREE.Mesh(g,material);m.matrixAutoUpdate=false;m.updateMatrix();return m;
    },
  };
  return api;
}
const mix=(a,b,t)=>'#'+new THREE.Color(a).lerp(new THREE.Color(b),t).getHexString();
// The same "random" every time, from a seed.
const rng=seed=>()=>{seed=(seed+0x6d2b79f5)>>>0;let t=seed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296};

function buildScenery(core){
  const P=PLAN,HW=core.halfWidth,zF=core.zFront,zN=core.bounds.minZ,zS=core.bounds.maxZ,T=P.OUTER_T,H=P.OUTER_H;
  const floor=batch(),solid=batch(),glass=batch(),lights=batch(),city=batch();
  const sides={N:batch(),S:batch(),W:batch(),E:batch()};

  // ----- the floor and its zones -----
  floor.flat(0,(zN+zS)/2,2*HW,zS-zN,-0.02,C.concrete);
  floor.flat(0,0,P.SPINE,2*zF,0.004,C.spine);
  floor.framed(0,-zF-P.RECESS/2+1.4,P.CENTER-0.5,P.RECESS+2.8,0.004,C.stage,mix(C.stage,C.trim,0.25),0.1);   // in front of the main board
  floor.framed(0,zF+ROOM_D/2,P.CENTER,ROOM_D,0.004,C.terrazzo,mix(C.terrazzo,C.trim,0.2),0.1);
  floor.framed(0,zF+4.6,5.6,4,0.008,C.rug,C.rugEdge,0.2);                                                 // reception's rug
  {const L=core.loungeZone,n=Math.round(L.d/0.75),dz=L.d/n;for(let i=0;i<n;i++)floor.flat(L.x,L.z-L.d/2+(i+0.5)*dz,L.w,dz,0.004,i%2?C.wood:C.wood2)}
  {const m=core.meeting;floor.framed(m.x,zF+ROOM_D/2,P.SLOT,ROOM_D,0.004,mix(C.concrete,'#cfdcea',0.5),mix(C.concrete,C.trim,0.18),0.1)}
  for(const p of core.pods)floor.framed(p.x,p.z,p.w,p.d,0.004,p.color,mix(p.color,C.trim,0.28),0.12);
  for(const r of core.props)if(r.t==='rug')floor.framed(r.x,r.z,r.w,r.d,0.004,r.color,mix(r.color,C.trim,0.25),0.12);
  // The slab's edge, seen from outside.
  solid.box(0,(zN+zS)/2,2*HW+2*T,zS-zN+2*T,-0.7,-0.03,C.slab,0,{top:false});

  // ----- the outer walls: solid where rooms back onto them, windows elsewhere -----
  // spans: [from, to, window] along the wall, west to east or north to south.
  const window=(b,horizontal,a0,a1,fixed,sill=0.9)=>{
    const len=a1-a0,mid=(a0+a1)/2,put=(m,along,l,y0,y1,color,t=T,o)=>horizontal?m.box(along,fixed,l,t,y0,y1,color,0,o):m.box(fixed,along,t,l,y0,y1,color,0,o);
    put(b,mid,len,0,sill,C.wall);put(b,mid,len,3.3,H,C.wall,T,{top:C.trim});
    const n=Math.max(1,Math.round(len/2.05));
    for(let i=0;i<=n;i++)put(b,a0+len*i/n,0.12,sill,3.3,C.frame,T*0.8);
    put(glass,mid,len,sill,3.3,C.glass,0.05);
  };
  const solidWall=(b,horizontal,a0,a1,fixed)=>{const len=a1-a0,mid=(a0+a1)/2;if(horizontal)b.box(mid,fixed,len,T,0,H,C.wall,0,{top:C.trim});else b.box(fixed,mid,T,len,0,H,C.wall,0,{top:C.trim})};
  const run=(b,horizontal,fixed,spans)=>{for(const [a0,a1,win,sill] of spans)if(a1-a0>0.05)(win?window(b,horizontal,a0,a1,fixed,sill):solidWall(b,horizontal,a0,a1,fixed))};
  // Along x: a slot with windows (a bay, the meeting room, the lounge) has them between two piers. sillAt(side, i) -> 0 or the sill's height.
  const wing=sillAt=>{
    const spans=[],k=Math.round((HW-P.CENTER/2)/P.SLOT);
    const slot=(x0,x1,sill)=>{if(sill)spans.push([x0,x0+0.45,false],[x0+0.45,x1-0.45,true,sill],[x1-0.45,x1,false]);else spans.push([x0,x1,false])};
    for(let i=k;i>=1;i--){const x1=-(P.CENTER/2+(i-1)*P.SLOT);slot(x1-P.SLOT,x1,sillAt(-1,i))}
    spans.push([-P.CENTER/2,P.CENTER/2,false]);
    for(let i=1;i<=k;i++){const x0=P.CENTER/2+(i-1)*P.SLOT;slot(x0,x0+P.SLOT,sillAt(1,i))}
    return spans;
  };
  const bayAt=w=>(side,i)=>core.bays.some(b=>b.wing===w&&b.side===side&&b.i===i)?0.9:0;
  run(sides.N,true,zN-T/2,wing(bayAt(-1)));
  // South: the meeting room and the lounge (a higher sill over its counter) have windows too.
  run(sides.S,true,zS+T/2,wing((side,i)=>i===1?(side>0?1.15:0.9):bayAt(1)(side,i)));
  for(const [b,x] of [[sides.W,-HW-T/2],[sides.E,HW+T/2]])run(b,false,x,[[zN-T,-zF+0.3,false],[-zF+0.3,zF-0.3,true],[zF-0.3,zS+T,false]]);

  // ----- the service core behind the main board -----
  {const w=core.mainWall,d=w.z-MAIN_WALL_T/2-zN;solid.box(0,zN+d/2,P.CENTER-0.5,d,0,MAIN_WALL_H,C.core,0,{top:C.roof}).box(0,zN+d/2,P.CENTER-2.5,d-2,MAIN_WALL_H,MAIN_WALL_H+0.12,C.roof2)}

  // ----- glass over the rooms' low walls, with a slim frame -----
  const G=P.GLASS_H;
  for(const r of core.rooms){
    const at=(lx,lz)=>toWorld(r,lx,lz),side=(ROOM_W-DOOR_W)/2;
    const pane=(lx,lz,w,d)=>{const p=at(lx,lz);glass.box(p.x,p.z,w,d,WALL_H,G,C.glass,r.facing);solid.box(p.x,p.z,w+0.02,d+0.04,G,G+0.07,C.frame,r.facing)};
    pane(-ROOM_W/2,0,0.05,ROOM_D);pane(ROOM_W/2,0,0.05,ROOM_D);pane(-(DOOR_W/2+side/2),ROOM_D/2,side,0.05);pane(DOOR_W/2+side/2,ROOM_D/2,side,0.05);
    {const p=at(0,ROOM_D/2);solid.box(p.x,p.z,DOOR_W,0.09,G,G+0.07,C.frame,r.facing)}
    for(const [lx,lz,y0] of [[-ROOM_W/2,ROOM_D/2,WALL_H],[ROOM_W/2,ROOM_D/2,WALL_H],[-DOOR_W/2,ROOM_D/2,1.5],[DOOR_W/2,ROOM_D/2,1.5]]){const p=at(lx,lz);solid.box(p.x,p.z,0.1,0.1,y0,G,C.frame,r.facing)}
  }

  // ----- furniture and plants -----
  const local=(x,z,yaw,lx,lz)=>{const c=Math.cos(yaw),s=Math.sin(yaw);return [x+lx*c+lz*s,z-lx*s+lz*c]};
  for(const p of core.pods){
    for(const t of p.tables){
      solid.box(t.x,t.z,t.w,t.d,0.7,0.76,C.white).box(t.x,t.z,t.w-0.3,0.05,0.76,1.02,'#c9d2cd');
      for(const s of [-1,1])solid.box(t.x+s*(t.w/2-0.12),t.z,0.07,t.d-0.12,0,0.7,C.trim);
      const used=Math.ceil(t.seats/2);
      for(let i=0;i<t.seats;i++){
        const col=Math.floor(i/2),south=i%2?1:-1,x=t.x+(col-(used-1)/2)*P.POD_COL,z=t.z+south*0.2;
        solid.box(x,z,0.5,0.035,0.86,1.16,C.dark).box(x,z+south*0.02,0.44,0.012,0.89,1.13,C.screen).box(x,z,0.08,0.05,0.76,0.88,C.trim);
      }
    }
    // The pod's sign post, at its head.
    const sx=p.x-p.w/2+0.35,sz=p.north+0.35,tone=mix(p.color,C.trim,0.55);
    solid.box(sx,sz,0.1,0.1,0,2.5,C.trim).box(sx+0.55,sz,1.2,0.06,2.02,2.46,tone);
  }
  for(const r of core.props){
    const yaw=r.yaw||0;
    if(r.t==='plant'){
      const s=r.s||1,tall=(Math.round(r.x*7+r.z*3)&1)===0;
      solid.prism(r.x,r.z,0,0.5*s,0.24*s,0.32*s,6,tall?C.pot2:C.pot,'#5a4a3a');
      if(tall)solid.prism(r.x,r.z,0.5*s,1.9*s,0.42*s,0,6,C.leaf).prism(r.x,r.z,1.15*s,2.5*s,0.3*s,0,6,C.leaf2);
      else solid.prism(r.x,r.z,0.45*s,1.25*s,0.55*s,0.18*s,6,C.leaf,C.leaf2).prism(r.x,r.z,0.9*s,1.75*s,0.36*s,0,6,C.leaf2);
    }else if(r.t==='sofa'){
      const color=r.color||C.teal,dark=mix(color,C.trim,0.3);
      solid.box(r.x,r.z,r.w,r.d,0.14,0.46,color,yaw);
      {const [x,z]=local(r.x,r.z,yaw,0,-r.d/2+0.12);solid.box(x,z,r.w,0.24,0.14,0.86,dark,yaw)}
      for(const s of [-1,1]){const [x,z]=local(r.x,r.z,yaw,s*(r.w/2-0.1),0.06);solid.box(x,z,0.2,r.d-0.12,0.14,0.62,dark,yaw)}
    }else if(r.t==='table'){
      solid.box(r.x,r.z,r.w,r.d,0.7,0.76,C.desk,yaw);for(const s of [-1,1]){const [x,z]=local(r.x,r.z,yaw,s*(r.w/2-0.3),0);solid.box(x,z,0.08,r.d-0.3,0,0.7,C.trim,yaw)}
    }else if(r.t==='stool'){
      solid.prism(r.x,r.z,0,0.44,0.15,0.13,6,C.frame).prism(r.x,r.z,0.44,0.5,0.19,0.19,6,C.teal);
    }else if(r.t==='coffeetable'){
      solid.box(r.x,r.z,r.w,r.d,0.36,0.42,C.desk,yaw).box(r.x,r.z,r.w*0.5,r.d*0.5,0,0.36,C.trim,yaw);
    }else if(r.t==='desk'){
      solid.box(r.x,r.z,r.w,r.d,0,1,C.white).box(r.x,r.z,r.w+0.12,r.d+0.12,1,1.08,C.trim).box(r.x-r.w/2-0.01,r.z,0.03,r.d*0.7,0.3,0.7,C.leaf);
      solid.box(r.x+0.1,r.z-0.6,0.035,0.5,1.12,1.42,C.dark).box(r.x+0.12,r.z-0.6,0.012,0.44,1.15,1.39,C.screen);
      for(const dz of [-0.9,0.9])lamp(r.x-0.1,r.z+dz);
    }else if(r.t==='benchseat'){
      solid.box(r.x,r.z,r.w,r.d,0,0.42,C.desk,yaw).box(r.x,r.z,r.w-0.06,r.d-0.06,0.42,0.5,C.teal,yaw);
    }else if(r.t==='counter'){
      solid.box(r.x,r.z,r.w,r.d,0,0.9,C.white).box(r.x,r.z,r.w+0.06,r.d+0.06,0.9,0.95,C.trim);
      solid.box(r.x-1.9,r.z,0.42,0.46,0.95,1.42,C.dark).box(r.x-1.9,r.z-0.2,0.2,0.1,1.02,1.12,C.mustard).box(r.x-2.6,r.z,0.5,0.5,0.95,1.05,'#d9dcde');
      for(let i=0;i<4;i++)solid.prism(r.x+0.4+i*0.24,r.z-0.05,0.95,1.06,0.07,0.08,6,[C.white,C.teal,C.mustard,'#e58b7a'][i]);
      solid.box(r.x+2.3,r.z,0.6,0.6,0,1.9,'#dfe3e6').box(r.x+2.3,r.z-0.31,0.05,0.03,0.9,1.5,C.frame);                      // the fridge
    }else if(r.t==='island'){
      solid.box(r.x,r.z,r.w,r.d,0.98,1.05,C.desk);
      for(const s of [-1,1]){solid.box(r.x+s*(r.w/2-0.25),r.z,0.08,r.d-0.2,0,0.98,C.trim);solid.prism(r.x+s*(r.w/2+0.5),r.z,0,0.66,0.16,0.14,6,C.frame).prism(r.x+s*(r.w/2+0.5),r.z,0.66,0.72,0.2,0.2,6,C.desk)}
      for(const dx of [-0.6,0.6])lamp(r.x+dx,r.z);
    }else if(r.t==='pingpong'){
      solid.box(r.x,r.z,r.w,r.d,0.72,0.78,'#3f7fb0',yaw,{top:'#3f7fb0'}).box(r.x,r.z,0.03,r.d+0.2,0.78,0.94,C.white,yaw).box(r.x,r.z,r.w-0.6,0.08,0,0.72,C.trim,yaw);
    }else if(r.t==='shelf'){
      solid.box(r.x,r.z,r.w,r.d,0,2,C.desk,yaw);
      const rnd=rng(Math.round(r.x*31+r.z*17)>>>0),cols=['#c86b5c','#5fa8d3','#e9a23b','#7cb980','#8f7cc3',C.white,'#4fb3a5'];
      for(let row=0;row<3;row++)for(let i=0;i<6;i++){const [x,z]=local(r.x,r.z,yaw,-r.w/2+0.3+i*(r.w-0.6)/5,r.d/2+0.01);solid.box(x,z,0.34,0.03,0.25+row*0.6,0.25+row*0.6+0.3+rnd()*0.16,cols[Math.floor(rnd()*cols.length)],yaw)}
    }else if(r.t==='booth'){
      solid.box(r.x,r.z,r.w,r.d,2.1,2.2,C.trim,yaw,{bottom:true});
      {const [x,z]=local(r.x,r.z,yaw,0,-r.d/2+0.04);solid.box(x,z,r.w,0.08,0,2.1,C.trim,yaw)}
      for(const s of [-1,1]){const [x,z]=local(r.x,r.z,yaw,s*(r.w/2-0.04),0);solid.box(x,z,0.08,r.d,0,2.1,mix(C.trim,C.teal,0.35),yaw)}
      {const [x,z]=local(r.x,r.z,yaw,0,-0.3);solid.box(x,z,r.w-0.3,0.5,0,0.46,C.mustard,yaw)}
      {const [x,z]=local(r.x,r.z,yaw,0,r.d/2-0.03);glass.box(x,z,r.w-0.16,0.04,0,2.1,C.glass,yaw)}
    }
  }
  // A hanging lamp: a thin rod and a shade.
  function lamp(x,z){solid.box(x,z,0.02,0.02,2.45,3.6,C.frame).prism(x,z,2.12,2.45,0.24,0.07,6,C.mustard,C.mustard)}

  // ----- light panels overhead (they fade when the camera is above them) -----
  const LY=3.55,panel=(x,z,w,d)=>lights.box(x,z,w,d,LY,LY+0.05,'#ffffff',0,{bottom:true});
  for(const p of core.pods)for(const t of p.tables)panel(t.x,t.z,Math.max(1.6,t.w-0.6),0.5);
  for(let z=-zF+2;z<=zF-1.9;z+=4)panel(0,z,0.5,2.2);
  for(const s of [-1,1])for(let x=-HW+4;x<=HW-4;x+=8)if(Math.abs(x)>P.SPINE)panel(x,s*(zF-P.CORRIDOR/2),2.6,0.4);

  // ----- the city outside: towers around the floor, paler the farther off -----
  {
    const rnd=rng(20261),near=16,far=170,sky='#e4edf4',tones=['#a9bacb','#b6c3cf','#9fb3c4','#c2ccd6','#aebfca'];
    const zHalf=(zS-zN)/2;
    for(let i=0;i<170;i++){
      const a=rnd()*Math.PI*2,u=rnd(),d=near+u*u*(far-near)+rnd()*14;
      // Low roofs near the windows, towers further off, so the skyline rises towards the horizon.
      const x=Math.cos(a)*(HW+d),z=Math.sin(a)*(zHalf+d),w=8+rnd()*12,dd=8+rnd()*12,rise=Math.min(1,d/90),top=-30+rnd()*14+rise*rnd()*46,t=Math.min(0.78,0.12+d/far*0.8);
      const base=tones[Math.floor(rnd()*tones.length)],color=mix(base,sky,t);
      city.box(x,z,w,dd,-90,top,color,rnd()*0.5,{top:mix(color,'#ffffff',0.25)});
      if(rnd()<0.4)city.box(x+(rnd()-0.5)*w*0.4,z+(rnd()-0.5)*dd*0.4,w*0.4,dd*0.4,top,top+2+rnd()*5,mix(color,'#ffffff',0.12),0,{top:mix(color,'#ffffff',0.3)});
    }
    // The tower this floor is in, going down.
    city.box(0,(zN+zS)/2,2*HW+2*T-0.4,zS-zN+2*T-0.4,-90,-0.7,'#c3ced8',0,{top:false});
  }
  return {floor,solid,glass,lights,city,sides};
}

export function createClassicWorld({scene}){
  const bg='#e4edf4';
  scene.background=new THREE.Color(bg);scene.fog=new THREE.Fog(bg,45,135);
  const hemi=new THREE.HemisphereLight('#ffffff','#c2cbc7',2.25),sun=new THREE.DirectionalLight('#fff6e8',1.5);sun.position.set(14,30,20);
  scene.add(hemi,sun);
  const lit=()=>new THREE.MeshLambertMaterial({vertexColors:true});
  const mats={floor:lit(),solid:lit(),city:lit(),
    glass:new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,opacity:0.26,depthWrite:false}),
    lights:new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,opacity:0.9,depthWrite:false,fog:false}),
    N:lit(),S:lit(),W:lit(),E:lit()};
  const group=new THREE.Group();group.name='classic-scenery';scene.add(group);
  let core=classicWorld([]),sig='',meshes={},backs=[];
  const fade={N:1,S:1,W:1,E:1};let veilSig='';
  function rebuild(){
    for(const m of Object.values(meshes)){group.remove(m);m.geometry.dispose()}
    const b=buildScenery(core);meshes={};let triangles=0;
    const add=(name,bt,material)=>{const m=bt.mesh(material);m.name=name;meshes[name]=m;group.add(m);triangles+=bt.count();return m};
    add('floor',b.floor,mats.floor);add('solid',b.solid,mats.solid);add('city',b.city,mats.city);
    for(const s of 'NSWE')add(s,b.sides[s],mats[s]);
    add('glass',b.glass,mats.glass).renderOrder=2;add('lights',b.lights,mats.lights).renderOrder=3;
    world.floors=[meshes.floor];world.stats={triangles,meshes:Object.keys(meshes).length};
  }
  const world={
    id:'classic',name:'Office',background:bg,sea:-Infinity,floors:[],stats:{triangles:0},terrain:null,scenery:[group],
    layout(keys,opts={}){core=classicWorld(keys,opts);if(core.sig!==sig){sig=core.sig;rebuild()}return core},
    // Where the AgentFlow org stands for these members: Map(id -> {x, z, yaw}); sig changes when the floor must be laid out again.
    org(list,keys){const w=classicWorld(keys,{org:list});return {pos:w.org.pos,pods:w.org.pods,radius:Math.max(9,w.coreDepth/2),sig:w.sig}},
    common(){},
    // The rooms office.js built: their back walls are the outer walls' inner face, and fade with them.
    adoptRooms(rooms){backs=[];for(const [key,r] of rooms)if(r.backMat)backs.push({key,mat:r.backMat,side:r.center.z<0?'N':'S'});veilSig=''},
    // Rooms (member keys) whose back wall the camera is behind right now: what hangs on it is hidden too (office.js).
    veiled:new Set(),veilRev:0,
    update(t,dt,{camera}={}){
      if(!camera)return;
      const p=camera.position,b=core.bounds,k=Math.min(1,(dt||0.016)*9);
      // Fog starts beyond the floor, however high the camera is: the overview stays crisp, the city soft.
      scene.fog.near=Math.max(45,p.y+12);scene.fog.far=scene.fog.near+Math.max(90,core.radius+60);
      const out={N:p.z<b.minZ+0.2,S:p.z>b.maxZ-0.2,W:p.x<b.minX+0.2,E:p.x>b.maxX-0.2};
      for(const s of 'NSWE'){
        const want=out[s]?0.07:1;fade[s]+=(want-fade[s])*k;if(Math.abs(want-fade[s])<0.01)fade[s]=want;
        setFade(mats[s],fade[s]);
      }
      for(const x of backs)setFade(x.mat,fade[x.side]);
      const now=backs.filter(x=>out[x.side]).map(x=>x.key).join('\n');
      if(now!==veilSig){veilSig=now;world.veiled=new Set(now?now.split('\n'):[]);world.veilRev++}
      mats.lights.opacity=Math.max(0.1,Math.min(0.92,(5.2-p.y)/1.6));
      // From high above the floor is a plan: the city under it steps back.
      setFade(mats.city,Math.max(0.16,Math.min(1,(70-p.y)/40)));
    },
    get walls(){return core.walls},get signs(){return core.signs},get spawn(){return core.spawn},get center(){return core.center},get bounds(){return core.bounds},
    ground:(x,z)=>core.ground(x,z),respawn:p=>core.respawn(p),splash(){},
    dispose(){scene.remove(hemi,sun,group);for(const m of Object.values(meshes))m.geometry.dispose();for(const m of Object.values(mats))m.dispose();scene.fog=null},
  };
  rebuild();
  return world;
}
function setFade(m,a){
  const solid=a>=0.995;
  if(m.transparent===solid){m.transparent=!solid;m.depthWrite=solid;m.needsUpdate=true}
  m.opacity=solid?1:a;
}
