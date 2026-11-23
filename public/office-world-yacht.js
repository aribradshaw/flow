// The yacht world of the 3D office: a superyacht at sea, drawn from the plan in office-world-core.js.
// Cheap on purpose: the whole yacht is three merged meshes (painted surfaces with vertex colours, glass,
// lights), the sea and the sky are one shader each, and islands, clouds, gulls and the splash are a
// handful of draw calls more. No textures, no shadows, no post-processing.
import * as THREE from './vendor/three/three.module.min.js';
import {yachtWorld,YACHT} from './office-world-core.js';

const PAL={navy:'#1e3446',stripe:'#3d8f66',keel:'#5d3b38',white:'#f4f7f5',shade:'#dde5e1',teak:'#c99b6c',teak2:'#a97d50',teakLight:'#d9b68a',teakGrey:'#b89878',gold:'#d8b46a',carpet:'#cfe3d2',dark:'#182830',steel:'#c5cecc',
  cushion:'#fbfbf7',green:'#3d8f66',amber:'#e9a23b',teal:'#2f8f8a',coral:'#d9785f',pad:'#39484d',yellow:'#f2c94c',leaf:'#4f9a5d',leaf2:'#37774a',trunk:'#96764f',
  pool:'#63dbe6',warm:'#ffdca6',red:'#e5484d',lime:'#46c46a',glass:'#bfe3ea',sand:'#e6d6ac',rock:'#8f9a8c',hill:'#6aa56f',hill2:'#4d8a5c',cloud:'#ffffff',navy2:'#27455c',heli:'#f2f4f3',dolphin:'#6f8ea6'};
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
  const {PIT,MAIN,SWIM,UPPER,SUN,FORE,SEA,RAIL,EDGE}=YACHT,P=W.plan,{HB,px,pz,zL0,zL1,zSw,swimRamp,upRamp,zT0,zC0,SB,sunRamp,slot,zS0,zS1,zB0,zB1,bow,zBow,foreRamp,pool,pad,roomW,roomD}=P;
  const S=mesher(),G=mesher(),L=mesher(),F=mesher(); // solid, glass, lights, floors (for picking)
  const lerp=(a,b,t)=>a+(b-a)*Math.max(0,Math.min(1,t));

  // ----- hull: lofted between stations, navy topsides over a green boot stripe -----
  const navyTop=z=>z<=zB0?FORE+RAIL+0.9*((zB0-z)/bow)**2:z<zB0+12?lerp(FORE+RAIL,MAIN+RAIL,(z-zB0)/12):z<=zL1?MAIN+RAIL:lerp(MAIN+RAIL,SWIM+0.02,(z-zL1)/swimRamp);
  const waterBeam=z=>z<zB0?0.9*HB*Math.max(0,1-((zB0-z)/(bow-7))**1.7):0.9*W.halfBeam(z);
  const profile=z=>{const hw=W.halfBeam(z),wl=Math.min(waterBeam(z),hw);const top=navyTop(z);return [[0,SEA-2.3],[wl*0.55,SEA-1.7],[wl,SEA-0.12],[lerp(wl,hw,0.16),SEA+0.5],[lerp(wl,hw,0.86),lerp(SEA+0.5,top,0.72)],[hw,top]]};
  const stations=[];
  for(let i=0;i<=14;i++)stations.push(zBow+bow*(i/14)**1.35);
  for(const z of [zB0+6,zB0+12,(zB0+12+zL0)/2,zL0,(zL0+zL1)/2,zL1])if(z>stations.at(-1)+0.5)stations.push(z);
  for(let i=1;i<=4;i++)stations.push(zL1+(zSw-zL1)*i/4);
  const bands=[PAL.keel,PAL.keel,PAL.stripe,PAL.navy,PAL.navy2],NB=bands.length;
  for(let i=0;i<stations.length-1;i++){
    const za=stations[i],zb=stations[i+1],a=profile(za),b=profile(zb),from=[0,SEA,(za+zb)/2];
    for(const s of [-1,1])for(let j=0;j<NB;j++)S.face([s*a[j][0],a[j][1],za],[s*b[j][0],b[j][1],zb],[s*b[j+1][0],b[j+1][1],zb],[s*a[j+1][0],a[j+1][1],za],bands[j],from,j===3?[.72,.72,1,1]:[.9,.9,1,1]);
  }
  {const t=profile(zSw);for(let j=0;j<NB;j++)S.face([-t[j][0],t[j][1],zSw],[t[j][0],t[j][1],zSw],[t[j+1][0],t[j+1][1],zSw],[-t[j+1][0],t[j+1][1],zSw],bands[j],[0,SEA,zSw-2],[.8,.8,1,1])}
  // portholes along the topsides
  for(let z=zB0+5;z<zL1-3;z+=4.4)for(const s of [-1,1])S.box(s*(HB+0.02),SEA+1.75,z,0.08,0.42,1.1,PAL.dark,{ao:1});

  // ----- decks -----
  const slab=(x0,x1,z0,z1,y,thick,color=PAL.teak,side=PAL.white)=>S.box((x0+x1)/2,y-thick,(z0+z1)/2,x1-x0,thick,z1-z0,side,{top:color});
  // a deck outline that follows the hull between two z's
  const outline=(z0,z1,n,inset=0.04)=>{const a=[],b=[];for(let i=0;i<=n;i++){const z=z0+(z1-z0)*i/n,w=Math.max(0.05,W.halfBeam(z)-inset);a.push([w,z]);b.unshift([-w,z])}return a.concat(b)};
  const strips=(z0,z1,n,y,thick,color)=>{for(let i=0;i<n;i++){const za=z0+(z1-z0)*i/n,zb=z0+(z1-z0)*(i+1)/n,wa=Math.max(0.05,W.halfBeam(za)-0.04),wb=Math.max(0.05,W.halfBeam(zb)-0.04);
    S.prism([[-wa,za],[wa,za],[wb,zb],[-wb,zb]],y-thick,y,PAL.white,{top:color})}};
  const E=HB-0.04;
  // swim platform, and its inlay
  // fore-and-aft plank seams on the open decks
  const planks=(x0,x1,z0,z1,y,every=1.3)=>{for(let x=x0+every/2;x<x1;x+=every)S.box(x,y,(z0+z1)/2,0.05,0.012,z1-z0,PAL.teak2,{ao:1})};
  strips(zL1,zSw,5,SWIM,0.5,PAL.teakGrey);
  S.box(0,SWIM,zL1+swimRamp+1.4,(HB-3)*2,0.02,1.7,PAL.teak2,{ao:1});
  // lounge: the deck round the sunken seating, the seating's floor, margin boards
  slab(-E,E,zL0,-pz,MAIN,0.6);slab(-E,E,pz,zL1,MAIN,0.6);slab(-E,-px,-pz,pz,MAIN,0.6);slab(px,E,-pz,pz,MAIN,0.6);
  S.box(0,PIT-0.3,0,px*2,0.3,pz*2,PAL.teak2,{top:PAL.carpet});
  for(const s of [-1,1]){S.box(0,MAIN,s*(pz+0.2),px*2+0.8,0.02,0.4,PAL.teak2,{ao:1});S.box(s*(px+0.2),MAIN,0,0.4,0.02,pz*2,PAL.teak2,{ao:1})}
  // upper deck, the aft terrace between the stair trenches, and the bridge front
  slab(-E,E,zB0,zL0-upRamp,UPPER,0.35,PAL.teakLight);
  S.box(0,MAIN,zL0-upRamp/2,(HB-3.6)*2,UPPER-MAIN,upRamp,PAL.white,{top:PAL.teakLight});
  planks(-(HB-3.8),HB-3.8,zS1,zL0-0.3,UPPER);
  for(const s of [-1,1]){planks(s>0?SB+0.4:-(HB-0.8),s>0?HB-0.8:-(SB+0.4),zB1,zS1,UPPER);planks(s>0?px+0.5:-(HB-0.8),s>0?HB-0.8:-(px+0.5),-pz,pz,MAIN);planks(s>0?0.4:-(HB-5),s>0?HB-5:-0.4,pz+0.5,zL1-0.2,MAIN)}
  // a green line along the upper deck's edge, and a gold cove line on the hull
  for(const s of [-1,1]){S.box(s*(HB+0.01),UPPER-0.34,(zB0+zL0)/2,0.06,0.2,zL0-zB0,PAL.stripe,{ao:1});S.box(s*(HB+0.03),MAIN+0.62,(zB0+12+zL1)/2,0.05,0.09,zL1-zB0-12,PAL.gold,{ao:1})}
  for(const s of [-1,1])S.box(s*(HB-0.06),MAIN,(zB0+zL0)/2,0.1,UPPER-MAIN,zL0-zB0,PAL.white);      // superstructure sides
  S.box(0,FORE-0.4,zB0+0.1,E*2,UPPER-FORE+0.4,0.2,PAL.white);                                      // bridge front
  // foredeck
  strips(zBow+0.2,zB0,12,FORE,0.5,PAL.teakGrey);
  // sundeck block: body, deck round the pool, an eyebrow all round
  const bodyTop=SUN-0.6;
  S.box(0,UPPER,(zS0+zS1-sunRamp)/2,SB*2,bodyTop-UPPER,zS1-sunRamp-zS0,PAL.white);
  for(const s of [-1,1])S.box(s*(slot+SB)/2,UPPER,zS1-sunRamp/2,SB-slot,bodyTop-UPPER,sunRamp,PAL.white);
  const pz0=pool.z-pool.halfZ,pz1=pool.z+pool.halfZ;
  slab(-SB,SB,zS0,pz0,SUN,0.6,PAL.teakLight);slab(-SB,SB,pz1,zS1-sunRamp,SUN,0.6,PAL.teakLight);slab(-SB,-pool.halfX,pz0,pz1,SUN,0.6,PAL.teakLight);slab(pool.halfX,SB,pz0,pz1,SUN,0.6,PAL.teakLight);
  for(const s of [-1,1]){slab(s>0?slot:-SB,s>0?SB:-slot,zS1-sunRamp,zS1,SUN,0.6,PAL.teakLight);planks(s>0?pool.halfX+0.3:-SB+0.3,s>0?SB-0.3:-pool.halfX-0.3,zS0+0.4,zS1-0.4,SUN)}
  // a white coaming round the pool
  for(const s of [-1,1]){S.box(s*(pool.halfX+0.12),SUN,pool.z,0.26,0.1,pool.halfZ*2+0.5,PAL.white,{ao:1});S.box(0,SUN,pool.z+s*(pool.halfZ+0.12),pool.halfX*2+0.5,0.1,0.26,PAL.white,{ao:1})}
  S.box(0,SUN-0.62,pool.z,pool.halfX*2,0.12,pool.halfZ*2,PAL.teal,{top:PAL.teal});
  L.box(0,SUN-0.22,pool.z,pool.halfX*2,0.04,pool.halfZ*2,PAL.pool,{ao:1});
  for(const s of [-1,1]){S.box(s*(SB+0.2),SUN-0.16,(zS0+zS1)/2,0.5,0.14,zS1-zS0+0.9,PAL.shade);S.box(0,SUN-0.16,s>0?zS1+0.2:zS0-0.2,SB*2,0.14,0.5,PAL.shade)}

  // ----- no shadows are drawn, so decks get a darker band where something tall stands on them -----
  const shade=(x,z,w,d,y,color=PAL.teak2)=>S.box(x,y+0.013,z,w,0.012,d,color,{ao:1});
  shade(0,zL0+0.95,(HB-3.6)*2,1.5,MAIN);shade(0,zL1+0.75,(HB-4.8)*2,1.2,SWIM);shade(0,zB0-0.7,(HB-4.2)*2,1.4,FORE);
  shade(0,zS0-0.6,SB*2+1.2,1.2,UPPER);for(const s of [-1,1]){shade(s*(SB+0.6),(zS0+zS1)/2,1.2,zS1-zS0,UPPER);shade(s*(slot+SB)/2,zS1+0.6,SB-slot,1.2,UPPER)}
  shade(0,zS0+2,7.4,1.3,SUN);shade(0,pad.z+0.4,2.9,5.8,FORE,PAL.pad);
  // ----- windows: long dark bands, broken by mullions -----
  const band=(x,z0,z1,y0,y1,every=3.4)=>{S.box(x,y0,(z0+z1)/2,0.1,y1-y0,z1-z0,PAL.dark,{ao:.9});for(let z=z0+every;z<z1-0.5;z+=every)S.box(x,y0,z,0.14,y1-y0,0.16,PAL.white,{ao:1})};
  const bandX=(z,x0,x1,y0,y1,every=3.4)=>{S.box((x0+x1)/2,y0,z,x1-x0,y1-y0,0.1,PAL.dark,{ao:.9});for(let x=x0+every;x<x1-0.5;x+=every)S.box(x,y0,z,0.16,y1-y0,0.14,PAL.white,{ao:1})};
  for(const s of [-1,1]){band(s*(HB+0.02),zB0+14,zL0-1.5,MAIN+1.7,UPPER-0.6);band(s*(SB+0.03),zS0+1.2,zS1-1.2,UPPER+0.75,SUN-0.95,4)}
  bandX(zS0-0.03,-SB+1.2,SB-1.2,UPPER+0.75,SUN-0.95,4);
  bandX(zB0-0.02,-(HB-5),HB-5,FORE+0.75,UPPER-0.55,3);
  for(const s of [-1,1])bandX(zL0+0.03,s>0?8.6:-(HB-3.9),s>0?HB-3.9:-8.6,MAIN+0.05,UPPER-0.75,3.2);   // glass doors either side of the main board
  bandX(zL1+0.28,-5,5,SWIM+0.08,MAIN-0.5,2.5);                                                    // the beach club
  S.box(0,SWIM,zL1+0.12,(HB-4.8)*2,MAIN-SWIM,0.26,PAL.white);                                     // transom

  // ----- stairs: boxes for steps, each with a lit nosing -----
  function stairs(x,w,zLow,zHigh,yLow,yHigh){
    const n=Math.max(3,Math.round((yHigh-yLow)/0.32)),run=(zHigh-zLow)/n,rise=(yHigh-yLow)/n;
    for(let i=0;i<n;i++){const z=zLow+run*(i+0.5),h=rise*(i+1);S.box(x,yLow-0.3,z,w,h+0.3,Math.abs(run)+0.01,PAL.white,{top:PAL.teak});L.box(x,yLow+h-0.07,z-run/2,w-0.3,0.05,0.04,PAL.warm,{ao:1})}
  }
  for(const s of [-1,1]){
    stairs(s*(HB-3.2),3.2,zL1+swimRamp,zL1,SWIM,MAIN);
    stairs(s*(HB-2.1),3,zL0,zL0-upRamp,MAIN,UPPER);
    stairs(s*(HB-2.4),3.6,zB0-foreRamp,zB0,FORE,UPPER);
    // the wing that carries the hull's line down beside the swim stairs
    const x0=s*(HB-1.6),top=z=>lerp(MAIN+RAIL,SWIM+0.9,(z-zL1)/swimRamp),z1=zL1+swimRamp,xo=z=>s*(W.halfBeam(z)-0.02);
    S.face([x0,SWIM,zL1],[x0,SWIM,z1],[x0,top(z1),z1],[x0,top(zL1),zL1],PAL.white,[s*HB,0,zL1]);
    S.face([x0,top(zL1),zL1],[x0,top(z1),z1],[xo(z1),top(z1),z1],[xo(zL1),top(zL1),zL1],PAL.teak2,[x0,SWIM,zL1]);
    S.face([x0,SWIM,z1],[xo(z1),SWIM,z1],[xo(z1),top(z1),z1],[x0,top(z1),z1],PAL.white,[x0,SWIM,zL1]);
    S.face([xo(zL1),SWIM,zL1],[xo(z1),SWIM,z1],[xo(z1),top(z1),z1],[xo(zL1),top(zL1),zL1],PAL.navy,[0,SWIM,zL1]);
  }
  stairs(0,slot*2,zS1,zS1-sunRamp,UPPER,SUN);
  // steps into the sunken seating
  for(const s of [-1,1])for(let i=0;i<2;i++){const h=(MAIN-PIT)*(i+1)/3,o=pz-1.3+0.65*i+0.33;S.box(0,PIT,s*o,3.4,h,0.66,PAL.teak2,{top:PAL.teak});S.box(s*(px-1.3+0.65*i+0.33),PIT,0,0.66,h,3.4,PAL.teak2,{top:PAL.teak})}

  // ----- rails and bulwarks, from the same boxes that stop people -----
  function glassRail(b,y0,y1=y0){
    const len=b.halfX*2,roll=Math.atan2(y1-y0,len),long=len/Math.cos(roll),ym=(y0+y1)/2;
    G.box(b.x,ym+0.1,b.z,long,0.8,0.04,PAL.glass,{yaw:b.yaw,roll,ao:1});
    S.box(b.x,ym+0.96,b.z,long,0.07,0.1,PAL.steel,{yaw:b.yaw,roll,ao:1});
    const n=Math.max(1,Math.round(len/2.6));
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

  // ----- the lounge -----
  const pillows=[PAL.green,PAL.amber,PAL.teal,PAL.coral];
  // a sofa run from (x0,z0) to (x1,z1), its back on the side `bx,bz` points to
  function sofa(x,z,w,d,bx,bz,y=PIT){
    S.box(x,y,z,w,0.42,d,PAL.cushion,{ao:.9});
    S.box(x+bx*(w/2-0.16),y,z+bz*(d/2-0.16),bx?0.32:w,MAIN-y+0.5,bz?0.32:d,PAL.cushion,{ao:.9});
    const len=bx?d:w,n=Math.max(1,Math.floor(len/2.3));
    for(let i=0;i<n;i++){const t=(i+0.5)/n-0.5,c=pillows[(i+Math.round(Math.abs(x+z)))%4];
      S.box(x+(bx?bx*(w/2-0.42):t*len),y+0.42,z+(bz?bz*(d/2-0.42):t*len),bx?0.2:0.55,0.42,bz?0.2:0.55,c,{ao:.92})}
  }
  for(const b of W.walls)if(b.kind==='sofa'){const wide=b.halfX>b.halfZ;sofa(b.x,b.z,b.halfX*2,b.halfZ*2,wide?0:Math.sign(b.x),wide?Math.sign(b.z):0)}
  // warm strip lights under the seating's rim, and along the deck edges
  for(const s of [-1,1]){L.box(0,MAIN-0.1,s*(pz-0.005),px*2,0.05,0.03,PAL.warm,{ao:1});L.box(s*(px-0.005),MAIN-0.1,0,0.03,0.05,pz*2,PAL.warm,{ao:1})}
  // bar: counter, back shelf with bottles, stools
  function bar(x,z,w,y,dir){
    S.box(x,y,z,w,1.05,0.9,PAL.white,{top:PAL.teak2});L.box(x,y+0.08,z+dir*0.47,w-0.3,0.05,0.03,PAL.warm,{ao:1});
    S.box(x,y,z-dir*1.05,w,1.9,0.34,PAL.dark,{ao:.9});
    for(let i=0;i<Math.floor(w/0.5);i++)S.box(x-w/2+0.35+i*0.5,y+1.9,z-dir*1.05,0.14,0.34+(i%3)*0.08,0.14,[PAL.green,PAL.amber,PAL.coral,PAL.teal,PAL.cushion][i%5],{ao:1});
    for(let i=0;i<Math.floor(w/1.6);i++){const sx=x-w/2+0.9+i*1.6;S.cyl(sx,y,z+dir*1.15,0.07,0.7,5,PAL.steel);S.cyl(sx,y+0.7,z+dir*1.15,0.3,0.12,7,PAL.cushion)}
  }
  bar(0,zS0+3,7,SUN,1);
  // palms in planters at the lounge's corners
  function palm(x,z,y,h=4.2,lean=0.5){
    S.box(x,y,z,1,0.7,1,PAL.white,{top:PAL.leaf2});
    const dir=Math.atan2(-z,-x)+0.6;let tx=x,tz=z,ty=y+0.7;
    for(let i=0;i<4;i++){const r=0.2-i*0.03;S.cyl(tx,ty,tz,r,h/4+0.05,5,PAL.trunk,{r2:r-0.02});ty+=h/4;tx+=Math.cos(dir)*lean*i*0.12;tz+=Math.sin(dir)*lean*i*0.12}
    for(let i=0;i<7;i++){const a=i/7*Math.PI*2,c=Math.cos(a),s=Math.sin(a),m=[tx,ty-3,tz];
      const mid=[tx+c*1.3,ty+0.35,tz+s*1.3],tip=[tx+c*2.5,ty-0.75,tz+s*2.5],w=0.42;
      S.face([tx,ty,tz],[mid[0]-s*w,mid[1],mid[2]+c*w],[mid[0]+s*w,mid[1],mid[2]-c*w],null,i%2?PAL.leaf:PAL.leaf2,m);
      S.face([mid[0]-s*w,mid[1],mid[2]+c*w],tip,[mid[0]+s*w,mid[1],mid[2]-c*w],null,i%2?PAL.leaf2:PAL.leaf,m)}
  }
  for(const b of W.walls)if(b.kind==='planter')palm(b.x,b.z,b.y,b.z>0?4.4:3.4);
  // sun pads aft, either side of the way down
  for(const b of W.walls)if(b.kind==='pad'){S.box(b.x,b.y,b.z,b.halfX*2,0.4,b.halfZ*2,PAL.cushion,{yaw:b.yaw,ao:.9});S.box(b.x,b.y+0.4,b.z-b.halfZ+0.4,b.halfX*2-0.4,0.16,0.5,PAL.teal,{ao:1})}

  // ----- sun loungers, parasols, cabin dressing -----
  function lounger(x,z,y,yaw,color=PAL.cushion){
    const c=Math.cos(yaw),s=Math.sin(yaw);
    S.box(x,y+0.22,z,0.75,0.14,1.5,color,{yaw,ao:.9});S.box(x+s*0.95,y+0.22,z+c*0.95,0.75,0.14,0.75,color,{yaw,tilt:-0.75,ao:.9});
    S.box(x,y,z,0.6,0.22,1.3,PAL.teak2,{yaw});
  }
  function parasol(x,z,y,color){S.cyl(x,y,z,0.05,2.5,5,PAL.steel);S.cyl(x,y+2.3,z,1.7,0.5,8,color,{r2:0.06})}
  const place=(r,lx,lz)=>[r.x+lx*Math.cos(r.facing)+lz*Math.sin(r.facing),r.z-lx*Math.sin(r.facing)+lz*Math.cos(r.facing)];
  for(const r of W.rooms){
    // office.js builds each room with a tall back wall for its board. From outside that wall is the cabin's
    // (or the wheelhouse's) side: windows on it, a roof lip over it, and an open pergola back to the door.
    const hw=roomW/2,hd=roomD/2,H=3.9,bridge=r.kind==='bridge';
    {const [x,z]=place(r,0,-hd-0.12);S.box(x,r.y+1.5,z,roomW-1.6,1.5,0.06,PAL.dark,{yaw:r.facing,ao:.9});
      for(let i=1;i<4;i++){const [mx,mz]=place(r,-hw+0.8+i*(roomW-1.6)/4,-hd-0.14);S.box(mx,r.y+1.5,mz,0.14,1.5,0.08,PAL.white,{yaw:r.facing,ao:1})}}
    {const [x,z]=place(r,0,-hd+0.55);S.box(x,r.y+H+0.06,z,roomW+0.7,0.14,1.9,PAL.white,{yaw:r.facing,top:PAL.shade,bottom:true})}
    for(const lx of [-hw,hw]){const [x,z]=place(r,lx,hd);S.box(x,r.y,z,0.16,H,0.16,PAL.white);const [bx,bz]=place(r,lx,0.6);S.box(bx,r.y+H,bz,0.14,0.14,roomD-1.4,PAL.white,{yaw:r.facing})}
    if(!bridge)for(const lx of [-1.7,1.7]){const [x,z]=place(r,lx,hd);L.box(x,r.y+1.12,z,0.16,0.1,0.16,PAL.warm,{ao:1})}
  }
  for(const r of W.spare){
    for(const lx of [-3,0,3]){const [x,z]=place(r,lx,-0.6);lounger(x,z,r.y,r.facing,PAL.cushion)}
    const [x,z]=place(r,4.6,-1.8);parasol(x,z,r.y,PAL.teal);
  }
  // sundeck loungers, facing the pool
  for(const s of [-1,1])for(let i=0;i<3;i++)lounger(s*(SB-1.9),pool.z-3+i*2.1,SUN,s>0?Math.PI/2:-Math.PI/2,i%2?PAL.cushion:PAL.shade);
  for(const s of [-1,1])parasol(s*(SB-1.4),pool.z+4.6,SUN,s>0?PAL.amber:PAL.coral);
  // terrace over the lounge
  for(const s of [-1,1])for(let i=0;i<2;i++)lounger(s*(2.2+i*2.4),zL0-2.4,UPPER,Math.PI);

  // ----- the lines that make it a yacht: wings sweeping from the upper deck down to the lounge's bulwark,
  // fins at the sundeck's after corners, and one long deckhouse where cabins stand side by side -----
  for(const s of [-1,1]){
    const x=s*(HB-0.05),from=[0,2,(zL0+zL1)/2],a=[x,UPPER+RAIL+0.1,zL0-1.2],b=[x,MAIN+RAIL-0.02,zL0+9.5],c=[x,MAIN+RAIL-0.02,zL0-1.2];
    S.face(a,b,c,null,PAL.white,[x-s,2,zL0]);S.face(a,b,c,null,PAL.white,[x+s,2,zL0]);
    S.face([x+s*0.03,UPPER+RAIL-0.5,zL0-0.7],[x+s*0.03,MAIN+RAIL+0.35,zL0+5.6],[x+s*0.03,MAIN+RAIL+0.35,zL0-0.7],null,PAL.dark,[x-s,2,zL0]);
    const fx=s*(SB+0.02),fa=[fx,SUN+RAIL+1.5,zS1-5.5],fb=[fx,SUN,zS1+0.2],fc=[fx,SUN,zS1-5.5];
    S.face(fa,fb,fc,null,PAL.white,[fx-s,SUN,zS1]);S.face(fa,fb,fc,null,PAL.white,[fx+s,SUN,zS1]);
    const ga=[fx,SUN+RAIL+1.5,zS1-5.5],gb=[fx,SUN+RAIL+1.5,zS1-9],gc=[fx,SUN,zS1-12],gd=[fx,SUN,zS1-5.5];
    S.face(ga,gb,gc,gd,PAL.white,[fx-s,SUN,zS1]);S.face(ga,gb,gc,gd,PAL.white,[fx+s,SUN,zS1]);
    S.face([fx+s*0.03,SUN+RAIL+1,zS1-6],[fx+s*0.03,SUN+RAIL+1,zS1-8.6],[fx+s*0.03,SUN+0.5,zS1-10.4],[fx+s*0.03,SUN+0.5,zS1-6],PAL.dark,[fx-s,SUN,zS1]);
  }
  for(const b of W.walls)if(b.kind==='infill'){
    S.box(b.x,b.y,b.z,0.2,b.height-b.y,b.halfZ*2,PAL.white);
    S.box(b.x+Math.sign(b.x)*0.12,b.y+1.5,b.z,0.06,1.5,b.halfZ*2-0.5,PAL.dark,{ao:.9});
    S.box(b.x-Math.sign(b.x)*0.55,b.height+0.06,b.z,1.9,0.14,b.halfZ*2,PAL.white,{top:PAL.shade,bottom:true});
  }
  // ----- bridge: the walk round the wheelhouse front has a solid bulwark -----
  S.box(0,UPPER,zB0+0.14,13.4,RAIL-0.05,0.3,PAL.white,{top:PAL.teak2});
  // ----- radar arch and mast on the sundeck -----
  const ax=SB-0.55,az=zS0+4.2,AH=3.9;
  for(const s of [-1,1]){S.box(s*ax,SUN,az,0.9,AH+0.3,2.6,PAL.white,{tilt:-0.2});S.box(s*ax,SUN,az+3.4,0.5,AH*0.62,1.5,PAL.white,{tilt:-0.75});L.box(s*(ax+0.5),SUN+AH-0.2,az-0.6,0.12,0.3,0.3,s>0?PAL.lime:PAL.red,{ao:1})}
  S.box(0,SUN+AH,az-1.1,ax*2+1.6,0.24,4.6,PAL.white,{top:PAL.shade,bottom:true});
  S.box(0,SUN+AH+0.24,az-0.6,1.5,1.5,2.6,PAL.white,{tilt:0.18});S.cyl(0,SUN+AH+1.6,az-0.5,0.2,3.4,6,PAL.white,{r2:0.07});L.box(0,SUN+AH+5.05,az-0.5,0.16,0.16,0.16,PAL.warm,{ao:1});
  S.box(0,SUN+AH+3.6,az-0.5,3.4,0.07,0.07,PAL.steel);for(const s of [-1,1])S.cyl(s*1.6,SUN+AH+3.6,az-0.5,0.03,0.9,4,PAL.steel);
  for(const s of [-1,1]){S.ball(s*3.2,SUN+AH+0.75,az-1,0.7,PAL.white);S.cyl(s*5.4,SUN+AH+0.24,az-1.6,0.04,1.9,4,PAL.steel)}
  S.box(0,SUN+AH+1.5,az-1.2,2.6,0.08,0.08,PAL.steel);

  // ----- foredeck: helipad, anchor gear -----
  S.cyl(pad.x,FORE,pad.z,pad.r,0.03,20,PAL.pad);
  const ringPts=(r0,r1,color,n=20)=>{for(let i=0;i<n;i++){const a=i/n*Math.PI*2,b=(i+1)/n*Math.PI*2,y=FORE+0.045;
    S.face([pad.x+Math.cos(a)*r0,y,pad.z+Math.sin(a)*r0],[pad.x+Math.cos(b)*r0,y,pad.z+Math.sin(b)*r0],[pad.x+Math.cos(b)*r1,y,pad.z+Math.sin(b)*r1],[pad.x+Math.cos(a)*r1,y,pad.z+Math.sin(a)*r1],color,[pad.x,FORE-1,pad.z])}};
  ringPts(pad.r-0.9,pad.r-0.45,PAL.yellow);ringPts(3.6,3.9,PAL.white);
  for(const s of [-1,1])S.box(pad.x+s*1.1,FORE+0.03,pad.z,0.5,0.02,3.4,PAL.white,{ao:1});
  S.box(pad.x,FORE+0.03,pad.z,2.2,0.02,0.5,PAL.white,{ao:1});
  for(let i=0;i<8;i++){const a=i/8*Math.PI*2;L.box(pad.x+Math.cos(a)*(pad.r-0.2),FORE+0.03,pad.z+Math.sin(a)*(pad.r-0.2),0.22,0.08,0.22,PAL.lime,{ao:1})}
  for(const s of [-1,1]){S.cyl(s*1.5,FORE,zBow+7,0.45,0.7,7,PAL.steel,{r2:0.35});S.box(s*1.5,FORE,zBow+5,0.3,0.25,2.6,PAL.dark)}
  // a helicopter on the pad (its rotor turns: a mesh of its own), and jet skis on the swim platform
  {const hx=pad.x,hz=pad.z+0.4,y=FORE+0.5;
    S.ball(hx,y+0.95,hz-0.7,1.25,PAL.heli,{sy:0.8,n:8});S.ball(hx,y+1.05,hz-1.35,0.95,PAL.dark,{sy:0.7,n:8});
    S.box(hx,y+0.9,hz+1.9,0.34,0.36,3.2,PAL.heli,{tilt:-0.12});S.box(hx,y+1.5,hz+3.4,0.1,1,0.7,PAL.stripe,{tilt:0.3});
    S.box(hx,y+0.5,hz+0.6,1.5,0.5,1.4,PAL.heli);S.cyl(hx,y+1.9,hz-0.5,0.12,0.5,5,PAL.steel);
    for(const s of [-1,1]){S.box(hx+s*0.85,FORE+0.06,hz-0.4,0.09,0.09,3,PAL.steel);for(const dz of [-1.2,0.5])S.box(hx+s*0.7,FORE+0.1,hz+dz,0.07,0.55,0.07,PAL.steel,{roll:-s*0.5})}}
  for(const b of W.walls)if(b.kind==='jetski'){
    const c=b.x>0?PAL.coral:PAL.teal;
    S.box(b.x,b.y+0.1,b.z,1,0.42,2.5,PAL.heli,{top:c});S.box(b.x,b.y+0.5,b.z+0.35,0.5,0.22,1.1,PAL.dark);
    S.box(b.x,b.y+0.5,b.z-0.75,0.62,0.34,0.5,c,{tilt:-0.4});S.box(b.x,b.y+0.86,b.z-0.6,0.8,0.05,0.07,PAL.dark);
  }
  // ensign staff at the stern
  {const fx=-(HB-5.3),fz=zL1-0.3;S.cyl(fx,MAIN,fz,0.05,3.4,5,PAL.steel);S.face([fx,MAIN+3.3,fz],[fx,MAIN+2.4,fz],[fx,MAIN+2.4,fz+1.5],[fx,MAIN+3.3,fz+1.5],PAL.stripe,null)}

  // ----- floors for picking: one flat sheet per level, highest hit first -----
  const sheet=(x0,x1,z0,z1,y)=>F.face([x0,y,z0],[x0,y,z1],[x1,y,z1],[x1,y,z0],'#fff',[0,y-1,0]);
  sheet(-HB,HB,zL1,zSw,SWIM);sheet(-HB,HB,zL0,zL1,MAIN);sheet(-HB,HB,zB0,zL0,UPPER);sheet(-SB,SB,zS0,zS1,SUN);sheet(-HB,HB,zBow,zB0,FORE);
  return {solid:S.build(),glass:G.build(),lights:L.build(),floors:F.build(),triangles:S.count+G.count+L.count};
}

// ---------- far scenery: islands and clouds in one mesh, tiled along the course ----------
const TILE=1800;
function buildFar(){
  const S=mesher();let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
  const island=(x,z,r,h)=>{
    const n=9,turn=rnd()*6,rings=[[1,-1.5,PAL.sand],[0.82,h*0.07,PAL.sand],[0.66,h*0.3,PAL.hill],[0.36,h*0.72,PAL.hill2],[0.12,h,PAL.rock]].map(([k,y,c])=>({y,c,p:S.ring(x,z,r*k,n,turn).map(p=>[p[0]+(rnd()-0.5)*r*0.14,p[1]+(rnd()-0.5)*r*0.14])}));
    for(let j=0;j<rings.length-1;j++)for(let i=0;i<n;i++){const a=rings[j],b=rings[j+1],k=(i+1)%n;
      S.face([a.p[i][0],a.y,a.p[i][1]],[a.p[k][0],a.y,a.p[k][1]],[b.p[k][0],b.y,b.p[k][1]],[b.p[i][0],b.y,b.p[i][1]],b.c,[x,-20,z],[.86,.86,1,1])}
    const t=rings.at(-1);for(let i=1;i<n-1;i++)S.face([t.p[0][0],t.y,t.p[0][1]],[t.p[i][0],t.y,t.p[i][1]],[t.p[i+1][0],t.y,t.p[i+1][1]],null,t.c,[x,-20,z]);
  };
  for(const [x,z,r,h] of [[-430,-520,120,58],[-560,-380,70,30],[520,-640,150,74],[690,-420,60,26],[-640,300,95,44],[470,420,80,36],[-380,820,60,22],[760,60,110,50]])island(x,z,r,h);
  for(let i=0;i<14;i++){const a=rnd()*Math.PI*2,d=340+rnd()*620,x=Math.cos(a)*d,z=(rnd()-0.5)*TILE,y=150+rnd()*130,s=26+rnd()*30;
    for(let j=0;j<4;j++)S.ball(x+(j-1.5)*s*0.8+(rnd()-0.5)*8,y+(rnd()-0.5)*6,z+(rnd()-0.5)*s*0.5,s*(0.55+rnd()*0.4),PAL.cloud,{sy:0.42,n:7,ao:.86})}
  return S.build();
}

// ---------- sea and sky ----------
const WATER_VERT=`uniform float uT,uSpeed,uAmp;varying vec3 vP;
float H(vec2 p){return sin(p.x*0.085+uT*0.8)*0.34+sin(p.y*0.12-uT*1.05+p.x*0.04)*0.28+sin((p.x*0.7-p.y)*0.23+uT*1.5)*0.14+sin((p.x+p.y*0.6)*0.47-uT*2.1)*0.07;}
void main(){vec4 w=modelMatrix*vec4(position,1.0);vec2 q=w.xz-vec2(0.0,uT*uSpeed);
  w.y+=H(q)*uAmp*(1.0-smoothstep(240.0,700.0,length(w.xz)));vP=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`;
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
  float u=clamp((uHull.y-p.y)/(uHull.y-uHull.x-7.0),0.0,1.0),hw=uHull.w*0.9*(1.0-pow(u,1.7));
  float d=max(abs(p.x)-hw,max(uHull.x+7.0-p.y,p.y-uHull.z));
  vec2 ps=p+vec2(3.2,4.4);float us=clamp((uHull.y-ps.y)/(uHull.y-uHull.x-7.0),0.0,1.0);
  col*=1.0-0.3*smoothstep(4.0,-1.5,max(abs(ps.x)-uHull.w*0.95*(1.0-pow(us,1.7)),max(uHull.x+7.0-ps.y,ps.y-uHull.z)));
  float foam=smoothstep(2.2,0.1,d+nz*2.6)*0.9;
  float s2=p.y-(uHull.x+7.0);
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
function seaGeometry(){
  const n=84,a=190,b=1110,pos=[],idx=[],f=u=>u*a+u*u*u*b;
  for(let j=0;j<=n;j++)for(let i=0;i<=n;i++)pos.push(f(i/n*2-1),0,f(j/n*2-1));
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){const p=j*(n+1)+i;idx.push(p,p+n+1,p+1,p+1,p+n+1,p+n+2)}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);return g;
}

// ---------- the world ----------
// ctx: {scene, deck (the group everything on board is added to, which rocks with the sea)}
export function createYachtWorld({scene,deck}){
  const col=s=>new THREE.Color(s),own=[],keep=o=>{own.push(o);return o};
  const horizon=col(SKY.horizon);
  scene.background=horizon;scene.fog=new THREE.Fog(SKY.horizon,150,1150);
  // a warm sun against cool shade: with no shadows drawn, that contrast is what gives the house its shape
  const hemi=keep(new THREE.HemisphereLight('#e4f1ff','#7b9fb4',1.65)),sun=keep(new THREE.DirectionalLight('#fff0d2',2.45));
  sun.position.copy(SUN_DIR).multiplyScalar(60);scene.add(hemi,sun);
  const tU={value:0};
  const sea=keep(new THREE.Mesh(seaGeometry(),new THREE.ShaderMaterial({vertexShader:WATER_VERT,fragmentShader:WATER_FRAG,uniforms:{uT:tU,uSpeed:{value:3.2},uAmp:{value:0.55},uSea:{value:YACHT.SEA},
    uDeep:{value:col(SKY.deep)},uShallow:{value:col(SKY.shallow)},uSkyCol:{value:col(SKY.mirror)},uHorizon:{value:horizon},uSunDir:{value:SUN_DIR},uSunCol:{value:col(SKY.sun)},uHull:{value:new THREE.Vector4()}}})));
  sea.position.y=YACHT.SEA;sea.frustumCulled=false;scene.add(sea);
  const sky=keep(new THREE.Mesh(new THREE.SphereGeometry(1200,24,12),new THREE.ShaderMaterial({vertexShader:SKY_VERT,fragmentShader:SKY_FRAG,side:THREE.BackSide,depthWrite:false,depthTest:false,
    uniforms:{uZenith:{value:col(SKY.zenith)},uHorizon:{value:horizon},uHaze:{value:col(SKY.haze)},uSunDir:{value:SUN_DIR},uSunCol:{value:col(SKY.sun)}}})));
  sky.frustumCulled=false;sky.renderOrder=-10;scene.add(sky);
  const paint=new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide}),glassMat=new THREE.MeshLambertMaterial({vertexColors:true,transparent:true,opacity:.34,depthWrite:false,side:THREE.DoubleSide}),
    lightMat=new THREE.MeshBasicMaterial({vertexColors:true}),farMat=new THREE.MeshLambertMaterial({vertexColors:true}),pickMat=new THREE.MeshBasicMaterial({visible:false});
  const farGeo=buildFar(),far=[0,1].map(()=>{const m=keep(new THREE.Mesh(farGeo,farMat));m.frustumCulled=false;scene.add(m);return m});
  // gulls: one instanced, flapping V
  const gullGeo=new THREE.BufferGeometry();gullGeo.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0.25,-1.1,0.3,0,0,0,-0.2, 0,0,0.25,0,0,-0.2,1.1,0.3,0],3));gullGeo.computeVertexNormals();
  const gulls=keep(new THREE.InstancedMesh(gullGeo,new THREE.MeshBasicMaterial({color:'#ffffff',side:THREE.DoubleSide}),7));gulls.frustumCulled=false;scene.add(gulls);
  // the splash: droplets and a ring on the water
  const drops=keep(new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16,0),new THREE.MeshBasicMaterial({color:'#eafaff'}),14));drops.visible=false;drops.frustumCulled=false;scene.add(drops);
  const ripple=keep(new THREE.Mesh(new THREE.RingGeometry(0.72,1,20),new THREE.MeshBasicMaterial({color:'#ffffff',transparent:true,opacity:0,depthWrite:false})));ripple.rotation.x=-Math.PI/2;ripple.visible=false;scene.add(ripple);
  const group=new THREE.Group();deck.add(group);
  const radar=new THREE.Mesh(new THREE.BoxGeometry(2.6,0.14,0.3),new THREE.MeshLambertMaterial({color:PAL.white,flatShading:true}));group.add(radar);
  const rotorGeo=(()=>{const m=mesher();m.box(0,0,0,7.6,0.05,0.3,PAL.dark,{bottom:true});m.box(0,0,0,0.3,0.05,7.6,PAL.dark,{bottom:true});return m.build()})();
  const rotor=new THREE.Mesh(rotorGeo,paint);group.add(rotor);
  const dolphinGeo=(()=>{const m=mesher();m.cyl(0,-1.15,0,0.03,1.15,6,PAL.dolphin,{r2:0.3,ao:.9});m.cyl(0,0,0,0.3,1.25,6,PAL.dolphin,{r2:0.04,ao:1});
    m.face([0,-0.2,0.25],[0,0.3,0.25],[0,-0.05,0.62],null,PAL.dolphin,null);m.face([-0.42,-1.3,0],[0.42,-1.3,0],[0,-1.0,0],null,PAL.dolphin,null);
    const g=m.build();g.rotateX(-Math.PI/2);return g})();
  const dolphins=keep(new THREE.InstancedMesh(dolphinGeo,new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide}),3));dolphins.frustumCulled=false;scene.add(dolphins);
  const dummy=new THREE.Object3D();
  let core=yachtWorld(1),key='',meshes=[],floor=null,splashAt=-1,splashPos=new THREE.Vector3(),stats={triangles:0};
  // members: the room keys, the owner first. Answers the plan (rooms, walls, board anchors, …) and rebuilds the yacht for it.
  function layout(n,opts={}){
    const k=JSON.stringify([n,opts.commonR||10]);if(k===key)return core;key=k;
    core=yachtWorld(n,opts);
    for(const m of meshes){group.remove(m);m.geometry.dispose()}
    const g=buildYacht(core);stats={triangles:g.triangles};
    meshes=[new THREE.Mesh(g.solid,paint),new THREE.Mesh(g.lights,lightMat),new THREE.Mesh(g.glass,glassMat),new THREE.Mesh(g.floors,pickMat)];
    meshes[2].renderOrder=2;floor=meshes[3];for(const m of meshes)group.add(m);
    const P=core.plan;sea.material.uniforms.uHull.value.set(P.zBow,P.zB0,P.zSw,P.HB);
    radar.position.set(0,YACHT.SUN+3.9+1.9,P.zS0+4.2-0.6);rotor.position.set(P.pad.x,YACHT.FORE+2.95,P.pad.z-0.1);
    return core;
  }
  function update(t,dt,{camera,motion=true}={}){
    tU.value=t;
    if(camera)sky.position.copy(camera.position);
    // gentle heave, roll and pitch of everything on board
    const k=motion?1:0;
    deck.position.y=k*0.07*Math.sin(t*0.62+0.5);deck.rotation.z=k*(0.0052*Math.sin(t*0.55)+0.0024*Math.sin(t*0.83+1));deck.rotation.x=k*0.0026*Math.sin(t*0.41+2);
    const drift=(t*1.1)%TILE;far[0].position.z=drift;far[1].position.z=drift-TILE;
    radar.rotation.y=t*1.4;rotor.rotation.y=t*2.2;
    // dolphins off the starboard bow: each leaps in an arc, then swims under for a while
    for(let i=0;i<dolphins.count;i++){
      const cycle=5.5+i*1.3,u=((t+i*1.9)%cycle)/1.5,up=u<1,a=Math.PI*u;
      dummy.position.set(core.plan.HB+11+i*3.5,up?YACHT.SEA-0.5+Math.sin(a)*2.6:YACHT.SEA-4,core.plan.zBow+34-i*7-(up?u*5:0));
      dummy.rotation.set(up?Math.cos(a)*0.95:0,0,0);dummy.scale.setScalar(1.25);dummy.updateMatrix();dolphins.setMatrixAt(i,dummy.matrix);
    }
    dolphins.instanceMatrix.needsUpdate=true;
    const P=core.plan;
    for(let i=0;i<gulls.count;i++){
      const a=t*(0.16+i*0.013)*(i%2?1:-1)+i*2.1,r=16+i*5.5;dummy.position.set(Math.cos(a)*r,YACHT.SUN+9+i*1.7+Math.sin(t*0.4+i)*1.5,P.zS0+10+Math.sin(a)*r*1.4);
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
    id:'yacht',name:'Yacht',background:SKY.horizon,layout,update,
    get core(){return core},get walls(){return core.walls},get terrain(){return core.terrain},get signs(){return core.signs},get spawn(){return core.spawn},
    get center(){return core.center},get floors(){return floor?[floor]:[]},get stats(){return stats},sea:YACHT.SEA,
    ground:(x,z)=>core.ground(x,z),respawn:p=>core.respawn(p),common(){},
    splash(p,t){splashPos.set(p.x,0,p.z);splashAt=t;drops.visible=ripple.visible=true},
    dispose(){
      deck.remove(group);deck.position.y=0;deck.rotation.set(0,0,0);
      for(const o of own){scene.remove(o);o.geometry?.dispose();o.material?.dispose()}
      for(const m of meshes)m.geometry.dispose();radar.geometry.dispose();radar.material.dispose();farGeo.dispose();rotorGeo.dispose();
      for(const m of [paint,glassMat,lightMat,farMat,pickMat])m.dispose();
      scene.fog=null;
    },
  };
  return world;
}
