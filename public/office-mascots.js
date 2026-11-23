// Coding-agent mascots for the 3D office: chunky low-poly figures built from boxes, ellipsoids and one
// extrusion, with their colours baked into the vertices. Each is about 1.6 units across, centred on its
// origin, facing +z.
//   mascotKind(text)       'claude' | 'openai' | 'deepseek' | 'grok' | 'gemini' | 'orb'  (vendor, model, … any text)
//   createMascot(kind, {color, scale}) -> {group, kind, update(t, state)}
//       state: {status:'running'|'waiting'|'idle', children: n subagents, phase}
//       It turns slowly and bobs out of phase with its neighbours; a waiting one hops and glows; an idle one
//       is still and dim; subagents are tiny copies circling it. Add effects on top through group (it is a
//       THREE.Group: the figure is group.userData.body, the subagents group.userData.kids).
// Geometries and materials are shared between all mascots of a kind.
import * as THREE from './vendor/three/three.module.min.js';

const KINDS=[[/claude|opus|sonnet|haiku|fable|anthropic/,'claude'],[/gpt|codex|openai|\bo3\b|\bo4/,'openai'],[/deepseek/,'deepseek'],[/grok|xai/,'grok'],[/gemini/,'gemini']];
export function mascotKind(...text){const t=text.filter(Boolean).join(' ').toLowerCase();for(const [re,k] of KINDS)if(re.test(t))return k;return 'orb'}
// Vendor colours, also the orb's colour for anything else.
export const VENDOR_COLOR={claude:'#d97857',openai:'#2e80ed',deepseek:'#4d6bff',grok:'#17171a',gemini:'#5b7cf5',orb:'#5f9e6e',
  qwen:'#694ff0',mistral:'#fa520f',meta:'#1a73e6',moonshot:'#e0e0ea',nvidia:'#76ba00',minimax:'#e83561'};

// ---------- building meshes ----------
function builder(){
  const pos=[],nor=[],col=[],idx=[];let n=0;
  // Colours are written as sRGB, as they look on screen; three.js wants vertex colours linear.
  const lin=new THREE.Color(),v=(x,y,z,nx,ny,nz,c)=>{pos.push(x,y,z);nor.push(nx,ny,nz);lin.setRGB(c[0],c[1],c[2],THREE.SRGBColorSpace);col.push(lin.r,lin.g,lin.b);return n++};
  const tri=(a,b,c)=>idx.push(a,b,c);
  const FACES=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  return {v,tri,get n(){return n},
    // A box centred at (x,y,z) with half sizes (hx,hy,hz): flat faces, the voxel look.
    box(x,y,z,hx,hy,hz,c){for(const f of FACES){const u=f[0]!==0?[0,1,0]:[1,0,0],w=[f[1]*u[2]-f[2]*u[1],f[2]*u[0]-f[0]*u[2],f[0]*u[1]-f[1]*u[0]],a=n;
      for(const [su,sw] of [[-1,-1],[1,-1],[1,1],[-1,1]])v(x+(f[0]+su*u[0]+sw*w[0])*hx,y+(f[1]+su*u[1]+sw*w[1])*hy,z+(f[2]+su*u[2]+sw*w[2])*hz,f[0],f[1],f[2],c);
      // keep the winding facing out
      const cr=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];
      if(cr[0]*f[0]+cr[1]*f[1]+cr[2]*f[2]>0){tri(a,a+1,a+2);tri(a,a+2,a+3)}else{tri(a,a+2,a+1);tri(a,a+3,a+2)}}},
    // A low-poly ellipsoid with radii (rx,ry,rz).
    ell(x,y,z,rx,ry,rz,c,lat=9,lon=14){const a0=n;
      for(let i=0;i<=lat;i++){const p=-Math.PI/2+Math.PI*i/lat;for(let j=0;j<=lon;j++){const th=2*Math.PI*j/lon,ex=Math.cos(p)*Math.cos(th),ey=Math.sin(p),ez=Math.cos(p)*Math.sin(th);
        let nx=ex/rx,ny=ey/ry,nz=ez/rz;const l=Math.hypot(nx,ny,nz)||1;v(x+ex*rx,y+ey*ry,z+ez*rz,nx/l,ny/l,nz/l,c)}}
      for(let i=0;i<lat;i++)for(let j=0;j<lon;j++){const a=a0+i*(lon+1)+j,b=a+lon+1;tri(a,a+1,b);tri(a+1,b+1,b)}},
    geometry(){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
      g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));g.setIndex(idx);g.computeBoundingSphere();return g},
  };
}
// Claude: Clawd, a wide orange voxel crab with ">" "<" eyes, stubby arms and four square legs.
function clawd(){const b=builder(),o=[.85,.47,.34],dk=[.10,.07,.06];
  b.box(0,.12,0,.86,.46,.42,o);b.box(-.98,.12,0,.13,.14,.2,o);b.box(.98,.12,0,.13,.14,.2,o);
  for(const lx of [-.62,-.22,.22,.62])b.box(lx,-.52,.05,.11,.2,.14,o);
  const v=.075,z=.44;for(const [dx,dy] of [[-1,1],[0,0],[-1,-1]])b.box(-.36+dx*2*v,.24+dy*2*v,z,v,v,.04,dk);
  for(const [dx,dy] of [[1,1],[0,0],[1,-1]])b.box(.36+dx*2*v,.24+dy*2*v,z,v,v,.04,dk);return b.geometry()}
// OpenAI / Codex: a puffy blue cloud head with a black ">_" screen, on a small body.
function cloud(){const b=builder(),c=[.18,.50,.93],dk=[.05,.05,.07],lb=[.55,.85,1];
  for(const [x,y,r] of [[0,.30,.62],[-.50,.22,.42],[.50,.22,.42],[-.24,.66,.42],[.26,.64,.44]])b.ell(x,y,0,r,r*.92,r*.55,c);
  b.box(0,.30,.33,.44,.25,.035,dk);const v=.05;for(const [dx,dy] of [[0,1],[1,0],[0,-1]])b.box(-.20+dx*2*v,.32+dy*2*v,.38,v,v,.025,lb);
  b.box(.10,.20,.38,.12,.035,.025,lb);b.ell(0,-.38,0,.32,.26,.24,c);b.ell(-.40,-.34,0,.11,.11,.11,c);b.ell(.40,-.34,0,.11,.11,.11,c);
  b.box(-.15,-.70,0,.09,.11,.11,c);b.box(.15,-.70,0,.09,.11,.11,c);return b.geometry()}
// DeepSeek: a blue pixel-art whale in profile: stepped body, upturned fluke, white belly and eyes.
function whale(){const b=builder(),c=[.30,.42,1],w=[.95,.96,1],dk=[.06,.07,.12];
  b.box(-.15,0,0,.62,.36,.32,c);b.box(-.82,-.02,0,.08,.26,.28,c);b.box(-.15,.42,0,.42,.08,.26,c);b.box(.58,.02,0,.14,.2,.22,c);
  b.box(.80,.20,0,.1,.16,.18,c);b.box(.78,.48,0,.1,.14,.16,c);b.box(.98,.52,0,.1,.18,.16,c);b.box(-.2,-.3,0,.6,.09,.34,w);
  for(const zs of [1,-1]){b.box(-.52,.1,.33*zs,.11,.11,.03,w);b.box(-.56,.1,.37*zs,.05,.06,.02,dk)}return b.geometry()}
// Grok: a glossy black sphere with two tall white eyes.
function grok(){const b=builder();b.ell(0,0,0,.8,.8,.8,[.09,.09,.1],14,20);b.ell(-.26,.12,.66,.1,.27,.09,[1,1,1]);b.ell(.26,.12,.66,.1,.27,.09,[1,1,1]);return b.geometry()}
// Gemini: an extruded four-point sparkle, blue to purple.
function sparkle(){const b=builder(),k=48,d=.16,ring=[];
  for(let i=0;i<k;i++){const a=2*Math.PI*i/k,c=Math.cos(a),s=Math.sin(a);ring.push([.95*Math.sign(c)*Math.abs(c)**2.4,.95*Math.sign(s)*Math.abs(s)**2.4])}
  const col=(x,y)=>{const f=Math.max(0,Math.min(1,(x+y)/2.4+.5));return [.26+.38*f,.52-.12*f,.96]};
  for(const zs of [1,-1]){const c0=b.v(0,0,d*zs,0,0,zs,col(0,0)),first=b.n;for(const p of ring)b.v(p[0],p[1],d*zs,0,0,zs,col(p[0],p[1]));
    for(let i=0;i<k;i++)zs>0?b.tri(c0,first+i,first+(i+1)%k):b.tri(c0,first+(i+1)%k,first+i)}
  for(let i=0;i<k;i++){const p=ring[i],q=ring[(i+1)%k];let nx=q[1]-p[1],ny=p[0]-q[0];const l=Math.hypot(nx,ny)||1;nx/=l;ny/=l;if(nx*(p[0]+q[0])+ny*(p[1]+q[1])<0){nx=-nx;ny=-ny}
    const a=b.v(p[0],p[1],d,nx,ny,0,col(p[0],p[1]));b.v(q[0],q[1],d,nx,ny,0,col(q[0],q[1]));b.v(q[0],q[1],-d,nx,ny,0,col(q[0],q[1]));b.v(p[0],p[1],-d,nx,ny,0,col(p[0],p[1]));
    b.tri(a,a+2,a+1);b.tri(a,a+3,a+2)}
  return b.geometry()}
function orb(){const b=builder();b.ell(0,0,0,.75,.75,.75,[1,1,1],10,16);return b.geometry()}

const GEO={},MAT={};
const BUILD={claude:clawd,openai:cloud,deepseek:whale,grok,gemini:sparkle,orb};
export const mascotGeometry=kind=>GEO[kind]||(GEO[kind]=(BUILD[kind]||orb)());
// One material per kind of look; a waiting one's glow pulses together (one shared material per colour).
function material(look,color='#ffffff'){
  const k=look+color;if(MAT[k])return MAT[k];
  const m=new THREE.MeshLambertMaterial({vertexColors:true,color,side:THREE.DoubleSide,emissive:look==='wait'?'#ffb020':'#000000',emissiveIntensity:look==='wait'?.35:0,
    ...(look==='idle'?{transparent:true,opacity:.5}:{})});
  return MAT[k]=m;
}
export function disposeMascots(){for(const g of Object.values(GEO))g.dispose();for(const m of Object.values(MAT))m.dispose();for(const k in GEO)delete GEO[k];for(const k in MAT)delete MAT[k]}
// The waiting glow, once per frame for all of them.
export function pulseMascots(t){for(const [k,m] of Object.entries(MAT))if(k.startsWith('wait'))m.emissiveIntensity=.22+.45*(.5+.5*Math.sin(t*9))}

export function createMascot(kind,{color,scale=1}={}){
  const k=BUILD[kind]?kind:'orb',tint=k==='orb'?(color||VENDOR_COLOR.orb):'#ffffff',group=new THREE.Group(),body=new THREE.Mesh(mascotGeometry(k),material('run',tint));
  group.add(body);group.scale.setScalar(scale);const kids=new THREE.Group();group.add(kids);
  group.userData.body=body;group.userData.kids=kids;let status='',nKids=-1;
  return {group,kind:k,body,
    update(t,{status:st='running',children=0,phase=0}={}){
      if(st!==status){status=st;body.material=material(st==='waiting'?'wait':st==='idle'?'idle':'run',tint);for(const c of kids.children)c.material=body.material}
      const n=Math.min(children,3);
      if(n!==nKids){nKids=n;kids.clear();for(let i=0;i<n;i++){const c=new THREE.Mesh(body.geometry,body.material);c.scale.setScalar(.28);kids.add(c)}}
      const wait=st==='waiting',idle=st==='idle',hop=wait?.35*Math.abs(Math.sin(t*4.5)):0;
      body.position.y=idle?0:.06*Math.sin(t*1.6+phase)+hop;body.rotation.y=idle?0:.55*Math.sin(t*.45+phase);
      kids.children.forEach((c,i)=>{const a=t*.9*(idle?.3:1)+i*(2*Math.PI/n)+phase,d=1.05;c.position.set(d*Math.cos(a),body.position.y-.6+.08*Math.sin(a*2),.6*d*Math.sin(a));c.rotation.y=a+1.5});
    }};
}
