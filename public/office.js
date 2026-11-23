// The 3D office (docs/concepts/12-office.md): a full-screen, low-poly office for one environment, drawn with
// Three.js (public/vendor/three, MIT). One room per member with their live coding agents at desks, the
// environment's AgentFlow agents in the common area, and everyone who has the office open as an avatar.
// Live over Server-Sent Events (GET /api/office/{env}/events); moves, chat, emotes and Allow / Deny are
// small POSTs to /api/office/{env}/… The server redacts other people's agents per viewer, so what
// arrives here is already what this person may see. Loaded on demand from the AgentFlow toolbar.
import * as THREE from './vendor/three/three.module.min.js';
import {icon} from './icons.js';
import {esc} from './ui.js';
import {memberColor,initials} from './devops-core.js';

const VENDOR={claude:{name:'Claude',color:'#d97757'},codex:{name:'Codex',color:'#2b2f33'},gemini:{name:'Gemini',color:'#4c7cf0'},other:{name:'Agent',color:'#5f9e6e'}};
const STATUS={running:'Running',waiting:'Waiting on its person',idle:'Idle'};
const EMOTES=[['wave','👋','Wave'],['thumbs','👍','Thumbs up'],['clap','👏','Clap'],['heart','❤️','Heart']];
const SPEED=5.2,SAY_RADIUS=14,SEND_MS=110,ROOM_W=12,ROOM_D=9;
let S=null; // the open office

// ---------- opening and closing ----------
// opts: {env, current (the app's environment), offices:[{id,name}], agentflow():[] (the local store's agents, for current),
//        focusAgent(id) (opens an AgentFlow agent; current env only), me:{name,image}, toast(msg,bad)}
export function openOffice(opts){
  if(S)return;
  const root=document.createElement('div');root.className='of';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','3D office');
  root.innerHTML=`<div class="of-top">
      <span class="of-title">${icon('cube3d',16)}<b>3D office</b></span>
      ${opts.offices.length>1?`<select class="of-switch" aria-label="Office">${opts.offices.map(o=>`<option value="${esc(o.id)}"${o.id===opts.env?' selected':''}>${esc(o.name)}</option>`).join('')}</select>`:`<span class="of-env">${esc(opts.offices[0]?.name||'')}</span>`}
      <span class="of-status" role="status" aria-live="polite">Connecting…</span><span class="sp"></span>
      <span class="of-keys">WASD or arrows · click to walk · 1–4 emotes · Esc closes</span>
      <button type="button" class="ib" data-of="zoomOut" aria-label="Zoom out" data-tip="Zoom out">${icon('minus')}</button><button type="button" class="ib" data-of="zoomIn" aria-label="Zoom in" data-tip="Zoom in">${icon('plus')}</button>
      <button type="button" class="ib of-close" data-of="close" aria-label="Close the 3D office" data-tip="Close (Esc)">${icon('x')}</button></div>
    <div class="of-stage"><div class="of-labels" aria-hidden="true"></div></div>
    <div class="of-dock">
      <div class="of-log" aria-label="Chat"><div class="of-lines" role="log" aria-live="polite"></div></div>
      <form class="of-say"><input class="of-input" maxlength="280" placeholder="Say something… (Enter)" aria-label="Chat message" autocomplete="off"><button type="submit" class="ib" aria-label="Send" data-tip="Send">${icon('send')}</button></form>
      <div class="of-emotes" role="group" aria-label="Emotes">${EMOTES.map(([k,e,l],i)=>`<button type="button" data-emote="${k}" aria-label="${l} (${i+1})" data-tip="${l} · ${i+1}">${e}</button>`).join('')}</div>
    </div>
    <aside class="of-panel" hidden></aside><div class="of-menu" hidden role="menu"></div>`;
  root.tabIndex=-1;document.body.append(root);
  S={opts,root,lines:root.querySelector('.of-lines'),env:opts.env,stage:root.querySelector('.of-stage'),labels:root.querySelector('.of-labels'),panel:root.querySelector('.of-panel'),menu:root.querySelector('.of-menu'),
    keys:new Set(),people:new Map(),members:[],rooms:new Map(),live:new Map(),afFigures:[],clickables:[],labelList:[],answers:new Map(),
    me:null,meKey:'',pos:new THREE.Vector3(0,0,6),heading:0,az:0,target:null,follow:null,zoom:1.2,sentAt:0,moving:false,lastSent:'',chat:[],opener:document.activeElement};
  try{initScene()}catch(e){S.stage.innerHTML='<p class="of-fail">This browser could not start 3D graphics, so the office cannot open here.</p>';status('3D is not available')}
  root.addEventListener('click',onClick);
  root.querySelector('.of-say').addEventListener('submit',e=>{e.preventDefault();say()});
  root.querySelector('.of-switch')?.addEventListener('change',e=>{switchTo(e.target.value)});
  addEventListener('keydown',onKey,true);addEventListener('keyup',onKeyUp,true);addEventListener('blur',clearKeys);
  connect();
  root.focus({preventScroll:true});
}
export const officeOpen=()=>!!S;
export function closeOffice(){
  if(!S)return;const s=S;S=null;
  s.es?.close();cancelAnimationFrame(s.raf);s.resize?.disconnect();
  removeEventListener('keydown',onKey,true);removeEventListener('keyup',onKeyUp,true);removeEventListener('blur',clearKeys);
  try{s.renderer?.dispose();s.scene?.traverse(o=>{o.geometry?.dispose?.();for(const m of [].concat(o.material||[]))m.dispose?.()})}catch{}
  s.root.remove();s.opener?.focus?.({preventScroll:true});
}
function switchTo(env){if(!S||env===S.env)return;const opts={...S.opts,env};closeOffice();openOffice(opts)}
const status=t=>{const el=S?.root.querySelector('.of-status');if(el)el.textContent=t};

// ---------- the network ----------
const api=(path,body)=>fetch(`/api/office/${encodeURIComponent(S.env)}/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(Error(d.error||'Something went wrong'),{code:d.code,status:r.status});return d});
function connect(){
  const es=new EventSource(`/api/office/${encodeURIComponent(S.env)}/events`);S.es=es;let fails=0;
  const on=(type,f)=>es.addEventListener(type,e=>{if(S?.es!==es)return;try{f(JSON.parse(e.data))}catch(err){console.error('office',type,err)}});
  on('snapshot',d=>{fails=0;snapshot(d)});
  on('join',p=>upsertPerson(p));on('move',p=>upsertPerson(p));
  on('leave',({key})=>removePerson(key));
  on('say',line=>addLine(line));
  on('emote',({key,emote})=>showEmote(key,emote));
  on('agents',({member,agents})=>{S.live.set(member,agents);buildDesks(member);refreshPanel()});
  on('members',({members,agentflow})=>{S.members=members;S.snapAgentflow=agentflow;buildRooms();buildAgentflow();refreshPanel()});
  on('action',a=>{S.answers.set(a.agentId,{...a,state:'sent'});refreshPanel()});
  on('result',a=>{S.answers.set(a.agentId,{...a,state:'done'});refreshPanel();S.opts.toast?.(a.result?.message||'Done',a.result&&!a.result.ok)});
  es.onopen=()=>status('Live');
  es.onerror=()=>{if(S?.es!==es)return;fails++;status(es.readyState===EventSource.CLOSED||fails>5?'Could not reach the office. Close and try again.':'Reconnecting…')};
}
function snapshot(d){
  S.meKey=d.me.key;S.me=d.me;S.members=d.members;S.snapAgentflow=d.agentflow;S.live=new Map(Object.entries(d.live||{}));
  S.people.forEach((p,k)=>{if(k!==S.meKey)removePerson(k)});
  for(const a of d.actions||[])S.answers.set(a.agentId,{...a,state:a.result?'done':'sent'});
  buildRooms();buildAgentflow();
  if(!S.placed){S.placed=true;const r=S.rooms.get(S.meKey);if(r){S.pos.copy(r.door);S.heading=r.facing}S.az=Math.atan2(S.pos.x,S.pos.z)}
  upsertPerson({key:S.meKey,name:S.opts.me?.name||d.me.name,image:S.opts.me?.image||'',x:S.pos.x,z:S.pos.z,heading:S.heading,moving:false},true);
  for(const p of d.people)if(p.key!==S.meKey)upsertPerson(p);
  S.lines.innerHTML='';S.chat=[];for(const l of d.chat||[])addLine(l,{quiet:true});
  status(`Live · ${S.members.length} ${S.members.length===1?'room':'rooms'}`);sendPresence(true);
}
function sendPresence(force){
  const t=performance.now(),sig=[S.pos.x.toFixed(2),S.pos.z.toFixed(2),S.heading.toFixed(2),S.moving].join();
  if(!force&&(sig===S.lastSent||t-S.sentAt<SEND_MS))return;
  S.sentAt=t;S.lastSent=sig;api('presence',{x:+S.pos.x.toFixed(2),z:+S.pos.z.toFixed(2),heading:+S.heading.toFixed(2),moving:S.moving}).catch(()=>{});
}

// ---------- the scene ----------
const M={};
const mat=(c,o={})=>new THREE.MeshLambertMaterial({color:c,flatShading:true,...o});
function initScene(){
  const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;
  S.stage.prepend(renderer.domElement);renderer.domElement.className='of-canvas';
  const scene=new THREE.Scene();scene.background=new THREE.Color('#eef2ef');scene.fog=new THREE.Fog('#eef2ef',45,110);
  const camera=new THREE.PerspectiveCamera(45,1,0.1,200);
  scene.add(new THREE.HemisphereLight('#ffffff','#b9c4bf',2.2));
  const sun=new THREE.DirectionalLight('#ffffff',1.6);sun.position.set(12,30,18);scene.add(sun);
  const ground=new THREE.Mesh(new THREE.CircleGeometry(120,48),mat('#dfe6e2'));ground.rotation.x=-Math.PI/2;ground.name='ground';scene.add(ground);
  const rug=new THREE.Mesh(new THREE.CircleGeometry(10,32),mat('#cfe3d2'));rug.rotation.x=-Math.PI/2;rug.position.y=0.01;scene.add(rug);
  Object.assign(M,{
    box:new THREE.BoxGeometry(1,1,1),ico:new THREE.IcosahedronGeometry(1,0),ico1:new THREE.IcosahedronGeometry(1,1),oct:new THREE.OctahedronGeometry(1,0),
    cyl:new THREE.CylinderGeometry(1,1,1,7),cone:new THREE.ConeGeometry(1,1,6),torus:new THREE.TorusGeometry(0.62,0.12,5,14),disc:new THREE.CircleGeometry(1,16),
    wall:mat('#f9fbfa'),hit:new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false}),desk:mat('#b98d63'),screenOff:mat('#3b4542'),dark:mat('#1d2421'),white:mat('#ffffff'),shadow:new THREE.MeshBasicMaterial({color:'#000',transparent:true,opacity:.14,depthWrite:false}),
  });
  S.world=new THREE.Group();scene.add(S.world);
  Object.assign(S,{renderer,scene,camera,ground,ray:new THREE.Raycaster(),clock:new THREE.Clock()});
  const fit=()=>{const w=S.stage.clientWidth||innerWidth,h=S.stage.clientHeight||innerHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix()};
  S.resize=new ResizeObserver(fit);S.resize.observe(S.stage);fit();
  const cv=renderer.domElement;let down=null;
  cv.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY,t:performance.now()}});
  cv.addEventListener('pointerup',e=>{if(down&&Math.hypot(e.clientX-down.x,e.clientY-down.y)<8)pick(e);down=null});
  cv.addEventListener('wheel',e=>{e.preventDefault();zoomBy(Math.exp(e.deltaY*.0012))},{passive:false});
  cv.addEventListener('pointermove',e=>{const hit=hitAt(e);cv.style.cursor=hit?.kind?'pointer':'default'});
  const loop=()=>{if(!S)return;S.raf=requestAnimationFrame(loop);frame(Math.min(.05,S.clock.getDelta()),S.clock.elapsedTime)};loop();
}
const zoomBy=f=>{S.zoom=Math.max(.45,Math.min(2.6,S.zoom*f))};
const part=(geo,m,[x,y,z],[sx,sy,sz]=[1,1,1])=>{const o=new THREE.Mesh(geo,m);o.position.set(x,y,z);o.scale.set(sx,sy,sz);return o};
const shadow=r=>{const s=part(M.disc,M.shadow,[0,0.02,0],[r,r,r]);s.rotation.x=-Math.PI/2;return s};
function clear(group){S.world.remove(group);group.traverse(o=>{if(o.material&&o.userData.own)o.material.dispose()});const g=new Set();group.traverse(o=>g.add(o));S.clickables=S.clickables.filter(c=>!g.has(c));S.labelList=S.labelList.filter(l=>{if(g.has(l.obj)){l.el.remove();return false}return true})}
function label(obj,html,{y=1.6,cls='',near=0}={}){const el=document.createElement('div');el.className='of-label '+cls;el.innerHTML=html;S.labels.append(el);const l={obj,el,y,near};S.labelList.push(l);return l}

// ---------- rooms ----------
function layout(n){
  const R=Math.max(17,n*(ROOM_W+3)/(2*Math.PI)+6),out=[];
  for(let i=0;i<n;i++){const a=-Math.PI/2+i/n*Math.PI*2,c=new THREE.Vector3(Math.cos(a)*R,0,Math.sin(a)*R),facing=Math.atan2(-c.x,-c.z);out.push({c,facing})}
  return out;
}
function buildRooms(){
  for(const r of S.rooms.values())clear(r.group);S.rooms.clear();
  const list=[...S.members].sort((a,b)=>(b.owner-a.owner)||String(a.name).localeCompare(b.name));
  layout(list.length).forEach(({c,facing},i)=>{
    const m=list[i],[bg,fg]=memberColor(m.key),g=new THREE.Group();g.position.copy(c);g.rotation.y=facing;
    const floor=part(M.box,mat(bg),[0,0.03,0],[ROOM_W,0.06,ROOM_D]);floor.userData.own=true;g.add(floor);
    const wall=(x,z,w,d)=>g.add(part(M.box,M.wall,[x,0.55,z],[w,1.1,d]));
    wall(0,-ROOM_D/2,ROOM_W,0.2);wall(-ROOM_W/2,0,0.2,ROOM_D);wall(ROOM_W/2,0,0.2,ROOM_D);
    const side=(ROOM_W-3)/2;wall(-(3/2+side/2),ROOM_D/2,side,0.2);wall(3/2+side/2,ROOM_D/2,side,0.2);
    const stripe=part(M.box,mat(fg),[0,1.12,-ROOM_D/2],[ROOM_W,0.06,0.24]);stripe.userData.own=true;g.add(stripe);
    S.world.add(g);
    const sign=new THREE.Object3D();sign.position.set(3.4,0,ROOM_D/2);g.add(sign);
    label(sign,`<span class="of-room" style="--c:${fg}">${esc(m.name)}${m.me?' · your room':''}</span>`,{y:1.45,cls:'room'});
    const door=new THREE.Vector3(0,0,ROOM_D/2-1.6).applyAxisAngle(new THREE.Vector3(0,1,0),facing).add(c);
    S.rooms.set(m.key,{member:m,group:g,center:c,facing,door,desks:null});
    buildDesks(m.key);
  });
}
// A member's live agents at desks: up to 4 per row, rows towards the back wall.
function buildDesks(key){
  const room=S.rooms.get(key);if(!room)return;
  if(room.desks){clear(room.desks)}
  const g=new THREE.Group();g.position.copy(room.center);g.rotation.y=room.facing;room.desks=g;S.world.add(g);
  const agents=S.live.get(key)||[],cols=agents.length>8?4:3,sx=agents.length>8?2.6:3.2;
  if(!agents.length){const o=new THREE.Object3D();o.position.set(0,0,-1);g.add(o);label(o,'<span class="of-empty">No agents running</span>',{y:0.4,cls:'muted',near:22})}
  agents.slice(0,16).forEach((a,i)=>{
    const col=i%cols,row=Math.floor(i/cols),x=(col-(cols-1)/2)*sx,z=-ROOM_D/2+1.4+row*2.1;
    const d=new THREE.Group();d.position.set(x,0,z);g.add(d);
    d.add(part(M.box,M.desk,[0,0.72,0],[1.7,0.08,0.8]),part(M.box,M.desk,[0,0.36,-0.25],[1.5,0.7,0.12]));
    const scr=new THREE.MeshLambertMaterial({color:'#3b4542',emissive:'#000000',flatShading:true});
    const screen=part(M.box,scr,[0,1.08,-0.25],[0.8,0.5,0.06]);screen.userData.own=true;d.add(screen);
    const mascot=makeMascot(a.vendor,1);mascot.position.set(0,0,0.85);mascot.rotation.y=Math.PI;d.add(mascot);
    mascot.userData={kind:'agent',member:key,id:a.id,base:0,screen:scr,status:a.status,mats:mascot.userData.mats};
    mascot.add(shadow(0.45));
    mascot.userData.kids=(a.children||[]).slice(0,8).map((c,j,all)=>{const k=makeMascot(c.vendor,.32);k.userData.orbit={r:0.95,a:j/all.length*Math.PI*2,y:1.25+((j%2)*.15)};d.add(k);return k});
    mascot.add(part(M.box,M.hit,[0,0.9,0],[1.1,1.9,1.1]));S.clickables.push(mascot);
    const name=a.private?'Private project':a.title||VENDOR[a.vendor]?.name||'Agent',at=`data-agent="${esc(a.id)}" data-member="${esc(key)}"`;
    label(mascot,`<button type="button" class="of-tag${a.private?' priv':''}" ${at}>${esc(name)}</button>`,{y:1.75,cls:'agent click',near:16});
    if(a.status==='waiting')label(mascot,`<button type="button" class="of-bang" ${at} aria-label="Waiting: ${esc(name)}">!</button>`,{y:2.25,cls:'bang click'});
    setLook(mascot,a.status);
  });
}
function setLook(m,st){
  const u=m.userData;for(const x of u.mats||[]){x.emissive.set(st==='waiting'?'#ffb020':'#000000');x.emissiveIntensity=st==='waiting'?0.35:0;x.opacity=st==='idle'?0.5:1;x.transparent=st==='idle'}
  u.screen?.emissive.set(st==='running'?'#5fd38a':st==='waiting'?'#ffb020':'#000000');
}
// Low-poly vendor mascots: Claude a warm round critter with a sunburst, Codex a dark knot-ringed gem,
// Gemini a blue spark, anything else a green box robot.
function makeMascot(vendor,s){
  const v=VENDOR[vendor]?vendor:'other',g=new THREE.Group(),body=new THREE.MeshLambertMaterial({color:VENDOR[v].color,flatShading:true}),mats=[body];
  if(v==='claude'){
    g.add(part(M.ico1,body,[0,0.62,0],[0.42,0.4,0.38]));
    const ray=new THREE.MeshLambertMaterial({color:'#f0a07e',flatShading:true});mats.push(ray);
    for(let i=0;i<6;i++){const c=part(M.cone,ray,[Math.cos(i/6*Math.PI*2)*0.16,1.06,Math.sin(i/6*Math.PI*2)*0.16],[0.06,0.22,0.06]);c.rotation.z=-Math.cos(i/6*Math.PI*2)*.5;c.rotation.x=Math.sin(i/6*Math.PI*2)*.5;g.add(c)}
    g.add(part(M.box,body,[-0.2,0.18,0],[0.1,0.3,0.1]),part(M.box,body,[0.2,0.18,0],[0.1,0.3,0.1]));
  }else if(v==='codex'){
    g.add(part(M.oct,body,[0,0.66,0],[0.36,0.46,0.36]));
    const ring=new THREE.MeshLambertMaterial({color:'#e9ece9',flatShading:true});mats.push(ring);
    const t=part(M.torus,ring,[0,0.66,0],[0.72,0.72,0.72]);t.rotation.x=Math.PI/2.4;g.add(t);
    g.add(part(M.box,body,[0,0.12,0],[0.3,0.24,0.2]));
  }else if(v==='gemini'){
    const glow=new THREE.MeshLambertMaterial({color:'#8fb0ff',flatShading:true});mats.push(glow);
    g.add(part(M.oct,body,[0,0.68,0],[0.2,0.52,0.2]),part(M.oct,glow,[0,0.68,0],[0.46,0.2,0.2]),part(M.cyl,body,[0,0.12,0],[0.16,0.24,0.16]));
  }else{
    g.add(part(M.box,body,[0,0.44,0],[0.5,0.5,0.4]),part(M.box,body,[0,0.86,0],[0.4,0.3,0.34]),part(M.cyl,M.dark,[0,1.1,0],[0.025,0.18,0.025]),part(M.ico,M.white,[0,1.2,0],[0.05,0.05,0.05]));
  }
  g.add(part(M.ico,M.dark,[-0.11,0.72,0.33*(v==='claude'?1.08:1)],[0.05,0.06,0.04]),part(M.ico,M.dark,[0.11,0.72,0.33*(v==='claude'?1.08:1)],[0.05,0.06,0.04]));
  g.scale.setScalar(s);g.userData.mats=mats;for(const m of mats)m.userData={};g.traverse(o=>{if(o.material&&mats.includes(o.material))o.userData.own=true});
  return g;
}

// ---------- AgentFlow agents in the common area ----------
function afAgents(){return S.env===S.opts.current&&S.opts.agentflow?S.opts.agentflow():S.snapAgentflow||[]}
function buildAgentflow(){
  if(S.afGroup)clear(S.afGroup);const g=new THREE.Group();S.afGroup=g;S.world.add(g);S.afFigures=[];
  const list=afAgents(),byId=new Map(list.map(a=>[a.id,a])),depth=a=>{let d=0,x=a,seen=new Set();while(x?.reportsTo&&byId.has(x.reportsTo)&&!seen.has(x.id)){seen.add(x.id);x=byId.get(x.reportsTo);d++}return d};
  const rows=new Map();for(const a of list){const d=Math.min(4,depth(a));(rows.get(d)||rows.set(d,[]).get(d)).push(a)}
  const near=list.length>24?11:30;
  [...rows.keys()].sort().forEach(d=>{
    const row=rows.get(d),per=Math.min(row.length,8);
    row.slice(0,40).forEach((a,i)=>{
      const line=Math.floor(i/per),n=Math.min(per,row.length-line*per),x=(i%per-(n-1)/2)*2.1,z=-6+d*3.1+line*1.6;
      const f=makeFigure(a);f.position.set(x,0,z);f.userData={kind:'af',id:a.id};f.add(part(M.box,M.hit,[0,0.8,0],[1,1.6,1]));g.add(f);S.clickables.push(f);S.afFigures.push(f);
      label(f,`<button type="button" class="of-tag af" data-af-id="${esc(a.id)}">${esc(a.name)}</button>`,{y:a.kind==='team'?0.9:1.85,cls:'af click',near});
    });
  });
}
function makeFigure(a){
  const g=new THREE.Group(),dim=a.status==='retired'||a.status==='paused',c=a.kind==='human'?'#8a6f5c':a.kind==='team'?'#88a374':a.kind==='automation'?'#7f8c88':'#3d8f66';
  const m=new THREE.MeshLambertMaterial({color:c,flatShading:true,transparent:dim,opacity:dim?.55:1});
  if(a.kind==='team'){g.add(part(M.cyl,m,[0,0.2,0],[0.9,0.4,0.9]))}
  else if(a.kind==='automation'){g.add(part(M.cyl,m,[0,0.5,0],[0.32,1,0.32]));const t=part(M.torus,m,[0,1.15,0],[0.5,0.5,0.5]);t.rotation.x=Math.PI/2;g.add(t)}
  else if(a.kind==='human'){g.add(part(M.cyl,m,[0,0.55,0],[0.28,0.9,0.24]),part(M.ico,M.white,[0,1.25,0],[0.24,0.26,0.24]))}
  else{g.add(part(M.box,m,[0,0.5,0],[0.5,0.7,0.36]),part(M.box,m,[0,1.12,0],[0.44,0.36,0.36]),part(M.ico,M.white,[-0.1,1.14,0.19],[0.05,0.05,0.03]),part(M.ico,M.white,[0.1,1.14,0.19],[0.05,0.05,0.03]))}
  m.userData={};g.traverse(o=>{if(o.material===m)o.userData.own=true});g.add(shadow(0.5));
  return g;
}

// ---------- people ----------
function makeAvatar(key){
  const [bg,fg]=memberColor(key),g=new THREE.Group(),body=new THREE.MeshLambertMaterial({color:fg,flatShading:true}),skin=new THREE.MeshLambertMaterial({color:bg,flatShading:true});
  const legs=part(M.cyl,M.dark,[0,0.3,0],[0.22,0.6,0.18]),torso=part(M.cyl,body,[0,0.92,0],[0.32,0.7,0.26]),head=part(M.ico,skin,[0,1.52,0],[0.27,0.29,0.27]);
  g.add(legs,torso,head,part(M.box,M.dark,[0,1.55,0.24],[0.18,0.05,0.04]),shadow(0.45));
  for(const o of [torso,head])o.userData.own=true;g.userData.parts={torso,head};
  return g;
}
function upsertPerson(p,self=false){
  if(!S)return;let a=S.people.get(p.key);
  if(!a){
    const obj=makeAvatar(p.key);obj.position.set(p.x??0,0,p.z??0);obj.rotation.y=p.heading||0;obj.userData={kind:'person',key:p.key,parts:obj.userData.parts};S.world.add(obj);
    if(!self){obj.add(part(M.box,M.hit,[0,1,0],[0.9,2,0.9]));S.clickables.push(obj)}
    const [bg,fg]=memberColor(p.key),badge=p.image&&/^(https:|data:image\/)/.test(p.image)?`<img src="${esc(p.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`:'';
    const tag=label(obj,`<span class="of-name${self?' me':''}" style="--bg:${bg};--fg:${fg}"><i>${esc(initials(p.name))}${badge}</i>${esc(p.name)}</span>`,{y:2.05,cls:'person'});
    a={key:p.key,name:p.name,obj,tag,target:new THREE.Vector3(p.x??0,0,p.z??0),heading:p.heading||0,moving:!!p.moving,self};S.people.set(p.key,a);
  }
  if(!self&&Number.isFinite(p.x)){a.target.set(p.x,0,p.z);a.heading=p.heading||0;a.moving=!!p.moving}
  if(p.name)a.name=p.name;
  return a;
}
function removePerson(key){const a=S?.people.get(key);if(!a)return;clear(a.obj);S.people.delete(key);if(S.follow===key)S.follow=null;closeMenu()}
const nameOf=key=>S.people.get(key)?.name||S.members.find(m=>m.key===key)?.name||'Someone';

// ---------- chat and emotes ----------
function addLine(l,{quiet=false}={}){
  const el=document.createElement('div');el.className='of-line'+(l.key===S.meKey?' mine':'');el.innerHTML=`<b>${esc(l.name)}</b> ${esc(l.text)}`;
  S.lines.append(el);while(S.lines.children.length>50)S.lines.firstChild.remove();S.lines.scrollTop=S.lines.scrollHeight;
  if(quiet)return;
  const p=S.people.get(l.key);if(!p)return;
  if(p.obj.position.distanceTo(S.pos)>SAY_RADIUS&&l.key!==S.meKey)return; // too far away to hear: the log only
  p.bubble?.el.remove();S.labelList=S.labelList.filter(x=>x!==p.bubble);
  const b=label(p.obj,`<span class="of-bubble">${esc(l.text)}</span>`,{y:2.6,cls:'bubble'});p.bubble=b;
  setTimeout(()=>{b.el.remove();if(S)S.labelList=S.labelList.filter(x=>x!==b);if(p.bubble===b)p.bubble=null},Math.min(12000,3500+l.text.length*60));
}
function say(){
  const i=S.root.querySelector('.of-input'),t=i.value.trim();if(!t)return;
  api('say',{text:t}).then(()=>{i.value=''}).catch(e=>S.opts.toast?.(e.message,true));
}
function emote(k){api('emote',{emote:k}).catch(e=>S.opts.toast?.(e.message,true))}
function showEmote(key,k){
  const p=S.people.get(key),e=EMOTES.find(x=>x[0]===k);if(!p||!e)return;
  const l=label(p.obj,`<span class="of-emote">${e[1]}</span>`,{y:2.5,cls:'emote'});p.hop=performance.now();
  setTimeout(()=>{l.el.remove();if(S)S.labelList=S.labelList.filter(x=>x!==l)},2400);
}

// ---------- clicks, menus and the side panel ----------
function hitAt(e){
  if(!S.camera)return null;const r=S.renderer.domElement.getBoundingClientRect();
  S.ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),S.camera);
  for(const h of S.ray.intersectObjects(S.clickables,true)){let o=h.object;while(o&&!o.userData?.kind)o=o.parent;if(o)return {kind:o.userData.kind,obj:o,point:h.point}}
  const g=S.ray.intersectObject(S.ground)[0];return g?{kind:'',point:g.point}:null;
}
function pick(e){
  const hit=hitAt(e);closeMenu();if(!hit)return;
  if(hit.kind==='agent'){showAgent(hit.obj.userData.member,hit.obj.userData.id);return}
  if(hit.kind==='af'){showAf(hit.obj.userData.id);return}
  if(hit.kind==='person'){openMenu(hit.obj.userData.key,e);return}
  S.follow=null;S.target=new THREE.Vector3(hit.point.x,0,hit.point.z);
}
function openMenu(key,e){
  const r=S.root.getBoundingClientRect();S.menu.hidden=false;S.menu.dataset.key=key;
  S.menu.innerHTML=`<div class="of-mh">${esc(nameOf(key))}</div><button type="button" role="menuitem" data-of="wave">👋 Wave</button><button type="button" role="menuitem" data-of="follow">${icon('arrowR',13)}${S.follow===key?'Stop following':'Follow'}</button><button type="button" role="menuitem" data-of="message">${icon('send',13)}Message</button>`;
  S.menu.style.left=Math.min(e.clientX-r.left,r.width-180)+'px';S.menu.style.top=Math.min(e.clientY-r.top,r.height-150)+'px';
  S.menu.querySelector('button').focus({preventScroll:true});
}
function closeMenu(){if(S&&!S.menu.hidden){S.menu.hidden=true;return true}return false}
function onClick(e){
  const em=e.target.closest('[data-emote]');if(em){emote(em.dataset.emote);return}
  const ag=e.target.closest('.of-labels [data-agent]');if(ag){showAgent(ag.dataset.member,ag.dataset.agent);return}
  const fa=e.target.closest('.of-labels [data-af-id]');if(fa){showAf(fa.dataset.afId);return}
  const b=e.target.closest('[data-of]');if(!b)return;
  const key=S.menu.dataset.key;
  ({close:closeOffice,zoomIn:()=>zoomBy(1/1.2),zoomOut:()=>zoomBy(1.2),closePanel:()=>{S.panel.hidden=true;S.panelFor=null},
    wave(){emote('wave');closeMenu()},
    follow(){S.follow=S.follow===key?null:key;S.target=null;closeMenu()},
    message(){closeMenu();const i=S.root.querySelector('.of-input');i.value=`@${nameOf(key)} `+i.value.replace(/^@\S+\s/,'');i.focus()},
    allow:()=>decide('allow'),deny:()=>decide('deny'),
  })[b.dataset.of]?.();
}
function agentOf(member,id){return (S.live.get(member)||[]).find(a=>a.id===id)}
function showAgent(member,id){S.panelFor={type:'agent',member,id};refreshPanel()}
function showAf(id){S.panelFor={type:'af',id};refreshPanel()}
const row=(k,v)=>v?`<div class="of-row"><span>${k}</span><b>${esc(v)}</b></div>`:'';
function refreshPanel(){
  const p=S?.panelFor;if(!p)return;
  let html='';
  if(p.type==='af'){
    const a=afAgents().find(x=>x.id===p.id);if(!a){S.panel.hidden=true;return}
    const here=S.env===S.opts.current&&S.opts.focusAgent;
    html=`<div class="of-ph">${icon(a.kind==='human'?'user':a.kind==='team'?'users':a.kind==='automation'?'gear':'bot',16)}<b>${esc(a.name)}</b><span class="sp"></span><button type="button" class="ib" data-of="closePanel" aria-label="Close">${icon('x')}</button></div>
      <div class="of-pb">${row('Role',a.title)}${row('Kind',a.kind)}${row('Status',a.status)}<p class="of-note">An AgentFlow ${a.kind==='human'?'person':a.kind} of this environment.</p>
      ${here?`<button type="button" class="txt" data-of="openAfAgent" data-id="${esc(a.id)}">${icon('external',13)}Open in AgentFlow</button>`:''}</div>`;
  }else{
    const a=agentOf(p.member,p.id),owner=S.members.find(m=>m.key===p.member);
    if(!a){html=`<div class="of-ph"><b>Agent</b><span class="sp"></span><button type="button" class="ib" data-of="closePanel" aria-label="Close">${icon('x')}</button></div><div class="of-pb"><p class="of-note">It stopped reporting.</p></div>`}
    else{
      const v=VENDOR[a.vendor]||VENDOR.other,ans=S.answers.get(a.id);
      const head=`<div class="of-ph"><span class="of-dot" style="background:${v.color}"></span><b>${esc(a.private?'Private project':a.title||v.name)}</b><span class="sp"></span><button type="button" class="ib" data-of="closePanel" aria-label="Close">${icon('x')}</button></div>`;
      if(a.private)html=head+`<div class="of-pb">${row('Agent',v.name)}${row('Status',STATUS[a.status])}${row('Belongs to',owner?.name)}${a.children?.length?row('Subagents',String(a.children.length)):''}
        <p class="of-note">Its details are private: it works in a repo outside the projects you can see here.</p></div>`;
      else{
        let prompt='';
        if(a.pending){
          const can=a.mine&&a.pending.can?.length;
          prompt=`<div class="of-prompt"><div class="of-pk">${a.pending.kind==='question'?'Question':'Permission prompt'}</div><pre>${esc(a.pending.summary||'')}</pre>
            ${can&&ans?.requestId!==a.pending.requestId?`<div class="of-btns">${a.pending.can.includes('allow')?`<button type="button" class="txt primary" data-of="allow">${icon('check',13)}Allow</button>`:''}${a.pending.can.includes('deny')?`<button type="button" class="txt" data-of="deny">${icon('ban',13)}Deny</button>`:''}</div>`:''}
            ${!can?`<p class="of-note">${a.mine?'Answer it where it runs.':`Waiting on ${esc(owner?.name||'its owner')}.`}</p>`:''}</div>`;
        }
        const res=ans&&(!a.pending||ans.requestId===a.pending?.requestId||ans.state==='done')?`<p class="of-res ${ans.state==='done'?(ans.result?.ok?'ok':'bad'):''}">${ans.state==='done'?esc(ans.result?.message||'Done'):`${ans.decision==='allow'?'Allow':'Deny'} sent. Waiting for ${esc(a.host||'the reporter')}…`}</p>`:'';
        html=head+`<div class="of-pb">${row('Status',STATUS[a.status])}${row('Model',a.model?`${v.name} · ${a.model}`:v.name)}${row('Where',a.hostLabel||a.host)}${row('Repo',a.repo?.slug||a.repo?.name)}${row('Project',(a.projects||[]).join(', '))}
          ${row('Doing',a.activity)}${a.children?.length?row('Subagents',`${a.children.length}: ${a.children.map(c=>c.title||VENDOR[c.vendor]?.name).join(', ')}`):''}${row('Belongs to',a.mine?'You':owner?.name)}${prompt}${res}</div>`;
      }
    }
  }
  S.panel.innerHTML=html;S.panel.hidden=false;
  S.panel.querySelector('[data-of="openAfAgent"]')?.addEventListener('click',e=>{const id=e.currentTarget.dataset.id,f=S.opts.focusAgent;closeOffice();f?.(id)});
}
function decide(decision){
  const p=S.panelFor,a=p&&agentOf(p.member,p.id);if(!a?.pending||!a.mine)return;
  S.answers.set(a.id,{agentId:a.id,requestId:a.pending.requestId,decision,state:'sent'});refreshPanel();
  api('answer',{source:a.source,agentId:a.id,requestId:a.pending.requestId,decision}).catch(e=>{S.answers.delete(a.id);refreshPanel();S.opts.toast?.(e.message,true)});
}

// ---------- keys ----------
const MOVE={w:[0,-1],arrowup:[0,-1],s:[0,1],arrowdown:[0,1],a:[-1,0],arrowleft:[-1,0],d:[1,0],arrowright:[1,0]};
function onKey(e){
  if(!S)return;
  const typing=e.target.closest?.('input,textarea,select');
  e.stopPropagation(); // the app underneath does not see keys while the office is open
  if(typing){if(e.key==='Escape'){e.preventDefault();e.target.blur()}return}
  if(e.key==='Escape'){e.preventDefault();if(closeMenu())return;if(!S.panel.hidden){S.panel.hidden=true;S.panelFor=null;return}closeOffice();return}
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  const k=e.key.toLowerCase();
  if(MOVE[k]&&!e.target.closest?.('[role=menu]')){e.preventDefault();S.keys.add(k);S.target=null;S.follow=null;return}
  if(MOVE[k]&&e.target.closest?.('[role=menu]')&&(k==='arrowup'||k==='arrowdown')){e.preventDefault();const bs=[...S.menu.querySelectorAll('button')],i=bs.indexOf(document.activeElement);bs[(i+(k==='arrowup'?-1:1)+bs.length)%bs.length]?.focus();return}
  if(/^[1-4]$/.test(e.key)){e.preventDefault();emote(EMOTES[+e.key-1][0]);return}
  if(e.key==='Enter'&&e.target===document.body||e.key==='t'){e.preventDefault();S.root.querySelector('.of-input').focus()}
}
function onKeyUp(e){if(!S)return;S.keys.delete(e.key.toLowerCase());e.stopPropagation()}
function clearKeys(){S?.keys.clear()}

// ---------- each frame ----------
const v3=new THREE.Vector3();
function frame(dt,t){
  // Me: keys, then a click target, then following someone.
  // The camera sits outside me, looking towards the middle of the office; keys move relative to it.
  if(Math.hypot(S.pos.x,S.pos.z)>3)S.az=turn(S.az,Math.atan2(S.pos.x,S.pos.z),dt*0.16);
  const fx=-Math.sin(S.az),fz=-Math.cos(S.az);
  let dx=0,dz=0;for(const k of S.keys){const [r,f]=MOVE[k];dx+=r*-fz+-f*fx;dz+=r*fx+-f*fz}
  if(!dx&&!dz&&S.follow){const f=S.people.get(S.follow);if(f){v3.copy(f.obj.position).sub(S.pos);const d=v3.length();if(d>1.8){dx=v3.x/d;dz=v3.z/d}}}
  if(!dx&&!dz&&S.target){v3.copy(S.target).sub(S.pos);const d=v3.length();if(d<0.15)S.target=null;else{dx=v3.x/d;dz=v3.z/d}}
  const len=Math.hypot(dx,dz),was=S.moving;S.moving=len>0;
  if(S.moving){S.pos.x+=dx/len*SPEED*dt;S.pos.z+=dz/len*SPEED*dt;const lim=110;S.pos.x=Math.max(-lim,Math.min(lim,S.pos.x));S.pos.z=Math.max(-lim,Math.min(lim,S.pos.z));S.heading=Math.atan2(dx,dz)}
  if(S.meKey&&(S.moving||was))sendPresence(was&&!S.moving);
  for(const p of S.people.values()){
    const o=p.obj;
    if(p.self){o.position.copy(S.pos);o.rotation.y=turn(o.rotation.y,S.heading,dt)}
    else{o.position.lerp(p.target,Math.min(1,dt*9));o.rotation.y=turn(o.rotation.y,p.heading,dt)}
    const moving=p.self?S.moving:p.moving||o.position.distanceTo(p.target)>0.05,hop=p.hop&&performance.now()-p.hop<700?Math.sin((performance.now()-p.hop)/700*Math.PI)*0.45:0;
    o.position.y=hop+(moving?Math.abs(Math.sin(t*11))*0.08:0);
  }
  // Agents: running bob and type, waiting hop and glow, idle still; subagents circle.
  for(const c of S.clickables){
    const u=c.userData;if(u.kind!=='agent')continue;
    if(u.status==='running'){c.position.y=Math.abs(Math.sin(t*7+c.id))*0.06;c.rotation.z=Math.sin(t*14+c.id)*0.04}
    else if(u.status==='waiting'){c.position.y=Math.abs(Math.sin(t*3.2+c.id))*0.38;for(const m of u.mats||[])m.emissiveIntensity=0.25+Math.abs(Math.sin(t*3.2))*0.35}
    for(const k of u.kids||[]){const o=k.userData.orbit;o.a+=dt*(u.status==='idle'?0.3:1.6);k.position.set(c.position.x+Math.cos(o.a)*o.r,o.y+Math.sin(t*5+o.a)*0.06,c.position.z+Math.sin(o.a)*o.r);k.rotation.y=-o.a}
  }
  // Camera: behind and above me, eased.
  const cam=S.camera,goal=v3.set(S.pos.x-fx*13*S.zoom,14*S.zoom,S.pos.z-fz*13*S.zoom);cam.position.lerp(goal,Math.min(1,dt*5));cam.lookAt(S.pos.x+fx*2,0.6,S.pos.z+fz*2);
  S.renderer.render(S.scene,cam);
  placeLabels();
}
const turn=(a,b,dt)=>{let d=((b-a+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI;return a+d*Math.min(1,dt*10)};
function placeLabels(){
  const w=S.stage.clientWidth,h=S.stage.clientHeight,p=new THREE.Vector3();
  for(const l of S.labelList){
    l.obj.getWorldPosition(p);const far=l.near&&p.distanceTo(S.pos)>l.near;p.y+=l.y;p.project(S.camera);
    const off=far||p.z>1||p.x<-1.2||p.x>1.2||p.y<-1.2||p.y>1.2;
    if(off){if(!l.hidden){l.el.style.display='none';l.hidden=true}continue}
    if(l.hidden){l.el.style.display='';l.hidden=false}
    l.el.style.transform=`translate(${((p.x+1)/2*w).toFixed(1)}px,${((1-p.y)/2*h).toFixed(1)}px) translate(-50%,-100%)`;
  }
}
