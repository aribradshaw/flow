// Merged geometry for the 3D office: many boxes, prisms and floor rectangles as one mesh (one draw call),
// each with its own colour (a colour per vertex) and flat shaded (a normal per face). office-world-classic.js
// builds its scenery with it, and office.js a room's walls.
import * as THREE from './vendor/three/three.module.min.js';

// A batch: boxes, prisms and floor quads with a colour each, as one geometry (flat shaded: a normal per face).
export function batch(){
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
