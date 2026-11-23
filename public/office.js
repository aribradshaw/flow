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
import {angleDelta,bindOfficePointer,createOfficeCamera,createOfficeCharacter,createOfficeInput,officeBox,WALK_SPEED,RUN_SPEED} from './office-controls.js';
import {createOfficeBoards,createOfficeCardDrag} from './office-boards.js';
import {officeMemberRefs} from './office-boards-core.js';
import {store} from './store.js';
import {openBridgeDialog} from './office-connect.js';
import {makeHuman,animateHuman,lookFor,orgField,orgLayout,disposeFigures} from './office-figures.js';
import {createMascot,mascotKind,pulseMascots,disposeMascots,VENDOR_COLOR} from './office-mascots.js';
import {createActivity,hudHtml,bindHud,shownKind} from './office-activity.js';
import {seatsByAgent,isSeated,seatTag,deskPanel} from './office-seats.js';

const VENDOR={claude:{name:'Claude',color:'#d97857'},codex:{name:'Codex',color:'#2e80ed'},gemini:{name:'Gemini',color:'#5b7cf5'},deepseek:{name:'DeepSeek',color:'#4d6bff'},grok:{name:'Grok',color:'#17171a'},other:{name:'Agent',color:'#5f9e6e'}};
const STATUS={running:'Running',waiting:'Waiting on its person',idle:'Idle'};
const EMOTES=[['wave','👋','Wave'],['thumbs','👍','Thumbs up'],['clap','👏','Clap'],['heart','❤️','Heart']];
const SAY_RADIUS=14,SEND_MS=75,ROOM_W=12,ROOM_D=9;
let S=null; // the open office

// ---------- opening and closing ----------
// opts: {env, current (the app's environment), offices:[{id,name}], agentflow():[] (the local store's agents, for current),
//        focusAgent(id) (opens an AgentFlow agent; current env only), me:{name,image}, toast(msg,bad),
//        focus (optional: a live agent's id, or an AgentFlow agent's id or name, to show once it arrives), onClose()}
export function openOffice(opts){
  if(S)return;
  const root=document.createElement('div');root.className='of';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','3D office');
  root.innerHTML=`<div class="of-top">
      <span class="of-title">${icon('cube3d',16)}<b>3D office</b></span>
      ${opts.offices.length>1?`<select class="of-switch" aria-label="Office">${opts.offices.map(o=>`<option value="${esc(o.id)}"${o.id===opts.env?' selected':''}>${esc(o.name)}</option>`).join('')}</select>`:`<span class="of-env">${esc(opts.offices[0]?.name||'')}</span>`}
      <span class="of-status" role="status" aria-live="polite">Connecting…</span><span class="sp"></span>
      <button type="button" class="txt of-connect-link" data-of="connect" hidden>Connect your agents</button>
      <span class="of-keys">WASD · Shift sprint · Space jump · middle/right drag</span>
      ${hudHtml(icon)}<button type="button" class="ib" data-of="zoomOut" aria-label="Zoom out" data-tip="Zoom out">${icon('minus')}</button><button type="button" class="ib" data-of="zoomIn" aria-label="Zoom in" data-tip="Zoom in">${icon('plus')}</button>
      <button type="button" class="ib" data-of="overview" aria-label="Office overview" aria-pressed="false" data-tip="Overview (O)">${icon('cube3d')}</button>
      <button type="button" class="ib" data-of="controls" aria-label="Office controls" aria-expanded="false" data-tip="Office controls">?</button>
      <button type="button" class="ib of-close" data-of="close" aria-label="Close the 3D office" data-tip="Close (Esc)">${icon('x')}</button></div>
    <div class="of-stage"><div class="of-labels" aria-hidden="true"></div>
      <aside class="of-connect-callout" hidden><strong>Your agents aren’t connected yet</strong>
        <button type="button" class="txt primary" data-of="connect">Connect your agents</button>
      </aside>
    </div>
    <div class="of-dock">
      <div class="of-log" aria-label="Chat"><div class="of-lines" role="log" aria-live="polite"></div></div>
      <form class="of-say"><input class="of-input" maxlength="280" placeholder="Say something… (Enter)" aria-label="Chat message" autocomplete="off"><button type="submit" class="ib" aria-label="Send" data-tip="Send">${icon('send')}</button></form>
      <div class="of-emotes" role="group" aria-label="Emotes">${EMOTES.map(([k,e,l],i)=>`<button type="button" data-emote="${k}" aria-label="${l} (${i+1})" data-tip="${l} · ${i+1}">${e}</button>`).join('')}</div>
    </div>
    <aside class="of-controls" aria-label="Office controls" hidden>
      <b>Office controls</b>
      <dl><dt>Walk</dt><dd>WASD, arrows, or click/tap a destination</dd>
        <dt>Sprint</dt><dd>Hold Shift or double-tap a direction</dd>
        <dt>Jump</dt><dd>Space. Hold for height, press again to flip.</dd>
        <dt>Orbit</dt><dd>Middle/right drag, Alt+drag, Q / E, or one-finger drag</dd>
        <dt>Zoom</dt><dd>Scroll, + / − buttons, or pinch</dd>
        <dt>Pan</dt><dd>Two-finger drag</dd>
        <dt>Recenter</dt><dd>Middle-click or F</dd>
        <dt>Overview</dt><dd>O or the overview button</dd>
        <dt>Gamepad</dt><dd>Left stick to move, right stick to orbit, A to jump, B/X to sprint</dd>
        <dt>DevOps cards</dt><dd>Walk up to a whiteboard and click a card. Left-drag to a person, room, agent or column. Hold Shift to replace agent delegates.</dd>
        <dt>Chat &amp; emotes</dt><dd>T to chat, 1–4 to react</dd></dl>
      <label><input type="checkbox" class="of-auto-camera" checked> Recenter while moving</label>
    </aside>
    <aside class="of-panel" hidden></aside><div class="of-menu" hidden role="menu"></div>`;
  root.tabIndex=-1;document.body.append(root);
  S={opts,root,lines:root.querySelector('.of-lines'),env:opts.env,stage:root.querySelector('.of-stage'),labels:root.querySelector('.of-labels'),panel:root.querySelector('.of-panel'),menu:root.querySelector('.of-menu'),
    input:createOfficeInput(),controller:createOfficeCharacter(),walls:[],colliders:[],overviewRadius:12,people:new Map(),members:[],rooms:new Map(),live:new Map(),afFigures:[],clickables:[],labelList:[],answers:new Map(),
    me:null,meKey:'',pos:new THREE.Vector3(0,0,6),target:null,follow:null,sentAt:0,lastSent:'',chat:[],opener:document.activeElement};
  S.controller.reset(S.pos,0);
  try{initScene()}catch(e){S.stage.insertAdjacentHTML('afterbegin','<p class="of-fail">3D graphics are unavailable in this browser.</p>');status('3D is not available')}
  root.addEventListener('click',onClick);
  bindHud(root,{icon,toast:opts.toast});
  root.addEventListener('focusin',e=>{if(isTyping(e.target))clearKeys()});
  root.querySelector('.of-auto-camera').addEventListener('change',e=>S.rig?.setAuto(e.target.checked));
  root.querySelector('.of-say').addEventListener('submit',e=>{e.preventDefault();say()});
  root.querySelector('.of-switch')?.addEventListener('change',e=>{switchTo(e.target.value)});
  addEventListener('keydown',onKey,true);addEventListener('keyup',onKeyUp,true);addEventListener('blur',clearKeys);
  connect();S.watch=setInterval(watch,1000);
  root.focus({preventScroll:true});
}
export const officeOpen=()=>!!S;
export function closeOffice(){
  if(!S)return;const s=S;S=null;
  s.es?.close();clearTimeout(s.retry);clearInterval(s.watch);cancelAnimationFrame(s.raf);s.resize?.disconnect();
  removeEventListener('keydown',onKey,true);removeEventListener('keyup',onKeyUp,true);removeEventListener('blur',clearKeys);
  s.pointer?.cancelGrab();s.cardDrag?.dispose();s.boards?.dispose();
  try{s.org?.dispose();disposeFigures();disposeMascots();s.renderer?.dispose();s.scene?.traverse(o=>{o.geometry?.dispose?.();for(const m of [].concat(o.material||[]))m.dispose?.()})}catch{}
  s.bridge?.dialog.close();s.root.remove();s.opener?.focus?.({preventScroll:true});
  if(!s.switching)try{s.opts.onClose?.()}catch{}
}
function switchTo(env){if(!S||env===S.env)return;S.opts.remember?.(env);const opts={...S.opts,env,focus:''};S.switching=true;closeOffice();openOffice(opts)}
// opts.focus (#office/<id>): show that agent's panel as soon as it is in the office (live agents can
// arrive a few seconds after the snapshot); given up after 20 seconds.
function focusPending(){
  const id=S?.opts.focus;if(!id||S.focused)return;
  if(!S.focusUntil)S.focusUntil=Date.now()+20e3;
  if(Date.now()>S.focusUntil){S.focused=true;return}
  for(const [member,list] of S.live)if(list.some(a=>a.id===id)){S.focused=true;showAgent(member,id);return}
  const f=afAgents().find(a=>a.id===id||String(a.name||'').toLowerCase()===id.toLowerCase());
  if(f){S.focused=true;showAf(f.id)}
}
const status=t=>{const el=S?.root.querySelector('.of-status');if(el)el.textContent=t};

// ---------- the network ----------
const api=(path,body)=>fetch(`/api/office/${encodeURIComponent(S.env)}/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(Error(d.error||'Something went wrong'),{code:d.code,status:r.status});return d});
// EventSource retries by itself after a dropped connection, but not after an error answer (a deploy
// restarting the server): then we open a new one, backing off up to 10 s. "Reconnecting…" shows only
// after 4 s without the stream; a stream that has said nothing for 40 s (heartbeats come every 15 s) is replaced.
function connect(){
  S.es?.close();clearTimeout(S.retry);
  const es=new EventSource(`/api/office/${encodeURIComponent(S.env)}/events`);S.es=es;S.heard=Date.now();
  const on=(type,f)=>es.addEventListener(type,e=>{if(S?.es!==es)return;S.heard=Date.now();try{f(JSON.parse(e.data))}catch(err){console.error('office',type,err)}});
  on('snapshot',d=>{S.tries=0;S.down=0;updateSources(d.yourSources||[]);snapshot(d)});
  on('yourSources',updateSources);
  on('hb',()=>{});
  on('join',p=>{if(!S.world)return;upsertPerson(p);presenceChanged(p.key)});on('move',p=>{if(S.world)upsertPerson(p)});
  on('leave',({key,at})=>{removePerson(key);const m=S.members.find(x=>x.key===key);if(m&&at)m.lastSeen=at;if(S.world)presenceChanged(key)});
  on('say',line=>addLine(line));
  on('emote',({key,emote})=>showEmote(key,emote));
  on('agents',({member,agents})=>{S.live.set(member,agents);if(S.world){buildDesks(member);seatsChanged()}refreshPanel();focusPending()});
  on('members',({members,agentflow})=>{S.members=members;S.snapAgentflow=agentflow;if(S.world){buildAgentflow();buildRooms()}refreshPanel()});
  on('action',a=>{S.answers.set(a.agentId,{...a,state:'sent'});refreshPanel()});
  on('result',a=>{S.answers.set(a.agentId,{...a,state:'done'});refreshPanel();S.opts.toast?.(a.result?.message||'Done',a.result&&!a.result.ok)});
  es.onerror=()=>{
    if(S?.es!==es)return;S.down||=Date.now();
    if(es.readyState===EventSource.CLOSED){const wait=Math.min(10000,800*2**(S.tries||0));S.tries=(S.tries||0)+1;S.retry=setTimeout(()=>{if(S?.es===es)connect()},wait)}
  };
}
function watch(){
  if(!S)return;
  if(Date.now()-S.heard>40000&&S.es?.readyState===EventSource.OPEN){S.down||=Date.now();connect()}
  const down=S.down?Date.now()-S.down:0;
  if(down>60000)status('Cannot reach the office. Still trying…');else if(down>4000)status('Reconnecting…');
  else if(!S.down&&S.me)status(`Live · ${S.members.length} ${S.members.length===1?'room':'rooms'} · ${S.people.size} here`);
}
function snapshot(d){
  S.meKey=d.me.key;S.me=d.me;S.members=d.members;S.snapAgentflow=d.agentflow;S.live=new Map(Object.entries(d.live||{}));
  S.people.forEach((p,k)=>{if(k!==S.meKey)removePerson(k)});
  for(const a of d.actions||[])S.answers.set(a.agentId,{...a,state:a.result?'done':'sent'});
  watch();
  if(!S.world){focusPending();return}
  buildAgentflow();buildRooms();
  if(!S.placed){
    S.placed=true;const r=S.rooms.get(S.meKey),heading=r?.facing??0;
    if(r)S.pos.copy(r.door);
    S.controller.reset(S.pos,heading);S.rig?.reset(S.pos,heading);
  }
  const {x,y,z,heading}=S.controller.state;
  upsertPerson({key:S.meKey,name:S.opts.me?.name||d.me.name,image:S.opts.me?.image||'',x,y,z,heading,moving:false},true);
  for(const p of d.people)if(p.key!==S.meKey)upsertPerson(p);
  S.lines.innerHTML='';S.chat=[];for(const l of d.chat||[])addLine(l,{quiet:true});
  watch();sendPresence(true);presenceChanged();
  focusPending();
}
function updateSources(sources){
  S.sources=sources;S.bridge?.updateSources(sources);
  const empty=!sources.length;
  S.root.querySelector('.of-connect-callout').hidden=!empty;
  S.root.querySelector('.of-connect-link').hidden=empty;
}
function connectAgents(opener){
  const office=S;
  // The current workspace owns the key even when visiting another workspace's office.
  const env=office.opts.current,name=office.opts.offices.find(o=>o.id===env)?.name;
  clearKeys();
  const bridge=openBridgeDialog({env,envName:name,sources:office.sources,openProjects:()=>{
    closeOffice();office.opts.openProjects?.();
  }});
  office.bridge=bridge;
  clearKeys();
  office.root.append(bridge.dialog);bridge.dialog.showModal();
  bridge.dialog.addEventListener('close',()=>{
    if(S!==office||office.bridge!==bridge)return;
    office.bridge=null;
    (opener.hidden||opener.closest('[hidden]')?office.root.querySelector('[data-of="connect"]:not([hidden])'):opener).focus();
  },{once:true});
}
function sendPresence(force){
  const t=performance.now();
  if(!force&&t-S.sentAt<SEND_MS)return;
  const {x,y,z,heading,speed,grounded,sprinting}=S.controller.state;
  const rounded=n=>Math.round(n*100)/100;
  const pose={x:rounded(x),y:rounded(y),z:rounded(z),heading:rounded(heading),moving:speed>0.05,jump:!grounded,sprint:sprinting};
  const sig=JSON.stringify(pose);
  if(!force&&sig===S.lastSent)return;
  S.sentAt=t;S.lastSent=sig;api('presence',pose).catch(()=>{});
}

// ---------- the scene ----------
const M={};
const mat=(c,o={})=>new THREE.MeshLambertMaterial({color:c,flatShading:true,...o});
function initScene(){
  const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;
  S.stage.prepend(renderer.domElement);renderer.domElement.className='of-canvas';
  const scene=new THREE.Scene();scene.background=new THREE.Color('#eef2ef');scene.fog=new THREE.Fog('#eef2ef',45,110);
  const camera=new THREE.PerspectiveCamera(45,1,0.08,1400);
  scene.add(new THREE.HemisphereLight('#ffffff','#b9c4bf',2.2));
  const sun=new THREE.DirectionalLight('#ffffff',1.6);sun.position.set(12,30,18);scene.add(sun);
  const ground=new THREE.Mesh(new THREE.CircleGeometry(120,48),mat('#dfe6e2'));ground.rotation.x=-Math.PI/2;ground.name='ground';scene.add(ground);
  const rug=new THREE.Mesh(new THREE.CircleGeometry(1,40),mat('#cfe3d2'));rug.rotation.x=-Math.PI/2;rug.position.y=0.01;rug.scale.setScalar(10);scene.add(rug);S.rug=rug;
  Object.assign(M,{
    box:new THREE.BoxGeometry(1,1,1),ico:new THREE.IcosahedronGeometry(1,0),ico1:new THREE.IcosahedronGeometry(1,1),oct:new THREE.OctahedronGeometry(1,0),
    cyl:new THREE.CylinderGeometry(1,1,1,7),cone:new THREE.ConeGeometry(1,1,6),torus:new THREE.TorusGeometry(0.62,0.12,5,14),disc:new THREE.CircleGeometry(1,16),
    wall:mat('#f9fbfa'),hit:new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false}),desk:mat('#b98d63'),screenOff:mat('#3b4542'),dark:mat('#1d2421'),white:mat('#ffffff'),shadow:new THREE.MeshBasicMaterial({color:'#000',transparent:true,opacity:.14,depthWrite:false}),
  });
  S.world=new THREE.Group();scene.add(S.world);
  Object.assign(S,{renderer,scene,camera,ground,ray:new THREE.Raycaster(),clock:new THREE.Clock()});
  S.activity=createActivity({THREE,part,M,roomW:ROOM_W,roomD:ROOM_D,person:key=>S.people.get(key)});
  const fit=()=>{const w=S.stage.clientWidth||innerWidth,h=S.stage.clientHeight||innerHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix()};
  S.resize=new ResizeObserver(fit);S.resize.observe(S.stage);fit();
  const cv=renderer.domElement;
  S.rig=createOfficeCamera(camera);S.rig.reset(S.pos,S.controller.state.heading);
  cv.addEventListener('pointerdown',()=>S.root.focus({preventScroll:true}));
  const office=S;
  const openCard=id=>{if(store.db.devops.cards.some(c=>c.id===id)){closeOffice();office.opts.openCard?.(id)}};
  S.boards=createOfficeBoards({env:S.env,world:S.world,camera,position:()=>office.pos,agents:afAgents,openCard,
    seatCard:entry=>{
      const {kind,member,id}=entry.obj.userData;
      return kind==='agent'&&entry.cls?.includes('agent')?agentOf(member,id)?.seat?.card:null;
    }});
  S.cardDrag=createOfficeCardDrag({root:S.root,env:S.env,local:()=>S.env===S.opts.current,hitAt,targetAt:cardTargetAt,openCard});
  S.pointer=bindOfficePointer(cv,S.rig,{pick,recenter:recenterCamera,grab:S.cardDrag.grab,
    hover:e=>{if(e.pointerType==='touch')return;const hit=hitAt(e);cv.style.cursor=hit?.kind||hit?.board?.near&&hit.board.tile?'pointer':'default';S.hover=hit?.kind==='af'?hit.id:hit?.kind==='agent'?hit.obj.userData.id:null}});
  const loop=()=>{if(!S)return;S.raf=requestAnimationFrame(loop);frame(Math.min(.05,S.clock.getDelta()),S.clock.elapsedTime)};loop();
}
function toggleOverview(){
  if(!S.rig)return;
  S.root.querySelector('[data-of="overview"]').setAttribute('aria-pressed',String(S.rig.toggleOverview()));
}
function recenterCamera(){
  if(S.rig?.overview)toggleOverview();
  S.rig?.recenter(S.controller.state.heading);
}
function toggleControls(){
  const el=S.root.querySelector('.of-controls');
  el.hidden=!el.hidden;
  S.root.querySelector('[data-of="controls"]').setAttribute('aria-expanded',String(!el.hidden));
}
const part=(geo,m,[x,y,z],[sx,sy,sz]=[1,1,1])=>{const o=new THREE.Mesh(geo,m);o.position.set(x,y,z);o.scale.set(sx,sy,sz);return o};
const shadow=r=>{const s=part(M.disc,M.shadow,[0,0.02,0],[r,r,r]);s.rotation.x=-Math.PI/2;return s};
function clear(group){S.world.remove(group);group.traverse(o=>{if(o.material&&o.userData.own)o.material.dispose()});const g=new Set();group.traverse(o=>g.add(o));S.clickables=S.clickables.filter(c=>!g.has(c));S.labelList=S.labelList.filter(l=>{if(g.has(l.obj)){l.el.remove();return false}return true})}
function label(obj,html,{y=1.6,cls='',near=0,show=null}={}){const el=document.createElement('div');el.className='of-label '+cls;el.innerHTML=html;S.labels.append(el);const l={obj,el,y,cls,near,show};S.labelList.push(l);return l}

// ---------- rooms ----------
function layout(n){
  const R=Math.max(17,(S.commonR||10)+ROOM_D/2+5,n*(ROOM_W+3)/(2*Math.PI)+6),out=[];
  for(let i=0;i<n;i++){const a=-Math.PI/2+i/n*Math.PI*2,c=new THREE.Vector3(Math.cos(a)*R,0,Math.sin(a)*R),facing=Math.atan2(-c.x,-c.z);out.push({c,facing})}
  return out;
}
function buildRooms(){
  for(const r of S.rooms.values()){clear(r.group);if(r.desks)clear(r.desks)}S.rooms.clear();
  S.walls=[];S.overviewRadius=12;
  const list=[...S.members].sort((a,b)=>(b.owner-a.owner)||String(a.name).localeCompare(b.name));
  layout(list.length).forEach(({c,facing},i)=>{
    const m=list[i],[bg,fg]=memberColor(m.key),g=new THREE.Group();g.position.copy(c);g.rotation.y=facing;
    const floorMat=mat(bg),floor=part(M.box,floorMat,[0,0.03,0],[ROOM_W,0.06,ROOM_D]);floor.userData.own=true;g.add(floor);
    const cos=Math.cos(facing),sin=Math.sin(facing);
    S.overviewRadius=Math.max(S.overviewRadius,Math.hypot(c.x,c.z)+8);
    const wall=(x,z,w,d)=>{
      g.add(part(M.box,M.wall,[x,0.55,z],[w,1.1,d]));
      S.walls.push(officeBox(c.x+x*cos+z*sin,c.z-x*sin+z*cos,facing,w,d,1.1));
    };
    wall(0,-ROOM_D/2,ROOM_W,0.2);wall(-ROOM_W/2,0,0.2,ROOM_D);wall(ROOM_W/2,0,0.2,ROOM_D);
    const side=(ROOM_W-3)/2;wall(-(3/2+side/2),ROOM_D/2,side,0.2);wall(3/2+side/2,ROOM_D/2,side,0.2);
    const stripe=part(M.box,mat(fg),[0,1.12,-ROOM_D/2],[ROOM_W,0.06,0.24]);stripe.userData.own=true;g.add(stripe);
    S.world.add(g);
    const sign=new THREE.Object3D();sign.position.set(3.4,0,ROOM_D/2);g.add(sign);
    const tag=label(sign,`<span class="of-room" data-office-person="${esc(m.key)}" style="--c:${fg}"><b>${esc(m.name)}</b>${m.me?' · your room':''}<small></small></span>`,{y:1.45,cls:'room'});
    const door=new THREE.Vector3(0,0,ROOM_D/2-1.6).applyAxisAngle(new THREE.Vector3(0,1,0),facing).add(c);
    S.rooms.set(m.key,{member:m,group:g,center:c,facing,door,desks:null,boxes:[],floorMat,bg,tag});roomLook(m.key);
    buildDesks(m.key,false);
  });
  updateColliders();
  S.boards?.rebuild(S.rooms,{commonRadius:S.commonR||10,boardAnchor:key=>S.worldLayout?.boardAnchor?.(key)});
}
// A room is lit while its member has the office open; otherwise dimmed, with when they were last here.
const ago=iso=>{const t=Date.parse(iso);if(!t)return '';const m=Math.round((Date.now()-t)/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`};
function roomLook(key){
  const r=S.rooms.get(key);if(!r)return;const on=S.people.has(key)||r.member.me;
  r.floorMat.color.set(r.bg);if(!on)r.floorMat.color.lerp(new THREE.Color('#d5d9d7'),.6);
  r.tag.el.classList.toggle('off',!on);
  const seen=ago(r.member.lastSeen);r.tag.el.querySelector('small').textContent=on?'':` · offline${seen?` · last seen ${seen}`:''}`;
}
function presenceChanged(key){if(key)roomLook(key);else for(const k of S.rooms.keys())roomLook(k);buildAgentflow()}
// A member's live agents at desks: up to 4 per row, rows towards the back wall.
function updateColliders(){
  S.colliders=[...S.walls,...[...S.rooms.values()].flatMap(room=>room.boxes)];
}
function buildDesks(key,refresh=true){
  const room=S.rooms.get(key);if(!room)return;
  if(room.desks){clear(room.desks)}
  const g=new THREE.Group();g.position.copy(room.center);g.rotation.y=room.facing;room.desks=g;S.world.add(g);
  room.boxes=[];
  const cos=Math.cos(room.facing),sin=Math.sin(room.facing);
  for(const b of S.activity?.lounge(g)||[])room.boxes.push(officeBox(room.center.x+b.x*cos+b.z*sin,room.center.z-b.x*sin+b.z*cos,room.facing,b.w,b.d,b.h));
  // Sessions seated at an AgentFlow agent's desk sit in the common area instead (buildSeats).
  const all=S.live.get(key)||[],agents=all.filter(a=>!isSeated(a,S.afPlaced)),away=all.length-agents.length,cols=agents.length>8?4:3,sx=agents.length>8?2.6:3.2;
  if(!agents.length){const o=new THREE.Object3D();o.position.set(0,0,-1);g.add(o);label(o,`<span class="of-empty">${away?`${away} at AgentFlow ${away===1?'desk':'desks'}`:'No agents running'}</span>`,{y:0.4,cls:'muted',near:22})}
  agents.slice(0,16).forEach((a,i)=>{
    const col=i%cols,row=Math.floor(i/cols),x=(col-(cols-1)/2)*sx,z=-ROOM_D/2+1.4+row*2.1;
    room.boxes.push(officeBox(room.center.x+x*cos+z*sin,room.center.z-x*sin+z*cos,room.facing,1.7,0.8,0.76));
    makeDesk(g,a,key,x,z,a.private?'Private project':seatTag(a,'',a.title||VENDOR[a.vendor]?.name||'Agent'),{phase:(i*1.7+key.length)%6.28});
  });
  if(refresh)updateColliders();
}
// One live session at a desk (in its owner's room, or beside an AgentFlow agent): the desk and its screen,
// the mascot with its subagents, and its clickable name tag.
function makeDesk(parent,a,key,x,z,name,{tagY=1.75,phase=0,scale=1,lounge=true}={}){
  const d=new THREE.Group();d.position.set(x,0,z);d.scale.setScalar(scale);parent.add(d);
  d.add(part(M.box,M.desk,[0,0.72,0],[1.7,0.08,0.8]),part(M.box,M.desk,[0,0.36,-0.25],[1.5,0.7,0.12]));
  const scr=new THREE.MeshLambertMaterial({color:'#3b4542',emissive:'#000000',flatShading:true});
  const screen=part(M.box,scr,[0,1.08,-0.25],[0.8,0.5,0.06]);screen.userData.own=true;d.add(screen);
  // The mascot faces the room's back wall (its desk) and so the camera, which looks in from outside.
  const m=createMascot(mascotKind(a.vendor,a.model),{color:VENDOR_COLOR[a.vendor],scale:.52}),mascot=new THREE.Group();
  m.group.position.y=0.62;mascot.add(m.group);mascot.position.set(0,0,0.85);mascot.rotation.y=Math.PI;d.add(mascot);
  mascot.userData={kind:'agent',member:key,id:a.id,screen:scr,status:a.status,mascot:m,children:(a.children||[]).length,phase};
  mascot.add(shadow(0.45));
  mascot.add(part(M.box,M.hit,[0,0.9,0],[1.1,1.9,1.1]));S.clickables.push(mascot);
  S.activity?.attach(mascot,a,{member:key,desk:d,root:parent,lounge});
  const at=`data-agent="${esc(a.id)}" data-member="${esc(key)}"`,kind=shownKind(a);
  label(mascot,`<button type="button" class="of-tag${a.private?' priv':''}${a.seat?.agent?' seat':''}" ${at}><i class="of-kind" title="${kind[1]}">${kind[0]}</i>${esc(name)}</button>`,{y:tagY,cls:'agent click',near:16});
  if(a.status==='waiting')label(mascot,`<button type="button" class="of-bang" ${at} aria-label="Waiting: ${esc(name)}">!</button>`,{y:tagY+0.5,cls:'bang click'});
  scr.emissive.set(a.status==='running'?'#5fd38a':a.status==='waiting'?'#ffb020':'#000000');
  return d;
}
// ---------- AgentFlow agents in the common area ----------
// Laid out like the org chart. AI agents are robots, teams round tables, automations little machines (all
// instanced); human agents are people. A human agent that is a member (a.member) is that member's avatar
// while they are here, and stands at its place in the org, dimmed and marked offline, while they are not.
function afAgents(){
  const local=S.env===S.opts.current&&S.opts.agentflow?S.opts.agentflow():null,server=S.snapAgentflow||[];
  if(!local)return server;
  const link=new Map(server.map(a=>[a.id,a.member]));return local.map(a=>({...a,member:link.get(a.id)||''}));
}
const afOf=id=>afAgents().find(a=>a.id===id);
const afFor=key=>afAgents().find(a=>a.member&&a.member===key);
function buildAgentflow(){
  S.boards?.invalidate();
  if(S.afGroup){clear(S.afGroup);S.org?.dispose();S.org=null}
  const g=new THREE.Group();S.afGroup=g;S.world.add(g);
  const list=afAgents().slice(0,200),{pos,radius}=orgLayout(list);
  // Seats: which agents have a place here decides which sessions leave their owners' rooms; an AI agent with
  // nobody at its desk is dimmed.
  const was=[...S.afPlaced||[]].join('\n');S.afPlaced=new Set(list.filter(a=>pos.has(a.id)).map(a=>a.id));S.afPos=pos;
  if(S.rooms.size&&[...S.afPlaced].join('\n')!==was){for(const k of S.rooms.keys())buildDesks(k,false);updateColliders()}
  const seats=seatsByAgent(S.live,S.afPlaced);S.seatSig=seatSig(seats);
  if(S.commonR!==radius){S.commonR=radius;S.rug.scale.setScalar(radius);if(S.rooms.size)queueMicrotask(()=>S&&buildRooms())}
  const items=[],people=[];
  for(const a of list){
    const p=pos.get(a.id);if(!p)continue;const dim=a.status==='retired'||a.status==='paused';
    if(a.kind==='human'){if(a.member&&S.people.has(a.member))continue;people.push({a,p,offline:!!a.member,dim})}
    else{const kind=a.kind==='team'?'team':a.kind==='automation'?'automation':'agent';items.push({id:a.id,kind,x:p.x,z:p.z,dim:dim||kind==='agent'&&!seats.has(a.id)})}
  }
  S.org=orgField(items);g.add(S.org.group);for(const m of S.org.meshes)S.clickables.push(m);
  for(const it of items){const o=new THREE.Object3D();o.position.set(it.x,0,it.z);g.add(o);const a=afOf(it.id);
    label(o,`<button type="button" class="of-tag af" data-af-id="${esc(it.id)}">${esc(a.name)}</button>`,{y:it.kind==='team'?1.1:1.65,cls:'af click',show:()=>S.hover===it.id||S.panelFor?.id===it.id||o.position.distanceTo(S.pos)<7})}
  S.afPeople=people.map(({a,p,offline,dim})=>{
    const f=makeHuman(lookFor(a.member||a.id),{dim:offline||dim});f.position.set(p.x,0,p.z);f.userData={kind:'af',id:a.id,rig:f.userData.rig};f.add(part(M.box,M.hit,[0,1,0],[0.9,2,0.9]));
    g.add(f);S.clickables.push(f);
    label(f,`<button type="button" class="of-tag af person${offline?' off':''}" data-af-id="${esc(a.id)}">${esc(a.name)}${offline?' · offline':''}</button>`,{y:2.05,cls:'af click',show:()=>S.hover===a.id||S.panelFor?.id===a.id||f.position.distanceTo(S.pos)<9});
    return f;
  });
  buildSeats(seats);
}
// Seats (office-seats.js): each live session working on an AgentFlow agent's card sits at a small desk beside
// that agent, seen from any side, with the agent's name and the card on its tag; up to three per agent.
const seatSig=seats=>[...seats].map(([id,l])=>id+':'+l.length).sort().join();
function buildSeats(seats=seatsByAgent(S.live,S.afPlaced)){
  // Detached anchors tell the activity module (office-activity.js) their actors are gone.
  if(S.seatGroup){clear(S.seatGroup);S.seatGroup.clear()}const g=new THREE.Group();S.seatGroup=g;S.world.add(g);
  for(const [id,sitting] of seats){
    const p=S.afPos?.get(id),a=afOf(id);if(!p||!a)continue;
    sitting.slice(0,3).forEach(({member,agent},i,list)=>{
      // Its own anchor, turned so the mascot sits between the agent and its desk: the activity's frame (office-activity.js).
      const at=new THREE.Group();at.position.set(p.x+1.12,0,p.z+(i-(list.length-1)/2)*0.85);at.rotation.y=-Math.PI/2;g.add(at);
      makeDesk(at,agent,member,0,0,seatTag(agent,a.name),{tagY:list.length>1&&i%2?1.15:1.6,phase:i*1.7,scale:0.5,lounge:false});
    });
  }
}
// A session report changed: re-seat, and redraw the org only when who is busy changed (that dims or lights robots).
function seatsChanged(){const seats=seatsByAgent(S.live,S.afPlaced);if(seatSig(seats)!==S.seatSig)buildAgentflow();else buildSeats(seats)}

// ---------- people ----------
// A person (office-figures.js); the controller's pose group squashes and tilts it, its shadow stays on the ground.
function makeAvatar(key){return makeHuman(lookFor(key),{shadow:false})}
function upsertPerson(p,self=false){
  if(!S)return;let a=S.people.get(p.key);
  if(!a){
    const obj=new THREE.Group(),pose=new THREE.Group(),figure=makeAvatar(p.key),shade=shadow(0.45);
    figure.position.y=-0.88;pose.add(figure);pose.position.y=0.88;obj.add(pose,shade);
    obj.position.set(p.x??0,p.y??0,p.z??0);obj.rotation.y=p.heading||0;obj.userData={kind:'person',key:p.key,rig:figure.userData.rig};S.world.add(obj);
    if(!self){obj.add(part(M.box,M.hit,[0,1,0],[0.9,2,0.9]));S.clickables.push(obj)}
    const [bg,fg]=memberColor(p.key),badge=p.image&&/^(https:|data:image\/)/.test(p.image)?`<img src="${esc(p.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`:'';
    const tag=label(obj,`<span class="of-name${self?' me':''}" data-office-person="${esc(p.key)}" style="--bg:${bg};--fg:${fg}"><i>${esc(initials(p.name))}${badge}</i>${esc(p.name)}</span>`,{y:2.05,cls:'person'});
    a={key:p.key,name:p.name,obj,tag,pose,shade,self,samples:[],remote:{},phase:0,landing:0,wasAirborne:false};S.people.set(p.key,a);
  }
  if(!self&&Number.isFinite(p.x)){
    const at=performance.now(),samples=a.samples,last=samples.at(-1);
    const speed=p.moving?(last?Math.hypot(p.x-last.x,p.z-last.z)/Math.max(0.03,(at-last.at)/1000):WALK_SPEED):0;
    samples.push({at,x:p.x,y:p.y??0,z:p.z,heading:p.heading||0,speed:Math.min(RUN_SPEED,speed),
      grounded:!p.jump,jumping:!!p.jump,sprinting:!!p.sprint});
    if(samples.length>12)samples.shift();
  }
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
  const l=label(p.obj,`<span class="of-emote">${e[1]}</span>`,{y:p.bubble?3.6:2.6,cls:'emote'});p.emote={kind:k,at:performance.now()};
  setTimeout(()=>{l.el.remove();if(S)S.labelList=S.labelList.filter(x=>x!==l)},2400);
}

// ---------- clicks, menus and the side panel ----------
function hitAt(e){
  if(!S.camera)return null;const r=S.renderer.domElement.getBoundingClientRect();
  S.ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),S.camera);
  const board=S.boards?.hit(S.ray);
  for(const h of S.ray.intersectObjects(S.clickables,true)){
    if(board&&board.distance<h.distance)break;
    if(h.object.isInstancedMesh){const id=S.org?.pick(h.object,h.instanceId);if(id)return {kind:'af',id,obj:h.object,point:h.point};continue}
    let o=h.object;while(o&&!o.userData?.kind)o=o.parent;if(o)return {kind:o.userData.kind,id:o.userData.id,obj:o,point:h.point}}
  const g=S.ray.intersectObject(S.ground)[0];
  return board&&(!g||board.distance<g.distance)?{kind:'',board,point:g?.point||board.point}:g?{kind:'',point:g.point}:null;
}
function cardTargetAt(e){
  const bounds=S.stage.getBoundingClientRect();
  if(e.clientX<bounds.left||e.clientX>bounds.right||e.clientY<bounds.top||e.clientY>bounds.bottom)return null;
  const person=key=>{
    const member=S.members.find(m=>m.key===key);
    if(member)return {type:'person',refs:officeMemberRefs(store.db,member),name:member.name};
  };
  const agent=id=>{
    const a=afOf(id);
    if(a)return {type:'agent',id,name:a.name};
  };
  const el=document.elementFromPoint(e.clientX,e.clientY);
  const name=el?.closest('[data-af-id],[data-office-person],[data-agent][data-member]');
  if(name){
    const box=name.getBoundingClientRect();
    const target=name.dataset.officePerson?person(name.dataset.officePerson):agent(name.dataset.afId||
      agentOf(name.dataset.member,name.dataset.agent)?.seat?.agent);
    if(target)return {...target,x:box.left+box.width/2,y:box.top};
  }
  if(el!==S.renderer.domElement&&!el?.closest('.of-labels'))return null;
  const hit=hitAt(e);
  if(hit?.board?.column&&hit.board.near)return {type:'column',id:hit.board.column.id,name:hit.board.column.name};
  if(hit?.kind==='af')return agent(hit.id);
  if(hit?.kind==='person')return person(hit.obj.userData.key);
  if(hit?.kind==='agent'){
    const {member,id}=hit.obj.userData;
    const seated=agentOf(member,id)?.seat?.agent;
    return seated?agent(seated):person(member);
  }
  if(!hit?.point)return null;
  for(const [key,room] of S.rooms){
    const pos=room.group.worldToLocal(hit.point.clone());
    if(Math.abs(pos.x)<=ROOM_W/2&&Math.abs(pos.z)<=ROOM_D/2)return person(key);
  }
  return null;
}
function pick(e){
  const hit=hitAt(e);closeMenu();if(!hit)return;
  if(S.boards?.pick(hit.board))return;
  if(hit.kind==='agent'){showAgent(hit.obj.userData.member,hit.obj.userData.id);return}
  if(hit.kind==='af'){showAf(hit.id);return}
  if(hit.kind==='person'){openMenu(hit.obj.userData.key,e);return}
  S.follow=null;S.target=new THREE.Vector3(hit.point.x,0,hit.point.z);
}
function openMenu(key,e){
  const r=S.root.getBoundingClientRect();S.menu.hidden=false;S.menu.dataset.key=key;
  const af=afFor(key);
  S.menu.innerHTML=`<div class="of-mh">${esc(nameOf(key))}${af?.title?`<small>${esc(af.title)}</small>`:''}</div>${af?`<button type="button" role="menuitem" data-of="afInfo" data-id="${esc(af.id)}">${icon('user',13)}AgentFlow role</button>`:''}<button type="button" role="menuitem" data-of="wave">👋 Wave</button><button type="button" role="menuitem" data-of="follow">${icon('arrowR',13)}${S.follow===key?'Stop following':'Follow'}</button><button type="button" role="menuitem" data-of="message">${icon('send',13)}Message</button>`;
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
  ({close:closeOffice,connect:()=>connectAgents(b),zoomIn:()=>S.rig?.zoomBy(1/1.2),zoomOut:()=>S.rig?.zoomBy(1.2),overview:toggleOverview,controls:toggleControls,closePanel:()=>{S.panel.hidden=true;S.panelFor=null},
    wave(){emote('wave');closeMenu()},
    follow(){S.follow=S.follow===key?null:key;S.target=null;closeMenu()},
    message(){closeMenu();const i=S.root.querySelector('.of-input');i.value=`@${nameOf(key)} `+i.value.replace(/^@\S+\s/,'');i.focus()},
    allow:()=>decide('allow'),deny:()=>decide('deny'),
    afInfo(){closeMenu();showAf(b.dataset.id)},
  })[b.dataset.of]?.();
}
function agentOf(member,id){return (S.live.get(member)||[]).find(a=>a.id===id)}
function showAgent(member,id){S.panelFor={type:'agent',member,id};refreshPanel()}
function showAf(id){S.panelFor={type:'af',id};refreshPanel()}
// The AgentFlow agent whose desk a session sits at, by name.
const deskOf=a=>a.seat?.agent&&S.afPlaced?.has(a.seat.agent)?afOf(a.seat.agent)?.name||'':'';
const row=(k,v)=>v?`<div class="of-row"><span>${k}</span><b>${esc(v)}</b></div>`:'';
function refreshPanel(){
  const p=S?.panelFor;if(!p)return;
  let html='';
  if(p.type==='af'){
    const a=afAgents().find(x=>x.id===p.id);if(!a){S.panel.hidden=true;return}
    const here=S.env===S.opts.current&&S.opts.focusAgent;
    html=`<div class="of-ph">${icon(a.kind==='human'?'user':a.kind==='team'?'users':a.kind==='automation'?'gear':'bot',16)}<b>${esc(a.name)}</b><span class="sp"></span><button type="button" class="ib" data-of="closePanel" aria-label="Close">${icon('x')}</button></div>
      <div class="of-pb">${row('Role',a.title)}${row('Kind',a.kind)}${row('Status',a.status)}<p class="of-note">An AgentFlow ${a.kind==='human'?'person':a.kind} of this environment.</p>
      ${a.kind==='agent'?deskPanel(a,seatsByAgent(S.live,S.afPlaced).get(a.id)||[],{desk:(S.snapAgentflow||[]).find(x=>x.id===a.id)?.desk,nameOf,vendorName:v=>(VENDOR[v]||VENDOR.other).name,me:S.meKey}):''}
      ${here?`<button type="button" class="txt" data-of="openAfAgent" data-id="${esc(a.id)}">${icon('external',13)}Open in AgentFlow</button>`:''}</div>`;
  }else{
    const a=agentOf(p.member,p.id),owner=S.members.find(m=>m.key===p.member);
    if(!a){html=`<div class="of-ph"><b>Agent</b><span class="sp"></span><button type="button" class="ib" data-of="closePanel" aria-label="Close">${icon('x')}</button></div><div class="of-pb"><p class="of-note">It stopped reporting.</p></div>`}
    else{
      const v=VENDOR[a.vendor]||VENDOR.other,ans=S.answers.get(a.id),doing=a.status==='waiting'?'':shownKind(a)[1];
      const head=`<div class="of-ph"><span class="of-dot" style="background:${v.color}"></span><b>${esc(a.private?'Private project':a.title||v.name)}</b><span class="sp"></span><button type="button" class="ib" data-of="closePanel" aria-label="Close">${icon('x')}</button></div>`;
      if(a.private)html=head+`<div class="of-pb">${row('Agent',v.name)}${row('Status',STATUS[a.status])}${row('Doing',doing)}${row('Belongs to',owner?.name)}${a.children?.length?row('Subagents',String(a.children.length)):''}
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
          ${row('Desk',deskOf(a))}${row('Card',a.seat?.card?`#${a.seat.card.number} ${a.seat.card.title}`:'')}${row('Doing',[doing,a.activity].filter(Boolean).join(' · '))}${a.children?.length?row('Subagents',`${a.children.length}: ${a.children.map(c=>c.title||VENDOR[c.vendor]?.name).join(', ')}`):''}${row('Belongs to',a.mine?'You':owner?.name)}${prompt}${res}</div>`;
      }
    }
  }
  S.panel.innerHTML=html;S.panel.hidden=false;
  for(const b of S.panel.querySelectorAll('[data-seat-agent]'))b.addEventListener('click',()=>showAgent(b.dataset.seatMember,b.dataset.seatAgent));
  S.panel.querySelector('[data-of="openAfAgent"]')?.addEventListener('click',e=>{const id=e.currentTarget.dataset.id,f=S.opts.focusAgent;closeOffice();f?.(id)});
}
function decide(decision){
  const p=S.panelFor,a=p&&agentOf(p.member,p.id);if(!a?.pending||!a.mine)return;
  S.answers.set(a.id,{agentId:a.id,requestId:a.pending.requestId,decision,state:'sent'});refreshPanel();
  api('answer',{source:a.source,agentId:a.id,requestId:a.pending.requestId,decision}).catch(e=>{S.answers.delete(a.id);refreshPanel();S.opts.toast?.(e.message,true)});
}

// ---------- keys ----------
const isTyping=el=>el?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable=false])');
function onKey(e){
  if(!S)return;
  if(S.bridge?.dialog.open){e.stopPropagation();return}
  if(e.key==='Escape'){
    e.preventDefault();e.stopPropagation();
    if(S.pointer?.cancelGrab())return;
    if(closeMenu())return;
    if(!S.panel.hidden){S.panel.hidden=true;S.panelFor=null;return}
    closeOffice();return;
  }
  if(isTyping(e.target))return;
  if(S.pointer?.grabbing){e.stopPropagation();return}
  e.stopPropagation(); // the app underneath does not see office shortcuts
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  const k=e.key.toLowerCase(),menu=e.target.closest?.('[role=menu]');
  if(menu){
    if(k==='arrowup'||k==='arrowdown'){
      e.preventDefault();const bs=[...S.menu.querySelectorAll('button')],i=bs.indexOf(document.activeElement);
      bs[(i+(k==='arrowup'?-1:1)+bs.length)%bs.length]?.focus();
    }
    return;
  }
  if(e.code==='Space'&&e.target.closest?.('button,a'))return;
  if(S.input.keyDown(e.code,performance.now(),e.repeat,S.controller.jump)){e.preventDefault();return}
  if(['q','e','f','o','?'].includes(k)){
    e.preventDefault();
    if(e.repeat)return;
    if(k==='q'||k==='e')S.rig?.rotate((k==='q'?1:-1)*Math.PI/6);
    if(k==='f')recenterCamera();
    if(k==='o')toggleOverview();
    if(k==='?')toggleControls();
    return;
  }
  if(/^[1-4]$/.test(e.key)){e.preventDefault();emote(EMOTES[+e.key-1][0]);return}
  if(e.key==='Enter'&&e.target===document.body||e.key==='t'){e.preventDefault();S.root.querySelector('.of-input').focus()}
}
function onKeyUp(e){
  if(S?.input.keyUp(e.code)&&!isTyping(e.target))e.stopPropagation();
}
function clearKeys(){S?.input.clear();S?.controller.clearJump();S?.pointer?.cancelGrab()}

// Buffer roughly one presence interval and interpolate the three coordinates together.
function remoteMotion(p, now){
  const q=p.samples;
  const playAt=now-110;
  while(q.length>1&&q[1].at<=playAt)q.shift();
  const a=q[0],b=q[1]||a,out=p.remote;
  const alpha=a===b?0:THREE.MathUtils.clamp((playAt-a.at)/Math.max(1,b.at-a.at),0,1);
  const lerp=(x,y)=>x+(y-x)*alpha;
  out.x=lerp(a.x,b.x);out.y=lerp(a.y,b.y);out.z=lerp(a.z,b.z);
  out.heading=a.heading+angleDelta(a.heading,b.heading)*alpha;
  out.speed=lerp(a.speed,b.speed);
  out.grounded=a.grounded&&!b.jumping;
  out.jumping=!out.grounded;
  out.sprinting=a.sprinting||b.sprinting;
  return out;
}

function frame(dt,t){
  const controller=S.controller,state=controller.state,now=performance.now(),yaw=S.rig.yaw;
  const editing=S.bridge?.dialog.open||S.pointer.grabbing||isTyping(document.activeElement);
  const pads=editing?[]:navigator.getGamepads?.()||[];
  const gamepad=Array.prototype.find.call(pads,pad=>pad?.connected&&pad.mapping==='standard');
  const input=S.input.sample(gamepad,controller.jump);
  const {right,forward,orbitX,orbitY}=input,steering=!!(right||forward);
  if(orbitX||orbitY)S.rig.rotate(-orbitX*2.6*dt,orbitY*1.9*dt);

  const c=Math.cos(yaw),s=Math.sin(yaw);
  let x=right*c-forward*s,z=-right*s-forward*c;
  if(steering){S.follow=null;S.target=null}
  else{
    const target=S.people.get(S.follow)?.obj.position||S.target;
    if(target){
      const dx=target.x-state.x,dz=target.z-state.z,d=Math.hypot(dx,dz),stop=S.follow?1.8:0.18;
      if(d>stop){
        const throttle=Math.min(1,Math.sqrt(2*24*(d-stop))/(input.sprint?RUN_SPEED:WALK_SPEED));
        x=dx/d*throttle;z=dz/d*throttle;
      }else if(!S.follow)S.target=null;
    }
  }
  const player=controller.advance(dt,{...input,x,z},S.colliders);
  S.pos.set(player.x,player.y,player.z);
  if(S.meKey)sendPresence(false);
  for(const p of S.people.values()){
    // The figure animation can use the same motion fields for local and remote avatars.
    const motion=p.motion=p.self?player:remoteMotion(p,now);
    const o=p.obj,hop=0;
    o.position.set(motion.x,motion.y+hop,motion.z);o.rotation.y=motion.heading;
    if(!p.self&&p.wasAirborne&&motion.grounded)p.landing=0.12;
    p.wasAirborne=!motion.grounded;
    p.landing*=Math.exp(-13*dt);
    const squash=p.self?motion.squash:p.landing;
    const run=THREE.MathUtils.clamp((motion.speed-WALK_SPEED)/(RUN_SPEED-WALK_SPEED),0,1);
    const stride=Math.min(1,motion.speed/WALK_SPEED);
    p.phase+=dt*motion.speed*(2.35-run*0.37);
    const step=motion.grounded?Math.abs(Math.sin(p.phase))*0.065*stride:0;
    const scale=1-squash+(motion.jumping?0.07:0);
    p.pose.scale.set(1+squash*0.5,scale,1+squash*0.5);
    p.pose.position.y=0.88*scale+step;
    p.pose.rotation.x=motion.flip|| (motion.jumping?-0.17:stride*(0.05+run*0.13));
    p.pose.rotation.z=motion.grounded?Math.sin(p.phase)*stride*0.045:0;
    p.shade.position.y=0.02-o.position.y;
    animateHuman(o.userData.rig,t,{speed:motion.speed,grounded:motion.grounded,jumping:motion.jumping,emote:p.emote,phase:(o.id%7)*0.9});
  }
  for(const f of S.afPeople||[])animateHuman(f.userData.rig,t,{phase:(f.id%7)*0.9});
  // Agents: running bob and type, waiting hop and glow, idle still; subagents circle.
  for(const c of S.clickables){
    const u=c.userData;if(u.kind!=='agent')continue;
    u.mascot?.update(t,{status:u.status,children:u.children,phase:u.phase});
  }
  pulseMascots(t);
  // What each agent acts out and where it walks (office-activity.js): after the above, so it has the last word.
  S.activity?.tick(dt,t);
  S.rig.update(dt,S.pos,player.heading,player.vx,player.vz,S.walls,S.overviewRadius,
    {held:S.pointer.orbiting||S.pointer.grabbing||!!(orbitX||orbitY),align:!steering||(forward>0&&Math.abs(right)<0.1)});
  S.scene.fog.far=Math.max(110,S.camera.position.y+S.overviewRadius);
  S.boards?.frame(S.labelList);
  S.renderer.render(S.scene,S.camera);
  placeLabels();
}
function placeLabels(){
  const w=S.stage.clientWidth,h=S.stage.clientHeight,p=new THREE.Vector3();
  for(const l of S.labelList){
    l.obj.getWorldPosition(p);const far=(l.near&&p.distanceTo(S.pos)>l.near)||(l.show&&!l.show());p.y+=l.y;p.project(S.camera);
    const off=far||p.z>1||p.x<-1.2||p.x>1.2||p.y<-1.2||p.y>1.2;
    if(off){if(!l.hidden){l.el.style.display='none';l.hidden=true}continue}
    if(l.hidden){l.el.style.display='';l.hidden=false}
    l.el.style.transform=`translate(${((p.x+1)/2*w).toFixed(1)}px,${((1-p.y)/2*h).toFixed(1)}px) translate(-50%,-100%)`;
  }
}
