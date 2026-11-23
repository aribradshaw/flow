// The 3D office (docs/concepts/12-office.md): a full-screen, low-poly office for one environment, drawn with
// Three.js (public/vendor/three, MIT). One room per member with their live coding agents at desks, the
// environment's AgentFlow agents in the common area, and everyone who has the office open as an avatar.
// Live over Server-Sent Events (GET /api/office/{env}/events); moves, status, chat, emotes and Allow / Deny are
// small POSTs to /api/office/{env}/… The server redacts other people's agents per viewer, so what
// arrives here is already what this person may see. Loaded on demand from the AgentFlow toolbar.
import * as THREE from './vendor/three/three.module.min.js';
import {icon} from './icons.js';
import {esc,ib,uid} from './ui.js';
import {detailModal} from './modal.js';
import {officeOverlayActions} from './office-overlays-core.js';
import {memberColor,initials} from './devops-core.js';
import {angleDelta,bindOfficePointer,createOfficeCamera,createOfficeCharacter,createOfficeInput,officeBox,WALK_SPEED,RUN_SPEED} from './office-controls.js';
import {createOfficeBoards,createOfficeCardDrag,boardFrame} from './office-boards.js';
import {createOfficeDevops} from './office-devops.js';
import {toWorld,officeMeterMount,ROOM_W,ROOM_D,WALL_T,WALL_H,BACK_WALL_H,DOOR_W} from './office-layout.js';
import {officeMemberRefs} from './office-boards-core.js';
import {store} from './store.js';
import {officeStream,officeDiff,mergeOfficeChat} from './office-stream.js';
import {createInteractions} from './office-interact.js';
import {createReactions} from './office-reactions.js';
import {createOfficeMeters} from './office-meters.js';
import {openBridgeDialog} from './office-connect.js';
import {createSteer} from './office-steer.js';
import {attachOfficeChat,chatChannel,chatTargets} from './office-chat.js';
import {makeHuman,animateHuman,lookFor,orgField,orgLayout,disposeFigures,paceFigures} from './office-figures.js';
import {cleanLook} from './office-look-core.js';
import {lookFromSpec,specFromLook} from './avatar-spec.js';
import {createMascot,mascotKind,pulseMascots,disposeMascots,VENDOR_COLOR} from './office-mascots.js';
import {doorSpots,buildDoors as doorMeshes,doorAt} from './office-portals.js';
import {createActivity,hudHtml,bindHud,shownKind} from './office-activity.js';
import {createNpcs} from './office-npc.js';
import {seatsByAgent,isSeated,seatTag,deskPanel} from './office-seats.js';
import {notifyOn,toggleNotify} from './office-alerts.js';
import {attachOfficeStatus,status as presenceStatus} from './office-status.js';
import {attachOfficeReplay} from './office-replay.js';
import {createWorld,WORLDS,worldId,wallsFrom} from './office-world.js';
import {createVoice} from './office-voice.js';
import {createDecor} from './office-decor.js';
import {createChief} from './office-chief.js';

const VENDOR={claude:{name:'Claude',color:'#d97857'},codex:{name:'Codex',color:'#2e80ed'},gemini:{name:'Gemini',color:'#5b7cf5'},deepseek:{name:'DeepSeek',color:'#4d6bff'},grok:{name:'Grok',color:'#17171a'},other:{name:'Agent',color:'#5f9e6e'}};
const STATUS={running:'Running',waiting:'Waiting on its person',idle:'Idle'};
const EMOTES=[['wave','👋','Wave'],['thumbs','👍','Thumbs up'],['clap','👏','Clap'],['heart','❤️','Heart']];
const SEND_MS=100;
let S=null; // the open office

// ---------- opening and closing ----------
// opts: {env, current (the app's environment), offices:[{id,name}], agentflow():[] (the local store's agents, for current),
//        overlays (hosted editors), me:{name,image}, toast(msg,bad),
//        focus (optional: a live agent's id, or an AgentFlow agent's id or name, to show once it arrives), onClose()}
export function openOffice(opts){
  if(S)return;
  const root=document.createElement('div');root.className='of';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','3D office');
  root.innerHTML=`<div class="of-top">
      <span class="of-title">${icon('cube3d',16)}<b>3D office</b></span>
      ${opts.offices.length>1?`<select class="of-switch" aria-label="Office">${opts.offices.map(o=>`<option value="${esc(o.id)}"${o.id===opts.env?' selected':''}>${esc(o.name)}</option>`).join('')}</select>`:`<span class="of-env">${esc(opts.offices[0]?.name||'')}</span>`}
      <select class="of-world" aria-label="World" data-tip="World" hidden>${WORLDS.map(w=>`<option value="${w.id}">${w.name}</option>`).join('')}</select>
      <span class="of-status" role="status" aria-live="polite">Connecting…</span><span class="sp"></span>
      <button type="button" class="txt of-connect-link" data-of="connect" hidden>Connect your agents</button>
      <button type="button" class="txt" data-of-replay disabled>Replay</button>
      <button type="button" class="txt of-decor-btn" data-of="decorate" hidden aria-pressed="false">Decorate</button>
      <span class="of-keys">WASD · E interact · B board · Shift sprint · Space jump · middle/right drag</span>
      <button type="button" class="ib" data-of="look" aria-label="Edit your look" data-tip="Edit your look (L)">${icon('shirt')}</button>
      ${hudHtml(icon,{notify:true})}<button type="button" class="ib" data-of="zoomOut" aria-label="Zoom out" data-tip="Zoom out">${icon('minus')}</button><button type="button" class="ib" data-of="zoomIn" aria-label="Zoom in" data-tip="Zoom in">${icon('plus')}</button>
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
        <dt>Interact</dt><dd>E (gamepad X / Square, or tap the prompt) near an agent, a person or a board; E or Esc closes it</dd>
        <dt>Orbit</dt><dd>Middle/right drag, Alt+drag, Z / C, or one-finger drag</dd>
        <dt>Zoom</dt><dd>Scroll, + / − buttons, or pinch</dd>
        <dt>Pan</dt><dd>Two-finger drag</dd>
        <dt>Recenter</dt><dd>Middle-click or F</dd>
        <dt>Overview</dt><dd>O or the overview button</dd>
        <dt>DevOps board</dt><dd>B opens the full board from anywhere; Esc goes back</dd>
        <dt>Gamepad</dt><dd>Left stick to move, right stick to orbit, A to jump, B to sprint, X to interact</dd>
        <dt>DevOps board</dt><dd>The main board is your DevOps board. Press E at it, or click it, to work on it as in the DevOps tab; Esc returns.</dd>
        <dt>Room boards</dt><dd>Walk up to a room's whiteboard and click a card. Left-drag to a person, room, agent or column. Hold Shift to replace agent delegates.</dd>
        <dt>Meters</dt><dd>Walk up to a room or office meter and press E</dd>
        <dt>Chat &amp; emotes</dt><dd>T to chat, 1–4 to react</dd>
        <dt>Status</dt><dd>Available, Focus, Do not disturb or Away, from the header</dd>
        <dt>Voice</dt><dd>Walk into the Meeting room to talk. M mutes; hold V to talk if push-to-talk is on. Talk to people nearby from the voice bar.</dd>
        <dt>Decorate</dt><dd>Inside your room: place props, R to rotate, Delete to remove, Esc to leave</dd>
        <dt>Your look</dt><dd>L, the shirt button, the mirror in your room, or E (or a click) on yourself</dd></dl>
      <label><input type="checkbox" class="of-auto-camera" checked> Recenter while moving</label>
      <label class="of-motion-row" hidden><input type="checkbox" class="of-motion"> Sea motion (the deck sways gently)</label>
    </aside>
    <aside class="of-panel" hidden></aside><div class="of-menu" hidden role="menu"></div>`;
  root.tabIndex=-1;document.body.append(root);document.body.classList.add('office-open');
  S={opts,root,overlays:[],overlaySession:uid(),lines:root.querySelector('.of-lines'),env:opts.env,stage:root.querySelector('.of-stage'),labels:root.querySelector('.of-labels'),panel:root.querySelector('.of-panel'),menu:root.querySelector('.of-menu'),
    input:createOfficeInput(),controller:createOfficeCharacter(),walls:[],colliders:[],overviewRadius:12,place:null,floor:0,ov:0,motion:seaMotion(),people:new Map(),members:[],rooms:new Map(),live:new Map(),looks:new Map(),afFigures:[],clickables:[],labelList:[],answers:new Map(),
    steer:createSteer({post:body=>api('steer',body),toast:(m,bad)=>opts.toast?.(m,bad)}),me:null,meKey:'',pos:new THREE.Vector3(0,0,6),target:null,follow:null,sentAt:0,lastSent:'',chat:[],stream:officeStream(),absent:new Map(),opener:document.activeElement};
  S.controller.reset(S.pos,0);
  // Browser automation only (navigator.webdriver): end-to-end checks can place the avatar and read the office.
  if(navigator.webdriver)globalThis.__flowOffice={state:()=>S,place:(x,z,heading=0)=>{S.pos.set(x,0,z);S.controller.reset(S.pos,heading);S.rig?.reset(S.pos,heading)}};
  try{initScene()}catch(e){S.stage.insertAdjacentHTML('afterbegin','<p class="of-fail">3D graphics are unavailable in this browser.</p>');status('3D is not available')}
  root.addEventListener('click',onClick);
  bindHud(root,{icon,notify:{on:notifyOn,toggle:toggleNotify},toast:opts.toast});
  root.addEventListener('focusin',e=>{if(isTyping(e.target))clearKeys()});
  root.querySelector('.of-auto-camera').addEventListener('change',e=>S.rig?.setAuto(e.target.checked));
  const motion=root.querySelector('.of-motion');motion.checked=S.motion;motion.addEventListener('change',()=>{S.motion=motion.checked;try{localStorage.setItem(MOTION_KEY,S.motion?'1':'0')}catch{}});
  root.querySelector('.of-world').addEventListener('change',e=>{const id=worldId(e.target.value);S.opts.setWorld?.(id);usePlace(id)});
  const office=S;
  S.composer=attachOfficeChat({form:root.querySelector('.of-say'),env:opts.env,me:()=>office.me,
    api,show:addLine,toast:opts.toast,canSend:()=>!!office.me&&!office.replay?.active,
    targets:()=>chatTargets({people:[...office.people.values()],live:office.live.get(office.meKey)||[],agentflow:afAgents(),meKey:office.meKey}),
    sendDirect:(target,body)=>postJson('/api/chat/send',{office:{env:office.env,target},body})});
  root.querySelector('.of-switch')?.addEventListener('change',e=>{switchTo(e.target.value)});
  addEventListener('keydown',onKey,true);addEventListener('keyup',onKeyUp,true);addEventListener('blur',clearKeys);
  S.presence=attachOfficeStatus(S,{officeBox,refreshColliders:updateColliders});
  S.replay=attachOfficeReplay(root,{env:S.env,scene:replayScene,live:restoreLiveScene,clear:clearReplayScene,
    names:key=>key===S.meKey?'You':S.members.find(m=>m.key===key)?.name||'Guest',
    react:e=>{if(e.type==='emote')showEmote(e.member,e.emote);else S.reactions?.react(e.member+'|'+e.agent,e.decision)}});
  connect();S.watch=setInterval(watch,1000);
  root.focus({preventScroll:true});
  if(opts.cardId)openOverlay('card',opts.cardId);
}
export const officeOpen=()=>!!S;
export const officePeek=()=>S; // the open office's state, for tests and the screenshot harness
export function closeOffice(){
  if(!S)return;S.replay?.destroy();const s=S;S=null;
  s.devops?.dispose(); // first: the DevOps tab gets its board back whatever else happens
  s.presence?.destroy();s.composer?.dispose();s.lookEditor?.close();
  s.es?.close();clearTimeout(s.retry);clearInterval(s.watch);cancelAnimationFrame(s.raf);s.resize?.disconnect();
  removeEventListener('keydown',onKey,true);removeEventListener('keyup',onKeyUp,true);removeEventListener('blur',clearKeys);
  // Each part closes on its own (voice first: every call ends, the mic and a shared screen are released), so one
  // that fails cannot leave the office on screen.
  for(const close of [()=>s.voice?.dispose(),()=>s.decor?.dispose(),()=>s.meters?.dispose(),()=>s.pointer?.cancelGrab(),()=>s.cardDrag?.dispose(),()=>s.boards?.dispose(),()=>s.interact?.dispose(),()=>s.reactions?.dispose(),()=>s.chief?.dispose(),()=>s.npc?.dispose()])
    try{close()}catch(e){console.error('office close',e)}
  clearInterval(s.answerTick);
  try{s.place?.dispose();s.org?.dispose();const all=[];s.scene?.traverse(o=>all.push(o));for(const o of all)o.userData.dispose?.();disposeFigures();disposeMascots();s.renderer?.dispose();for(const o of all){o.geometry?.dispose?.();for(const m of [].concat(o.material||[]))m.dispose?.()}}catch{}
  for(const {modal} of s.overlays.reverse())modal.close();
  s.bridge?.dialog.close();s.root.remove();document.body.classList.remove('office-open');s.opener?.focus?.({preventScroll:true});
  if(!s.switching)try{s.opts.onClose?.()}catch{}
}
// Each overlay owns a same-URL history entry, so Back returns to the office or its parent overlay.
export function officeHistory(state){
  if(!S)return false;
  const top=S.overlays.at(-1),key=state?.officeOverlay;
  if(!top)return typeof key==='string'&&key.startsWith(S.overlaySession+'/');
  if(key!==top.key){
    const keep=S.overlays.findIndex(entry=>entry.key===key)+1;
    const office=S,removed=office.overlays.splice(keep),expected=office.overlays.at(-1);
    Promise.all(removed.reverse().map(entry=>entry.modal.close())).then(()=>{
      if(S!==office||office.overlays.at(-1)!==expected)return;
      const parent=office.overlays.at(-1)?.modal.el||office.bridge?.dialog||office.root;
      if(parent.contains(document.activeElement))return;
      const from=removed.at(-1)?.from;
      (from?.isConnected&&parent.contains(from)?from:parent).focus({preventScroll:true});
    });
    if(!keep)office.leaveOverlay?.();
  }
  return true;
}
function openOverlay(kind,id){
  const office=S,open=kind==='link'?openLinkDetails:office?.opts.overlays?.[kind];if(!office||!open)return;
  const at=office.overlays.findIndex(entry=>entry.kind===kind&&entry.id===id);
  if(at>=0){
    const distance=office.overlays.length-1-at;
    if(distance)history.go(-distance);
    return;
  }
  clearKeys();office.pointer?.cancelOrbit();
  const key=office.overlaySession+'/'+uid(),from=document.activeElement;
  const modal=open(id,{host:office.root,from,...officeOverlayActions(openOverlay),leaveForAgent:agentId=>{
    const leave=office.opts.overlays.leaveForAgent;
    // Remove the overlay entries as a unit before handing focus over to the AgentFlow tab.
    office.leaveOverlay=()=>{closeOffice();leave?.(agentId)};
    history.go(-office.overlays.length);
  },onClose(){
    if(S!==office)return;
    const i=office.overlays.findIndex(entry=>entry.key===key);
    if(history.state?.officeOverlay===key)history.back();
    else if(i>=0)office.overlays.splice(i,1);
  }});
  if(!modal)return;
  office.overlays.push({kind,id,key,modal,from});
  history.pushState({...history.state,officeOverlay:key},'');
}
function openLinkDetails(url,{host,from,onClose}){
  if(!/^https?:\/\//i.test(url))return;
  const m=detailModal({host,from,onClose,cls:'office-record-modal',label:'Link details',events:{click:e=>{
    if(e.target.closest('[data-office-close]'))m.close();
  }}});
  m.body.innerHTML=`<div class="ihead cd-h"><span class="k">${icon('link')}</span><strong>Link details</strong><span class="sp"></span>${ib('x','Close',{attrs:'data-office-close'})}</div>
    <div class="ibody office-record-body"><p class="office-url">${esc(url)}</p>
      <a class="txt office-leave-link" href="${esc(url)}" target="_blank" rel="noopener">Open website ↗</a></div>`;
  m.body.querySelector('[data-office-close]').focus();
  return m;
}
function switchTo(env){if(!S||env===S.env)return;S.opts.remember?.(env);const opts={...S.opts,env,focus:'',cardId:undefined};S.switching=true;closeOffice();openOffice(opts)}
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
const status=t=>{const el=S?.root.querySelector('.of-status');if(el&&el.textContent!==t)el.textContent=t};

// ---------- the network ----------
const api=(path,body)=>postJson(`/api/office/${encodeURIComponent(S.env)}/${path}`,body);
const postJson=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  .then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(Error(d.error||'Something went wrong'),{code:d.code,status:r.status});return d});
// Replace failed or stalled streams ourselves, including HTTP errors that stop native retries.
function disconnect(restart=false){
  S.es?.close();S.es=null;clearTimeout(S.retry);
  S.retry=setTimeout(connect,S.stream.disconnected({restart}));
  watch();
}
function connect(){
  const cursor=S.stream.cursor,query=cursor?'?lastEventId='+encodeURIComponent(cursor):'';
  const es=new EventSource(`/api/office/${encodeURIComponent(S.env)}/events${query}`);S.es=es;S.heard=Date.now();
  const on=(type,f)=>es.addEventListener(type,e=>{
    if(S?.es!==es)return;
    S.heard=Date.now();
    try{
      const data=JSON.parse(e.data);
      if(!liveDuringReplay(type,data))f(data);
      if(['join','leave','agents','members','snapshot'].includes(type))S.composer.refresh();
      S.stream.received(e.lastEventId);
    }catch(err){console.error('office',type,err)}
  });
  on('snapshot',d=>{snapshot(d);S.stream.connected();watch()});
  // Access ended (the share was revoked): say so and stay disconnected.
  on('gone',()=>{S.gone=true;S.replay?.finish(false);S.liveFeed=null;S.es?.close();S.es=null;clearTimeout(S.retry);showGone()});
  // Doors changed (a share made or revoked): office-portals.js.
  on('portals',list=>{S.portalList=Array.isArray(list)?list:[];if(S.world)buildDoors()});
  on('restart',()=>disconnect(true));
  on('yourSources',updateSources);
  on('hb',()=>{});
  S.presence?.bind(on);
  on('join',p=>{if(!S.world)return;const joined=!S.people.has(p.key);upsertPerson(p);if(joined)presenceChanged(p.key)});
  on('move',p=>{if(S.world)upsertPerson(p)});
  on('leave',({key,at})=>{S.absent.delete(key);removePerson(key);const m=S.members.find(x=>x.key===key);if(m&&at)m.lastSeen=at;if(S.world)presenceChanged(key)});
  on('say',line=>S.composer.receive(line));
  on('chatHint',hint=>{if(!S.replay?.active)showChatHint(hint)});
  on('emote',({key,emote})=>showEmote(key,emote));
  // Someone saved a new look (office-look-editor.js), or went back to their default (look: null).
  on('look',({key,look})=>setLook(key,look));
  on('rtc',d=>S.voice?.event(d)); // voice signalling (office-voice.js, lib/office-rtc.mjs)
  on('agents',({member,agents})=>{S.live.set(member,agents);if(member===S.meKey)answersSeen(agents);if(S.world){buildDesks(member);seatsChanged()}S.chief?.update();S.chief?.agents(member,agents);refreshPanel();focusPending();S.presence?.observeWaiting(member,agents);S.meters?.invalidate()});
  on('meters',d=>{S.sparks=d.sparks||{};S.meters?.invalidate()});
  on('members',({members,agentflow,world})=>{if(world)S.serverWorld=world;if(S.world)usePlace(wantedWorld());updateRooms(members,agentflow);refreshPanel()});
  on('decor',row=>{if(S.world)S.decor?.remote(row)});
  // Messages and stops (office-steer.js) are tracked apart from Allow / Deny answers.
  on('action',a=>{if(S.steer.isSteer(a))S.steer.track(a,'sent');else answerSent(a)});
  on('result',a=>{
    const isSteer=S.steer.isSteer(a);
    if(isSteer)S.steer.track(a,'done');else answerResult(a);
    if(S.replay?.active)S.presence?.toast(a.result?.message||(a.result?.ok?'Done':'Agent action failed'),!a.result?.ok);
    else if(isSteer)S.opts.toast?.(a.result?.message||'Done',a.result&&!a.result.ok);
  });
  // A nod, a shake, or working until the result, for anyone's agent (lib/office.mjs: no prompt text).
  on('reaction',r=>{const k=r.member+'|'+r.agent;if(r.phase==='answered')S.reactions?.react(k,r.decision);else if(!r.ok||r.decision==='deny')S.reactions?.settle(k)});
  es.onerror=()=>{if(S?.es===es)disconnect()};
}
// Keep the live data current while its actors are off-stage.
function liveDuringReplay(type,data){
  const replay=S.replay?.active;
  if(type==='snapshot'){
    S.liveFeed={data:{...data,live:{...data.live}},people:new Map(data.people.map(p=>[p.key,p]))};
    if(replay){
      S.stream.connected();
      updateSources(data.yourSources||[]);
      S.portalList=data.portals||[];S.serverWorld=data.env?.world;
      if(S.world){usePlace(wantedWorld());buildDoors()}
      for(const a of data.actions||[]){
        if(S.steer.isSteer(a))S.steer.track(a,a.result?'done':'sent');
        else if(a.result)answerResult(a);
        else if(!S.answers.has(a.agentId))answerSent(a);
      }
      for(const line of data.chat||[])addLine(line,{quiet:true});
      S.presence?.onSnapshot(data);
      updateRooms(data.members,data.agentflow);
      S.replay.reload();
    }
    return replay;
  }
  const feed=S.liveFeed;
  if(!feed)return false;
  if(type==='join'||type==='move')feed.people.set(data.key,data);
  else if(type==='leave'){
    feed.people.delete(data.key);
    const member=feed.data.members.find(m=>m.key===data.key);
    if(member&&data.at)member.lastSeen=data.at;
  }else if(type==='portals')feed.data.portals=data;
  else if(type==='members'){
    feed.data.members=data.members;feed.data.agentflow=data.agentflow;
    if(data.world){feed.data.env={...feed.data.env,world:data.world};S.serverWorld=data.world}
    if(replay){if(S.world)usePlace(wantedWorld());updateRooms(data.members,data.agentflow);S.replay.reload()}
  }else if(type==='agents'){
    const previous=feed.data.live[data.member]||[];
    feed.data.live[data.member]=data.agents;
    if(replay&&data.member===S.meKey){
      answersSeen(data.agents);
      S.presence?.observeWaiting(data.member,data.agents);
      const waits=new Map(previous.filter(a=>a.status==='waiting').map(a=>[a.source+'|'+a.id,a.pending?.requestId||'']));
      if(!presenceStatus.isQuiet(S.meKey))for(const a of data.agents){
        if(a.status==='waiting'&&waits.get(a.source+'|'+a.id)!==(a.pending?.requestId||''))S.presence?.toast(`Live · ${a.title||'An agent'} is waiting`);
      }
    }
  }else if(replay&&type==='say'){addLine(data,{quiet:true});return true}
  return replay&&['join','move','leave','agents','members','reaction','emote'].includes(type);
}

function clearReplayScene(){
  if(!S.world)return;
  closePanel();closeMenu();S.interact?.closeOpen();clearKeys();
  S.follow=S.target=null;
  S.reactions?.reset();
  S.absent.clear();S.live.clear();
  for(const key of S.people.keys())removePerson(key);
  for(const key of S.rooms.keys())buildDesks(key,false);
  updateColliders();presenceChanged();
  S.boards?.setVisible(!S.replay?.active);S.devops?.setVisible(!S.replay?.active);
}

function replayScene({roster,poses},seek){
  if(!S.world)return;
  let presence=false;
  for(const key of S.people.keys())if(!poses.has(key)){removePerson(key);presence=true}
  for(const [key,pose] of poses){
    let p=S.people.get(key);
    if(!p){
      p=upsertPerson({key,name:key===S.meKey?'You':S.members.find(m=>m.key===key)?.name||'Guest',...pose});
      if(key===S.meKey){p.obj.visible=false;p.tag.show=()=>false}
      presence=true;
    }
    p.replayPose=pose;
    p.obj.position.set(pose.x,pose.y,pose.z);
  }
  const changed=[];
  for(const key of new Set([...S.live.keys(),...roster.keys()])){
    const prev=S.live.get(key)||[],next=roster.get(key)||[];
    if(prev.length!==next.length||prev.some((a,i)=>a!==next[i]))changed.push(key);
  }
  S.live=roster;
  for(const key of changed)buildDesks(key,false);
  if(changed.length)updateColliders();
  if(presence)presenceChanged();else if(changed.length)seatsChanged();
  if(seek){S.reactions?.reset();S.activity?.reset();for(let i=0;i<16;i++)S.activity?.tick(.1,i*.1)}
}
function restoreLiveScene(){
  const feed=S.liveFeed;
  if(feed&&!S.gone)snapshot({...feed.data,actions:[],people:[...feed.people.values()],resumedHere:true});
  watch();
}

function watch(){
  if(!S)return;
  S.presence?.tickIdle();
  if(S.gone){status('No longer shared with you');S.root.querySelector('[data-of-replay]').disabled=true;return}
  const now=Date.now();
  if(S.es&&now-S.heard>40000){disconnect();return}
  if(S.replay?.active)return;
  if(!S.stream.stale){
    let changed=false;
    for(const [key,until] of S.absent)if(now>=until){S.absent.delete(key);removePerson(key);roomLook(key);changed=true}
    if(changed)buildAgentflow();
  }
  const phase=S.stream.phase;
  const el=S.root.querySelector('.of-status');
  el.classList.toggle('stale',S.stream.stale&&!!S.me);
  if(phase==='unreachable')status('Cannot reach the office. Still trying…');
  else if(phase==='reconnecting')status('Reconnecting…');
  else if(!S.stream.stale&&S.me)status(`Live · ${S.members.length} ${S.members.length===1?'room':'rooms'} · ${S.people.size} here`);
}
function updateRooms(members,agentflow){
  const roomShape=rows=>rows.map(({key,name,owner,me})=>[key,name,owner,me]);
  const changed=!S.placed||JSON.stringify(roomShape(S.members))!==JSON.stringify(roomShape(members));
  const afChanged=!S.placed||JSON.stringify(S.snapAgentflow)!==JSON.stringify(agentflow);
  S.members=members;S.snapAgentflow=agentflow;
  S.root.querySelector('[data-of-replay]').disabled=!S.world||!members.some(m=>m.key===S.meKey);
  if(!S.world)return;
  if(afChanged)buildAgentflow();
  if(changed)buildRooms();
  else for(const m of members){const room=S.rooms.get(m.key);if(room){room.member=m;roomLook(m.key)}}
  S.chief?.update();
}
function snapshot(d){
  const previous=S.live;
  if(S.meKey&&S.meKey!==d.me.key)removePerson(S.meKey);
  S.meKey=d.me.key;S.me=d.me;
  S.decor?.load(d.decor);
  S.live=new Map(Object.entries(d.live||{}));S.sparks=d.sparks||{};S.portalList=d.portals||[];
  S.serverWorld=d.env?.world;if(S.world)usePlace(wantedWorld());
  for(const key of new Set([...S.looks.keys(),...Object.keys(d.looks||{})]))setLook(key,d.looks?.[key]||null);
  updateSources(d.yourSources||[]);
  updateRooms(d.members,d.agentflow);if(S.world)buildDoors();S.boards?.invalidate();S.meters?.invalidate();
  for(const a of d.actions||[])if(S.steer.isSteer(a))S.steer.track(a,a.result?'done':'sent');else if(!S.answers.has(a.agentId))S.answers.set(a.agentId,{...a,state:a.result?(a.result.ok?'done':'failed'):'sent',at:Date.parse(a.at)||Date.now()});
  for(const line of mergeOfficeChat(S.chat,d.chat||[]))addLine(line,{quiet:true});
  if(S.world){
    const changed=officeDiff([...previous],[...S.live],([key])=>key);
    for(const [key] of changed.upsert)buildDesks(key);
    for(const key of changed.remove)buildDesks(key);
    if(changed.upsert.length||changed.remove.length)seatsChanged();
    if(!S.placed){
      S.placed=true;arrive();
    }
    const {x,y,z,heading}=S.controller.state;
    if(!S.people.has(S.meKey))upsertPerson({key:S.meKey,name:S.opts.me?.name||d.me.name,image:S.opts.me?.image||'',x,y,z,heading,moving:false},true);
    const diff=officeDiff([...S.people.values()].filter(p=>!p.self),d.people.filter(p=>p.key!==S.meKey),p=>p.key,()=>false);
    let joined=false;
    for(const p of diff.upsert){joined||=!S.people.has(p.key);upsertPerson(p)}
    for(const key of diff.remove){
      // The new process starts with empty positions. Give peers time to send their poses.
      if(d.resumedHere) {S.absent.delete(key);removePerson(key);roomLook(key);joined=true}
      else if(!S.absent.has(key))S.absent.set(key,Date.now()+10000);
    }
    if(joined)presenceChanged();
  }
  sendPresence(true);refreshPanel();focusPending();
  S.presence?.onSnapshot(d);
  for(const [member,agents] of S.live)S.presence?.observeWaiting(member,agents);
  S.chief?.update();S.chief?.agents(S.meKey,S.live.get(S.meKey)||[]);
}
function updateSources(sources){
  S.sources=sources;S.bridge?.updateSources(sources);
  const empty=!sources.length;
  S.root.querySelector('.of-connect-callout').hidden=!empty;
  const link=S.root.querySelector('.of-connect-link');link.hidden=empty;
  // Connected already: the header button is for adding another machine, so say so.
  if(!empty){const n=sources.length;link.textContent=`✓ ${n} machine${n===1?'':'s'} connected · Add another`;link.title=sources.map(x=>x.source||x.name||'').filter(Boolean).join(', ')}
}
function connectAgents(opener){
  const office=S;
  // The current workspace owns the key even when visiting another workspace's office.
  // In an environment shared with you (opts.keyEnv), the key is for your own environment.
  const env=office.opts.keyEnv||office.opts.current,name=office.opts.keyEnvName||office.opts.offices.find(o=>o.id===env)?.name;
  clearKeys();office.pointer?.cancelOrbit();
  const bridge=openBridgeDialog({env,envName:name,sources:office.sources,openProjects:()=>{
    openOverlay('projects');
  }});
  office.bridge=bridge;
  bridge.dialog.addEventListener('keydown',e=>e.stopPropagation());
  office.root.append(bridge.dialog);bridge.dialog.showModal();
  bridge.dialog.addEventListener('close',()=>{
    if(S!==office||office.bridge!==bridge)return;
    office.bridge=null;
    (opener.hidden||opener.closest('[hidden]')?office.root.querySelector('[data-of="connect"]:not([hidden])'):opener).focus();
  },{once:true});
}
function sendPresence(force){
  const t=performance.now();
  if(S.replay?.active||(!force&&(S.stream.stale||t-S.sentAt<SEND_MS)))return;
  const {x,y,z,heading,speed,grounded,sprinting}=S.controller.state;
  const rounded=n=>Math.round(n*100)/100;
  const pose={x:rounded(x),y:rounded(y),z:rounded(z),heading:rounded(heading),moving:speed>0.05,jump:!grounded,sprint:sprinting};
  const sig=JSON.stringify(pose);
  if(!force&&sig===S.lastSent)return;
  const office=S;S.sentAt=t;S.lastSent=sig;
  if(force&&typeof S.me?.status==='string')pose.status=S.me.status;
  api('presence',pose).catch(()=>{if(S===office&&S.lastSent===sig)S.lastSent=''})
}

// ---------- the scene ----------
const M={};
const mat=(c,o={})=>new THREE.MeshLambertMaterial({color:c,flatShading:true,...o});
function initScene(){
  // alpha: the main board's DOM shows through where the canvas is clear (office-devops.js).
  const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power',alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;
  S.stage.prepend(renderer.domElement);renderer.domElement.className='of-canvas';
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,1,0.08,1400);
  Object.assign(M,{
    box:new THREE.BoxGeometry(1,1,1),ico:new THREE.IcosahedronGeometry(1,0),ico1:new THREE.IcosahedronGeometry(1,1),oct:new THREE.OctahedronGeometry(1,0),
    cyl:new THREE.CylinderGeometry(1,1,1,7),cone:new THREE.ConeGeometry(1,1,6),torus:new THREE.TorusGeometry(0.62,0.12,5,14),disc:new THREE.CircleGeometry(1,16),
    wall:mat('#f9fbfa'),hit:new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false}),desk:mat('#b98d63'),screenOff:mat('#3b4542'),dark:mat('#1d2421'),white:mat('#ffffff'),plinth:mat('#c9d2cd'),trim:mat('#3d4c56'),glass:new THREE.MeshBasicMaterial({color:'#d3ebf3'}),pot:mat('#b5835a'),leaf:mat('#5f9e6e'),shadow:new THREE.MeshBasicMaterial({color:'#000',transparent:true,opacity:.14,depthWrite:false}),
  });
  S.world=new THREE.Group();scene.add(S.world);
  Object.assign(S,{renderer,scene,camera,ray:new THREE.Raycaster(),clock:new THREE.Clock()});
  // Everyone but people's avatars moves like an NPC: along paths, never snapping (office-npc.js).
  S.npcLayer=new THREE.Group();S.world.add(S.npcLayer);
  S.npc=createNpcs({THREE,layer:S.npcLayer,world:S.world,
    navWorld,person:key=>S.people.get(key),isQuiet:key=>presenceStatus.isQuiet(key),
    inMeeting:key=>{const p=S?.people.get(key)?.obj.position;return !!p&&!!S.voice?.inMeeting?.(p.x,p.z)},
    room:roomSpots,boardSpot:key=>(key==null?S.devops?.spot():S.boards?.spot(key))||null,
    entrance:()=>S.npcEntrance||S.place?.spawn||{x:0,z:(S.commonR||10)+1.5},commonRadius:()=>S.commonR||10,player:()=>S.pos,
    label,unlabel:l=>{l.el.remove();S.labelList=S.labelList.filter(x=>x!==l)},
    // A figure that outlived its desk or its place in the org (walking out): nothing to click or press E on.
    retire:obj=>{const u=obj.userData;S.clickables=S.clickables.filter(c=>c!==obj);if(u?.kind==='agent')S.interact?.unregister(`agent:${u.member}:${u.id}`);else if(u?.kind==='af')S.interact?.unregister('af:'+u.id)}});
  S.activity=createActivity({THREE,part,M,roomW:ROOM_W,roomD:ROOM_D,npc:S.npc});
  const office=S,openCard=id=>openOverlay('card',id);
  // The main board's title: the office's environment, and "This office ▸" when doors lead to others.
  const boardName=()=>{const name=office.opts.offices.find(o=>o.id===office.env)?.name||'This office';return office.portalList?.length?`This office ▸ ${name}`:name};
  // The main whiteboard is the DevOps tab's own board (office-devops.js).
  S.devops=createOfficeDevops({stage:S.stage,root:S.root,world:S.world,camera,position:()=>office.pos,frameParts:(w,h)=>boardFrame(w,h),envName:boardName,
    local:()=>office.env===office.opts.current,here:()=>office.opts.offices.find(o=>o.id===office.opts.current)?.name||'',
    openHere:S.opts.openEnv?()=>office.opts.openEnv(office.env):null,openCard,
    onFocus(){clearKeys();office.pointer?.cancelOrbit();office.target=null;office.follow=null;closeMenu();closePanel()},
    // Its width follows the screen's shape: the office meter beside it moves along.
    onResize:()=>office.meters?.rebuild(office.rooms,{commonRadius:office.commonR||10,roomD:ROOM_D})});
  usePlace(wantedWorld());
  const fit=()=>{const w=S.stage.clientWidth||innerWidth,h=S.stage.clientHeight||innerHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();S.devops.resize(w,h)};
  S.resize=new ResizeObserver(fit);S.resize.observe(S.stage);fit();
  const cv=renderer.domElement;
  S.rig=createOfficeCamera(camera);S.rig.reset(S.pos,S.controller.state.heading);
  cv.addEventListener('pointerdown',()=>S.root.focus({preventScroll:true}));
  // E: talk to, open or look at whatever you are near (office-interact.js; other modules register their own things).
  S.reactions=createReactions(THREE);
  S.interact=createInteractions({scene,camera,stage:S.stage,player:()=>({x:S.pos.x,z:S.pos.z,heading:S.controller?.state.heading}),facing:()=>S.rig?S.rig.yaw+Math.PI:NaN,
    toast:m=>S?.opts.toast?.(m,true),stale:id=>{if(!S?.world)return;if(id.startsWith('af:'))buildAgentflow();else for(const k of S.rooms.keys())buildDesks(k,false)}});
  S.meters=createOfficeMeters({world:S.world,root:S.root,env:()=>S.env,position:()=>office.pos,members:()=>S.members,live:()=>S.live,sparks:()=>S.sparks||{},meKey:()=>S.meKey,
    label:(obj,html,opts)=>label(obj,html,opts),unlabel:hint=>{if(!hint)return;hint.el.remove();office.labelList=office.labelList.filter(l=>l!==hint)},
    anchor:key=>meterMount(key),interact:()=>office.interact}); // office, not S: these also run while it closes
  // Voice (office-voice.js): the meeting room's call, proximity voice and screen sharing.
  S.voice=createVoice({scene,world:S.world,stage:S.stage,root:S.root,interact:S.interact,label,clear,env:()=>office.env,me:()=>office.pos,
    facing:()=>office.rig?office.rig.yaw+Math.PI:office.controller.state.heading,people:()=>office.people,meKey:()=>office.meKey,nameOf,
    quiet:()=>presenceStatus.isQuiet(office.meKey), // Do not disturb: no proximity calls
    layout:()=>({world:office.worldLayout,rooms:[...office.rooms.values()].map(r=>({x:r.center.x,z:r.center.z})),commonR:office.commonR||10,roomW:ROOM_W,roomD:ROOM_D}),
    walkTo:(x,z)=>{office.follow=null;office.target=x==null?null:new THREE.Vector3(x,0,z)},walking:()=>!!office.target,
    toast:(m,bad)=>office.opts.toast?.(m,bad)});
  // Your Chief of Staff (office-chief.js): your conductor as a companion that walks with you and takes /cos.
  S.chief=createChief({root:S.root,meKey:()=>office.meKey,members:()=>office.members,live:()=>office.live,af:afAgents,deskKey,npc:S.npc,
    label,unlabel:l=>{if(!l)return;l.el.remove();office.labelList=office.labelList.filter(x=>x!==l)},labelAlive:l=>office.labelList.includes(l),
    interact:S.interact,openPanel,post:body=>api('steer',body),toast:(m,bad)=>office.opts.toast?.(m,bad),isQuiet:key=>presenceStatus.isQuiet(key),
    cardId:n=>office.env===office.opts.current&&office.opts.overlays?.card?store.db?.devops?.cards?.find(c=>c.number===n)?.id||null:null,openCard,
    cards:()=>office.env===office.opts.current?store.db?.devops?.cards||[]:[],refs:()=>{const m=office.members.find(x=>x.me);return m?officeMemberRefs(store.db,m):[]},
    myName:()=>office.opts.me?.name||office.me?.name||'',afName:id=>afOf(id)?.name||'',lines:()=>office.lines,
    showAgent:(member,id)=>showAgent(member,id),repaint:()=>{if(office.panelFor?.type==='chief'&&!office.panel.hidden)refreshPanel()}});
  S.boards=createOfficeBoards({env:S.env,world:S.world,camera,position:()=>office.pos,agents:afAgents,openCard,
    seatCard:entry=>{
      const {kind,member,id}=entry.obj.userData;
      if(kind!=='agent'||!entry.cls?.includes('agent'))return null;
      // No badge on the way to the board to fetch it: it has the card once it took it (office-npc.js).
      const a=agentOf(member,id);return a&&!S.npc?.hidesCard(deskKey(member,a))?a.seat?.card:null;
    }});
  S.cardDrag=createOfficeCardDrag({root:S.root,env:S.env,local:()=>S.env===S.opts.current,hitAt,targetAt:cardTargetAt,openCard});
  S.pointer=bindOfficePointer(cv,S.rig,{pick,recenter:recenterCamera,grab:e=>S.replay?.active?null:S.cardDrag.grab(e),
    hover:e=>{S.decor?.hover(e);if(S.decor?.editing()){cv.style.cursor='crosshair';return}if(e.pointerType==='touch')return;const hit=hitAt(e);cv.style.cursor=hit?.kind||hit?.board?.near&&hit.board.tile?'pointer':'default';S.hover=hit?.kind==='af'?hit.id:hit?.kind==='agent'?hit.obj.userData.id:null}});
  // office, not S: the decor also runs while the office closes (S is null by then).
  S.decor=createDecor({
    root:()=>office.root,me:()=>office.meKey,pos:()=>office.pos,rooms:()=>office.rooms,liveCount:key=>(office.live.get(key)||[]).length,
    anchor(key){const layout=office.worldLayout,list=layout?.decorAnchors?.()||[];return list.find(a=>a.key===key)||layout?.decorAnchor?.(key)||null},
    api:(path,body)=>api(path,body),toast:(m,bad)=>S?.opts.toast?.(m,bad),camera:()=>office.camera,canvas:()=>office.renderer?.domElement,
    refresh:()=>updateColliders(),repaint:key=>roomLook(key),
  });
  if(navigator.webdriver&&globalThis.__flowOffice)Object.assign(globalThis.__flowOffice,{project:(x,z)=>S.decor.project(x,z),decor:()=>S.decor.debug()});
  const loop=()=>{if(!S)return;S.raf=requestAnimationFrame(loop);const delta=S.clock.getDelta();frame(Math.min(.05,delta),S.clock.elapsedTime,delta)};loop();
}
function toggleOverview(){
  if(!S.rig)return;
  const on=S.rig.toggleOverview();
  S.root.querySelector('[data-of="overview"]').setAttribute('aria-pressed',String(on));
  S.root.classList.toggle('of-overview',on);
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
// Also called while the office closes (S is null by then: office-voice.js disposing its room), with nothing left to unlist.
function clear(group){group.removeFromParent();const g=new Set();group.traverse(o=>g.add(o));for(const o of g){if(o.material&&o.userData.own)o.material.dispose();o.userData.dispose?.()}if(!S)return;S.clickables=S.clickables.filter(c=>!g.has(c));S.labelList=S.labelList.filter(l=>{if(g.has(l.obj)){l.el.remove();return false}return true})}
// top: the label hangs below its point (a plate on a wall) instead of standing on it.
function label(obj,html,{y=1.6,cls='',near=0,show=null,top=false}={}){const el=document.createElement('div');el.className='of-label '+cls;el.innerHTML=html;S.labels.append(el);const l={obj,el,y,cls,near,show,top};S.labelList.push(l);return l}

// ---------- the world ----------
// What everyone stands in (office-world.js): the classic office, or the yacht. The environment says which
// (its AgentFlow data's office.world); in your own environment the picker in the top bar changes it for
// everyone. S.world is the group that holds rooms, people and agents; S.place is the world around them.
const MOTION_KEY='flow.office.seaMotion';
function seaMotion(){try{const v=localStorage.getItem(MOTION_KEY);if(v)return v==='1'}catch{}return !matchMedia('(prefers-reduced-motion: reduce)').matches}
const mine=()=>S.env===S.opts.current;
const wantedWorld=()=>worldId(mine()&&S.opts.world?S.opts.world():S.serverWorld);
function usePlace(id){
  if(S.place?.id===id)return;
  S.place?.dispose();S.place=createWorld(id,{scene:S.scene,deck:S.world});
  S.root.style.background=S.place.background;S.root.dataset.world=id;S.place.common(S.commonR||10);
  const pick=S.root.querySelector('.of-world');pick.value=id;pick.hidden=!(mine()&&S.opts.setWorld);
  S.root.querySelector('.of-motion-row').hidden=S.place.sea===-Infinity;
  if(!S.placed)return;
  buildRooms();arrive();S.boards?.invalidate();sendPresence(true);
}
// Stand at my room's door (or where this world lets people in).
function arrive(){
  const r=S.rooms.get(S.meKey),at=S.place.spawn,heading=r?r.facing:at.heading;
  if(r)S.pos.copy(r.door);else S.pos.set(at.x,at.y,at.z);
  S.floor=S.pos.y;S.target=S.follow=null;S.controller.reset(S.pos,heading);S.rig?.reset(S.pos,heading);
}
// Walls as the camera needs them: measured up from the deck I stand on.
function cameraWalls(){
  const c=S.camWalls;
  if(!c||c.src!==S.walls||c.n!==S.walls.length||Math.abs(c.floor-S.floor)>0.04)S.camWalls=Object.assign(wallsFrom(S.walls,S.floor),{src:S.walls,n:S.walls.length,floor:S.floor});
  return S.camWalls;
}

// ---------- rooms ----------
// The world (office-layout.js) places the rooms and the main board's feature wall. A room has low walls so
// you can see in, a tall back wall its whiteboard hangs on, and a door with its name plate beside it.
function buildRooms(){
  if(S.signs)clear(S.signs);
  const previous=S.rooms;
  S.rooms=new Map();
  for(const r of previous.values())clear(r.group);
  if(S.mainWall){clear(S.mainWall);S.mainWall=null}
  S.walls=[];
  S.interact?.unregister('mirror');
  const list=[...S.members].sort((a,b)=>(b.owner-a.owner)||String(a.name).localeCompare(b.name));
  const byKey=new Map(list.map(m=>[m.key,m]));
  S.worldLayout=S.place.layout(list.map(m=>m.key),{commonR:S.commonR||10});
  S.overviewRadius=Math.max(12,S.worldLayout.radius+8);
  // Boxes are solid from their top down, so one on a raised deck is that much taller.
  const boxAt=(frame,x,z,w,d,h)=>{const p=toWorld(frame,x,z);S.walls.push(officeBox(p.x,p.z,frame.facing,w,d,h+(frame.y||0)))};
  S.signs=new THREE.Group();S.world.add(S.signs);
  for(const n of S.place.signs){const o=new THREE.Object3D();o.position.set(n.x,n.y,n.z);S.signs.add(o);label(o,`<span class="of-sign">${esc(n.text)}</span>`,{y:0,cls:'sign',near:26})}
  for(const slot of S.worldLayout.rooms){
    const m=byKey.get(slot.key),c=new THREE.Vector3(slot.x,slot.y||0,slot.z),facing=slot.facing;
    const [bg,fg]=memberColor(m.key),g=new THREE.Group();g.position.copy(c);g.rotation.y=facing;
    const floorMat=mat(bg),floor=part(M.box,floorMat,[0,0.03,0],[ROOM_W,0.06,ROOM_D]);floor.userData.own=true;g.add(floor);
    // One material per room so a theme can recolour these walls without painting every room.
    const wallMat=M.wall.clone();let wallOwned=false;
    const wall=(x,z,w,d,h=WALL_H)=>{const mesh=part(M.box,wallMat,[x,h/2,z],[w,h,d]);mesh.userData.wall=true;if(!wallOwned){mesh.userData.own=true;wallOwned=true}g.add(mesh);boxAt(slot,x,z,w,d,h)};
    wall(0,-ROOM_D/2,ROOM_W,WALL_T,BACK_WALL_H);wall(-ROOM_W/2,0,WALL_T,ROOM_D);wall(ROOM_W/2,0,WALL_T,ROOM_D);
    const side=(ROOM_W-DOOR_W)/2;wall(-(DOOR_W/2+side/2),ROOM_D/2,side,WALL_T);wall(DOOR_W/2+side/2,ROOM_D/2,side,WALL_T);
    const accent=mat(fg);accent.userData.own=true;
    const stripe=part(M.box,accent,[0,BACK_WALL_H+0.03,-ROOM_D/2],[ROOM_W,0.06,WALL_T+0.04]);stripe.userData.own=true;g.add(stripe);
    // Door posts in the member's colour mark the way in.
    for(const x of [-DOOR_W/2,DOOR_W/2]){const post=part(M.box,accent,[x,0.75,ROOM_D/2],[0.16,1.5,0.26]);post.userData.own=true;g.add(post);boxAt(slot,x,ROOM_D/2,0.16,0.26,1.5)}
    S.world.add(g);
    // The name plate hangs on the front wall beside the door: below the top of the wall on screen, so it
    // never covers the room's board, which is higher and further back. It also says who is away and
    // whether agents are running, so nothing floats inside the room.
    const sign=new THREE.Object3D();sign.position.set(DOOR_W/2+side/2,0,ROOM_D/2+WALL_T/2+0.02);g.add(sign);
    const tag=label(sign,`<span class="of-room" data-office-person="${esc(m.key)}" style="--c:${fg}"><b>${esc(m.name)}</b>${m.me?' · your room':''}<small></small></span>`,{y:WALL_H-0.08,cls:'room',top:true});
    const door=new THREE.Vector3(0,0,ROOM_D/2-1.6).applyAxisAngle(new THREE.Vector3(0,1,0),facing).add(c);
    const entrance=new THREE.Vector3(0,0,ROOM_D/2).applyAxisAngle(new THREE.Vector3(0,1,0),facing).add(c);
    if(m.me){
      // A standing mirror by your door: E there opens the look editor.
      const mx=ROOM_W/2-0.42,mz=ROOM_D/2-1.9,mirror=new THREE.Group();mirror.position.set(mx,0,mz);mirror.rotation.y=-Math.PI/2;
      mirror.add(part(M.box,M.trim,[0,1.02,-0.03],[0.86,1.9,0.06]),part(M.box,M.glass,[0,1.04,0.006],[0.72,1.72,0.02]),part(M.box,M.trim,[0,0.04,0],[0.7,0.08,0.36]));
      g.add(mirror);boxAt(slot,mx,mz,0.36,0.86,1.9);
      // Anchored on the mirror itself (you cannot stand inside it), and ahead of the room's meter when you face it.
      const at=toWorld(slot,mx,mz);
      S.interact?.register({id:'mirror',position:()=>({x:at.x,y:0,z:at.z}),radius:2.1,height:2.15,priority:2,label:'Edit your look',onInteract:()=>{openLook();return {close:()=>S?.lookEditor?.close(),isOpen:()=>!!S?.lookEditor}}});
    }
    S.rooms.set(m.key,{member:m,group:g,center:c,facing,door,entrance,desks:previous.get(m.key)?.desks,boxes:[],floorMat,wallMat,bg,fg,tag,note:previous.get(m.key)?.note||'',seen:''});roomLook(m.key);
    buildDesks(m.key,false);
  }
  for(const [key,r] of previous)if(!S.rooms.has(key)&&r.desks)clear(r.desks);
  buildMainWall();
  S.walls.push(...S.place.walls);
  buildDoors();
  S.presence?.syncDoors();
  S.voice?.layout();S.walls.push(...(S.voice?.walls||[])); // the meeting room's glass stops people and the camera
  // NPCs that are new to the office walk in from the edge of the common area, on the main wall's side (or
  // where the world lets people in).
  {const w=S.place.id==='classic'&&S.worldLayout.mainWall,d=w&&Math.hypot(w.x,w.z),r=(S.commonR||10)+1.5;S.npcEntrance=d?{x:w.x/d*r,z:w.z/d*r}:S.place.spawn?{x:S.place.spawn.x,z:S.place.spawn.z}:null}
  updateColliders();
  S.decor?.mount();
  const anchors=S.worldLayout.boardAnchors();
  S.boards?.rebuild({rooms:anchors.rooms.map(a=>({...a,member:S.rooms.get(a.key).member}))});
  S.devops?.rebuild(anchors.main);
  // E at a room's board opens the first card in the lane in front of you; at the main board, it takes you to it.
  S.interact?.unregisterWhere(id=>id.startsWith('board:'));
  for(const a of anchors.rooms){
    const key=a.key,spot={x:a.x+a.nx*1.8,y:0,z:a.z+a.nz*1.8},tile=()=>S.boards?.tileNear(key,S.pos);
    S.interact?.register({id:'board:'+key,position:()=>spot,radius:a.width/2+0.6,height:a.y-a.height/2-0.2,
      enabled:()=>!!tile(),label:()=>{const t=tile();return t?`Open #${t.number} ${t.title.length>28?t.title.slice(0,27)+'…':t.title}`:''},
      onInteract:()=>{const t=tile();if(t)S.boards.pick({near:true,tile:t})}});
  }
  const main=anchors.main,spot={x:main.x+main.nx*1.8,y:0,z:main.z+main.nz*1.8};
  S.interact?.register({id:'board:main',position:()=>spot,radius:Math.max(3,(S.devops?.width()||main.width)/2+0.6),height:main.y-main.height/2-0.2,
    enabled:()=>!S.replay?.active,label:'Work on the DevOps board',onInteract:()=>S.devops?.focus()||false});
  S.meters?.rebuild(S.rooms,{commonRadius:S.commonR||10,roomD:ROOM_D});
}
// key null is the office meter. A world's meterAnchors() wins; the meter module has a local fallback.
function meterMount(key){
  const all=S?.worldLayout?.meterAnchors?.();if(!all)return null;
  // The office meter stands beside the DevOps board, whose width follows the screen (office-devops.js).
  if(key==null||key==='office')return S.worldLayout.mainWall&&S.devops?.width()?officeMeterMount(S.worldLayout.mainWall,S.devops.width()):all.main||all.office||null;
  return all.rooms?.find(r=>r.key===key)||all[key]||null;
}
// The main board's feature wall: a freestanding wall on a plinth, with a planter at each end.
function buildMainWall(){
  const w=S.worldLayout.mainWall,y=w.y||0,g=new THREE.Group();g.position.set(w.x,y,w.z);g.rotation.y=w.facing;S.mainWall=g;
  g.add(part(M.box,M.wall,[0,w.height/2,0],[w.width,w.height,w.depth]));
  g.add(part(M.box,M.plinth,[0,0.09,0],[w.width+0.3,0.18,w.depth+0.3]));
  g.add(part(M.box,M.trim,[0,w.height+0.04,0],[w.width+0.1,0.08,w.depth+0.1]));
  S.walls.push(officeBox(w.x,w.z,w.facing,w.width+0.3,w.depth+0.3,w.height+y));
  for(const x of [-w.width/2-0.75,w.width/2+0.75]){
    g.add(part(M.cyl,M.pot,[x,0.3,0.4],[0.4,0.6,0.4]),part(M.cone,M.leaf,[x,1.15,0.4],[0.62,1.25,0.62]),part(M.cone,M.leaf,[x,1.75,0.4],[0.45,0.95,0.45]));
    const p=toWorld(w,x,0.4);S.walls.push(officeBox(p.x,p.z,w.facing,0.85,0.85,0.6+y));
  }
  S.world.add(g);
}
// A room is lit while its member has the office open; otherwise dimmed, with when they were last here.
const ago=iso=>{const t=Date.parse(iso);if(!t)return '';const m=Math.round((Date.now()-t)/60000);return m<1?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`};
function roomLook(key){
  const r=S.rooms.get(key);if(!r)return;const on=S.people.has(key)||(!S.replay?.active&&r.member.me);
  const theme=S.decor?.themeOf(key);
  r.floorMat.color.set(theme?.floor||r.bg);r.wallMat?.color.set(theme?.wall||'#f9fbfa');
  if(!on){r.floorMat.color.lerp(new THREE.Color('#d5d9d7'),.6);r.wallMat?.color.lerp(new THREE.Color('#d5d9d7'),.45)}
  r.tag.el.classList.toggle('off',!on);
  const seen=ago(r.member.lastSeen);r.seen=seen;
  if(S.presence)S.presence.paintRoom(r,on);
  else{
    const parts=[on?'':`offline${seen?` · last seen ${seen}`:''}`,r.note].filter(Boolean);
    r.tag.el.querySelector('small').textContent=parts.length?' · '+parts.join(' · '):'';
  }
}
function presenceChanged(key){if(key)roomLook(key);else for(const k of S.rooms.keys())roomLook(k);buildAgentflow()}
// A member's live agents at desks: up to 4 per row, rows towards the back wall.
function updateColliders(){
  S.decor?.stamp();
  S.colliders=[...S.walls,...[...S.rooms.values()].flatMap(room=>room.boxes),...(S.presence?.doorBoxes()||[])];
  S.npc?.invalidate(); // NPCs re-plan their walks around what is there now
}
// What NPCs walk on (office-nav.js): everything that stops people, and the world's floor heights (decks,
// stairs, water) within the part of the world the office uses.
function navWorld(){
  const c=S.place?.center||{x:0,z:0},r=(S.overviewRadius||12)+4,b=S.place?.bounds;
  const bounds={minX:Math.max(b?.minX??-Infinity,c.x-r),maxX:Math.min(b?.maxX??Infinity,c.x+r),minZ:Math.max(b?.minZ??-Infinity,c.z-r),maxZ:Math.min(b?.maxZ??Infinity,c.z+r)};
  // A door its member closed keeps visitors out, not the room's own agents: they come and go through it.
  return {boxes:[...S.walls,...[...S.rooms.values()].flatMap(room=>room.boxes)],bounds,ground:S.place?.id==='classic'?null:S.place?.ground};
}
// Where a room's NPCs come in and go out (just outside its door) and have coffee, in world coordinates.
function roomSpots(key){
  const r=S.rooms.get(key);if(!r)return undefined;
  if(!r.npc){const f={x:r.center.x,z:r.center.z,facing:r.facing},l=S.activity?.loungeSpot()||{x:-ROOM_W/2+1.9,z:ROOM_D/2-1.6};r.npc={door:toWorld(f,0,ROOM_D/2+1.3),lounge:toWorld(f,l.x,l.z)}}
  return r.npc;
}
function buildDesks(key,refresh=true){
  const room=S.rooms.get(key);if(!room)return;
  if(!room.desks){
    const g=new THREE.Group();
    room.desks=g;S.world.add(g);
    g.userData={entries:new Map(),lounge:S.activity?.lounge(g)||[]};
  }
  const g=room.desks,{entries}=g.userData;g.position.copy(room.center);g.rotation.y=room.facing;
  room.boxes=[];
  const cos=Math.cos(room.facing),sin=Math.sin(room.facing);
  for(const b of g.userData.lounge)room.boxes.push(officeBox(room.center.x+b.x*cos+b.z*sin,room.center.z-b.x*sin+b.z*cos,room.facing,b.w,b.d,b.h+room.center.y));
  // Sessions seated at an AgentFlow agent's desk sit in the common area instead (buildSeats).
  const all=S.live.get(key)||[],agents=all.filter(a=>!isSeated(a,S.afPlaced)),away=all.length-agents.length,cols=agents.length>8?4:3,sx=agents.length>8?2.6:3.2;
  room.note=agents.length?`${agents.length} ${agents.length===1?'agent':'agents'}`:away?`${away} at AgentFlow ${away===1?'desk':'desks'}`:'no agents running';
  roomLook(key);
  const visible=new Set();
  agents.slice(0,16).forEach((a,i)=>{
    const col=i%cols,row=Math.floor(i/cols),x=(col-(cols-1)/2)*sx,z=-ROOM_D/2+1.4+row*2.1,id=deskKey(key,a);
    visible.add(id);
    room.boxes.push(officeBox(room.center.x+x*cos+z*sin,room.center.z-x*sin+z*cos,room.facing,1.7,0.8,0.76+room.center.y));
    entries.set(id,makeDesk(g,a,key,x,z,a.private?'Private project':seatTag(a,'',a.title||VENDOR[a.vendor]?.name||'Agent'),{phase:(i*1.7+key.length)%6.28},entries.get(id)));
  });
  for(const [id,d] of entries)if(!visible.has(id)){clear(d);entries.delete(id)}
  if(refresh)updateColliders();
}
// One live session at a desk (in its owner's room, or beside an AgentFlow agent): the desk and its screen,
// the mascot with its subagents, and its clickable name tag.
const deskKey=(key,a)=>JSON.stringify([key,a.source,a.id]);
function makeDesk(parent,a,key,x,z,name,{tagY=1.75,phase=0,scale=1,lounge=true}={},existing){
  if(existing){updateDesk(existing,a,key,x,z,name,tagY,lounge);return existing}
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
  d.userData.mascot=mascot;
  // E: the same panel as clicking it (the entry drops out when the desk leaves the scene).
  const id=a.id;S.interact?.register({id:'desk:'+d.uuid,object3D:mascot,radius:2.6,height:2.5*scale,priority:a.mine&&a.status==='waiting'?2:a.mine?1:0,
    label:()=>{const x=agentOf(key,id)||a,n=x.private?'this agent':x.title||'this agent';return x.mine&&x.pending?.can?.length?`Answer ${n}`:x.mine?`Check on ${n}`:`Look at ${n}`},
    onInteract:()=>agentOf(key,id)?openPanel({type:'agent',member:key,id}):false});
  updateDesk(d,a,key,x,z,name,tagY,lounge);
  return d;
}
function updateDesk(d,a,key,x,z,name,tagY,lounge){
  d.position.set(x,0,z);
  const mascot=d.userData.mascot,u=mascot.userData;
  const look=mascotKind(a.vendor,a.model);
  if(u.mascot.kind!==look){
    u.mascot.group.removeFromParent();
    u.mascot=createMascot(look,{color:VENDOR_COLOR[a.vendor],scale:.52});
    u.mascot.group.position.y=.62;mascot.add(u.mascot.group);
  }
  u.status=a.status;u.children=(a.children||[]).length;
  u.screen.emissive.set(a.status==='running'?'#5fd38a':a.status==='waiting'?'#ffb020':'#000000');
  S.activity?.attach(mascot,a,{member:key,desk:d,root:d.parent,lounge,seated:!lounge});
  const at=`data-agent="${esc(a.id)}" data-member="${esc(key)}"`,kind=shownKind(a);
  const tag=`<button type="button" class="of-tag${a.private?' priv':''}${a.seat?.agent?' seat':''}" ${at}><i class="of-kind" title="${kind[1]}">${kind[0]}</i>${esc(name)}</button>`;
  if(!u.tag)u.tag=label(mascot,tag,{y:tagY,cls:'agent click',near:16});
  else if(u.tagHTML!==tag)u.tag.el.innerHTML=tag;
  u.tagHTML=tag;u.tag.y=tagY;
  const bang=a.status==='waiting'?`<button type="button" class="of-bang" ${at} aria-label="Waiting: ${esc(name)}">!</button>`:'';
  if(bang){
    if(!u.bang)u.bang=label(mascot,bang,{y:tagY+.5,cls:'bang click'});
    else if(u.bangHTML!==bang)u.bang.el.innerHTML=bang;
    u.bang.y=tagY+.5;
  }else if(u.bang){u.bang.el.remove();S.labelList=S.labelList.filter(l=>l!==u.bang);u.bang=null}
  u.bangHTML=bang;
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
  if(S.commonR!==radius){S.commonR=radius;S.place.common(radius);if(S.rooms.size)queueMicrotask(()=>S&&buildRooms())}
  const items=[],people=[];
  for(const a of list){
    const p=pos.get(a.id);if(!p)continue;const dim=a.status==='retired'||a.status==='paused';
    if(a.kind==='human'){if(a.member&&(a.member===S.meKey||S.people.has(a.member)))continue;people.push({a,p,offline:!!a.member,dim})}
    else{const kind=a.kind==='team'?'team':a.kind==='automation'?'automation':'agent';items.push({id:a.id,kind,x:p.x,z:p.z,dim:dim||kind==='agent'&&!seats.has(a.id),still:dim})}
  }
  // Robots that just left the org are still drawn while they walk out (office-npc.js).
  const robots=items.filter(it=>it.kind==='agent');
  if(S.npc)items.push(...S.npc.orgGhosts(new Set(robots.map(it=>it.id))));
  S.org=orgField(items);g.add(S.org.group);for(const m of S.org.meshes)S.clickables.push(m);
  const anchors=new Map();
  for(const it of items){if(it.ghost)continue;const o=new THREE.Object3D();o.position.set(it.x,0,it.z);g.add(o);anchors.set(it.id,o);const a=afOf(it.id);
    S.interact?.register({id:'af:'+it.id,object3D:o,radius:it.kind==='team'?2.8:2.2,height:it.kind==='team'?1.6:1.9,label:()=>`${it.kind==='team'?'Visit':'Check on'} ${a.name}`,onInteract:()=>afOf(it.id)?openPanel({type:'af',id:it.id}):false});
    label(o,`<button type="button" class="of-tag af" data-af-id="${esc(it.id)}">${esc(a.name)}</button>`,{y:it.kind==='team'?1.1:1.65,cls:'af click',show:()=>S.hover===it.id||S.panelFor?.id===it.id||o.position.distanceTo(S.pos)<7})}
  S.afPeople=people.map(({a,p,offline,dim})=>{
    const f=makeHuman(a.member?lookOf(a.member):lookFor(a.id),{dim:offline||dim});f.position.set(p.x,0,p.z);Object.assign(f.userData,{kind:'af',id:a.id,member:a.member||''});f.add(part(M.box,M.hit,[0,1,0],[0.9,2,0.9]));
    g.add(f);S.clickables.push(f);
    S.interact?.register({id:'af:'+a.id,object3D:f,radius:2.2,height:2.4,label:()=>`Talk to ${a.name}`,onInteract:()=>afOf(a.id)?openPanel({type:'af',id:a.id}):false});
    label(f,`<button type="button" class="of-tag af person${offline?' off':''}" data-af-id="${esc(a.id)}">${esc(a.name)}${offline?' · offline':''}</button>`,{y:2.05,cls:'af click',show:()=>S.hover===a.id||S.panelFor?.id===a.id||f.position.distanceTo(S.pos)<9});
    return f;
  });
  // The org as NPCs: robots walk about when nobody is at their desk; someone who just left the office walks
  // from where their avatar was to their place in the org.
  if(S.npc){
    const humans=people.map(({a,p,dim},i)=>{
      const left=a.member&&S.leftAt?.get(a.member),from=left&&Date.now()-left.at<20000?left:null;if(from)S.leftAt.delete(a.member);
      return {id:a.id,obj:S.afPeople[i],x:p.x,z:p.z,member:a.member||'',still:dim,from};
    });
    S.npc.org(S.org,robots.map(it=>({id:it.id,x:it.x,z:it.z,busy:seats.has(it.id),still:it.still,anchor:anchors.get(it.id)})),humans);
  }
  buildSeats(seats);
  S.chief?.update();
}
// Seats (office-seats.js): each live session working on an AgentFlow agent's card sits at a small desk beside
// that agent, seen from any side, with the agent's name and the card on its tag; up to three per agent.
const seatSig=seats=>[...seats].map(([id,l])=>id+':'+l.length).sort().join();
function buildSeats(seats=seatsByAgent(S.live,S.afPlaced)){
  if(!S.seatGroup){S.seatGroup=new THREE.Group();S.world.add(S.seatGroup)}
  const g=S.seatGroup,entries=S.seatEntries??=new Map(),visible=new Set();
  for(const [id,sitting] of seats){
    const p=S.afPos?.get(id),a=afOf(id);if(!p||!a)continue;
    sitting.slice(0,3).forEach(({member,agent},i,list)=>{
      // Its own anchor, turned so the mascot sits between the agent and its desk: the activity's frame (office-activity.js).
      const key=deskKey(member,agent);visible.add(key);
      let at=entries.get(key);
      if(!at){at=new THREE.Group();at.rotation.y=-Math.PI/2;g.add(at);entries.set(key,at)}
      at.position.set(p.x+1.12,0,p.z+(i-(Math.min(list.length,3)-1)/2)*0.85);
      makeDesk(at,agent,member,0,0,seatTag(agent,a.name),{tagY:list.length>1&&i%2?1.15:1.6,phase:i*1.7,scale:0.5,lounge:false},at.children[0]);
    });
  }
  for(const [key,at] of entries)if(!visible.has(key)){clear(at);entries.delete(key)}
}
// A session report changed: re-seat, and redraw the org only when who is busy changed (that dims or lights robots).
function seatsChanged(){const seats=seatsByAgent(S.live,S.afPlaced);if(seatSig(seats)!==S.seatSig)buildAgentflow();else buildSeats(seats)}

// ---------- people ----------
// A person (office-figures.js); the controller's pose group squashes and tilts it, its shadow stays on the ground.
function makeAvatar(key){return makeHuman(lookOf(key),{shadow:false})}
// A name tag sits just above the top of the head, hair or hat.
const tagHeight=p=>{p.tag.y=Math.max(2.05,p.figure.userData.stats().height+0.24)};
// What someone looks like: the look they saved (office-look-core.js), else the default for their key.
const lookOf=key=>S.looks.get(key)||lookFor(key);
function setLook(key,look){
  const next=look?cleanLook(look,{key}):null,was=S.looks.get(key)||null;
  if(JSON.stringify(next)===JSON.stringify(was))return;
  if(next)S.looks.set(key,next);else S.looks.delete(key);
  const p=S.people.get(key);if(p){p.figure.userData.setLook(lookOf(key));tagHeight(p)}
  for(const f of S.afPeople||[])if(f.userData.member===key)f.userData.setLook(lookOf(key));
}
// Your look is your account's avatar (docs/concepts/13-avatars.md): saved there, so every office shows it. The
// spec it came from is read first, so fields this version does not know survive the save.
async function saveAvatar(key,look){
  const me=(path,init)=>fetch('/api/me/avatar',{cache:'no-store',...init}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(Error(d.error||'Your look could not be saved'),{code:d.code,status:r.status});return d});
  const base=look?(await me()).avatar:null;
  const d=await me('',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({avatar:look?specFromLook(look,{seed:key,base}):null})});
  // Settings and the photo plumbing (account.js) follow: with "Use my avatar" on, the new portrait shows at once.
  dispatchEvent(new CustomEvent('flow:avatar',{detail:d}));
  return d;
}
// The look editor (office-look-editor.js): a dialog over the office, so walking pauses like under any overlay.
async function openLook(){
  const office=S;if(!office?.meKey||office.lookEditor||office.lookOpening)return;
  clearKeys();office.pointer?.cancelOrbit();closeMenu();office.lookOpening=true;
  let mod;try{mod=await import('./office-look-editor.js')}catch(e){office.lookOpening=false;office.opts.toast?.('The look editor could not load',true);return}
  office.lookOpening=false;if(S!==office||office.lookEditor)return;
  const opener=document.activeElement,key=office.meKey;
  const editor=mod.openLookEditor({key,name:office.people.get(key)?.name||office.me?.name||'You',look:lookOf(key),host:office.root,toast:office.opts.toast,
    save:look=>saveAvatar(key,look).then(d=>{if(S===office)setLook(key,d.custom?lookFromSpec(d.avatar,key):null)}),
    onClose(){if(office.lookEditor===editor)office.lookEditor=null;if(S===office)(opener?.isConnected&&office.root.contains(opener)?opener:office.root).focus({preventScroll:true})}});
  office.lookEditor=editor;
}
function upsertPerson(p,self=false){
  if(!S)return;S.absent.delete(p.key);let a=S.people.get(p.key);
  if(!a){
    const obj=new THREE.Group(),pose=new THREE.Group(),figure=makeAvatar(p.key),shade=shadow(0.45);
    figure.position.y=-0.88;pose.add(figure);pose.position.y=0.88;obj.add(pose,shade);
    obj.position.set(p.x??0,p.y??0,p.z??0);obj.rotation.y=p.heading||0;obj.userData={kind:'person',key:p.key,rig:figure.userData.rig};S.world.add(obj);
    // Your own avatar is clickable too: its menu opens the look editor.
    // The click target is never drawn (the raycaster still finds it): one draw call less per person.
    const hit=part(M.box,M.hit,self?[0,0.95,0]:[0,1,0],self?[0.6,1.9,0.6]:[0.9,2,0.9]);hit.visible=false;obj.add(hit);S.clickables.push(obj);
    const [bg,fg]=memberColor(p.key);
    const tag=label(obj,S.presence?S.presence.nameTag({name:p.name,image:p.image,self,bg,fg,key:p.key,presence:{status:'available',text:''}}):`<span class="of-name${self?' me':''}" data-office-person="${esc(p.key)}" style="--bg:${bg};--fg:${fg}"><i>${esc(initials(p.name))}</i>${esc(p.name)}</span>`,{y:2.05,cls:'person',show:self?()=>!!S.rig?.overview:null});
    a={key:p.key,name:p.name,image:p.image||'',colors:[bg,fg],obj,figure,tag,pose,shade,self,samples:[],remote:{},phase:0,landing:0,wasAirborne:false};S.people.set(p.key,a);
    tagHeight(a);
    // E on yourself: offered for a few seconds once you stand still, and only when nothing else is in reach.
    if(self)S.interact?.register({id:'self-look',object3D:obj,self:true,radius:0.8,height:2.5,priority:-6,label:'Edit your look',
      enabled:()=>{const still=performance.now()-(S.stillSince||0);return still>2500&&still<11000&&!S.lookEditor},
      onInteract:()=>{openLook();return {close:()=>S?.lookEditor?.close(),isOpen:()=>!!S?.lookEditor}}});
    if(!self)S.interact?.register({id:'person:'+p.key,object3D:obj,radius:2.4,height:2.6,priority:1,label:()=>`Wave at ${a.name}`,
      onInteract:()=>{const q=obj.getWorldPosition(new THREE.Vector3()).setY(2.2).project(S.camera),r=S.stage.getBoundingClientRect();
        if(!S.people.has(p.key))return false;
        openMenu(p.key,{clientX:r.left+(q.x+1)/2*r.width,clientY:r.top+(1-q.y)/2*r.height});return {close:closeMenu,isOpen:()=>!S.menu.hidden&&S.menu.dataset.key===p.key}}});
  }
  if(!self&&Number.isFinite(p.x)){
    const at=performance.now(),samples=a.samples,last=samples.at(-1);
    const speed=p.moving?(last?Math.hypot(p.x-last.x,p.z-last.z)/Math.max(0.03,(at-last.at)/1000):WALK_SPEED):0;
    samples.push({at,x:p.x,y:p.y??0,z:p.z,heading:p.heading||0,speed:Math.min(RUN_SPEED,speed),
      grounded:!p.jump,jumping:!!p.jump,sprinting:!!p.sprint});
    if(samples.length>12)samples.shift();
  }
  if(p.name)a.name=p.name;
  if(p.image)a.image=p.image;
  S.presence?.paintPerson(a);
  return a;
}
function removePerson(key){const a=S?.people.get(key);if(!a)return;(S.leftAt??=new Map()).set(key,{x:a.obj.position.x,z:a.obj.position.z,at:Date.now()});clear(a.obj);S.people.delete(key);if(S.follow===key)S.follow=null;closeMenu()}
const nameOf=key=>S.people.get(key)?.name||S.members.find(m=>m.key===key)?.name||'Someone';

// ---------- chat and emotes ----------
function addLine(l,{quiet=false}={}){
  if(S.chat.some(line=>line.id===l.id))return;
  S.chat=mergeOfficeChat(S.chat,[l]);
  if(!S.chat.some(line=>line.id===l.id))return;
  const channel=chatChannel(l.channel||'office');
  const el=document.createElement('div');el.dataset.id=l.id;el.className='of-line'+(l.key===S.meKey?' mine':'');
  el.style.setProperty('--of-chat-color',channel?.color||'#fff');
  const directMode=l.channel==='direct'?(l.saved?' · Saved in Flow chat':' · Office DM: not saved'):'';
  const audience=l.to&&l.key===S.meKey?` → ${l.to}`:'';
  el.innerHTML=`<span class="of-chat-kind">${esc((channel?.label||'Chat')+audience+directMode)}</span><b>${esc(l.name)}</b> ${esc(l.text)}`;
  const next=S.chat[S.chat.findIndex(line=>line.id===l.id)+1];
  S.lines.insertBefore(el,[...S.lines.children].find(child=>child.dataset.id===next?.id)||null);
  if(S.lines.children.length>50)S.lines.firstChild.remove();S.lines.scrollTop=S.lines.scrollHeight;
  if(quiet)return;
  const p=S.people.get(l.bubbleOn||l.key),obj=p?.obj||(l.bubbleOn?.isObject3D?l.bubbleOn:null);
  if(obj)chatBubble(obj,p,l.text,channel?.color,audience,l.channel||'office');
}
function showChatHint({key,channel}){
  const p=S.people.get(key);if(!p)return;
  // A fan-out can arrive in either order. Keep the fresh public message visible.
  if(p.bubble?.channel==='office'&&Date.now()-p.bubble.at<750)return;
  const text=channel==='agent'?`${p.name} is talking to an agent`:'…';
  chatBubble(p.obj,p,text,chatChannel(channel)?.color,'',channel,true);
}
function chatBubble(obj,p,text,color,audience,channel,hint=false){
  const office=S;
  const old=obj.userData.chatBubble;
  old?.el.remove();office.labelList=office.labelList.filter(x=>x!==old);
  const b=label(obj,`<span class="of-bubble${hint?' of-chat-hint':''}">${audience?`<small>${esc(audience)}</small>`:''}${esc(text)}</span>`,{y:2.6,cls:'bubble'});
  b.channel=channel;b.at=Date.now();
  if(color)b.el.style.setProperty('--of-chat-color',color);
  obj.userData.chatBubble=b;
  if(p)p.bubble=b;
  setTimeout(()=>{
    b.el.remove();office.labelList=office.labelList.filter(x=>x!==b);
    if(obj.userData.chatBubble===b)delete obj.userData.chatBubble;
    if(p?.bubble===b)p.bubble=null;
  },Math.min(12000,3500+text.length*60));
}
function emote(k){if(S.replay?.active)return;api('emote',{emote:k}).catch(e=>S.opts.toast?.(e.message,true))}
function showEmote(key,k){
  const p=S.people.get(key),e=EMOTES.find(x=>x[0]===k);if(!p||!e)return;
  const l=label(p.obj,`<span class="of-emote">${e[1]}</span>`,{y:p.bubble?3.6:2.6,cls:'emote'});p.emote={kind:k,at:performance.now()};
  setTimeout(()=>{l.el.remove();if(S)S.labelList=S.labelList.filter(x=>x!==l)},2400);
}

// ---------- clicks, menus and the side panel ----------
function hitAt(e){
  if(!S.camera)return null;const r=S.renderer.domElement.getBoundingClientRect();
  S.ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),S.camera);
  const board=S.replay?.active?null:S.boards?.hit(S.ray),meter=S.replay?.active?null:S.meters?.hit(S.ray),wall=S.replay?.active?null:S.devops?.hit(S.ray);
  for(const h of S.ray.intersectObjects(S.clickables,true)){
    if((board&&board.distance<h.distance)||(meter&&meter.distance<h.distance)||(wall&&wall.distance<h.distance))break;
    if(h.object.isInstancedMesh){const id=S.org?.pick(h.object,h.instanceId);if(id)return {kind:'af',id,obj:h.object,point:h.point};continue}
    let o=h.object;while(o&&!o.userData?.kind)o=o.parent;if(o)return {kind:o.userData.kind,id:o.userData.id,obj:o,point:h.point}}
  const g=S.ray.intersectObjects(S.place.floors)[0];
  let out=board&&(!g||board.distance<g.distance)?{kind:'',board,point:g?.point||board.point,distance:board.distance}:g?{kind:'',point:g.point,distance:g.distance}:null;
  if(meter&&(out?.distance==null||meter.distance<out.distance))out={kind:'meter',meter,point:meter.point,distance:meter.distance};
  // The main board (the real DevOps board): a click takes you to it.
  if(wall&&(out?.distance==null||wall.distance<out.distance))out={kind:'devops',point:wall.point,distance:wall.distance};
  return out;
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
  if(hit?.kind==='devops')return null;
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
  if(S.decor?.pointer(e))return;
  const hit=hitAt(e);closeMenu();if(!hit)return;
  if(S.replay?.active){if(hit.point)S.target=new THREE.Vector3(hit.point.x,0,hit.point.z);return}
  if(S.voice?.pick(S.ray))return;
  if(hit.kind==='meter'){if(S.meters?.pick(hit.meter))return;S.follow=null;S.target=new THREE.Vector3(hit.point.x,0,hit.point.z);return}
  if(hit.kind==='devops'){S.devops.focus();return}
  if(S.boards?.pick(hit.board))return;
  if(hit.kind==='agent'){showAgent(hit.obj.userData.member,hit.obj.userData.id);return}
  if(hit.kind==='af'){showAf(hit.id);return}
  if(hit.kind==='person'){openMenu(hit.obj.userData.key,e);return}
  if(hit.kind==='portal'){goDoor(hit.obj.userData.portal);return}
  const at=S.world.worldToLocal(hit.point.clone());if(S.place.ground(at.x,at.z)===null)return;
  S.follow=null;S.target=at;
}
// ---------- doors to other offices (office-portals.js; docs/concepts/12-office.md) ----------
function buildDoors(){
  if(!S?.world)return;if(S.doorGroup)clear(S.doorGroup);
  const rooms=[...S.rooms.values()],ring=rooms.length?Math.hypot(rooms[0].center.x,rooms[0].center.z):(S.commonR||10)+7;
  // The main board's wall holds a slot in the ring too: doors go in the gaps either side of it. So does the meeting room (office-voice.js).
  const wall=S.worldLayout?.mainWall,meet=S.worldLayout?.meetingAnchors?.()||[];
  const taken=[...rooms,...(wall?[{center:{x:wall.x,z:wall.z}}]:[]),...meet.map(a=>({center:{x:a.x,z:a.z}}))];
  // A world may have its own places for doors (the yacht: the swim platform); the office puts them in the ring's gaps.
  const spots=S.worldLayout?.doors?.(S.portalList)||doorSpots(S.portalList,{rooms:taken,ringRadius:ring});
  const d=buildDoors3d(spots);S.doorGroup=d.group;S.doorSpots=d.spots;S.world.add(d.group);
  d.spots.forEach((sp,i)=>{sp.anchor.parent.position.y=spots[i].y||0});
  for(const sp of d.spots){S.clickables.push(sp.hit);label(sp.anchor,`<button type="button" class="of-tag of-portal" data-door="${esc(sp.portal.env)}"><b>${esc(sp.portal.label)}</b>${sp.portal.sub?`<small>${esc(sp.portal.sub)}</small>`:''}</button>`,{y:3.25,cls:'portal click'})}
}
const buildDoors3d=spots=>doorMeshes(THREE,spots,{box:M.box,mat});
// Walking into a door (once you have been away from every door) or clicking it opens that office.
function checkDoor(){
  if(!S.doorSpots?.length||S.leaving||!S.placed)return;
  const d=doorAt(S.doorSpots,S.pos.x,S.pos.z);
  if(!d){S.doorArmed=true;return}
  if(S.doorArmed)goDoor(d.portal);
}
function goDoor(p){
  if(!S||S.leaving||!p?.env)return;S.leaving=true;
  if(!S.opts.offices.some(o=>o.id===p.env))S.opts={...S.opts,offices:[...S.opts.offices,{id:p.env,name:p.label}]};
  S.opts.toast?.(`Going to ${p.label}${p.sub?` · ${p.sub}`:''}`);switchTo(p.env);
}
function showGone(){
  S.panelFor=null;S.panel.hidden=false;
  S.panel.innerHTML=`<div class="of-ph">${icon('ban',16)}<b>No longer shared with you</b></div><div class="of-pb"><p class="of-note">${esc(S.opts.offices.find(o=>o.id===S.env)?.name||'This office')} is no longer shared with you, so you have left it.</p>
    <button type="button" class="txt primary" data-of="close">Close the office</button></div>`;
  watch();
}
function openMenu(key,e){
  const r=S.root.getBoundingClientRect();S.menu.hidden=false;S.menu.dataset.key=key;
  const af=afFor(key),head=`<div class="of-mh">${esc(nameOf(key))}${af?.title?`<small>${esc(af.title)}</small>`:''}</div>${af?`<button type="button" role="menuitem" data-of="afInfo" data-id="${esc(af.id)}">${icon('user',13)}AgentFlow role</button>`:''}`;
  if(key===S.meKey)S.menu.innerHTML=head+`<button type="button" role="menuitem" data-of="look">${icon('shirt',13)}Edit look</button><button type="button" role="menuitem" data-of="wave">👋 Wave</button>`;
  else S.menu.innerHTML=head+`<button type="button" role="menuitem" data-of="wave">👋 Wave</button><button type="button" role="menuitem" data-of="follow">${icon('arrowR',13)}${S.follow===key?'Stop following':'Follow'}</button><button type="button" role="menuitem" data-of="message">${icon('send',13)}Message</button>`;
  S.menu.style.left=Math.min(e.clientX-r.left,r.width-180)+'px';S.menu.style.top=Math.min(e.clientY-r.top,r.height-150)+'px';
  S.menu.querySelector('button').focus({preventScroll:true});
}
const closePanel=()=>{if(S){S.panel.hidden=true;S.panelFor=null}};
// Opens a side panel for an interaction, which then knows whether it is still open (E again closes it).
function openPanel(p){S.panelFor=p;refreshPanel();return {close:closePanel,isOpen:()=>!S.panel.hidden&&S.panelFor?.type===p.type&&S.panelFor?.id===p.id}}
function closeMenu(){if(S&&!S.menu.hidden){S.menu.hidden=true;return true}return false}
function onClick(e){
  const em=e.target.closest('[data-emote]');if(em){emote(em.dataset.emote);return}
  if(S.replay?.active&&e.target.closest('.of-labels'))return;
  const ag=e.target.closest('.of-labels [data-agent]');if(ag){showAgent(ag.dataset.member,ag.dataset.agent);return}
  const fa=e.target.closest('.of-labels [data-af-id]');if(fa){showAf(fa.dataset.afId);return}
  const dr=e.target.closest('.of-labels [data-door]');if(dr){goDoor(S.doorSpots?.find(x=>x.portal.env===dr.dataset.door)?.portal);return}
  const b=e.target.closest('[data-of]');if(!b)return;
  const key=S.menu.dataset.key;
  ({close:closeOffice,connect:()=>connectAgents(b),zoomIn:()=>S.rig?.zoomBy(1/1.2),zoomOut:()=>S.rig?.zoomBy(1.2),overview:toggleOverview,controls:toggleControls,closePanel:()=>{S.panel.hidden=true;S.panelFor=null},closeMeter:()=>S.meters?.close(),
    look:openLook,
    wave(){emote('wave');closeMenu()},
    follow(){S.follow=S.follow===key?null:key;S.target=null;closeMenu()},
    message(){closeMenu();S.composer.directTo(key)},
    allow:()=>decide('allow'),deny:()=>decide('deny'),decorate:()=>S.decor?.toggle(),
    afInfo(){closeMenu();showAf(b.dataset.id)},
    agentDetails:()=>openAgentPanelOverlay('agent',b.dataset.id),
    agentQueue:()=>openAgentPanelOverlay('queue',b.dataset.id),
  })[b.dataset.of]?.();
}
function openAgentPanelOverlay(kind,id){
  S.interact?.closeOpen();closePanel();S.root.focus({preventScroll:true});
  openOverlay(kind,S.opts.agentRecordId?.(id)||id);
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
  if(p.type==='chief'){S.chief.before(S.panel);S.panel.innerHTML=S.chief.panelHtml();S.panel.hidden=false;S.chief.attach(S.panel);return}
  if(p.type==='af'){
    const a=afAgents().find(x=>x.id===p.id);if(!a){S.panel.hidden=true;return}
    const here=S.env===S.opts.current&&S.opts.overlays?.agent;
    html=`<div class="of-ph">${icon(a.kind==='human'?'user':a.kind==='team'?'users':a.kind==='automation'?'gear':'bot',16)}<b>${esc(a.name)}</b><span class="sp"></span><button type="button" class="ib" data-of="closePanel" aria-label="Close">${icon('x')}</button></div>
      <div class="of-pb">${row('Role',a.title)}${row('Kind',a.kind)}${row('Status',a.status)}<p class="of-note">An AgentFlow ${a.kind==='human'?'person':a.kind} of this environment.</p>
      ${a.kind==='agent'?deskPanel(a,seatsByAgent(S.live,S.afPlaced).get(a.id)||[],{desk:(S.snapAgentflow||[]).find(x=>x.id===a.id)?.desk,nameOf,vendorName:v=>(VENDOR[v]||VENDOR.other).name,me:S.meKey}):''}
      ${here?`<div class="of-btns"><button type="button" class="txt" data-of="agentDetails" data-id="${esc(a.id)}">${icon('user',13)}Agent details</button>${a.kind==='agent'?`<button type="button" class="txt" data-of="agentQueue" data-id="${esc(a.id)}">${icon('branch',13)}Work queue</button>`:''}</div>`:''}</div>`;
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
        if(a.pending&&!(ans?.requestId===a.pending.requestId&&ans.result?.ok)){
          const can=a.mine&&a.pending.can?.length;
          prompt=`<div class="of-prompt"><div class="of-pk">${a.pending.kind==='question'?'Question':'Permission prompt'}</div><pre>${esc(a.pending.summary||'')}</pre>
            ${can&&(ans?.requestId!==a.pending.requestId||ans.state==='failed')?`<div class="of-btns">${a.pending.can.includes('allow')?`<button type="button" class="txt primary" data-of="allow">${icon('check',13)}Allow</button>`:''}${a.pending.can.includes('deny')?`<button type="button" class="txt" data-of="deny">${icon('ban',13)}Deny</button>`:''}</div>`:''}
            ${!can?`<p class="of-note">${a.mine?'Answer it where it runs.':`Waiting on ${esc(owner?.name||'its owner')}.`}</p>`:''}</div>`;
        }
        const res=answerHtml(ans,a);
        html=head+`<div class="of-pb">${row('Status',STATUS[a.status])}${row('Model',a.model?`${v.name} · ${a.model}`:v.name)}${row('Where',a.hostLabel||a.host)}${row('Repo',a.repo?.slug||a.repo?.name)}${row('Project',(a.projects||[]).join(', '))}
          ${row('Desk',deskOf(a))}${row('Card',a.seat?.card?`#${a.seat.card.number} ${a.seat.card.title}`:'')}${row('Doing',[doing,a.activity].filter(Boolean).join(' · '))}${a.children?.length?row('Subagents',`${a.children.length}: ${a.children.map(c=>c.title||VENDOR[c.vendor]?.name).join(', ')}`):''}${row('Belongs to',a.mine?'You':owner?.name)}${prompt}${res}${a.mine?'<div class="of-steer-slot"></div>':''}</div>`;
      }
    }
  }
  S.steer.before(S.panel);
  S.panel.innerHTML=html;S.panel.hidden=false;
  // Your own agent: its transcript, a message box and Stop (office-steer.js), kept across redraws.
  if(p.type==='agent'){const a=agentOf(p.member,p.id);if(a)S.steer.attach(S.panel.querySelector('.of-steer-slot'),a)}
  for(const b of S.panel.querySelectorAll('[data-seat-agent]'))b.addEventListener('click',()=>showAgent(b.dataset.seatMember,b.dataset.seatAgent));
}
// ---------- Allow / Deny: one state flow ----------
// Click: "Allowing…" or "Denying…" at once, and the mascot nods (and works) or shakes. The reporter's result
// either fails ("…isn't waiting any more", shown in red, the work stops) or goes through; an approved one
// shows "Running…" once its next report has it running with nothing pending, then clears. Nothing back
// in 20 s: "Still waiting on <host>…".
const ANSWER_SLOW=20000,ANSWER_DONE_MS=3000;
const reactKey=id=>S.meKey+'|'+id;
function decide(decision){
  const p=S.panelFor,a=p&&agentOf(p.member,p.id);if(!a?.pending||!a.mine)return;
  S.answers.set(a.id,{agentId:a.id,requestId:a.pending.requestId,decision,state:'sent',at:Date.now(),host:a.hostLabel||a.host||''});
  S.reactions?.react(reactKey(a.id),decision);answerTicker();refreshPanel();
  api('answer',{source:a.source,agentId:a.id,requestId:a.pending.requestId,decision})
    .catch(e=>{answerResult({agentId:a.id,requestId:a.pending.requestId,decision,result:{ok:false,message:e.message}})});
}
function answerSent(a){const cur=S.answers.get(a.agentId);S.answers.set(a.agentId,{...cur,...a,state:cur?.state==='failed'?'sent':cur?.state||'sent',at:cur?.at||Date.now()});refreshPanel()}
function answerResult(a){
  const cur=S.answers.get(a.agentId)||{},ok=!!a.result?.ok,next={...cur,...a,state:ok?'done':'failed'};
  if(cur.requestId&&cur.requestId!==a.requestId)return;
  if(cur.state==='running'&&ok)next.state='running';
  S.answers.set(a.agentId,next);
  if(!ok||a.decision==='deny')S.reactions?.settle(reactKey(a.agentId));
  if(ok&&a.decision==='allow')answersSeen(S.live.get(S.meKey)||[]);
  if(ok&&a.decision==='deny')setTimeout(()=>{if(S?.answers.get(a.agentId)===next){S.answers.delete(a.agentId);refreshPanel()}},ANSWER_DONE_MS);
  refreshPanel();
}
// My agents' next report: an approved one running again with nothing pending is "Running…", then done.
function answersSeen(agents){
  for(const [id,ans] of S.answers){
    if(ans.decision!=='allow'||ans.state!=='done')continue;
    const a=agents.find(x=>x.id===id);
    if(!a){S.reactions?.settle(reactKey(id));continue}
    if(a.pending&&a.pending.requestId===ans.requestId)continue; // still on that prompt
    // Past that prompt: running again is "Running…"; anything else (idle, another prompt) just ends it.
    ans.state=a.status==='running'&&!a.pending?'running':'gone';S.reactions?.settle(reactKey(id));
    setTimeout(()=>{if(S?.answers.get(id)===ans){S.answers.delete(id);refreshPanel()}},ans.state==='running'?ANSWER_DONE_MS:0);
  }
}
// While anything is unanswered, the panel re-renders each second so "Still waiting…" appears on time.
function answerTicker(){if(S.answerTick)return;S.answerTick=setInterval(()=>{if(!S)return;if(![...S.answers.values()].some(x=>x.state==='sent'||x.state==='done')){clearInterval(S.answerTick);S.answerTick=null}refreshPanel()},1000)}
function answerHtml(ans,a){
  if(!ans||ans.state==='gone'||(a.pending&&ans.requestId!==a.pending.requestId&&ans.state!=='running'&&ans.state!=='failed'))return '';
  const word=ans.decision==='allow'?'Approved':'Denied',slow=ans.state==='sent'&&Date.now()-(ans.at||Date.now())>ANSWER_SLOW;
  if(ans.state==='failed')return `<p class="of-res bad" role="status">${esc(ans.result?.message||'That did not go through')}</p>`;
  if(ans.state==='running')return `<p class="of-res ok" role="status">${icon('check',12)} Approved · Running…</p>`;
  if(ans.state==='sent')return `<p class="of-res" role="status">${ans.decision==='allow'?'Allowing':'Denying'}…${slow?` Still waiting on ${esc(ans.host||a.hostLabel||a.host||'its machine')}…`:''}</p>`;
  return `<p class="of-res ${ans.decision==='allow'?'ok':''}" role="status">${icon(ans.decision==='allow'?'check':'ban',12)} ${word}${ans.state==='done'&&ans.result?.message?` · ${esc(ans.result.message)}`:''}</p>`;
}

// ---------- keys ----------
const isTyping=el=>el?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable=false])');
function onKey(e){
  if(!S)return;
  if(e.target.closest?.('dialog[open]'))return;
  if(overlayOpen()){e.stopPropagation();return}
  // At the DevOps board: its keys are its own (office-devops.js); Esc comes back.
  if(S.devops?.focused()){if(e.key==='Escape'&&S.presence?.closeOverlays()){e.preventDefault();e.stopPropagation();return}S.devops.windowKey(e);return}
  if(e.key==='Escape'){
    e.preventDefault();e.stopPropagation();
    if(S.composer?.escape(e.target))return;
    if(S.decor?.escape())return;
    if(S.interact?.closeOpen())return;
    if(S.voice?.escape())return;
    if(S.pointer?.cancelGrab())return;
    if(closeMenu())return;
    if(S.presence?.closeOverlays())return;
    if(S.meters?.isOpen()&&S.meters.close())return;
    if(S.replay?.active){S.replay.finish();return}
    if(!S.panel.hidden){S.panel.hidden=true;S.panelFor=null;return}
    closeOffice();return;
  }
  if(isTyping(e.target))return;
  if(S.decor?.key(e)){e.stopPropagation();return}
  if(S.pointer?.grabbing){e.stopPropagation();return}
  e.stopPropagation(); // the app underneath does not see office shortcuts
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.target.closest?.('.of-say,.of-chat-reply'))return;
  const k=e.key.toLowerCase(),menu=e.target.closest?.('[role=menu]');
  if(menu){
    if(k==='arrowup'||k==='arrowdown'){
      e.preventDefault();const bs=[...S.menu.querySelectorAll('button')],i=bs.indexOf(document.activeElement);
      bs[(i+(k==='arrowup'?-1:1)+bs.length)%bs.length]?.focus();
    }
    return;
  }
  if(e.code==='Space'&&e.target.closest?.('button,a'))return;
  if(S.presence?.onKey(e))return;
  if(S.voice?.keyDown(e)){e.preventDefault();return} // M mute, hold V to talk
  if(S.input.keyDown(e.code,performance.now(),e.repeat,S.controller.jump)){e.preventDefault();return}
  if(k==='e'){e.preventDefault();if(!e.repeat&&!S.replay?.active)S.interact?.trigger();return}
  if(['z','c','f','o','?'].includes(k)){
    e.preventDefault();
    if(e.repeat)return;
    if(k==='z'||k==='c')S.rig?.rotate((k==='z'?1:-1)*Math.PI/6);
    if(k==='f')recenterCamera();
    if(k==='o')toggleOverview();
    if(k==='?')toggleControls();
    return;
  }
  if(k==='b'){e.preventDefault();if(!e.repeat&&!S.replay?.active){if(S.rig?.overview)toggleOverview();S.devops?.focus()}return}
  if(k==='l'){e.preventDefault();if(!e.repeat)openLook();return}
  if(/^[1-4]$/.test(e.key)){e.preventDefault();emote(EMOTES[+e.key-1][0]);return}
  if(!S.replay?.active&&(e.key==='Enter'&&e.target===document.body||e.key==='t')){e.preventDefault();S.root.querySelector('.of-input').focus()}
}
function onKeyUp(e){
  S?.voice?.keyUp(e); // push-to-talk ends even while typing
  if(S?.input.keyUp(e.code)&&!isTyping(e.target))e.stopPropagation();
}
const overlayOpen=()=>S.bridge?.dialog.open||S.overlays.length||S.root.querySelector('dialog[open]');
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

const rigPos=new THREE.Vector3();
function frame(dt,t,delta){
  const controller=S.controller,state=controller.state,now=performance.now(),yaw=S.rig.yaw;
  const paused=overlayOpen(),replay=S.replay?.active;
  const animation=replay?S.replay.tick(Math.min(.25,delta)):{dt,t};
  const editing=paused||S.pointer.grabbing||isTyping(document.activeElement)||!!S.devops?.focused();
  const pads=editing?[]:navigator.getGamepads?.()||[];
  const gamepad=Array.prototype.find.call(pads,pad=>pad?.connected&&pad.mapping==='standard');
  const input=S.input.sample(gamepad,controller.jump);if(!paused&&!replay)S.interact?.gamepad(gamepad);
  const {right,forward,orbitX,orbitY}=input,steering=!!(right||forward);
  if(orbitX||orbitY)S.rig.rotate(-orbitX*2.6*dt,orbitY*1.9*dt);

  const c=Math.cos(yaw),s=Math.sin(yaw);
  let x=right*c-forward*s,z=-right*s-forward*c;
  if(steering){S.follow=null;S.target=null}
  else{
    const target=S.people.get(S.follow)?.obj.position||S.target;
    if(target&&!paused){
      const dx=target.x-state.x,dz=target.z-state.z,d=Math.hypot(dx,dz),stop=S.follow?1.8:0.18;
      if(d>stop){
        const throttle=Math.min(1,Math.sqrt(2*24*(d-stop))/(input.sprint?RUN_SPEED:WALK_SPEED));
        x=dx/d*throttle;z=dz/d*throttle;
      }else if(!S.follow)S.target=null;
    }
  }
  S.presence?.beforeMove();
  let player=controller.advance(dt,{...input,x,z},S.colliders,S.place.terrain);
  // In the water: a splash, then back on the nearest deck.
  if(player.y<S.place.sea-1.1){
    S.place.splash(player,t);const r=S.place.respawn(player);
    controller.reset(r,r.heading);S.target=S.follow=null;S.input.clear();player=controller.advance(0,{...input,x:0,z:0},S.colliders,S.place.terrain);
  }
  S.presence?.afterMove(player);
  if(player.speed>0.05||!player.grounded||paused)S.stillSince=now;
  S.pos.set(player.x,player.y,player.z);
  // The deck I stand on (or last stood on, in the air), for the camera.
  const deck=S.place.ground(player.x,player.z);if(deck!==null&&player.grounded)S.floor+=(Math.min(deck,player.y)-S.floor)*Math.min(1,dt*8);
  if(!replay){checkDoor();if(S.meKey)sendPresence(false)}
  for(const p of S.people.values()){
    // The figure animation can use the same motion fields for local and remote avatars.
    const motion=p.motion=replay?p.replayPose:p.self?player:remoteMotion(p,now);
    if(!motion)continue;
    const o=p.obj,hop=0;
    o.position.set(motion.x,motion.y+hop,motion.z);o.rotation.y=motion.heading;
    if(!p.self&&p.wasAirborne&&motion.grounded)p.landing=0.12;
    p.wasAirborne=!motion.grounded;
    p.landing*=Math.exp(-13*animation.dt);
    const squash=p.self?motion.squash:p.landing;
    const run=THREE.MathUtils.clamp((motion.speed-WALK_SPEED)/(RUN_SPEED-WALK_SPEED),0,1);
    const stride=Math.min(1,motion.speed/WALK_SPEED);
    p.phase+=animation.dt*motion.speed*(2.35-run*0.37);
    const scale=1-squash+(motion.jumping?0.07:0);
    p.pose.scale.set(1+squash*0.5,scale,1+squash*0.5);
    p.pose.position.y=0.88*scale;
    p.pose.rotation.x=motion.flip|| (motion.jumping?-0.17:stride*(0.05+run*0.13));
    p.pose.rotation.z=motion.grounded?Math.sin(p.phase)*stride*0.02:0;
    p.shade.position.y=0.02-o.position.y;
    animateHuman(o.userData.rig,animation.t,{speed:motion.speed,grounded:motion.grounded,jumping:motion.jumping,emote:p.emote,phase:(o.id%7)*0.9,cycle:p.phase,talking:!!p.bubble});
  }
  if(!S.npc)for(const f of S.afPeople||[])animateHuman(f.userData.rig,animation.t,{phase:(f.id%7)*0.9});
  // Agents: running bob and type, waiting hop and glow, idle still; subagents circle.
  for(const c of S.clickables){
    const u=c.userData;if(u.kind!=='agent')continue;
    u.mascot?.update(animation.t,{status:u.status,children:u.children,phase:u.phase});
  }
  pulseMascots(animation.t);
  // Where everyone who is not a person walks (office-npc.js), then what agents act out at their desks
  // (office-activity.js): after the above, so they have the last word.
  S.npc?.tick(animation.dt,animation.t);
  S.chief?.frame();
  S.activity?.tick(animation.dt,animation.t);
  S.decor?.frame();
  if(S.reactions)for(const c of S.clickables){const u=c.userData;if(u.kind==='agent'&&u.mascot)S.reactions.apply(u.member+'|'+u.id,u.mascot,animation.t)}
  if(!paused){
    // The camera works as if my deck were the ground, then rides up to it; the overview frames the whole world.
    S.rig.update(dt,rigPos.set(S.pos.x,S.pos.y-S.floor,S.pos.z),player.heading,player.vx,player.vz,cameraWalls(),S.overviewRadius,
      {held:S.pointer.orbiting||S.pointer.grabbing||!!(orbitX||orbitY),align:!steering||(forward>0&&Math.abs(right)<0.1)});
    S.ov+=((S.rig.overview?1:0)-S.ov)*Math.min(1,dt*9);
    S.camera.position.x+=S.place.center.x*S.ov;S.camera.position.y+=S.floor*(1-S.ov);S.camera.position.z+=S.place.center.z*S.ov;
  }
  S.place.update(t,dt,{camera:S.camera,motion:S.motion});
  S.devops?.frame(dt,!paused);
  if(!replay)S.boards?.frame(S.labelList);
  S.meters?.frame();
  // The look editor covers the office: nothing to draw under it.
  if(!S.lookEditor){S.renderer.render(S.scene,S.camera);S.devops?.render();if(!document.hidden)paceFigures(delta)}
  if(!replay)S.interact?.update();
  S.voice?.frame(dt);
  placeLabels();
}
// The E prompt names what it targets, so that thing's own name tag steps aside while it is targeted.
const NAME_TAG=/\b(af|agent|person)\b/;
function placeLabels(){
  const w=S.stage.clientWidth,h=S.stage.clientHeight,p=new THREE.Vector3(),target=S.interact?.current()?.object3D;
  for(const l of S.labelList){
    l.obj.getWorldPosition(p);const far=(l.near&&p.distanceTo(S.pos)>l.near)||(l.show&&!l.show())||(target===l.obj&&NAME_TAG.test(l.cls));p.y+=l.y;p.project(S.camera);
    const off=far||p.z>1||p.x<-1.2||p.x>1.2||p.y<-1.2||p.y>1.2;
    if(off){if(!l.hidden){l.el.style.display='none';l.hidden=true}continue}
    if(l.hidden){l.el.style.display='';l.hidden=false}
    l.el.style.transform=`translate(${((p.x+1)/2*w).toFixed(1)}px,${((1-p.y)/2*h).toFixed(1)}px) translate(-50%,${l.top?'0':'-100%'})`;
  }
}
