// Walking paths for the 3D office's characters (office-npc.js). No Three.js here, so node can test it.
//
// A world (office-world-*.js, or office.js's classic rooms) becomes a grid of small cells: a cell is open when
// it has floor (world.ground) and no box, grown by a body's radius, covers it. A* finds a way between two
// cells (8 neighbours, no cutting corners, no climbing more than a step between neighbours), and the path is
// pulled tight: each point is joined to the farthest later one it can see, so walkers go straight across
// open floor and bend only at doors and furniture. A target nobody can reach ends at the closest open place
// on the way, and a start or target just inside furniture (a seat in front of a desk) is joined to the
// nearest open cell, so every request gets a path.
//
// buildNav({bounds:{minX,maxX,minZ,maxZ}, boxes, ground, cell, radius, climb}) -> nav
//   boxes: oriented boxes as officeBox / wallBox make them ({x, z, c, s, halfX, halfZ}); ground(x, z) -> floor
//   height or null (no floor); climb: the largest height step between neighbouring cells.
//   nav.path(ax, az, bx, bz) -> {points:[x0, z0, x1, z1, …], reached, cost}  (points start at a and end at
//                               b, or at the closest place to b when b cannot be reached)
//   nav.open(x, z), nav.nearest(x, z, maxCells) -> {x, z} | null, nav.clear(ax, az, bx, bz), nav.height(x, z)
// Buffers are made once per grid and reused by every search.

const SQRT2=Math.SQRT2;
export const NAV_CELL=0.5,NAV_RADIUS=0.32,NAV_CLIMB=0.32,NAV_MAX_CELLS=160000;

// Grow a box by r and mark the cells whose centres it covers.
function stamp(blocked,w,h,minX,minZ,cell,b,r){
  const c=b.c??Math.cos(b.yaw||0),s=b.s??Math.sin(b.yaw||0),hx=b.halfX+r,hz=b.halfZ+r;
  // The box's extent on the world axes.
  const ex=Math.abs(hx*c)+Math.abs(hz*s),ez=Math.abs(hx*s)+Math.abs(hz*c);
  const i0=Math.max(0,Math.floor((b.x-ex-minX)/cell)),i1=Math.min(w-1,Math.floor((b.x+ex-minX)/cell));
  const j0=Math.max(0,Math.floor((b.z-ez-minZ)/cell)),j1=Math.min(h-1,Math.floor((b.z+ez-minZ)/cell));
  for(let j=j0;j<=j1;j++){
    const oz=minZ+(j+0.5)*cell-b.z;
    for(let i=i0;i<=i1;i++){
      const ox=minX+(i+0.5)*cell-b.x;
      // officeBox's frame: local x = ox·c − oz·s, local z = ox·s + oz·c
      if(Math.abs(ox*c-oz*s)<=hx&&Math.abs(ox*s+oz*c)<=hz)blocked[j*w+i]=1;
    }
  }
}

export function buildNav({bounds,boxes=[],ground=null,cell=NAV_CELL,radius=NAV_RADIUS,climb=NAV_CLIMB}={}){
  let {minX=-20,maxX=20,minZ=-20,maxZ=20}=bounds||{};
  // Keep the grid a sensible size: a huge world gets bigger cells, never millions of them.
  while(((maxX-minX)/cell)*((maxZ-minZ)/cell)>NAV_MAX_CELLS)cell*=1.25;
  const w=Math.max(1,Math.ceil((maxX-minX)/cell)),h=Math.max(1,Math.ceil((maxZ-minZ)/cell)),n=w*h;
  const blocked=new Uint8Array(n),heights=ground?new Float32Array(n):null;
  if(ground)for(let j=0;j<h;j++)for(let i=0;i<w;i++){
    const y=ground(minX+(i+0.5)*cell,minZ+(j+0.5)*cell);
    if(y===null||y===undefined||!Number.isFinite(y))blocked[j*w+i]=1;else heights[j*w+i]=y;
  }
  for(const b of boxes)if(b&&Number.isFinite(b.x)&&Number.isFinite(b.z))stamp(blocked,w,h,minX,minZ,cell,b,radius);

  // Search buffers, reused: g costs, parents, a generation stamp per cell (no clearing between searches) and a
  // binary heap of cells by f.
  const g=new Float32Array(n),parent=new Int32Array(n),seen=new Uint32Array(n),closed=new Uint32Array(n);
  let heap=new Int32Array(1024),heapF=new Float32Array(1024),size=0,gen=0;
  const push=(node,f)=>{
    if(size===heap.length){const a=new Int32Array(size*2),b=new Float32Array(size*2);a.set(heap);b.set(heapF);heap=a;heapF=b}
    let k=size++;
    while(k>0){const p=(k-1)>>1;if(heapF[p]<=f)break;heap[k]=heap[p];heapF[k]=heapF[p];k=p}
    heap[k]=node;heapF[k]=f;
  };
  const pop=()=>{
    const top=heap[0],last=heap[--size],lf=heapF[size];let k=0;
    for(;;){let c=2*k+1;if(c>=size)break;if(c+1<size&&heapF[c+1]<heapF[c])c++;if(heapF[c]>=lf)break;heap[k]=heap[c];heapF[k]=heapF[c];k=c}
    heap[k]=last;heapF[k]=lf;return top;
  };

  const ci=x=>Math.floor((x-minX)/cell),cj=z=>Math.floor((z-minZ)/cell);
  const inside=(i,j)=>i>=0&&j>=0&&i<w&&j<h;
  const cx=i=>minX+(i+0.5)*cell,cz=j=>minZ+(j+0.5)*cell;
  // Outside the grid is open floor: the grid covers everything that can block.
  const openCell=(i,j)=>!inside(i,j)||!blocked[j*w+i];
  const open=(x,z)=>openCell(ci(x),cj(z));
  const stepOk=(a,b)=>!heights||Math.abs(heights[a]-heights[b])<=climb;
  const height=(x,z)=>{const i=ci(x),j=cj(z);return heights&&inside(i,j)?heights[j*w+i]:0};

  // The nearest open cell to (x, z), within maxCells rings. -> cell index or -1
  function nearestCell(x,z,maxCells=6){
    // From outside the grid (open floor all round), start at its nearest edge.
    const i0=Math.min(w-1,Math.max(0,ci(x))),j0=Math.min(h-1,Math.max(0,cj(z)));
    if(inside(i0,j0)&&!blocked[j0*w+i0])return j0*w+i0;
    let best=-1,bd=Infinity;
    for(let r=1;r<=maxCells;r++){
      for(let j=j0-r;j<=j0+r;j++)for(let i=i0-r;i<=i0+r;i++){
        if(Math.max(Math.abs(i-i0),Math.abs(j-j0))!==r||!inside(i,j)||blocked[j*w+i])continue;
        const d=(cx(i)-x)**2+(cz(j)-z)**2;if(d<bd){bd=d;best=j*w+i}
      }
      if(best>=0)return best;
    }
    return -1;
  }
  function nearest(x,z,maxCells=6){
    if(!inside(ci(x),cj(z)))return {x,z};
    const k=nearestCell(x,z,maxCells);return k<0?null:{x:cx(k%w),z:cz((k/w)|0)};
  }
  // Can a walker go straight from a to b? Samples a third of a cell apart, and checks height steps.
  function clear(ax,az,bx,bz){
    const d=Math.hypot(bx-ax,bz-az),k=Math.max(1,Math.ceil(d/(cell/3)));
    let prev=-1;
    for(let t=0;t<=k;t++){
      const x=ax+(bx-ax)*t/k,z=az+(bz-az)*t/k,i=ci(x),j=cj(z);
      if(!inside(i,j)){prev=-1;continue}
      const c=j*w+i;if(blocked[c])return false;
      if(prev>=0&&c!==prev&&!stepOk(prev,c))return false;
      prev=c;
    }
    return true;
  }

  const DI=[1,-1,0,0,1,1,-1,-1],DJ=[0,0,1,-1,1,-1,1,-1];
  // A* from cell s to cell t. -> the cell reached (t, or the closest to it when t cannot be reached)
  function search(s,t,maxExpand){
    gen++;if(gen===0xffffffff){seen.fill(0);closed.fill(0);gen=1}
    size=0;const ti=t%w,tj=(t/w)|0;
    const hOf=k=>{const dx=Math.abs(k%w-ti),dz=Math.abs(((k/w)|0)-tj);return (dx+dz+(SQRT2-2)*Math.min(dx,dz))};
    g[s]=0;parent[s]=-1;seen[s]=gen;push(s,hOf(s));
    let best=s,bestH=hOf(s),expanded=0;
    while(size){
      const k=pop();if(closed[k]===gen)continue;closed[k]=gen;
      if(k===t)return t;
      const hk=hOf(k);if(hk<bestH||(hk===bestH&&g[k]<g[best])){best=k;bestH=hk}
      if(++expanded>maxExpand)break;
      const i=k%w,j=(k/w)|0;
      for(let d=0;d<8;d++){
        const ni=i+DI[d],nj=j+DJ[d];if(!inside(ni,nj))continue;
        const m=nj*w+ni;if(blocked[m]||closed[m]===gen||!stepOk(k,m))continue;
        // A diagonal step needs both sides open, so nobody squeezes past a corner.
        if(d>=4&&(blocked[j*w+ni]||blocked[nj*w+i]))continue;
        const ng=g[k]+(d<4?1:SQRT2);
        if(seen[m]===gen&&ng>=g[m])continue;
        seen[m]=gen;g[m]=ng;parent[m]=k;push(m,ng+hOf(m));
      }
    }
    return best;
  }
  // Pull a list of points tight: keep a point only where the walker cannot see past it.
  function smooth(pts){
    if(pts.length<=4)return pts;
    const out=[pts[0],pts[1]];let ax=pts[0],az=pts[1],i=2;
    while(i<pts.length){
      // the farthest point visible from the anchor
      let far=i;for(let k=pts.length-2;k>i;k-=2)if(clear(ax,az,pts[k],pts[k+1])){far=k;break}
      ax=pts[far];az=pts[far+1];out.push(ax,az);i=far+2;
    }
    return out;
  }
  // Cell centres sit up to half a cell off the shortest line: slide each corner towards the line between its
  // neighbours while both legs stay clear, so walkers cut corners as closely as their radius allows.
  function tighten(pts){
    for(let i=2;i+3<pts.length;i+=2){
      const ax=pts[i-2],az=pts[i-1],bx=pts[i+2],bz=pts[i+3];
      // the foot of the corner on the line from its previous to its next point
      const dx=bx-ax,dz=bz-az,l2=dx*dx+dz*dz;if(l2<1e-9)continue;
      const u=Math.max(0,Math.min(1,((pts[i]-ax)*dx+(pts[i+1]-az)*dz)/l2)),fx=ax+dx*u,fz=az+dz*u;
      let lo=0,hi=1;
      for(let k=0;k<5;k++){const m=(lo+hi)/2,x=pts[i]+(fx-pts[i])*m,z=pts[i+1]+(fz-pts[i+1])*m;if(clear(ax,az,x,z)&&clear(x,z,bx,bz))lo=m;else hi=m}
      if(lo>0){pts[i]+=(fx-pts[i])*lo;pts[i+1]+=(fz-pts[i+1])*lo}
    }
    return pts;
  }
  function path(ax,az,bx,bz,{maxExpand=n,near=6}={}){
    if(clear(ax,az,bx,bz))return {points:[ax,az,bx,bz],reached:true,cost:Math.hypot(bx-ax,bz-az)};
    const s=nearestCell(ax,az,near),t=nearestCell(bx,bz,near);
    if(s<0)return {points:[ax,az],reached:false,cost:0}; // shut in: stay put
    let end=t,reached=t>=0;
    if(t<0){
      // No open cell near the target: aim at the open cell closest to it on the way there.
      const ti=Math.min(w-1,Math.max(0,ci(bx))),tj=Math.min(h-1,Math.max(0,cj(bz)));end=tj*w+ti;reached=false;
    }
    const got=search(s,end,maxExpand);
    if(got!==end)reached=false;
    const cells=[];for(let k=got;k>=0;k=parent[k])cells.push(k);
    const pts=[ax,az];
    // Only the cells where the chain turns: string-pulling then compares a handful of points, not every cell.
    for(let q=cells.length-1;q>=0;q--){
      const k=cells[q];
      if(q>0&&q<cells.length-1){const a=cells[q+1],b=cells[q-1];if(k-a===b-k)continue}
      pts.push(cx(k%w),cz((k/w)|0));
    }
    // The last step onto the target itself, when it is just beside the open cell (a seat at a desk).
    if(reached)pts.push(bx,bz);
    const points=tighten(smooth(pts));
    let cost=0;for(let q=2;q<points.length;q+=2)cost+=Math.hypot(points[q]-points[q-2],points[q+1]-points[q-1]);
    return {points,reached,cost};
  }
  return {path,open,nearest,clear,height,cell,w,h,bounds:{minX,maxX:minX+w*cell,minZ,maxZ:minZ+h*cell},blocked};
}

// Bounds around boxes and extra points, with a margin.
export function navBounds(boxes,points=[],margin=4){
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  const add=(x,z,r=0)=>{if(!Number.isFinite(x)||!Number.isFinite(z))return;minX=Math.min(minX,x-r);maxX=Math.max(maxX,x+r);minZ=Math.min(minZ,z-r);maxZ=Math.max(maxZ,z+r)};
  for(const b of boxes||[])add(b.x,b.z,Math.hypot(b.halfX,b.halfZ));
  for(const p of points||[])add(p.x,p.z);
  if(minX>maxX)return {minX:-20,maxX:20,minZ:-20,maxZ:20};
  return {minX:minX-margin,maxX:maxX+margin,minZ:minZ-margin,maxZ:maxZ+margin};
}

// Walking along a path, one frame: steer towards the next point, ease in on the last one. state: {x, z, vx,
// vz, i (index of the next point, in pairs)}; pts: path points; speed: top speed. Writes state; -> distance left
// to the end (0 when there). No allocation.
export function follow(state,pts,speed,dt,{accel=7,arrive=1.1,reach=0.3}={}){
  const last=pts.length-2;
  if(state.i>last)state.i=last;
  // Next point: skip the ones already reached.
  while(state.i<last&&Math.hypot(pts[state.i]-state.x,pts[state.i+1]-state.z)<reach)state.i+=2;
  let left=Math.hypot(pts[state.i]-state.x,pts[state.i+1]-state.z);
  for(let k=state.i;k<last;k+=2)left+=Math.hypot(pts[k+2]-pts[k],pts[k+3]-pts[k+1]);
  const tx=pts[state.i]-state.x,tz=pts[state.i+1]-state.z,d=Math.hypot(tx,tz);
  // Arrival easing: slow down over the last metre or so, never below a stroll.
  const want=left<0.02?0:speed*Math.max(0.28,Math.min(1,left/arrive));
  const wx=d>1e-6?tx/d*want:0,wz=d>1e-6?tz/d*want:0,k=1-Math.exp(-accel*dt);
  state.vx+=(wx-state.vx)*k;state.vz+=(wz-state.vz)*k;
  // Never overshoot the last point.
  let mx=state.vx*dt,mz=state.vz*dt;
  if(state.i===last){const m=Math.hypot(mx,mz);if(m>d&&m>0){mx*=d/m;mz*=d/m}}
  state.x+=mx;state.z+=mz;
  return Math.max(0,left-Math.hypot(mx,mz));
}

// Simple separation: a push away from neighbours closer than `room`, stronger the closer they are.
// others: flat [x, z, r, …] for count entries. Adds to out {x, z}. No allocation.
export function separation(x,z,r,others,count,out,skip=-1,{strength=2.2}={}){
  for(let k=0;k<count;k++){
    if(k===skip)continue;
    const ox=others[k*3],oz=others[k*3+1],room=r+others[k*3+2],dx=x-ox,dz=z-oz,d2=dx*dx+dz*dz;
    if(d2>=room*room)continue;
    const d=Math.sqrt(d2);
    if(d<1e-4){out.x+=strength*0.5*(k%2?1:-1);continue} // exactly on top: split along x
    const push=(room-d)/room*strength;out.x+=dx/d*push;out.z+=dz/d*push;
  }
  return out;
}

// A push against the way a walker is going (someone ahead) turns sideways, so it walks round them instead of
// standing still pressed against them. Pushes from the side or behind are kept. Writes push. No allocation.
export function sidestep(push,vx,vz){
  const v=Math.hypot(vx,vz),m=Math.hypot(push.x,push.z);if(v<0.05||m<1e-6)return push;
  const fx=vx/v,fz=vz/v,along=push.x*fx+push.z*fz;
  if(along>=0)return push;
  // what is left after taking out the backward part; dead ahead, step to the right
  let lx=push.x-along*fx,lz=push.z-along*fz;const l=Math.hypot(lx,lz);
  if(l<m*0.15){lx=fz;lz=-fx}else{lx/=l;lz/=l}
  push.x=lx*m;push.z=lz*m;return push;
}
