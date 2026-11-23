// What live agents act out in the 3D office (docs/concepts/12-office.md), per activityKind: typing at the
// keyboard (edit), a floating book (read), a sweeping magnifying glass (search), terminal glyphs (run), a
// bubbling test tube with green and red flashes (test), a thought cloud (think) and a little globe (web).
// Idle agents wander to their room's coffee corner and back. An agent that starts waiting walks to its
// owner's avatar when they are in the office (else stays at its desk), hops there under its "!", and, for
// the owner only, plays a soft ping (WebAudio, no assets; muted from the HUD). Clicking it still opens its
// panel with Allow / Deny (office.js).
//
// office.js owns the scene and rebuilds a room's desks on every report; this module keeps each agent's
// place and pose across rebuilds (keyed by owner and agent id), so walks carry on. One set of geometries
// and materials per open office, shared by every prop; per frame only transforms change.
import {getPref,setPref} from './prefs.js';

// [emoji, verb] for name tags and the side panel.
export const KINDS={edit:['✏️','Editing'],read:['📖','Reading'],search:['🔍','Searching'],run:['⌨️','Running commands'],test:['🧪','Testing'],think:['💭','Thinking'],web:['🌐','On the web'],idle:['☕','Idle']};
export const kindOf=a=>KINDS[a?.activityKind]?a.activityKind:a?.status==='idle'?'idle':'think';
// What a name tag and the panel say: waiting beats the kind of work it was doing.
export const shownKind=a=>a?.status==='waiting'?['⏳','Waiting on its person']:KINDS[kindOf(a)];
const MUTE='officeMute';
export const muted=()=>!!getPref(MUTE);

// ---------- the soft ping ----------
let audio=null;
function ctx(){
  const AC=globalThis.AudioContext||globalThis.webkitAudioContext;if(!AC)return null;
  try{audio||=new AC();if(audio.state==='suspended')audio.resume().catch(()=>{})}catch{audio=null}
  return audio;
}
// Two short sine notes, quiet, with soft edges.
export function ping(){
  if(muted())return;const a=ctx();if(!a)return;
  const t=a.currentTime+0.02;
  for(const [f,at] of [[880,0],[1318.5,0.13]]){
    const o=a.createOscillator(),g=a.createGain();o.type='sine';o.frequency.value=f;
    g.gain.setValueAtTime(0,t+at);g.gain.linearRampToValueAtTime(0.07,t+at+0.015);g.gain.exponentialRampToValueAtTime(0.0008,t+at+0.32);
    o.connect(g).connect(a.destination);o.start(t+at);o.stop(t+at+0.35);
  }
}
// Browsers start audio only after a gesture: the office's first click or key unlocks it.
export const unlockAudio=()=>{if(audio||!muted())ctx()};

// ---------- the HUD: sound and "notify me" ----------
// icon(name) from icons.js; notify (optional): {on(), toggle()} from office-alerts.js, for its bell.
export function hudHtml(icon,{notify=false}={}){
  return `<button type="button" class="ib of-hud" data-of-hud="sound" aria-pressed="${!muted()}" aria-label="Sound when your agents wait" data-tip="Sound when your agents wait">${icon(muted()?'volumeOff':'volume')}</button>`+
    (notify?`<button type="button" class="ib of-hud" data-of-hud="notify" aria-pressed="false" aria-label="Notify me when agents wait" data-tip="Notify me when agents wait">${icon('bell')}</button>`:'');
}
export function bindHud(root,{icon,notify,toast}){
  const paint=()=>{
    const s=root.querySelector('[data-of-hud="sound"]'),n=root.querySelector('[data-of-hud="notify"]');
    if(s){s.setAttribute('aria-pressed',String(!muted()));s.innerHTML=icon(muted()?'volumeOff':'volume');s.dataset.tip=muted()?'Sound is off':'Sound when your agents wait'}
    if(n&&notify){const on=notify.on();n.setAttribute('aria-pressed',String(on));n.innerHTML=icon(on?'bell':'bellOff');n.dataset.tip=on?'Notifying you when your agents wait':'Notify me when agents wait'}
  };
  root.addEventListener('click',async e=>{
    const b=e.target.closest('[data-of-hud]');if(!b)return;
    if(b.dataset.ofHud==='sound'){setPref(MUTE,!muted());paint();if(!muted())ping();return}
    if(!notify)return;const r=await notify.toggle();paint();
    if(r==='denied')toast?.('Notifications are blocked for this site in your browser. The 3D button still shows a badge.',true);
    else if(r==='unsupported')toast?.('This browser has no notifications. The 3D button still shows a badge.');
    else if(r)toast?.('You will be notified when one of your agents waits.');
  });
  root.addEventListener('pointerdown',unlockAudio,{passive:true});root.addEventListener('keydown',unlockAudio);
  paint();
}

// ---------- the scene side ----------
// office: {THREE, part(geo, mat, pos, scale), M (office.js shared geometry), room(memberKey) -> {group, desks},
//          person(memberKey) -> {obj} | undefined, roomW, roomD}
export function createActivity(office){
  const {THREE,part}=office,V=THREE.Vector3,actors=new Map();
  const basic=c=>new THREE.MeshBasicMaterial({color:c}),lam=(c,o={})=>new THREE.MeshLambertMaterial({color:c,flatShading:true,...o});
  const G={box:office.M.box,ico:office.M.ico,ico1:office.M.ico1,cyl:new THREE.CylinderGeometry(1,1,1,8),ring:new THREE.TorusGeometry(1,0.16,6,18),thin:new THREE.TorusGeometry(1,0.05,4,24),disc:new THREE.CircleGeometry(1,18),cone:office.M.cone};
  const K={paper:lam('#fbfaf5'),cover:lam('#c0563b'),key:lam('#2a312e'),code:basic('#bfe8cf'),green:basic('#5fd38a'),glass:lam('#cfe6ff',{transparent:true,opacity:.38,depthWrite:false}),
    brass:lam('#c99a3c'),cloud:lam('#ffffff',{transparent:true,opacity:.95}),sea:lam('#4c9be8'),land:lam('#5fae6e'),ringM:lam('#e6edf5'),bubble:lam('#ffffff',{transparent:true,opacity:.75}),
    hand:lam('#f4ede4'),counter:lam('#8c6a4f'),machine:lam('#39413e'),light:basic('#ff6b4a'),mug:lam('#f3efe6'),coffee:lam('#5a3a22'),leaf:lam('#5f9e6e'),pot:lam('#c7b299'),rug:lam('#000',{transparent:true,opacity:.07,depthWrite:false})};
  const W=office.roomW,D=office.roomD,LOUNGE=new V(-W/2+1.7,0,D/2-1.6),INNER=new V(0,0,D/2-0.9),OUTER=new V(0,0,D/2+1.1);
  const hash=s=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return (h>>>0)/4294967296};

  // The coffee corner, in a room's desks group (room coordinates). -> [{x, z, w, d, h}]: its counter, for colliders.
  function lounge(g){
    const c=new THREE.Group();c.position.copy(LOUNGE);g.add(c);
    const rug=part(G.disc,K.rug,[0,0.07,0],[1.25,1.25,1.25]);rug.rotation.x=-Math.PI/2;
    c.add(rug,part(G.box,K.counter,[-1.05,0.45,0.35],[0.7,0.9,1.3]),part(G.box,K.machine,[-1.1,1.12,0.6],[0.36,0.44,0.34]),part(G.box,K.light,[-0.92,1.22,0.6],[0.02,0.05,0.05]),
      part(G.cyl,K.mug,[-1.0,0.97,0.1],[0.06,0.1,0.06]),part(G.cyl,K.coffee,[-1.0,1.02,0.1],[0.05,0.01,0.05]),
      part(G.cyl,K.pot,[-1.05,0.18,-0.75],[0.22,0.36,0.22]),part(G.cone,K.leaf,[-1.05,0.72,-0.75],[0.32,0.8,0.32]));
    return [{x:LOUNGE.x-1.05,z:LOUNGE.z+0.35,w:0.7,d:1.3,h:0.9}];
  }

  // ---------- props, built on first use, children of the mascot (its forward is +z, towards its desk) ----------
  const BUILD={
    edit(){const g=new THREE.Group(),body=K.hand;
      g.add(part(G.box,K.key,[0,0.79,0.5],[0.62,0.03,0.2]));
      const l=part(G.ico,body,[-0.13,0.85,0.46],[0.075,0.06,0.075]),r=part(G.ico,body,[0.13,0.85,0.46],[0.075,0.06,0.075]);g.add(l,r);
      const lines=[0,1,2,3].map(i=>{const b=part(G.box,K.code,[-0.3,1.24-i*0.1,1.05],[0.3,0.035,0.01]);g.add(b);return b});
      g.userData.tick=(t,s)=>{const a=Math.max(0,Math.sin(t*17+s*9)),b=Math.max(0,Math.sin(t*17+s*9+Math.PI));l.position.y=0.85+a*0.06;r.position.y=0.85+b*0.06;
        lines.forEach((x,i)=>{const w=0.12+((Math.sin(t*1.7+i*1.9+s*5)+1)/2)*0.45;x.scale.x=w;x.position.x=0.3-w/2})};return g},
    read(){const g=new THREE.Group(),book=new THREE.Group();book.position.set(0,1.22,0.5);g.add(book);
      book.add(part(G.box,K.cover,[0,-0.01,0],[0.5,0.02,0.32]));
      const L=part(G.box,K.paper,[-0.12,0.01,0],[0.23,0.015,0.3]),R=part(G.box,K.paper,[0.12,0.01,0],[0.23,0.015,0.3]);L.rotation.z=0.18;R.rotation.z=-0.18;book.add(L,R);
      const hinge=new THREE.Group();hinge.position.y=0.02;book.add(hinge);const page=part(G.box,K.paper,[0.115,0,0],[0.22,0.01,0.28]);hinge.add(page);
      book.rotation.x=-0.9;
      g.userData.tick=(t,s)=>{book.position.y=1.22+Math.sin(t*2+s*7)*0.05;book.rotation.z=Math.sin(t*1.1+s)*0.08;const p=((t*0.6+s)%1);hinge.rotation.z=p<0.5?p*2*Math.PI*0.94:Math.PI*0.94;page.visible=p<0.62};return g},
    search(){const g=new THREE.Group(),m=new THREE.Group();g.add(m);
      const ring=part(G.ring,K.brass,[0,0,0],[0.15,0.15,0.15]),lens=part(G.disc,K.glass,[0,0,0],[0.14,0.14,0.14]),handle=part(G.cyl,K.machine,[0.15,-0.15,0],[0.03,0.22,0.03]);
      handle.rotation.z=Math.PI/4;m.add(ring,lens,handle);
      g.userData.tick=(t,s)=>{const a=Math.sin(t*1.8+s*6);m.position.set(a*0.38,0.98+Math.abs(Math.cos(t*1.8+s*6))*0.08,0.62);m.rotation.set(-0.35,a*0.5,a*0.25)};return g},
    run(){const g=new THREE.Group(),p=new THREE.Group();p.position.set(0,1.1,1.06);g.add(p);
      const c1=part(G.box,K.green,[-0.24,0.05,0],[0.11,0.025,0.01]),c2=part(G.box,K.green,[-0.24,-0.01,0],[0.11,0.025,0.01]);c1.rotation.z=-0.6;c2.rotation.z=0.6;
      const cursor=part(G.box,K.green,[-0.08,-0.06,0],[0.1,0.025,0.01]);p.add(c1,c2,cursor);
      const out=[0,1,2].map(i=>{const b=part(G.box,K.green,[0,1.45,1.0],[0.22,0.03,0.03]);g.add(b);return b});
      g.userData.tick=(t,s)=>{cursor.visible=((t*2.2+s)%1)<0.55;out.forEach((b,i)=>{const k=((t*0.7+i/3+s)%1);b.position.set(-0.1+((i*37+Math.floor(t*0.7+i/3+s)*13)%5)*0.05,1.38+k*0.55,1.0);const sc=k<0.8?1:Math.max(0,(1-k)*5);b.scale.set(0.08+((i*7)%3)*0.06,0.03*sc,0.03*sc)})};return g},
    test(u){const g=new THREE.Group(),tube=new THREE.Group();tube.position.set(0.34,1.0,0.42);g.add(tube);
      const liquid=lam('#7fd1a0',{emissive:'#000000'}),mesh=part(G.cyl,liquid,[0,-0.07,0],[0.05,0.16,0.05]);mesh.userData.own=true;u.own.push(liquid);
      tube.add(part(G.cyl,K.glass,[0,0,0],[0.065,0.34,0.065]),mesh,part(G.cyl,K.glass,[0,0.18,0],[0.085,0.02,0.085]));
      const bubbles=[0,1,2].map(()=>{const b=part(G.ico,K.bubble,[0,0,0],[0.022,0.022,0.022]);tube.add(b);return b});
      g.userData.tick=(t,s)=>{tube.rotation.z=Math.sin(t*2.3+s*4)*0.18;
        bubbles.forEach((b,i)=>{const k=((t*0.9+i/3+s)%1);b.position.set(Math.sin(t*5+i*2)*0.02,-0.1+k*0.42,0);b.scale.setScalar(0.016+k*0.016)});
        // A flash every 2.4 s: mostly green, sometimes red (it is running tests, not reporting results).
        const n=Math.floor(t/2.4+s*10),f=(t/2.4+s*10)%1,red=hash(u.key+n)<0.28,on=f<0.18;
        liquid.color.set(on?(red?'#ff5a4f':'#4dff88'):'#7fd1a0');liquid.emissive.set(on?(red?'#7a1010':'#106a2a'):'#000000')};return g},
    think(){const g=new THREE.Group(),c=new THREE.Group();c.position.set(0.42,1.72,0.1);g.add(c);
      for(const [x,y,z,r] of [[0,0,0,0.15],[0.15,0.03,0,0.12],[-0.14,0.02,0,0.11],[0.04,0.11,0,0.12],[0.02,-0.06,0.05,0.1]])c.add(part(G.ico1,K.cloud,[x,y,z],[r,r*0.85,r]));
      const dots=[[0.18,1.32,0.05,0.035],[0.28,1.47,0.07,0.05]].map(([x,y,z,r])=>{const d=part(G.ico,K.cloud,[x,y,z],[r,r,r]);g.add(d);return d});
      g.userData.tick=(t,s)=>{const k=1+Math.sin(t*2+s*5)*0.06;c.scale.setScalar(k);c.position.y=1.72+Math.sin(t*1.3+s)*0.04;dots.forEach((d,i)=>{d.visible=((t*1.4+s)%1)>i*0.3})};return g},
    web(){const g=new THREE.Group(),w=new THREE.Group();w.position.set(0,1.62,0.18);g.add(w);
      w.add(part(G.ico1,K.sea,[0,0,0],[0.16,0.16,0.16]),part(G.ico,K.land,[0.07,0.05,0.09],[0.08,0.06,0.07]),part(G.ico,K.land,[-0.09,-0.04,-0.06],[0.07,0.07,0.06]));
      const eq=part(G.thin,K.ringM,[0,0,0],[0.23,0.23,0.23]);eq.rotation.x=Math.PI/2;const mer=part(G.thin,K.ringM,[0,0,0],[0.21,0.21,0.21]);w.add(eq,mer);
      const sat=part(G.ico,K.green,[0,0,0],[0.025,0.025,0.025]);g.add(sat);
      g.userData.tick=(t,s)=>{w.rotation.y=t*1.2+s*6;w.rotation.z=0.35;w.position.y=1.62+Math.sin(t*1.6+s)*0.04;sat.position.set(Math.cos(t*2.6+s)*0.3,1.62+Math.sin(t*2.6+s)*0.1,0.18+Math.sin(t*2.6+s)*0.3)};return g},
  };
  function propFor(u,kind){if(!BUILD[kind])return null;if(!u.props[kind]){const p=BUILD[kind](u);u.props[kind]=p;u.mascot.add(p)}return u.props[kind]}

  // ---------- attach: called by office.js for each mascot it builds ----------
  // a: the agent as this viewer sees it; desk: the desk group (mascot's parent); root: the room's desks group.
  // lounge: false keeps an idle one at its desk (a session seated at an AgentFlow agent's desk, office-seats.js).
  // -> 'waiting' when it just started waiting (or waits on a new prompt), else ''. Pings for the owner.
  function attach(mascot,a,{member,desk,root,lounge=true}){
    const key=member+'\n'+a.id,prev=actors.get(key);
    root.updateWorldMatrix(true,true);
    const home=desk.localToWorld(mascot.position.clone()),facing=new THREE.Euler().setFromQuaternion(root.getWorldQuaternion(new THREE.Quaternion()),'YXZ').y;
    const u=prev||{key,member,pos:home.clone(),yaw:facing+Math.PI,seed:hash(key),phase:'desk',until:0,hopAt:0};
    // A new mascot each rebuild: props start over on it; place and pose carry on.
    for(const m of u.own||[])m.dispose?.();
    Object.assign(u,{mascot,desk,root,home,facing,lounge,props:{},own:[],kind:kindOf(a),status:a.status,mine:!!a.mine});
    const req=a.pending?.requestId||'',started=!!prev&&a.status==='waiting'&&(prev.lastStatus!=='waiting'||(req&&req!==prev.lastReq));
    u.lastStatus=a.status;u.lastReq=req;actors.set(key,u);
    if(started){u.hopAt=performance.now();if(u.mine)ping()}
    place(u,0);
    return started?'waiting':'';
  }

  // ---------- walking ----------
  const tmp=new V(),tmp2=new V(),lp=new V(),lg=new V();
  const inRoom=p=>Math.abs(p.x)<W/2&&p.z>-D/2&&p.z<D/2+0.6;
  // The next point towards goal, through the room's door when one end is inside and the other is not.
  function waypoint(u,goal,out){
    u.root.worldToLocal(lp.copy(u.pos));u.root.worldToLocal(lg.copy(goal));
    const pin=inRoom(lp),gin=inRoom(lg);
    if(pin===gin)return out.copy(goal);
    if(pin){const atDoor=Math.abs(lp.x)<0.6&&lp.z>INNER.z-0.3;return u.root.localToWorld(out.copy(atDoor?OUTER:INNER))}
    return u.root.localToWorld(out.copy(lp.distanceTo(OUTER)>0.5?OUTER:INNER));
  }
  function goalOf(u,now){
    if(u.status==='waiting'){
      const p=office.person(u.member);
      if(p){
        // Beside the owner, on the side it comes from (chosen once), spread so several agents do not stack.
        const o=p.obj.position;u.side??=Math.atan2(u.pos.x-o.x,u.pos.z-o.z)+(u.seed-0.5)*1.4;
        u.facePt=o;return tmp2.set(o.x+Math.sin(u.side)*1.25,0,o.z+Math.cos(u.side)*1.25);
      }
      u.facePt=null;u.side=null;return u.home;
    }
    u.facePt=null;u.side=null;
    if(u.status==='idle'&&u.lounge){
      // Desk a while, coffee a while, back again.
      if(now>u.until){u.phase=u.phase==='lounge'?'desk':'lounge';u.until=now+(u.phase==='lounge'?5+u.seed*5:7+((u.seed*7)%1)*9)}
      if(u.phase==='lounge'){const a=u.seed*Math.PI*2;return u.root.localToWorld(tmp2.set(LOUNGE.x+0.2+Math.sin(a)*0.65,0,LOUNGE.z+Math.cos(a)*0.65))}
      return u.home;
    }
    u.phase='desk';return u.home;
  }
  // Writes the actor's world place and heading onto its mascot (in its desk's coordinates).
  function place(u,y,tilt=0){
    u.desk.worldToLocal(tmp.copy(u.pos));u.mascot.position.set(tmp.x,y,tmp.z);
    u.mascot.rotation.set(tilt,u.yaw-u.facing,0);
  }
  const turn=(a,b,k)=>{const d=((b-a+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI;return a+d*Math.min(1,k)};

  // ---------- each frame ----------
  function tick(dt,t){
    const now=t;
    for(const [key,u] of actors){
      if(!u.root.parent){for(const m of u.own)m.dispose?.();actors.delete(key);continue} // its room was rebuilt without it
      const goal=goalOf(u,now),dist=Math.hypot(goal.x-u.pos.x,goal.z-u.pos.z),atHome=u.pos.distanceTo(u.home)<0.06;
      let y=0,tilt=0,walking=false;
      if(dist>0.06){
        const w=waypoint(u,goal,tmp),dx=w.x-u.pos.x,dz=w.z-u.pos.z,l=Math.hypot(dx,dz)||1,step=Math.min(l,(u.status==='waiting'?3.6:2.4)*dt);
        u.pos.x+=dx/l*step;u.pos.z+=dz/l*step;u.yaw=turn(u.yaw,Math.atan2(dx,dz),dt*10);walking=true;
        y=Math.abs(Math.sin(t*12+u.seed*9))*0.09;
      }else{
        u.pos.x=goal.x;u.pos.z=goal.z;
        if(u.facePt)u.yaw=turn(u.yaw,Math.atan2(u.facePt.x-u.pos.x,u.facePt.z-u.pos.z),dt*8);
        else if(atHome)u.yaw=turn(u.yaw,u.facing+Math.PI,dt*8);
        else if(u.phase==='lounge'){u.root.localToWorld(tmp.set(LOUNGE.x-1.1,0,LOUNGE.z+0.4));u.yaw=turn(u.yaw,Math.atan2(tmp.x-u.pos.x,tmp.z-u.pos.z),dt*6)}
        // The mascot itself bobs, and hops while waiting (office-mascots.js); this adds the lean of the work.
        if(u.status==='running'&&atHome)tilt=u.kind==='edit'?0.12:u.kind==='read'?-0.06:0;
        else if(u.phase==='lounge')y=Math.abs(Math.sin(t*1.5+u.seed*4))*0.03;
      }
      // A fresh wait: a bigger first hop.
      if(u.hopAt){const k=(performance.now()-u.hopAt)/900;if(k<1)y+=Math.sin(k*Math.PI)*0.6;else u.hopAt=0}
      place(u,y,tilt);
      // The prop for its kind shows only while it works at its desk.
      const show=!walking&&atHome&&u.status==='running'?u.kind:'';
      for(const [k,p] of Object.entries(u.props))p.visible=k===show;
      if(show){const p=propFor(u,show);if(p){p.visible=true;p.userData.tick?.(t,u.seed)}}
    }
  }
  return {lounge,attach,tick,actors};
}
