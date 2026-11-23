// The yacht world of the 3D office: a compact superyacht at sea, drawn from the plan in office-world-core.js.
// Cheap on purpose: the whole yacht is three merged meshes (painted surfaces with vertex colours, glass,
// lights) and one more for the team tables; the sea is a small grid near the hull and a flat plane beyond
// it; the sky is one shader; islands, clouds, gulls and the splash are a handful of draw calls more. About
// a dozen draw calls and well under 25k triangles. No textures, no shadows, no post-processing.
// Painted surfaces are cut away where they hide you (office-cutaway.js), so the camera never has to squeeze
// inside the rails.
import * as THREE from './vendor/three/three.module.min.js';
import {yachtWorld,YACHT} from './office-world-core.js';
import {TABLE} from './office-tables-core.js';
import {cutaway} from './office-cutaway.js';

const PAL={navy:'#1e3446',stripe:'#3d8f66',keel:'#5d3b38',white:'#f4f7f5',shade:'#dde5e1',teak:'#c99b6c',teak2:'#a97d50',teakLight:'#d9b68a',teakGrey:'#b89878',gold:'#d8b46a',carpet:'#cfe3d2',dark:'#182830',steel:'#c5cecc',
  cushion:'#fbfbf7',green:'#3d8f66',amber:'#e9a23b',teal:'#2f8f8a',coral:'#d9785f',pad:'#39484d',yellow:'#f2c94c',leaf:'#4f9a5d',leaf2:'#37774a',trunk:'#96764f',
  pool:'#63dbe6',runner:'#ecdcbc',slate:'#35566a',mint:'#bfe3cf',hedge:'#5fa66b',table:'#c79a6b',leg:'#8b6a48',warm:'#ffdca6',red:'#e5484d',lime:'#46c46a',glass:'#bfe3ea',sand:'#e6d6ac',rock:'#8f9a8c',hill:'#6aa56f',hill2:'#4d8a5c',cloud:'#ffffff',navy2:'#27455c',heli:'#f2f4f3',dolphin:'#6f8ea6'};
const SKY={zenith:'#3d8fdc',horizon:'#cfe8f3',haze:'#f7eedc',deep:'#0f5676',shallow:'#2aa0b6',mirror:'#8fc6e6',sun:'#fff1cf'};
const SUN_DIR=new THREE.Vector3(0.42,0.62,0.66).normalize();

// ---------- a small mesh builder: flat faces with a colour per vertex ----------
function mesher(){
  const pos=[],col=[],c=new THREE.Color();
  const put=(p,k)=>{pos.push(p[0],p[1],p[2]);col.push(c.r*k,c.g*k,c.b*k)};
  // A flat face a-b-c-d (or a triangle when d is null), wound to face away from the point `from`.
  function face(a,b,cc,d,color,from,k=[1,1,1,1]){
    c.set(color);
    const e=d||cc,ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=e[0]-a[0],vy=e[1]-a[1],vz=e[2]-a[2];
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,out=!from||nx*(a[0]-from[0])+ny*(a[1]-from[1])+nz*(a[2]-from[2])>=0;
    if(out){put(a,k[0]);put(b,k[1]);put(cc,k[2]);if(d){put(a,k[0]);put(cc,k[2]);put(d,k[3])}}
    else{put(a,k[0]);put(cc,k[2]);put(b,k[1]);if(d){put(a,k[0]);put(d,k[3]);put(cc,k[2])}}
  }
  // A box standing on (x, y, z): w wide, h high, d deep; yaw turns it, tilt leans it towards its +z, roll raises its +x end.
  function box(x,y,z,w,h,d,color,{yaw=0,tilt=0,roll=0,top=null,ao=.86,bottom=false}={}){
    const cy=Math.cos(yaw),sy=Math.sin(yaw),ct=Math.cos(tilt),st=Math.sin(tilt),cr=Math.cos(roll),sr=Math.sin(roll);
    const P=(lx,ly,lz)=>{const X=lx*cr-ly*sr,Y=lx*sr+ly*cr,Y2=Y*ct-lz*st,Z2=Y*st+lz*ct;return [x+X*cy+Z2*sy,y+Y2,z-X*sy+Z2*cy]};
    const a=w/2,b=d/2,v=[P(-a,0,-b),P(a,0,-b),P(a,0,b),P(-a,0,b),P(-a,h,-b),P(a,h,-b),P(a,h,b),P(-a,h,b)],m=P(0,h/2,0),k=[ao,ao,1,1];
    face(v[0],v[1],v[5],v[4],color,m,k);face(v[1],v[2],v[6],v[5],color,m,k);face(v[2],v[3],v[7],v[6],color,m,k);face(v[3],v[0],v[4],v[7],color,m,k);
    face(v[4],v[5],v[6],v[7],top||color,m);
    if(bottom)face(v[0],v[1],v[2],v[3],color,m,[ao,ao,ao,ao]);
  }
  // A convex outline [[x,z],…] from y0 up to y1.
  function prism(pts,y0,y1,color,{top=null,ao=.86,bottom=false}={}){
    const n=pts.length,mx=pts.reduce((s,p)=>s+p[0],0)/n,mz=pts.reduce((s,p)=>s+p[1],0)/n,m=[mx,(y0+y1)/2,mz];
    for(let i=0;i<n;i++){const p=pts[i],q=pts[(i+1)%n];face([p[0],y0,p[1]],[q[0],y0,q[1]],[q[0],y1,q[1]],[p[0],y1,p[1]],color,m,[ao,ao,1,1])}
    for(let i=1;i<n-1;i++){face([pts[0][0],y1,pts[0][1]],[pts[i][0],y1,pts[i][1]],[pts[i+1][0],y1,pts[i+1][1]],null,top||color,m);
      if(bottom)face([pts[0][0],y0,pts[0][1]],[pts[i][0],y0,pts[i][1]],[pts[i+1][0],y0,pts[i+1][1]],null,color,m,[ao,ao,ao,ao])}
  }
  const ring=(x,z,r,n,turn=0)=>Array.from({length:n},(_,i)=>[x+Math.cos(turn+i/n*Math.PI*2)*r,z+Math.sin(turn+i/n*Math.PI*2)*r]);
  // A cylinder or cone frustum standing on (x, y, z).
  function cyl(x,y,z,r,h,n,color,{r2=r,top=null,ao=.86}={}){
    const a=ring(x,z,r,n),b=ring(x,z,r2,n),m=[x,y+h/2,z];
    for(let i=0;i<n;i++){const j=(i+1)%n;face([a[i][0],y,a[i][1]],[a[j][0],y,a[j][1]],[b[j][0],y+h,b[j][1]],[b[i][0],y+h,b[i][1]],color,m,[ao,ao,1,1])}
    if(r2>0.001)for(let i=1;i<n-1;i++)face([b[0][0],y+h,b[0][1]],[b[i][0],y+h,b[i][1]],[b[i+1][0],y+h,b[i+1][1]],null,top||color,m);
  }
  // A low-poly ball centred on (x, y, z).
  function ball(x,y,z,r,color,{sy=1,n=7,ao=.8}={}){
    const lat=[-0.55,0.35],rr=lat.map(a=>Math.cos(a)*r),yy=lat.map(a=>y+Math.sin(a)*r*sy),lo=ring(x,z,rr[0],n),hi=ring(x,z,rr[1],n,Math.PI/n),m=[x,y,z];
    for(let i=0;i<n;i++){const j=(i+1)%n;
      face([x,y-r*sy,z],[lo[j][0],yy[0],lo[j][1]],[lo[i][0],yy[0],lo[i][1]],null,color,m,[ao,ao,ao]);
      face([lo[i][0],yy[0],lo[i][1]],[lo[j][0],yy[0],lo[j][1]],[hi[i][0],yy[1],hi[i][1]],null,color,m,[ao,ao,1]);
      face([lo[j][0],yy[0],lo[j][1]],[hi[j][0],yy[1],hi[j][1]],[hi[i][0],yy[1],hi[i][1]],null,color,m,[ao,1,1]);
      face([hi[i][0],yy[1],hi[i][1]],[hi[j][0],yy[1],hi[j][1]],[x,y+r*sy,z],null,color,m)}
  }
  function build(){
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
    g.computeVertexNormals();g.computeBoundingSphere();return g;
  }
  return {face,box,prism,cyl,ball,ring,build,get count(){return pos.length/9}};
}

// ---------- the yacht's static geometry, from a plan ----------
function buildYacht(W){
  const {MAIN,SWIM,UPPER,FORE,SEA,RAIL}=YACHT,P=W.plan,{HB,E,zL0,zL1,zSw,swimRamp,stairX,upRamp,zB0,bow,zBow,zBreak,foreRamp,roomW,roomD,meet,zone,tub}=P;
  const S=mesher(),G=mesher(),L=mesher(),F=mesher(); // solid, glass, lights, floors (for picking)
  const lerp=(a,b,t)=>a+(b-a)*Math.max(0,Math.min(1,t));

  // ----- hull: lofted between stations, navy topsides over a green boot stripe; the sheer rises to the bow -----
  const rise=9;
  const navyTop=z=>z<=zB0?FORE+RAIL+0.8*((zB0-z)/bow)**2:z<zB0+rise?lerp(FORE+RAIL,MAIN+RAIL,(z-zB0)/rise):z<=zL1?MAIN+RAIL:z<zL1+swimRamp?lerp(MAIN+RAIL,SWIM+0.02,(z-zL1)/swimRamp):SWIM+0.02;
  const waterBeam=z=>z<zB0?0.9*HB*Math.max(0,1-((zB0-z)/(bow-4))**1.7):0.9*W.halfBeam(z);
  const profile=z=>{const hw=W.halfBeam(z),wl=Math.min(waterBeam(z),hw),top=navyTop(z);return [[0,SEA-1.9],[wl*0.55,SEA-1.4],[wl,SEA-0.12],[lerp(wl,hw,0.16),SEA+0.45],[lerp(wl,hw,0.86),lerp(SEA+0.45,top,0.72)],[hw,top]]};
  const stations=[];
  for(let i=0;i<=10;i++)stations.push(zBow+bow*(i/10)**1.35);
  for(const z of [zB0+rise/2,zB0+rise,(zB0+rise+zL0)/2,zL0,(zL0+zL1)/2,zL1,zL1+swimRamp,(zL1+swimRamp+zSw)/2,zSw])if(z>stations.at(-1)+0.5)stations.push(z);
  const bands=[PAL.keel,PAL.keel,PAL.stripe,PAL.navy,PAL.navy2],NB=bands.length;
  for(let i=0;i<stations.length-1;i++){
    const za=stations[i],zb=stations[i+1],a=profile(za),b=profile(zb),from=[0,SEA,(za+zb)/2];
    for(const s of [-1,1])for(let j=0;j<NB;j++)S.face([s*a[j][0],a[j][1],za],[s*b[j][0],b[j][1],zb],[s*b[j+1][0],b[j+1][1],zb],[s*a[j+1][0],a[j+1][1],za],bands[j],from,j===3?[.72,.72,1,1]:[.9,.9,1,1]);
  }
  {const t=profile(zSw);for(let j=0;j<NB;j++)S.face([-t[j][0],t[j][1],zSw],[t[j][0],t[j][1],zSw],[t[j+1][0],t[j+1][1],zSw],[-t[j+1][0],t[j+1][1],zSw],bands[j],[0,SEA,zSw-2],[.8,.8,1,1])}
  for(let z=zL0+2;z<zL1-2;z+=3.6)for(const s of [-1,1])S.box(s*(HB+0.02),SEA+1.35,z,0.08,0.36,1,PAL.dark,{ao:1});   // portholes under the lounge

  // ----- decks: each area its own tone, so the plan reads at a glance -----
  const slab=(x0,x1,z0,z1,y,thick,color=PAL.teak,side=PAL.white)=>S.box((x0+x1)/2,y-thick,(z0+z1)/2,x1-x0,thick,z1-z0,side,{top:color});
  const inlay=(x0,x1,z0,z1,y,color)=>S.box((x0+x1)/2,y+0.008,(z0+z1)/2,x1-x0,0.012,z1-z0,color,{ao:1});
  const strips=(z0,z1,n,y,thick,color)=>{for(let i=0;i<n;i++){const za=z0+(z1-z0)*i/n,zb=z0+(z1-z0)*(i+1)/n,wa=Math.max(0.05,W.halfBeam(za)-0.04),wb=Math.max(0.05,W.halfBeam(zb)-0.04);
    S.prism([[-wa,za],[wa,za],[wb,zb],[-wb,zb]],y-thick,y,PAL.white,{top:color})}};
  const planks=(x0,x1,z0,z1,y,every=1.3)=>{for(let x=x0+every/2;x<x1;x+=every)S.box(x,y,(z0+z1)/2,0.05,0.012,z1-z0,PAL.teak2,{ao:1})};
  const X=HB-0.04;
  // the lounge: teak, a pale runner down the centre aisle, mint carpets under the tables, slate before the main board
  slab(-X,X,zL0,zL1,MAIN,0.5);
  planks(-X+0.5,X-0.4,zone.back+0.3,zL1-0.2,MAIN,1.4);
  inlay(-(stairX-0.2),stairX-0.2,zL0+0.9,zone.front-1.5,MAIN,PAL.slate);
  inlay(-zone.aisle,zone.aisle,zone.front-1.5,meet.z-meet.d/2,MAIN,PAL.runner);
  for(const s of [-1,1])inlay(s>0?zone.aisle+0.25:-zone.reach-0.1,s>0?zone.reach+0.1:-zone.aisle-0.25,zone.front-1.35,zone.back+0.25,MAIN,PAL.mint);
  inlay(stairX,X-0.5,zL0,zone.front-1.5,MAIN,PAL.runner);                                           // the way to the stair
  // the upper deck block: the lounge's forward bulkhead is its aft face; the stair cuts a trench in its starboard corner
  S.box((stairX-X)/2,MAIN,(zB0+zL0)/2,stairX+X,UPPER-MAIN,zL0-zB0,PAL.white,{top:PAL.teakLight});
  S.box((stairX+X)/2,MAIN,(zB0+zL0-upRamp)/2,X-stairX,UPPER-MAIN,zL0-upRamp-zB0,PAL.white,{top:PAL.teakLight});
  inlay(W.plan.cx+roomD/2+0.5,X-0.5,zB0+0.4,zL0-upRamp,UPPER,PAL.runner);                           // the one corridor
  inlay(stairX+0.1,X-0.5,zL0-upRamp-0.3,zL0-upRamp,UPPER,PAL.gold);
  for(const s of [-1,1]){S.box(s*(HB+0.01),UPPER-0.3,(zB0+zL0)/2,0.06,0.18,zL0-zB0,PAL.stripe,{ao:1});S.box(s*(HB+0.03),MAIN+0.62,(zB0+rise+zL1)/2,0.05,0.09,zL1-zB0-rise,PAL.gold,{ao:1})}
  // the sun deck on the bow, and the swim platform
  strips(zBow+0.2,zB0,9,FORE,0.5,PAL.teakGrey);
  S.box((stairX-X)/2,FORE-0.3,zB0+0.1,stairX+X,UPPER-FORE+0.3,0.2,PAL.white);                         // the bridge front
  strips(zL1,zSw,4,SWIM,0.45,PAL.teakGrey);
  S.box(0,SWIM,zSw-0.75,(W.halfBeam(zSw)-1)*2,0.02,0.9,PAL.teak2,{ao:1});
  S.box(0,SWIM,zL1+0.12,stairX*2,MAIN-SWIM,0.26,PAL.white);                                          // transom

  // ----- no shadows are drawn, so decks get a darker band where something tall stands on them -----
  const shade=(x,z,w,d,y,color=PAL.teak2)=>S.box(x,y+0.02,z,w,0.012,d,color,{ao:1});
  shade(0,zL1+0.7,stairX*2,1.1,SWIM);shade((stairX-X)/2,zB0-0.6,stairX+X,1.1,FORE);

  // ----- windows: long dark bands, broken by mullions -----
  const band=(x,z0,z1,y0,y1,every=3.4)=>{S.box(x,y0,(z0+z1)/2,0.1,y1-y0,z1-z0,PAL.dark,{ao:.9});for(let z=z0+every;z<z1-0.5;z+=every)S.box(x,y0,z,0.14,y1-y0,0.16,PAL.white,{ao:1})};
  const bandX=(z,x0,x1,y0,y1,every=3.4)=>{S.box((x0+x1)/2,y0,z,x1-x0,y1-y0,0.1,PAL.dark,{ao:.9});for(let x=x0+every;x<x1-0.5;x+=every)S.box(x,y0,z,0.16,y1-y0,0.14,PAL.white,{ao:1})};
  for(const s of [-1,1])band(s*(HB+0.02),zB0+rise+0.8,zL0-1.2,MAIN+1.42,UPPER-0.42);
  bandX(zB0-0.02,-(HB-1.6),stairX-0.6,FORE+0.5,UPPER-0.3,3);
  bandX(zL1+0.28,-3.4,3.4,SWIM+0.3,MAIN-0.35,2.3);                                                   // the beach club

  // ----- stairs: boxes for steps, each with a lit nosing -----
  function stairs(x,w,zLow,zHigh,yLow,yHigh){
    const n=Math.max(3,Math.round((yHigh-yLow)/0.3)),run=(zHigh-zLow)/n,rise=(yHigh-yLow)/n;
    for(let i=0;i<n;i++){const z=zLow+run*(i+0.5),h=rise*(i+1);S.box(x,yLow-0.3,z,w,h+0.3,Math.abs(run)+0.01,PAL.white,{top:PAL.teak});L.box(x,yLow+h-0.07,z-run/2,w-0.3,0.05,0.04,PAL.warm,{ao:1})}
  }
  stairs((stairX+X)/2,X-stairX,zL0,zL0-upRamp,MAIN,UPPER);
  stairs((stairX+X)/2-0.15,X-stairX-0.3,zB0-foreRamp,zB0,FORE,UPPER);
  for(const s of [-1,1]){
    stairs(s*(stairX+X)/2,X-stairX,zL1+swimRamp,zL1,SWIM,MAIN);
    // the wing that carries the hull's line down beside the swim steps
    const z1=zL1+swimRamp,xo=z=>s*(W.halfBeam(z)-0.02),top=z=>navyTop(z);
    S.face([xo(zL1),SWIM,zL1],[xo(z1),SWIM,z1],[xo(z1),top(z1)+0.5,z1],[xo(zL1),top(zL1),zL1],PAL.navy,[0,SWIM,zL1]);
    S.face([xo(zL1)-s*0.3,SWIM,zL1],[xo(z1)-s*0.3,SWIM,z1],[xo(z1)-s*0.3,top(z1)+0.5,z1],[xo(zL1)-s*0.3,top(zL1),zL1],PAL.white,[s*HB*2,SWIM,zL1]);
  }

  // ----- rails and bulwarks, from the same boxes that stop people -----
  function glassRail(b,y0,y1=y0){
    const len=b.halfX*2,roll=Math.atan2(y1-y0,len),long=len/Math.cos(roll),ym=(y0+y1)/2;
    G.box(b.x,ym+0.1,b.z,long,0.8,0.04,PAL.glass,{yaw:b.yaw,roll,ao:1});
    S.box(b.x,ym+0.96,b.z,long,0.07,0.1,PAL.steel,{yaw:b.yaw,roll,ao:1});
    const n=Math.max(1,Math.round(len/2.8));
    for(let i=0;i<=n;i++){const t=i/n-0.5,x=b.x+t*len*b.c,z=b.z-t*len*b.s;S.box(x,lerp(y0,y1,i/n),z,0.07,1,0.07,PAL.steel,{ao:1})}
  }
  for(const b of W.walls){
    const top=b.height;
    if(b.kind==='rail'){b.slope?glassRail(b,b.slope[0],b.slope[1]):glassRail(b,top-RAIL)}
    else if(b.kind==='block'||b.kind==='bulkhead'||b.kind==='transom')glassRail(b,top-RAIL);
    else if(b.kind==='bulwark'){
      // white inside, the hull's navy outside, a varnished cap
      const o=(b.s*b.x+b.c*(b.z-W.center.z)<0?-1:1)*0.16;
      S.box(b.x+o*b.s,b.y,b.z+o*b.c,b.halfX*2+0.1,RAIL-0.06,0.56,PAL.white,{yaw:b.yaw,top:PAL.teak2});
    }
  }

  // ----- furniture that stops people -----
  const pillows=[PAL.green,PAL.amber,PAL.teal,PAL.coral];
  for(const b of W.walls){
    if(b.kind==='sofa'){
      const w=b.halfX*2,d=b.halfZ*2,side=Math.sign(b.x)||-1;
      S.box(b.x,b.y,b.z,w,0.42,d,PAL.cushion,{ao:.9});S.box(b.x+side*(w/2-0.15),b.y,b.z,0.3,0.92,d,PAL.cushion,{ao:.9});
      for(let i=0;i<3;i++)S.box(b.x+side*(w/2-0.42),b.y+0.42,b.z+(i-1)*1,0.2,0.4,0.55,pillows[i],{ao:.92});
      S.box(b.x-side*1.25,b.y,b.z,0.7,0.4,1.3,PAL.teak2,{top:PAL.teak});
    }else if(b.kind==='tub'){S.cyl(b.x,b.y,b.z,tub.r,0.72,10,PAL.white,{top:PAL.teak2});S.cyl(b.x,b.y+0.3,b.z,tub.r-0.3,0.45,10,PAL.teal,{top:PAL.teal});L.cyl(b.x,b.y+0.6,b.z,tub.r-0.32,0.03,10,PAL.pool,{ao:1})}
    else if(b.kind==='jetski'){
      const c=b.x>0?PAL.coral:PAL.teal;
      S.box(b.x,b.y+0.1,b.z,1,0.42,2.4,PAL.heli,{top:c});S.box(b.x,b.y+0.5,b.z+0.35,0.5,0.22,1.1,PAL.dark);
      S.box(b.x,b.y+0.5,b.z-0.75,0.62,0.34,0.5,c,{tilt:-0.4});S.box(b.x,b.y+0.86,b.z-0.6,0.8,0.05,0.07,PAL.dark);
    }else if(b.kind==='hedge'){S.box(b.x,b.y,b.z,b.halfX*2,0.55,b.halfZ*2,PAL.white);S.box(b.x,b.y+0.55,b.z,b.halfX*2-0.2,0.62,b.halfZ*2-0.16,PAL.hedge,{top:PAL.leaf})}
  }
  // warm strip lights along the lounge's bulwarks and the main board's zone
  for(const s of [-1,1])L.box(s*(E-0.02),MAIN+0.12,(zL0+zL1)/2,0.03,0.05,zL1-zL0-0.6,PAL.warm,{ao:1});
  L.box((stairX-X)/2,MAIN+0.12,zL0+0.16,stairX+X-0.8,0.05,0.03,PAL.warm,{ao:1});
  // palms in planters on the sun deck, where they frame the bridge
  function palm(x,z,y,h=4,lean=0.5){
    S.box(x,y,z,0.9,0.6,0.9,PAL.white,{top:PAL.leaf2});
    const dir=Math.atan2(-z,-x)+0.6;let tx=x,tz=z,ty=y+0.6;
    for(let i=0;i<4;i++){const r=0.19-i*0.03;S.cyl(tx,ty,tz,r,h/4+0.05,5,PAL.trunk,{r2:r-0.02});ty+=h/4;tx+=Math.cos(dir)*lean*i*0.12;tz+=Math.sin(dir)*lean*i*0.12}
    for(let i=0;i<7;i++){const a=i/7*Math.PI*2,c=Math.cos(a),s=Math.sin(a),m=[tx,ty-3,tz];
      const mid=[tx+c*1.2,ty+0.35,tz+s*1.2],tip=[tx+c*2.3,ty-0.7,tz+s*2.3],w=0.4;
      S.face([tx,ty,tz],[mid[0]-s*w,mid[1],mid[2]+c*w],[mid[0]+s*w,mid[1],mid[2]-c*w],null,i%2?PAL.leaf:PAL.leaf2,m);
      S.face([mid[0]-s*w,mid[1],mid[2]+c*w],tip,[mid[0]+s*w,mid[1],mid[2]-c*w],null,i%2?PAL.leaf2:PAL.leaf,m)}
  }
  // ahead of the breakwater nobody walks: a sun pad, palms and the anchor gear
  for(const s of [-1,1])palm(s*(W.halfBeam(zBreak-0.9)-1.5),zBreak-0.9,FORE,s>0?3.2:3.7);
  S.box(0,FORE,zBreak-1.5,1.7,0.4,1.9,PAL.cushion,{ao:.9});S.box(0,FORE+0.4,zBreak-0.9,1.4,0.16,0.5,PAL.teal,{ao:1});
  function lounger(x,z,y,yaw,color=PAL.cushion){
    const c=Math.cos(yaw),s=Math.sin(yaw);
    S.box(x,y+0.22,z,0.75,0.14,1.5,color,{yaw,ao:.9});S.box(x+s*0.95,y+0.22,z+c*0.95,0.75,0.14,0.75,color,{yaw,tilt:-0.75,ao:.9});
    S.box(x,y,z,0.6,0.22,1.3,PAL.teak2,{yaw});
  }
  function parasol(x,z,y,color){S.cyl(x,y,z,0.05,2.5,5,PAL.steel);S.cyl(x,y+2.3,z,1.7,0.5,8,color,{r2:0.06})}
  parasol(tub.x+1.9,tub.z-1.2,FORE,PAL.amber);
  S.cyl(0,FORE,zBow+1.6,0.3,0.5,7,PAL.steel,{r2:0.22});S.box(0,FORE,zBow+0.9,0.22,0.2,1,PAL.dark);

  // ----- suites and the bridge: office.js builds each room with a tall back wall for its board. From the sea
  // that wall is the deckhouse's side: windows on it, a roof lip over it, and an open pergola back to the door -----
  const place=(r,lx,lz)=>[r.x+lx*Math.cos(r.facing)+lz*Math.sin(r.facing),r.z-lx*Math.sin(r.facing)+lz*Math.cos(r.facing)];
  for(const r of W.rooms){
    const hw=roomW/2,hd=roomD/2,H=3.9,bridge=r.kind==='bridge';
    {const [x,z]=place(r,0,-hd-0.12);S.box(x,r.y+1.5,z,roomW-1.6,1.5,0.06,PAL.dark,{yaw:r.facing,ao:.9});
      for(let i=1;i<4;i++){const [mx,mz]=place(r,-hw+0.8+i*(roomW-1.6)/4,-hd-0.14);S.box(mx,r.y+1.5,mz,0.14,1.5,0.08,PAL.white,{yaw:r.facing,ao:1})}}
    {const [x,z]=place(r,0,-hd+0.55);S.box(x,r.y+H+0.06,z,roomW+0.7,0.14,1.9,PAL.white,{yaw:r.facing,top:PAL.shade,bottom:true})}
    for(const lx of [-hw,hw]){const [x,z]=place(r,lx,hd);S.box(x,r.y,z,0.16,H,0.16,PAL.white);const [bx,bz]=place(r,lx,0.6);S.box(bx,r.y+H,bz,0.14,0.14,roomD-1.4,PAL.white,{yaw:r.facing})}
    for(const lx of [-1.7,1.7]){const [x,z]=place(r,lx,hd);L.box(x,r.y+1.12,z,0.16,0.1,0.16,PAL.warm,{ao:1})}
    if(bridge){
      // the wheelhouse: a raked windscreen across its forward side, a hardtop over the helm, the radar arch and mast on top
      const fx=r.z-hw-0.2,xa=r.x-hd,xb=r.x+hd,from=[r.x,r.y+2,r.z];
      S.face([xa,r.y+1.05,fx-0.5],[xb,r.y+1.05,fx-0.5],[xb,r.y+H,fx+0.5],[xa,r.y+H,fx+0.5],PAL.dark,from,[.9,.9,1,1]);
      for(let i=0;i<=4;i++){const x=xa+(xb-xa)*i/4;S.face([x-0.07,r.y+1.05,fx-0.52],[x+0.07,r.y+1.05,fx-0.52],[x+0.07,r.y+H,fx+0.48],[x-0.07,r.y+H,fx+0.48],PAL.white,from)}
      S.box(r.x,r.y,fx-0.3,roomD+0.3,1.05,0.5,PAL.white,{top:PAL.shade});
      S.box(r.x,r.y+H,fx+2.1,roomD+0.9,0.2,3.6,PAL.white,{top:PAL.shade,bottom:true});
      const az=fx+2.4,AH=r.y+H+0.2;
      for(const s of [-1,1]){S.box(r.x+s*(hd-0.3),AH,az,0.7,2.1,1.9,PAL.white,{tilt:-0.22});L.box(r.x+s*(hd+0.1),AH+1.7,az-0.4,0.12,0.26,0.26,s>0?PAL.lime:PAL.red,{ao:1})}
      S.box(r.x,AH+2.1,az-0.5,roomD+0.5,0.2,2.7,PAL.white,{top:PAL.shade,bottom:true});
      S.cyl(r.x,AH+2.3,az-0.4,0.18,2.9,6,PAL.white,{r2:0.06});L.box(r.x,AH+5.25,az-0.4,0.14,0.14,0.14,PAL.warm,{ao:1});
      S.box(r.x,AH+4.2,az-0.4,2.8,0.06,0.06,PAL.steel);for(const s of [-1,1]){S.ball(r.x+s*2.5,AH+2.85,az-0.6,0.6,PAL.white);S.cyl(r.x+s*1.3,AH+4.2,az-0.4,0.03,0.8,4,PAL.steel)}
    }
  }
  for(const r of W.spare){
    for(const lx of [-3,0,3]){const [x,z]=place(r,lx,-1.6);lounger(x,z,r.y,r.facing,PAL.cushion)}
    const [x,z]=place(r,4.6,-2.6);parasol(x,z,r.y,PAL.teal);
  }
  // ensign staff at the stern
  {const fx=-(stairX-0.5),fz=zL1-0.25;S.cyl(fx,MAIN,fz,0.05,3.2,5,PAL.steel);S.face([fx,MAIN+3.1,fz],[fx,MAIN+2.3,fz],[fx,MAIN+2.3,fz+1.4],[fx,MAIN+3.1,fz+1.4],PAL.stripe,null)}

  // ----- floors for picking: one flat sheet per level, highest hit first -----
  const sheet=(x0,x1,z0,z1,y)=>F.face([x0,y,z0],[x0,y,z1],[x1,y,z1],[x1,y,z0],'#fff',[0,y-1,0]);
  sheet(-HB,HB,zL1,zSw,SWIM);sheet(-HB,HB,zL0,zL1,MAIN);sheet(-HB,HB,zB0,zL0,UPPER);sheet(-HB,HB,zBow,zB0,FORE);
  const radar={x:W.rooms[0].x,y:W.rooms[0].y+3.9+0.2+2.35,z:W.rooms[0].z-roomW/2-0.2+2.4-0.5};
  return {solid:S.build(),glass:G.build(),lights:L.build(),floors:F.build(),triangles:S.count+G.count+L.count,radar};
}
// The team tables (office-tables-core.js): a top on two legs and a stool per seat, in one mesh.
function buildTables(seating){
  const S=mesher(),stools=[PAL.green,PAL.amber,PAL.teal,PAL.coral];
  for(const t of seating?.tables||[]){
    S.box(t.x,TABLE.height-0.08,t.z,t.width,0.08,t.depth,PAL.leg,{top:PAL.table,bottom:true});
    for(const k of [-1,1])S.box(t.x+k*Math.max(0,t.width/2-0.35),0,t.z,0.14,TABLE.height-0.08,t.depth-0.5,PAL.leg);
  }
  for(const p of seating?.pos.values()||[])if(p.role!=='table')S.cyl(p.x+p.out.x*0.16,0,p.z+p.out.z*0.16,0.2,0.3,6,PAL.white,{top:stools[p.table%4]});
  return {geometry:S.build(),triangles:S.count};
}

// ---------- far scenery: islands and clouds in one mesh, tiled along the course ----------
const TILE=1800;
function buildFar(){
  const S=mesher();
  for(const dz of [0,-TILE]){let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  const island=(x,z,r,h)=>{
    const n=9,turn=rnd()*6,rings=[[1,-1.5,PAL.sand],[0.82,h*0.07,PAL.sand],[0.66,h*0.3,PAL.hill],[0.36,h*0.72,PAL.hill2],[0.12,h,PAL.rock]].map(([k,y,c])=>({y,c,p:S.ring(x,z,r*k,n,turn).map(p=>[p[0]+(rnd()-0.5)*r*0.14,p[1]+(rnd()-0.5)*r*0.14])}));
    for(let j=0;j<rings.length-1;j++)for(let i=0;i<n;i++){const a=rings[j],b=rings[j+1],k=(i+1)%n;
      S.face([a.p[i][0],a.y,a.p[i][1]],[a.p[k][0],a.y,a.p[k][1]],[b.p[k][0],b.y,b.p[k][1]],[b.p[i][0],b.y,b.p[i][1]],b.c,[x,-20,z],[.86,.86,1,1])}
    const t=rings.at(-1);for(let i=1;i<n-1;i++)S.face([t.p[0][0],t.y,t.p[0][1]],[t.p[i][0],t.y,t.p[i][1]],[t.p[i+1][0],t.y,t.p[i+1][1]],null,t.c,[x,-20,z]);
  };
  for(const [x,z,r,h] of [[-430,-520,120,58],[-560,-380,70,30],[520,-640,150,74],[690,-420,60,26],[-640,300,95,44],[470,420,80,36],[-380,820,60,22],[760,60,110,50]])island(x,z+dz,r,h);
  for(let i=0;i<10;i++){const a=rnd()*Math.PI*2,d=340+rnd()*620,x=Math.cos(a)*d,z=(rnd()-0.5)*TILE+dz,y=150+rnd()*130,s=26+rnd()*30;
    for(let j=0;j<3;j++)S.ball(x+(j-1)*s*0.8+(rnd()-0.5)*8,y+(rnd()-0.5)*6,z+(rnd()-0.5)*s*0.5,s*(0.55+rnd()*0.4),PAL.cloud,{sy:0.42,n:6,ao:.86})}
  }
  return S.build();
}

// ---------- sea and sky ----------
const WATER_VERT=`uniform float uT,uSpeed,uAmp;varying vec3 vP;
float H(vec2 p){return sin(p.x*0.085+uT*0.8)*0.34+sin(p.y*0.12-uT*1.05+p.x*0.04)*0.28+sin((p.x*0.7-p.y)*0.23+uT*1.5)*0.14+sin((p.x+p.y*0.6)*0.47-uT*2.1)*0.07;}
void main(){vec4 w=modelMatrix*vec4(position,1.0);vec2 q=w.xz-vec2(0.0,uT*uSpeed);
  w.y+=H(q)*uAmp*(1.0-smoothstep(90.0,142.0,max(abs(w.x),abs(w.z))));vP=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`;
const WATER_FRAG=`uniform float uT,uSpeed,uSea;uniform vec3 uDeep,uShallow,uSkyCol,uHorizon,uSunDir,uSunCol;uniform vec4 uHull;varying vec3 vP;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),f.x),f.y);}
void main(){
  vec3 n=normalize(cross(dFdx(vP),dFdy(vP)));if(n.y<0.0)n=-n;
  vec3 v=normalize(cameraPosition-vP);
  float fres=pow(1.0-clamp(dot(n,v),0.0,1.0),3.0),lit=clamp(dot(n,uSunDir),0.0,1.0);
  vec3 col=mix(uDeep,uShallow,clamp(0.45+(vP.y-uSea)*0.9,0.0,1.0))*(0.7+0.5*lit);
  col=mix(col,uSkyCol,fres*0.5);
  vec2 gq=vP.xz-vec2(0.0,uT*uSpeed);
  col+=uSunCol*pow(max(dot(reflect(-uSunDir,n),v),0.0),46.0)*(0.5+1.7*step(0.66,noise(gq*1.9+uT*0.6)));
  vec2 p=vP.xz,q=p-vec2(0.0,uT*uSpeed);
  float nz=noise(q*0.32)*0.6+noise(q*1.05+uT*0.25)*0.4;
  // foam along the hull, a V from the bow, and the wash astern
  float u=clamp((uHull.y-p.y)/(uHull.y-uHull.x-4.0),0.0,1.0),hw=uHull.w*0.9*(1.0-pow(u,1.7));
  float d=max(abs(p.x)-hw,max(uHull.x+4.0-p.y,p.y-uHull.z));
  vec2 ps=p+vec2(3.2,4.4);float us=clamp((uHull.y-ps.y)/(uHull.y-uHull.x-4.0),0.0,1.0);
  col*=1.0-0.3*smoothstep(4.0,-1.5,max(abs(ps.x)-uHull.w*0.95*(1.0-pow(us,1.7)),max(uHull.x+4.0-ps.y,ps.y-uHull.z)));
  float foam=smoothstep(2.2,0.1,d+nz*2.6)*0.9;
  float s2=p.y-(uHull.x+4.0);
  if(s2>0.0){float arm=abs(abs(p.x)-(1.5+s2*0.33));foam=max(foam,smoothstep(1.0+s2*0.025,0.0,arm)*exp(-s2/55.0)*smoothstep(0.44,0.7,nz)*0.6);}
  float s=p.y-uHull.z;
  if(s>0.0){float w0=uHull.w*0.55+s*0.1;foam=max(foam,smoothstep(w0,w0*0.25,abs(p.x))*exp(-s/75.0)*smoothstep(0.4,0.72,nz+0.2*exp(-s/12.0))*0.9);}
  col=mix(col,mix(uShallow,vec3(0.97,0.99,1.0),0.82),clamp(foam,0.0,1.0)*0.9);
  // lighter, greener water where the hull has just passed
  if(s>0.0)col=mix(col,uShallow*1.25,smoothstep(uHull.w+s*0.16,0.0,abs(p.x))*exp(-s/120.0)*0.35);
  col+=vec3(0.05,0.5,0.6)*exp(-distance(p,vec2(0.0,uHull.z+1.0))*0.2)*0.55;
  col=mix(col,uHorizon,smoothstep(200.0,1050.0,length(vP.xz-cameraPosition.xz))*0.97);
  gl_FragColor=vec4(col,1.0);
  #include <colorspace_fragment>
}`;
const SKY_VERT=`varying vec3 vDir;void main(){vDir=position;vec4 p=viewMatrix*vec4(position+cameraPosition,1.0);gl_Position=projectionMatrix*p;}`;
const SKY_FRAG=`uniform vec3 uZenith,uHorizon,uHaze,uSunDir,uSunCol;varying vec3 vDir;
void main(){vec3 d=normalize(vDir);float h=max(d.y,0.0);
  vec3 col=mix(uHorizon,uZenith,pow(h,0.55));col=mix(col,uHaze,exp(-h*11.0)*0.45);
  float s=max(dot(d,uSunDir),0.0);col+=uSunCol*(smoothstep(0.9990,0.9994,s)+pow(s,220.0)*0.5+pow(s,14.0)*0.14);
  gl_FragColor=vec4(col,1.0);
  #include <colorspace_fragment>
}`;
// The sea near the hull: a small grid, finer towards the middle, that carries the waves, the wake and the foam.
const NEAR=150;
function seaGeometry(){
  const n=40,a=58,b=NEAR-58,pos=[],idx=[],f=u=>u*a+u*u*u*b;
  for(let j=0;j<=n;j++)for(let i=0;i<=n;i++)pos.push(f(i/n*2-1),0,f(j/n*2-1));
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){const p=j*(n+1)+i;idx.push(p,p+n+1,p+1,p+1,p+n+1,p+n+2)}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);return g;
}
// Beyond it: a flat frame out to the horizon, eight triangles and a few instructions a pixel.
function farSeaGeometry(){
  const a=NEAR-2,b=1400,pos=[-b,0,-b,b,0,-b,b,0,b,-b,0,b,-a,0,-a,a,0,-a,a,0,a,-a,0,a],idx=[];
  for(let i=0;i<4;i++){const j=(i+1)%4;idx.push(i,4+i,j,j,4+i,4+j)}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);return g;
}
const FAR_VERT=`varying vec3 vP;void main(){vec4 w=modelMatrix*vec4(position,1.0);vP=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`;
const FAR_FRAG=`uniform vec3 uDeep,uShallow,uSkyCol,uHorizon,uSunDir;varying vec3 vP;
void main(){
  vec3 v=normalize(cameraPosition-vP);
  vec3 col=mix(uDeep,uShallow,0.45)*(0.7+0.5*clamp(uSunDir.y,0.0,1.0));
  col=mix(col,uSkyCol,pow(1.0-clamp(v.y,0.0,1.0),3.0)*0.5);
  col=mix(col,uHorizon,smoothstep(200.0,1050.0,length(vP.xz-cameraPosition.xz))*0.97);
  gl_FragColor=vec4(col,1.0);
  #include <colorspace_fragment>
}`;

// ---------- the world ----------
// ctx: {scene, deck (the group everything on board is added to, which rocks with the sea)}
export function createYachtWorld({scene,deck}){
  const col=s=>new THREE.Color(s),own=[],keep=o=>{own.push(o);return o};
  const horizon=col(SKY.horizon);
  scene.background=horizon;scene.fog=new THREE.Fog(SKY.horizon,150,1150);
  // a warm sun against cool shade: with no shadows drawn, that contrast is what gives the house its shape
  const hemi=keep(new THREE.HemisphereLight('#e4f1ff','#7b9fb4',1.65)),sun=keep(new THREE.DirectionalLight('#fff0d2',2.45));
  sun.position.copy(SUN_DIR).multiplyScalar(60);scene.add(hemi,sun);
  const tU={value:0},seaU={uDeep:{value:col(SKY.deep)},uShallow:{value:col(SKY.shallow)},uSkyCol:{value:col(SKY.mirror)},uHorizon:{value:horizon},uSunDir:{value:SUN_DIR}};
  const sea=keep(new THREE.Mesh(seaGeometry(),new THREE.ShaderMaterial({vertexShader:WATER_VERT,fragmentShader:WATER_FRAG,uniforms:{...seaU,uT:tU,uSpeed:{value:3.2},uAmp:{value:0.5},uSea:{value:YACHT.SEA},
    uSunCol:{value:col(SKY.sun)},uHull:{value:new THREE.Vector4()}}})));
  const farSea=keep(new THREE.Mesh(farSeaGeometry(),new THREE.ShaderMaterial({vertexShader:FAR_VERT,fragmentShader:FAR_FRAG,uniforms:seaU})));
  for(const m of [sea,farSea]){m.position.y=YACHT.SEA;m.frustumCulled=false;scene.add(m)}
  const sky=keep(new THREE.Mesh(new THREE.SphereGeometry(1200,24,12),new THREE.ShaderMaterial({vertexShader:SKY_VERT,fragmentShader:SKY_FRAG,side:THREE.BackSide,depthWrite:false,depthTest:false,
    uniforms:{uZenith:{value:col(SKY.zenith)},uHorizon:{value:horizon},uHaze:{value:col(SKY.haze)},uSunDir:{value:SUN_DIR},uSunCol:{value:col(SKY.sun)}}})));
  sky.frustumCulled=false;sky.renderOrder=-10;scene.add(sky);
  const paint=cutaway(new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide})),glassMat=cutaway(new THREE.MeshLambertMaterial({vertexColors:true,transparent:true,opacity:.34,depthWrite:false,side:THREE.DoubleSide})),
    lightMat=new THREE.MeshBasicMaterial({vertexColors:true}),farMat=new THREE.MeshLambertMaterial({vertexColors:true}),pickMat=new THREE.MeshBasicMaterial({visible:false}),
    tableMat=new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide});
  const farGeo=buildFar(),far=keep(new THREE.Mesh(farGeo,farMat));far.frustumCulled=false;scene.add(far);
  // gulls: one instanced, flapping V
  const gullGeo=new THREE.BufferGeometry();gullGeo.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0.25,-1.1,0.3,0,0,0,-0.2, 0,0,0.25,0,0,-0.2,1.1,0.3,0],3));gullGeo.computeVertexNormals();
  const gulls=keep(new THREE.InstancedMesh(gullGeo,new THREE.MeshBasicMaterial({color:'#ffffff',side:THREE.DoubleSide}),6));gulls.frustumCulled=false;scene.add(gulls);
  // the splash: droplets and a ring on the water
  const drops=keep(new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16,0),new THREE.MeshBasicMaterial({color:'#eafaff'}),14));drops.visible=false;drops.frustumCulled=false;scene.add(drops);
  const ripple=keep(new THREE.Mesh(new THREE.RingGeometry(0.72,1,20),new THREE.MeshBasicMaterial({color:'#ffffff',transparent:true,opacity:0,depthWrite:false})));ripple.rotation.x=-Math.PI/2;ripple.visible=false;scene.add(ripple);
  const group=new THREE.Group();deck.add(group);
  const radar=new THREE.Mesh(new THREE.BoxGeometry(2.4,0.14,0.3),new THREE.MeshLambertMaterial({color:PAL.white,flatShading:true}));group.add(radar);
  const dolphinGeo=(()=>{const m=mesher();m.cyl(0,-1.15,0,0.03,1.15,6,PAL.dolphin,{r2:0.3,ao:.9});m.cyl(0,0,0,0.3,1.25,6,PAL.dolphin,{r2:0.04,ao:1});
    m.face([0,-0.2,0.25],[0,0.3,0.25],[0,-0.05,0.62],null,PAL.dolphin,null);m.face([-0.42,-1.3,0],[0.42,-1.3,0],[0,-1.0,0],null,PAL.dolphin,null);
    const g=m.build();g.rotateX(-Math.PI/2);return g})();
  const dolphins=keep(new THREE.InstancedMesh(dolphinGeo,new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide}),3));dolphins.frustumCulled=false;scene.add(dolphins);
  const dummy=new THREE.Object3D();
  let core=yachtWorld(1),key='',meshes=[],floor=null,splashAt=-1,splashPos=new THREE.Vector3(),hullTris=0,tables=null,tableWalls=[],tableTris=0,seatKey='';
  // members: the room keys, the owner first. Answers the plan (rooms, walls, board anchors, …) and rebuilds the yacht for it.
  function layout(n,opts={}){
    const k=JSON.stringify(n);if(k===key)return core;key=k;
    core=yachtWorld(n,opts);
    for(const m of meshes){group.remove(m);m.geometry.dispose()}
    const g=buildYacht(core);hullTris=g.triangles;
    meshes=[new THREE.Mesh(g.solid,paint),new THREE.Mesh(g.lights,lightMat),new THREE.Mesh(g.glass,glassMat),new THREE.Mesh(g.floors,pickMat)];
    meshes[2].renderOrder=2;floor=meshes[3];for(const m of meshes)group.add(m);
    const P=core.plan;sea.material.uniforms.uHull.value.set(P.zBow,P.zB0,P.zSw,P.HB);
    radar.position.set(g.radar.x,g.radar.y,g.radar.z);
    return core;
  }
  // The AgentFlow org at its tables: where everyone sits, and the tables themselves (drawn here, and in walls).
  // sig changes when a table moved, so office.js lays the floor's boxes out again.
  function org(list){
    const s=core.seat(list),k=s.rev+'|'+[...s.pos.values()].map(p=>p.x.toFixed(2)+','+p.z.toFixed(2)).join(';');
    tableWalls=s.walls;
    if(k!==seatKey){
      seatKey=k;
      if(tables){group.remove(tables);tables.geometry.dispose()}
      const t=buildTables(s);tableTris=t.triangles;tables=new THREE.Mesh(t.geometry,tableMat);group.add(tables);
    }
    return {...s,sig:s.rev};
  }
  function update(t,dt,{camera,motion=true}={}){
    tU.value=t;
    if(camera)sky.position.copy(camera.position);
    // gentle heave, roll and pitch of everything on board
    const k=motion?1:0;
    deck.position.y=k*0.06*Math.sin(t*0.62+0.5);deck.rotation.z=k*(0.0052*Math.sin(t*0.55)+0.0024*Math.sin(t*0.83+1));deck.rotation.x=k*0.0022*Math.sin(t*0.41+2);
    far.position.z=(t*1.1)%TILE;
    radar.rotation.y=t*1.4;
    const P=core.plan;
    // dolphins off the starboard bow: each leaps in an arc, then swims under for a while
    for(let i=0;i<dolphins.count;i++){
      const cycle=5.5+i*1.3,u=((t+i*1.9)%cycle)/1.5,up=u<1,a=Math.PI*u;
      dummy.position.set(P.HB+9+i*3.5,up?YACHT.SEA-0.5+Math.sin(a)*2.6:YACHT.SEA-4,P.zBow+22-i*7-(up?u*5:0));
      dummy.rotation.set(up?Math.cos(a)*0.95:0,0,0);dummy.scale.setScalar(1.2);dummy.updateMatrix();dolphins.setMatrixAt(i,dummy.matrix);
    }
    dolphins.instanceMatrix.needsUpdate=true;
    for(let i=0;i<gulls.count;i++){
      const a=t*(0.16+i*0.013)*(i%2?1:-1)+i*2.1,r=14+i*5;dummy.position.set(Math.cos(a)*r,YACHT.UPPER+11+i*1.7+Math.sin(t*0.4+i)*1.5,P.zB0+12+Math.sin(a)*r*1.4);
      dummy.rotation.set(0,-a+(i%2?0:Math.PI),0);dummy.scale.set(1,Math.sin(t*(5+i%3)+i)*1.1,1);dummy.updateMatrix();gulls.setMatrixAt(i,dummy.matrix);
    }
    gulls.instanceMatrix.needsUpdate=true;
    if(splashAt>=0){
      const s=t-splashAt;
      if(s>1.3){splashAt=-1;drops.visible=ripple.visible=false}
      else{
        for(let i=0;i<drops.count;i++){const a=i/drops.count*Math.PI*2,v=1.6+(i%3)*0.9;dummy.position.set(splashPos.x+Math.cos(a)*v*s,YACHT.SEA+(4.2+(i%4))*s-9*s*s,splashPos.z+Math.sin(a)*v*s);dummy.rotation.set(0,0,0);dummy.scale.setScalar(Math.max(0.01,1-s*0.6));dummy.updateMatrix();drops.setMatrixAt(i,dummy.matrix)}
        drops.instanceMatrix.needsUpdate=true;
        ripple.position.set(splashPos.x,YACHT.SEA+0.35,splashPos.z);ripple.scale.setScalar(0.6+s*4.2);ripple.material.opacity=Math.max(0,0.8-s*0.62);
      }
    }
  }
  const world={
    id:'yacht',name:'Yacht',background:SKY.horizon,layout,update,org,
    // cutaway: what hides you is cut away in a circle this wide, and the camera only keeps out of the solid masses.
    cutaway:2.3,
    // What this world draws itself, for measuring it (the screenshot harness).
    get drawn(){return [...own,group]},
    get core(){return core},get walls(){return tableWalls.length?core.walls.concat(tableWalls):core.walls},get masses(){return core.masses},get terrain(){return core.terrain},get signs(){return core.signs},get spawn(){return core.spawn},
    get bounds(){return core.bounds},
    get center(){return core.center},get floors(){return floor?[floor]:[]},get stats(){return {triangles:hullTris+tableTris}},sea:YACHT.SEA,
    ground:(x,z)=>core.ground(x,z),respawn:p=>core.respawn(p),common(){},
    splash(p,t){splashPos.set(p.x,0,p.z);splashAt=t;drops.visible=ripple.visible=true},
    dispose(){
      deck.remove(group);deck.position.y=0;deck.rotation.set(0,0,0);
      for(const o of own){scene.remove(o);o.geometry?.dispose();o.material?.dispose()}
      for(const m of meshes)m.geometry.dispose();tables?.geometry.dispose();radar.geometry.dispose();radar.material.dispose();farGeo.dispose();
      for(const m of [paint,glassMat,lightMat,farMat,pickMat,tableMat])m.dispose();
      scene.fog=null;
    },
  };
  return world;
}
