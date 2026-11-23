// The characters of the 3D office as game NPCs (docs/concepts/12-office.md): coding-agent mascots in their
// rooms and at AgentFlow desks, AgentFlow robots and offline people in the common area. Nobody snaps: every
// change of place is a walk along a path (office-nav.js), and what each one does next is its brain's choice
// (office-brain.js), seeded so every viewer sees much the same scene.
//
//   new session      appears at its owner's room door (a seated one at the office entrance), walks in, sits
//   gone             stands up, waves, walks out the door and fades
//   seated/unseated  walks from its room to the AgentFlow desk, or back
//   layout change    walks to its new place; when its whole room moved far, it fades out and in there
//   waiting          jogs to its person (in the office, not in Do not disturb) and hops; walks back after
//   new card         walks to the board, takes the card, carries it to its desk; UAT/Done: puts it up, cheers
//   idle             desk, coffee, the board, a short wander, a chat with another idle one ("…")
//   subagents        trail behind their parent while it walks, circle it while it is still
//   follow           a Chief of Staff (office-chief.js setFollow) walks 1.5–2 m behind its person, a little to one
//                    side so it never blocks the camera; back to its desk when they leave or go into a meeting
//
// office.js and office-activity.js keep building the figures as before; this module takes over where they
// stand. Remote people's avatars are not NPCs: they keep their own interpolation.
//
// createNpcs(office) -> {mascot, org, orgGhosts, tick, reset, invalidate, working, hidesCard, alive, setFollow, figure, dispose, stats}
//   office: {THREE, layer (a group in the world's frame, for figures that outlived their desk), world (the
//     group every room is in), navWorld() -> {boxes, bounds?, ground?}, person(memberKey) -> {obj}|undefined,
//     isQuiet(memberKey), room(memberKey) -> {door, lounge}|undefined, boardSpot(memberKey|null) -> {x, z, yaw}|null,
//     entrance() -> {x, z}, commonRadius(), lounge() -> [{x, z, fx, fz}]|null (where idle ones stand about), player() -> {x, z}, label(obj, html, opts) -> l, unlabel(l),
//     inMeeting(memberKey) -> true while they are in the meeting room (a follower waits at its desk),
//     retire(obj): a figure now only walking out (no clicks, no E)}
import {buildNav,navBounds,follow,separation,sidestep} from './office-nav.js';
import {createBrain,pairUp,unit,CHAT_SLOT} from './office-brain.js';
import {animateHuman} from './office-figures.js';

const PATHS_PER_FRAME=4,SETTLE_MS=2000,DIP_FAR=4,HUGE=45,WALK=1.7,JOG=3.4,TURN=9;
const R={mascot:0.38,seated:0.22,robot:0.36,human:0.3,player:0.45};
// Following: how far behind its person and to their right (about 1.7 m, out of the camera's way behind them), when to
// jog, and how far they must move for a new path.
export const FOLLOW_BACK=1.2,FOLLOW_SIDE=1.2,FOLLOW_FAR=5,FOLLOW_REPLAN=0.6;
// The spot a follower aims for: behind (x, z) facing heading, a little to the right. Pure, for tests.
export function behind(x,z,heading,back=FOLLOW_BACK,side=FOLLOW_SIDE){
  const s=Math.sin(heading),c=Math.cos(heading);
  return {x:x-s*back-c*side,z:z-c*back+s*side};
}

export function createNpcs(office){
  const {THREE}=office,npcs=new Map(),queue=[],follows=new Map();
  let nav=null,navDirty=true,navRev=0,settledAt=0,pairs=new Map(),pairsAt=-1,others=new Float32Array(64*3),clock=0;
  const v=new THREE.Vector3(),m4=new THREE.Matrix4(),worldInv=new THREE.Matrix4(),push={x:0,z:0},hs={speed:0,emote:null,phase:0};
  const tileGeo=new THREE.BoxGeometry(0.36,0.26,0.025),tileMat=new THREE.MeshLambertMaterial({color:'#fff3c4'}),tileBand=new THREE.MeshBasicMaterial({color:'#e9a23b'});
  const angle=(a,b)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));

  function rebuildNav(){
    navDirty=false;navRev++;spots.clear();
    try{
      const w=office.navWorld?.()||{},boxes=w.boxes||[];
      const pts=[];for(const n of npcs.values())pts.push(n.home);
      nav=buildNav({bounds:w.bounds||navBounds(boxes,pts,6),boxes,ground:w.ground||null});
      office.ground=w.ground||null;
    }catch(e){console.error('office nav',e);nav=null}
    // Walkers re-plan on the new floor (a few a frame); standing ones keep their place.
    for(const n of npcs.values())if(n.walking)request(n);
  }
  // Board spots, asked once per layout.
  const spots=new Map();
  const spotOf=key=>{if(!spots.has(key))spots.set(key,office.boardSpot(key)||null);return spots.get(key)};
  const groundAt=(n,x,z)=>{const y=office.ground?.(x,z);return Number.isFinite(y)?y:n.floorY};

  // ---------- NPCs ----------
  function make(key,type,{home,entering,door}){
    const brain=createBrain(key,{now:clock,entering});
    const at=entering&&door?door:home;
    const n={key,type,brain,intent:brain.intent,obj:null,frame:null,rel:new THREE.Matrix4(),inv:new THREE.Matrix4(),frameYaw:0,frameScale:1,frameKey:'',
      x:at.x,z:at.z,vx:0,vz:0,i:0,yaw:home.yaw??0,home:{x:home.x,z:home.z,yaw:home.yaw??0},floorY:0,scale:1,homeScale:1,
      member:'',area:'common',wander:true,status:'running',kind:'',card:null,still:false,
      input:{status:'running',kind:'',card:null,ownerHere:false,gone:false,arrived:!entering,partner:'',wander:true,board:true,still:false},
      pts:null,pathRev:-1,pathNav:-1,queued:false,walking:false,arrived:!entering,gx:at.x,gz:at.z,checkAt:0,stuckAt:0,stuckX:0,stuckZ:0,stuckN:0,cost:0,
      ghostUntil:0,sit:entering?0:1,phase:unit(key)*6.28,bob:0,trail:0,hopAt:0,hopped:false,side:null,alpha:1,fade:null,dip:null,ghost:false,removed:false,
      tile:null,bubble:null,emote:null,emoteState:'',emoteObj:null,humanEmote:{kind:'wave',at:0},anchor:null,field:null,vanish:0,speed:0};
    npcs.set(key,n);
    if(entering){n.yaw=Math.atan2(home.x-at.x,home.z-at.z);request(n)}
    return n;
  }
  const settled=()=>{const now=performance.now();if(!settledAt)settledAt=now+(office.settleMs??SETTLE_MS);return now>=settledAt};
  // The frame of a desk (its matrix in the world group's coordinates): its yaw, scale and inverse.
  function frameOf(n,obj){
    office.world.updateWorldMatrix(true,false);worldInv.copy(office.world.matrixWorld).invert();
    obj.parent.updateWorldMatrix(true,false);n.rel.multiplyMatrices(worldInv,obj.parent.matrixWorld);n.inv.copy(n.rel).invert();
    const e=n.rel.elements;n.frameYaw=Math.atan2(e[8],e[10]);n.frameScale=Math.hypot(e[8],e[9],e[10])||1;
  }

  // A live session's mascot, each time office.js builds its desk. obj: the mascot group, in its desk's frame;
  // a: the session; seated: at an AgentFlow desk; wander: false keeps it near its desk when idle.
  function mascot(key,obj,{a,member,seated=false,wander=true}){
    obj.rotation.order='YXZ';
    const frameKey=seated?'seat:'+(a.seat?.agent||''):'room:'+member;
    let n=npcs.get(key);
    const tmp={rel:new THREE.Matrix4(),inv:new THREE.Matrix4(),frameYaw:0,frameScale:1};
    frameOf(tmp,obj);
    // Its seat: where office.js put it at its desk, before this layer first moved it.
    const seat=obj.userData.npcSeat??={x:obj.position.x,y:obj.position.y,z:obj.position.z,yaw:obj.rotation.y};
    v.set(seat.x,seat.y,seat.z).applyMatrix4(tmp.rel);
    const home={x:v.x,z:v.z,yaw:tmp.frameYaw+seat.yaw},floorY=v.y;
    if(!n){
      const entering=settled();
      n=make(key,'mascot',{home,entering,door:entering?doorFor({type:'mascot',member,seated}):null});
      n.scale=n.homeScale=tmp.frameScale;
    }else{
      // A new figure (its desk was rebuilt, or it moved to another desk): the old one's labels went with it.
      if(n.obj!==obj){drop(n);n.bubble=null;n.emote=null;n.emoteState=''}
      // Same place, new frame: the room (or the agent it sits beside) moved. Far: fade over to the new place.
      if(n.frameKey===frameKey&&!n.ghost){
        v.set(n.x,floorY,n.z).applyMatrix4(n.inv).applyMatrix4(tmp.rel);
        if(Math.hypot(v.x-n.x,v.z-n.z)>DIP_FAR)dipTo(n,v.x,v.z);
      }
      n.ghost=false;
    }
    n.rel.copy(tmp.rel);n.inv.copy(tmp.inv);n.frameYaw=tmp.frameYaw;n.frameScale=tmp.frameScale;n.homeScale=tmp.frameScale;
    n.obj=obj;n.frame=obj.parent;n.frameKey=frameKey;n.floorY=floorY;
    if(n.home.x!==home.x||n.home.z!==home.z){n.home.x=home.x;n.home.z=home.z;if(n.intent.goal==='home')request(n)}
    n.home.yaw=home.yaw;
    n.input.gone=false;n.member=member;n.seated=seated;n.area=seated||!wander?'common':'room:'+member;n.wander=wander;
    n.status=a.status||'running';n.kind=a.activityKind||'';n.card=a.seat?.card||null;n.still=false;n.removed=false;
    n.boardKey=seated?null:member;
    write(n,clock);
    return n;
  }

  // The AgentFlow org, each time office.js lays it out. field: orgField (office-figures.js) with move();
  // robots: [{id, x, z, busy, still, anchor}]; humans: [{id, obj, x, z, member, still}].
  function org(field,robots,humans){
    const seen=new Set();
    for(const r of robots){
      const key='af:'+r.id;seen.add(key);let n=npcs.get(key);
      if(!n){const entering=settled();n=make(key,'robot',{home:{x:r.x,z:r.z,yaw:r.yaw||0},entering,door:entering?office.entrance():null})}
      else{retarget(n,r.x,r.z);n.home.yaw=r.yaw||0}
      if(n.anchor!==r.anchor){n.bubble=null;n.emote=null;n.emoteState=''} // the old anchor took its labels along
      n.anchor=r.anchor;n.status=r.busy?'running':'idle';n.still=!!r.still;n.wander=true;n.area='common';n.boardKey=null;n.removed=false;n.ghost=false;n.input.gone=false;
    }
    for(const h of humans){
      const key='af:'+h.id;seen.add(key);let n=npcs.get(key);
      if(!n){const entering=settled()&&!h.fromAvatar;const from=h.from||office.entrance();n=make(key,'human',{home:{x:h.x,z:h.z,yaw:0},entering:entering||!!h.from,door:from})}
      else{if(n.obj&&n.obj!==h.obj)drop(n);retarget(n,h.x,h.z)}
      n.obj=h.obj;n.member=h.member||'';n.status='idle';n.still=!!h.still;n.wander=true;n.area='common';n.boardKey=null;n.removed=false;n.ghost=false;n.vanish=0;n.floorY=0;n.input.gone=false;
      n.bubble=null;n.emote=null;n.emoteState='';
      write(n,clock);
    }
    for(const n of npcs.values()){
      // Every robot, leaving ones too, is drawn by the new field now.
      if(n.type==='robot'){n.field=field;write(n,clock)}
      if((n.type==='robot'||n.type==='human')&&!seen.has(n.key)&&!n.input.gone)gone(n);
    }
  }
  function retarget(n,x,z){
    const d=Math.hypot(n.home.x-x,n.home.z-z);if(d<1e-3)return;
    n.home.x=x;n.home.z=z;
    // The org was laid out again: a long way means fading over, a short one a walk.
    if(d>12&&Math.hypot(n.x-x,n.z-z)>12&&n.intent.goal==='home')dipTo(n,x,z);else if(n.intent.goal==='home')request(n);
  }
  // Robots that left the org this layout: still drawn (in the instanced field) until they have walked out.
  // ids: the robots in this layout. -> items for orgField
  function orgGhosts(ids){
    const out=[];
    for(const n of npcs.values()){
      if(n.type!=='robot')continue;
      const id=n.key.slice(3);if(ids.has(id))continue;
      if(!n.input.gone)gone(n);
      if(n.brain.state!=='gone')out.push({id,kind:'agent',x:n.x,z:n.z,dim:true,ghost:true});
    }
    return out;
  }
  function gone(n){n.input.gone=true;n.ghost=true;n.anchor=null}
  // Where it comes in and goes out.
  function doorFor(n){
    if(n.type==='mascot'&&!n.seated){const r=office.room(n.member);if(r)return r.door}
    return office.entrance();
  }
  // Fade out here and in at (x, z): for a jump too long to walk.
  function dipTo(n,x,z){n.dip={t:0,x,z};n.walking=false;n.pts=null}
  // Its old figure is done with: the new one took over, or it walked out.
  function drop(n){
    const o=n.obj;if(!o)return;
    restore(n);
    if(o.parent===office.layer)office.layer.remove(o);
    n.obj=null;
  }

  // ---------- fading (its own copies of the materials, only while it fades) ----------
  function setAlpha(n,a){
    if(n.type==='robot'||!n.obj){n.alpha=a;return}
    if(a>=0.999){restore(n);n.alpha=1;return}
    if(!n.fade){n.fade=new Map();n.obj.traverse(o=>{
      if(!o.isMesh||!o.material||o.material.colorWrite===false)return;
      const orig=o.material,clone=orig.clone();clone.transparent=true;clone.depthWrite=false;clone.userData.base=orig.opacity??1;n.fade.set(o,orig);o.material=clone;
    })}
    for(const o of n.fade.keys())o.material.opacity=o.material.userData.base*a;
    n.alpha=a;
  }
  function restore(n){
    if(!n.fade)return;
    for(const [o,orig] of n.fade){const c=o.material;if(c!==orig){o.material=orig;c.dispose()}}
    n.fade=null;
  }

  // ---------- goals and paths ----------
  function request(n){if(!n.queued){n.queued=true;queue.push(n)}}
  // The goal as a point (n.gx, n.gz). -> false when it should simply stay where it is.
  function resolve(n){
    const it=n.intent,s=it.spot;
    switch(it.goal){
      case 'here':n.gx=n.x;n.gz=n.z;return false;
      case 'door':{const d=n.exitDoor||(n.exitDoor=doorFor(n));n.gx=d.x;n.gz=d.z;return true}
      case 'owner':{
        const p=office.person(n.member)?.obj.position;if(!p){n.gx=n.home.x;n.gz=n.home.z;return true}
        // Beside its person, on the side it comes from (chosen once), spread so several do not stack.
        n.side??=Math.atan2(n.x-p.x,n.z-p.z)+(unit(n.key+'side')-0.5)*1.4;
        n.gx=p.x+Math.sin(n.side)*1.25;n.gz=p.z+Math.cos(n.side)*1.25;return true;
      }
      case 'board':{
        const b=spotOf(n.boardKey??null);if(!b){n.gx=n.home.x;n.gz=n.home.z;return true}
        // Along the board, so several do not stand on one spot.
        const off=(s-0.5)*3;n.gx=b.x+Math.cos(b.yaw)*off;n.gz=b.z-Math.sin(b.yaw)*off;n.faceX=b.x-Math.sin(b.yaw)*1.5;n.faceZ=b.z-Math.cos(b.yaw)*1.5;return true;
      }
      case 'lounge':{
        const r=n.area.startsWith('room:')?office.room(n.member):null,a=s*Math.PI*2;
        if(r){n.gx=r.lounge.x+Math.sin(a)*0.65;n.gz=r.lounge.z+Math.cos(a)*0.65;n.faceX=r.lounge.x;n.faceZ=r.lounge.z;return true}
        // The world's lounge (a coffee bar to stand at), or the common area's edge, where its rug ends.
        const spots=office.lounge?.();
        if(spots?.length){const q=spots[Math.min(spots.length-1,Math.floor(s*spots.length))],j=unit(n.key+'lounge')*Math.PI*2;n.gx=q.x+Math.sin(j)*0.22;n.gz=q.z+Math.cos(j)*0.22;n.faceX=q.fx;n.faceZ=q.fz;return true}
        const rad=Math.max(4,office.commonRadius()-1.2);n.gx=Math.cos(a)*rad;n.gz=Math.sin(a)*rad;n.faceX=0;n.faceZ=0;return true;
      }
      case 'wander':{const a=s*Math.PI*2,d=1.4+s*1.8;n.gx=n.home.x+Math.sin(a)*d;n.gz=n.home.z+Math.cos(a)*d;return true}
      case 'follow':{
        const who=office.person(follows.get(n.key));const p=who?.obj.position;if(!p){n.gx=n.home.x;n.gz=n.home.z;return true}
        // Their heading from how they last moved (the same for your own avatar and someone else's).
        const h=n.lead??=(n.leadAt={x:p.x,z:p.z},Math.atan2(n.x-p.x,n.z-p.z)+Math.PI);
        const at=behind(p.x,p.z,h);n.gx=at.x;n.gz=at.z;n.faceX=p.x;n.faceZ=p.z;return true;
      }
      case 'partner':{
        const p=npcs.get(n.input.partner);if(!p){n.gx=n.x;n.gz=n.z;return false}
        const mx=(n.x+p.x)/2,mz=(n.z+p.z)/2,dx=n.x-mx,dz=n.z-mz,d=Math.hypot(dx,dz)||1;
        n.gx=mx+dx/d*0.55;n.gz=mz+dz/d*0.55;n.faceX=p.x;n.faceZ=p.z;return true;
      }
      default:n.gx=n.home.x;n.gz=n.home.z;return true;
    }
  }
  function plan(n){
    n.queued=false;if(n.removed)return;
    n.pathRev=n.intent.rev;n.pathNav=navRev;n.stuckAt=clock;n.stuckX=n.x;n.stuckZ=n.z;
    if(!resolve(n)||Math.hypot(n.gx-n.x,n.gz-n.z)<0.04){n.walking=false;n.arrived=true;n.pts=null;return}
    const p=nav?nav.path(n.x,n.z,n.gx,n.gz):{points:[n.x,n.z,n.gx,n.gz],cost:Math.hypot(n.gx-n.x,n.gz-n.z)};
    if(p.cost>HUGE&&n.intent.goal!=='door'){dipTo(n,n.gx,n.gz);return}
    n.pts=p.points;n.i=2;n.cost=p.cost;n.walking=n.pts.length>2;n.arrived=!n.walking;
    if(!p.reached&&n.pts.length>=2){n.gx=n.pts[n.pts.length-2];n.gz=n.pts[n.pts.length-1]}
  }

  // ---------- each frame ----------
  function tick(dt,t){
    clock=t;
    if(navDirty)rebuildNav();
    for(let k=0;k<PATHS_PER_FRAME&&queue.length;k++)plan(queue.shift());
    if(t-pairsAt>1)updatePairs(t);
    // Everyone's place for separation, the player last.
    let count=0;
    if(others.length<(npcs.size+1)*3)others=new Float32Array((npcs.size+16)*3);
    for(const n of npcs.values()){n.slot=count;others[count*3]=n.x;others[count*3+1]=n.z;others[count*3+2]=n.type==='mascot'?R.mascot*n.scale:R[n.type];count++}
    const pl=office.player?.();if(pl){others[count*3]=pl.x;others[count*3+1]=pl.z;others[count*3+2]=R.player;count++}
    for(const n of npcs.values()){
      if(n.removed)continue;
      step(n,dt,t,count);
      if(n.brain.state==='gone'||n.vanish>=1){remove(n);continue}
      write(n,t);
    }
  }
  function updatePairs(t){
    pairsAt=t;const list=[];
    for(const n of npcs.values()){const s=n.brain.state;if(n.wander&&!n.still&&n.status==='idle'&&!n.input.gone&&(s==='idle'||s==='chat'))list.push({id:n.key,area:n.area})}
    pairs=pairUp(list,Math.floor(Date.now()/1000/CHAT_SLOT));
  }
  function step(n,dt,t,count){
    n.dt=dt;
    // An offline person who just came online: their figure gives way to their avatar.
    if(n.vanish){n.vanish=Math.min(1,n.vanish+dt/0.5);setAlpha(n,1-n.vanish);return}
    if(n.dip){
      const d=n.dip;d.t+=dt;
      if(d.t<0.3)setAlpha(n,1-d.t/0.3);
      else{if(!d.jumped){d.jumped=true;n.x=d.x;n.z=d.z;n.vx=n.vz=0}setAlpha(n,Math.min(1,(d.t-0.3)/0.4));if(d.t>=0.7){n.dip=null;setAlpha(n,1);n.arrived=false;request(n)}}
      return;
    }
    // A mascot whose desk is gone (the session ended): its figure stays, in the world's frame, to walk out.
    if(n.type==='mascot'&&!n.ghost&&n.obj&&!attached(n.frame)){
      const o=n.obj;n.ghost=true;n.input.gone=true;n.frame=null;n.bubble=null;n.emote=null;n.emoteState='';
      o.removeFromParent();office.layer.add(o);office.retire?.(o);
    }
    if(n.type==='human'&&!n.ghost&&n.obj&&!attached(n.obj)){
      const o=n.obj;n.ghost=true;n.frame=null;n.bubble=null;n.emote=null;n.emoteState='';
      o.removeFromParent();office.layer.add(o);office.retire?.(o);
      // Gone online (their avatar is here now): fade in place. Taken out of AgentFlow: walk out.
      if(n.member&&office.person(n.member)){n.vanish=0.001;return}
      n.input.gone=true;
    }
    const inp=n.input;
    inp.status=n.status;inp.kind=n.kind;inp.card=n.card;inp.still=n.still;inp.wander=n.wander;inp.board=!!spotOf(n.boardKey??null);
    inp.ownerHere=n.type==='mascot'&&!!office.person(n.member)&&!office.isQuiet?.(n.member);
    // A Chief of Staff keeps up with its person while they are here and not in a meeting.
    const lead=follows.get(n.key),lp=lead&&office.person(lead)?.obj.position;
    inp.follow=!!lp&&!office.inMeeting?.(lead);
    if(lp){
      const m=n.leadAt;if(!m||Math.hypot(lp.x-m.x,lp.z-m.z)>0.25){if(m)n.lead=Math.atan2(lp.x-m.x,lp.z-m.z);n.leadAt={x:lp.x,z:lp.z}}
      inp.far=Math.hypot(lp.x-n.x,lp.z-n.z)>FOLLOW_FAR;
    }else{inp.far=false;n.lead=undefined;n.leadAt=null}
    inp.partner=pairs.get(n.key)||'';inp.arrived=n.arrived&&n.pathRev===n.intent.rev;
    const it=n.brain.update(t,inp);
    if(it.goal!=='owner')n.side=null;
    if(it.goal!=='door')n.exitDoor=null;
    if(it.rev!==n.pathRev&&!n.queued)request(n);
    else if(n.walking&&n.pathNav!==navRev&&!n.queued)request(n);
    // Moving targets: re-plan when they moved off the end of the path.
    if((it.goal==='owner'||it.goal==='partner'||it.goal==='follow')&&t>n.checkAt){
      const follow=it.goal==='follow';n.checkAt=t+(follow?0.3:0.5);const gx=n.gx,gz=n.gz;resolve(n);
      if(Math.hypot(n.gx-gx,n.gz-gz)>(follow?FOLLOW_REPLAN:1))request(n);else{n.gx=gx;n.gz=gz}
    }
    // Walk.
    let speed=0;
    if(n.walking&&n.pts){
      const top=it.pace==='jog'?JOG:WALK+Math.min(0.9,n.cost/15);
      const left=follow(n,n.pts,top,dt);
      // Simple separation from the others (and the player), never into a wall. Someone in the way ahead is
      // walked round, not pushed against: the push turns sideways (office-nav.js sidestep).
      push.x=push.z=0;
      if(t>=n.ghostUntil){separation(n.x,n.z,others[n.slot*3+2],others,count,push,n.slot);sidestep(push,n.vx,n.vz)}
      if(push.x||push.z){const nx=n.x+push.x*dt,nz=n.z+push.z*dt;if(!nav||nav.open(nx,nz)){n.x=nx;n.z=nz}}
      speed=Math.hypot(n.vx,n.vz);
      if(speed>0.05)n.yaw+=angle(n.yaw,Math.atan2(n.vx,n.vz))*Math.min(1,dt*TURN);
      // There, or close enough for a moment with others in the way (several at one board, a crowd at the coffee).
      n.nearT=left<0.6?(n.nearT||0)+dt:0;
      if(left<0.03||n.nearT>1.2){n.walking=false;n.arrived=true;n.vx=n.vz=0;n.nearT=0}
      // Stuck (boxed in by a crowd, or a person standing in a doorway): plan again, and after a few tries
      // slip past the others for a moment rather than give up.
      if(t-n.stuckAt>2.5){if(Math.hypot(n.x-n.stuckX,n.z-n.stuckZ)<0.3){if(++n.stuckN>1){n.ghostUntil=t+2.5;n.stuckN=0}request(n)}else n.stuckN=0;n.stuckAt=t;n.stuckX=n.x;n.stuckZ=n.z}
    }else if(!n.seatedNow&&n.type!=='robot'&&!(it.goal==='home'&&it.pose==='sit')){
      // Standing about: drift apart from anyone right on top of it.
      push.x=push.z=0;separation(n.x,n.z,others[n.slot*3+2]*0.8,others,count,push,n.slot,{strength:0.8});
      if(push.x||push.z){const nx=n.x+push.x*dt,nz=n.z+push.z*dt;if(!nav||nav.open(nx,nz)){n.x=nx;n.z=nz}}
    }
    n.speed=speed;
    // Settling into its seat: the last few centimetres, whoever stands about.
    if(!n.walking&&n.arrived&&it.goal==='home'&&it.pose==='sit'&&Math.hypot(n.home.x-n.x,n.home.z-n.z)<0.7){const k=Math.min(1,dt*5);n.x+=(n.home.x-n.x)*k;n.z+=(n.home.z-n.z)*k}
    // Face what it is there for once it stands still.
    if(!n.walking){
      let face=null;
      if(it.pose==='sit'&&it.goal==='home')face=n.home.yaw;
      else if(it.goal==='owner'){const p=office.person(n.member)?.obj.position;if(p)face=Math.atan2(p.x-n.x,p.z-n.z)}
      else if(it.goal==='follow'){const p=office.person(follows.get(n.key))?.obj.position;if(p)face=Math.atan2(p.x-n.x,p.z-n.z)}
      else if(it.goal==='partner'){const p=npcs.get(inp.partner);if(p)face=Math.atan2(p.x-n.x,p.z-n.z)}
      else if((it.goal==='board'||it.goal==='lounge')&&n.faceX!==undefined)face=Math.atan2(n.faceX-n.x,n.faceZ-n.z);
      else if(it.goal==='home')face=n.home.yaw;
      if(face!==null)n.yaw+=angle(n.yaw,face)*Math.min(1,dt*6);
    }
    // Sitting down and standing up take a moment.
    const sit=it.pose==='sit'&&!n.walking&&n.arrived&&Math.hypot(n.x-n.home.x,n.z-n.home.z)<0.1;
    n.seatedNow=sit&&n.sit>0.5;
    n.sit=Math.max(0,Math.min(1,n.sit+(sit?dt:-dt)/0.35));
    // Its size eases to its desk's (a seated session's desk is half size).
    n.scale+=(n.homeScale-n.scale)*Math.min(1,dt*1.6);
    // A first big hop when it arrives to wait.
    if(it.pose==='hop'&&n.arrived&&!n.hopped){n.hopped=true;n.hopAt=t}else if(it.pose!=='hop')n.hopped=false;
    if(it.fade)setAlpha(n,1-it.fade);
    emotes(n,it,t);
  }
  const attached=o=>{while(o){if(o===office.world)return true;o=o.parent}return false};

  // Speech, waves and cheers: tiny labels over it.
  function emotes(n,it,t){
    const obj=n.type==='robot'?n.anchor:n.obj;if(!obj)return;
    const talk=it.say&&!n.walking&&n.arrived;
    if(talk&&!n.bubble)n.bubble=office.label(obj,'<span class="of-npc-say">…</span>',{y:n.type==='human'?2.35:n.type==='robot'?1.9:1.35*n.scale+0.35,cls:'npc-say',near:18});
    else if(!talk&&n.bubble){office.unlabel(n.bubble);n.bubble=null}
    const e=it.pose==='wave'?'👋':it.pose==='cheer'?'🎉':'';
    if(e!==n.emoteState){
      if(n.emote){office.unlabel(n.emote);n.emote=null}
      n.emoteState=e;
      if(e){n.emote=office.label(obj,`<span class="of-emote">${e}</span>`,{y:n.type==='human'?2.5:n.type==='robot'?2:1.5*n.scale+0.5,cls:'emote',near:22});n.humanEmote.kind=e==='👋'?'wave':'clap';n.humanEmote.at=performance.now()}
    }
  }

  // ---------- drawing ----------
  function write(n,t){
    const it=n.intent,y0=groundAt(n,n.x,n.z);
    // The walk cycle runs with its speed.
    n.phase+=(n.speed||0)*(n.dt||0)*7;
    const go=Math.min(1,(n.speed||0)/1.8);
    n.trail+=((go>0.15?1:0)-n.trail)*0.08;
    if(n.type==='robot'){
      const bob=Math.abs(Math.sin(n.phase))*0.07*go+(it.pose==='cheer'?Math.abs(Math.sin(t*9))*0.25:0)+hopY(n,t);
      const s=n.alpha<1?n.alpha:1;
      n.field?.move?.(n.key.slice(3),n.x,y0+bob,n.z,n.yaw,s);
      if(n.anchor)n.anchor.position.set(n.x,y0,n.z);
      tile(n,t,y0+1.55);
      return;
    }
    const o=n.obj;if(!o)return;
    if(n.type==='human'){
      o.position.set(n.x,y0,n.z);o.rotation.y=n.yaw;
      hs.speed=n.speed;hs.phase=n.phase;hs.emote=n.emoteState?n.humanEmote:null;
      animateHuman(o.userData.rig,t,hs);
      tile(n,t,y0+1.05,0.38);
      return;
    }
    // A mascot: a bounce for each step, a little lean into the walk, a bob while it stands up or sits down.
    const step=Math.abs(Math.sin(n.phase))*0.1*go,lean=0.16*go,rise=Math.sin(n.sit*Math.PI)*0.06*(n.sit>0&&n.sit<1?1:0);
    const wave=it.pose==='wave'?Math.sin(t*10)*0.22:0,cheer=it.pose==='cheer'?Math.abs(Math.sin(t*8))*0.3:0;
    const y=y0+step+rise+cheer+hopY(n,t)-0.04*n.sit;
    if(n.frame){
      v.set(n.x,y,n.z).applyMatrix4(n.inv);o.position.copy(v);
      o.rotation.set(lean,n.yaw-n.frameYaw,wave);o.scale.setScalar(n.scale/n.frameScale);
    }else{
      o.position.set(n.x,y,n.z);o.rotation.set(lean,n.yaw,wave);o.scale.setScalar(n.scale);
      // nobody updates a figure that left its desk: keep it alive here
      o.userData.mascot?.update(t,{status:n.status,children:o.userData.children||0,phase:o.userData.phase||0});
    }
    if(it.pose==='cheer')o.rotation.y+=t*6%(Math.PI*2);
    trailKids(n,o,t);
    tile(n,t,y0+1.25*n.scale+0.2);
  }
  // The big hop when it arrives to wait.
  function hopY(n,t){if(!n.hopAt)return 0;const k=(t-n.hopAt)/0.9;if(k>=1){n.hopAt=0;return 0}return Math.sin(k*Math.PI)*0.6*n.scale}
  // Subagents: a little line behind it while it walks, the usual circle while it is still.
  function trailKids(n,o,t){
    const kids=o.userData.mascot?.group?.userData.kids;if(!kids||!kids.children.length||n.trail<0.01)return;
    const list=kids.children,count=list.length;
    for(let i=0;i<count;i++){
      const c=list[i],tx=(i-(count-1)/2)*0.7,ty=-0.5+Math.abs(Math.sin(t*12+i*1.3))*0.25,tz=-1.4-i*0.3;
      c.position.x+=(tx-c.position.x)*n.trail;c.position.y+=(ty-c.position.y)*n.trail;c.position.z+=(tz-c.position.z)*n.trail;
    }
  }
  // The card it carries: a little tile over its head (or in a person's hands).
  function tile(n,t,y,ahead=0){
    const on=n.intent.carry&&n.alpha>0.05;
    if(!on){if(n.tile)n.tile.visible=false;return}
    if(!n.tile){const g=new THREE.Group(),m=new THREE.Mesh(tileGeo,tileMat),b=new THREE.Mesh(tileGeo,tileBand);b.scale.set(1,0.18,1.2);b.position.y=0.105;g.add(m,b);n.tile=g;office.layer.add(g)}
    const g=n.tile;g.visible=true;
    g.position.set(n.x+Math.sin(n.yaw)*ahead,y+Math.sin(t*4+n.phase)*0.03,n.z+Math.cos(n.yaw)*ahead);g.rotation.set(-0.25,n.yaw,0);
  }
  function remove(n){
    n.removed=true;npcs.delete(n.key);
    if(n.bubble)office.unlabel(n.bubble);if(n.emote)office.unlabel(n.emote);
    if(n.tile){office.layer.remove(n.tile);n.tile=null}
    if(n.type==='robot'){n.field?.move?.(n.key.slice(3),n.x,0,n.z,n.yaw,0);return}
    if(n.ghost||n.vanish)drop(n);else restore(n);
  }

  // ---------- for office.js and office-activity.js ----------
  // Is it at its desk, seated, working? (office-activity.js shows its work only then.)
  function working(key){const n=npcs.get(key);return !!n&&!!n.seatedNow&&n.brain.state==='work'}
  // Its card's badge shows once it has the card: not on the way to fetch it.
  function hidesCard(key){const n=npcs.get(key);return !!n&&(n.brain.state==='fetch'||(n.brain.state==='take'&&!n.intent.carry))}
  const alive=key=>npcs.has(key);
  // A jump in time (a day replay's seek): everyone at their place at once, seated, plans started over. The
  // one place where moving without walking is right.
  function reset(){
    for(const n of npcs.values()){
      if(n.input.gone||n.ghost){remove(n);continue}
      n.x=n.home.x;n.z=n.home.z;n.yaw=n.home.yaw;n.vx=n.vz=0;n.walking=false;n.arrived=true;n.pts=null;n.dip=null;n.vanish=0;
      n.sit=1;n.scale=n.homeScale;n.hopAt=0;n.side=null;n.queued=false;setAlpha(n,1);
      if(n.bubble){office.unlabel(n.bubble);n.bubble=null}if(n.emote){office.unlabel(n.emote);n.emote=null}n.emoteState='';
      n.brain=createBrain(n.key,{now:clock});n.intent=n.brain.intent;n.pathRev=-1;
      write(n,clock);
    }
    queue.length=0;
  }
  function stats(){let walking=0;for(const n of npcs.values())if(n.walking)walking++;return {npcs:npcs.size,walking,queued:queue.length,nav:nav?{w:nav.w,h:nav.h,cell:nav.cell}:null}}
  function dispose(){
    for(const n of npcs.values()){restore(n);if(n.tile)office.layer.remove(n.tile)}
    npcs.clear();queue.length=0;tileGeo.dispose();tileMat.dispose();tileBand.dispose();
  }
  // Who an NPC follows (a member key), or nobody: office-chief.js picks each person's Chief of Staff.
  function setFollow(key,member){if(member)follows.set(key,member);else follows.delete(key)}
  // Where an NPC is drawn, for labels and E: a robot's anchor, a figure's object.
  const figure=key=>{const n=npcs.get(key);return n&&!n.removed?(n.type==='robot'?n.anchor:n.obj)||null:null};
  return {mascot,org,orgGhosts,tick,reset,invalidate(){navDirty=true},working,hidesCard,alive,setFollow,figure,following:key=>npcs.get(key)?.brain.state==='follow',stats,dispose,npcs};
}
