// Voice in the 3D office (docs/concepts/12-office.md): a meeting room whose call you join by walking in,
// opt-in proximity voice outside it, and screen sharing onto the room's wall screen.
//
//   const voice=createVoice({scene, world, stage, root, interact, label, clear, env(), me() -> {x,z},
//     facing() -> heading, people() -> Map(key -> {obj}), meKey(), nameOf(key), quiet() (Do not disturb),
//     layout() -> {world, rooms:[{x,z}], commonR, roomW, roomD}, walkTo(x, z) | walkTo(null), walking() -> bool, toast(msg, bad)})
//   voice.event(data)     an `rtc` event from the office stream (lib/office-rtc.mjs)
//   voice.layout()        the rooms moved: place the meeting room again (office-voice-core.js meetingAnchors)
//   voice.walls           the meeting room's walls, for the office's colliders
//   voice.inMeeting(x, z) true inside the meeting room
//   voice.frame(dt)       once per frame: room membership, proximity mix, speaking rings
//   voice.keyDown(e) / keyUp(e)   M mute, hold V to talk (the office calls these outside text fields only)
//   voice.escape()        closes the full-screen view (-> true)
//   voice.pick(ray)       a click on the wall screen opens the full-screen view (-> true)
//   voice.dispose()       the office closed: every call ends, the microphone and screen are released
//
// Audio and video go browser to browser over WebRTC (a mesh, fine for about 8 people), signalled through
// POST /api/office/{env}/rtc and the office's event stream. Nothing is recorded; the server keeps no media.
// "Perfect negotiation": the peer with the smaller id opens a call, either side renegotiates (a screen
// share), and on a collision the polite side (isPolite) yields.
import * as THREE from './vendor/three/three.module.min.js';
import {officeBox} from './office-controls.js';
import {cutaway} from './office-cutaway.js';
import {meetingAnchors,roomAt,roomReduce,announce,ROOM_OUT,wantedPeers,proximityMix,roomCount,toWorld,isPolite} from './office-voice-core.js';

const PREF='flow.office.voice',HIDDEN_MS=120e3,RECONCILE_MS=900,SPEAKING=0.035;
const svg=p=>`<svg class="i" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICON={
  mic:svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  micOff:svg('<path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3"/>'),
  head:svg('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>'),
  headOff:svg('<path d="M4 15v-3a8 8 0 0 1 13-6.2M20 12v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><path d="M3 3l18 18"/>'),
  near:svg('<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>'),
  screen:svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  door:svg('<path d="M14 3h5v18h-5M10 17l5-5-5-5M15 12H3"/>'),
  gear:svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  expand:svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  x:svg('<path d="M18 6 6 18M6 6l12 12"/>'),
};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const readPrefs=()=>{try{return JSON.parse(localStorage.getItem(PREF)||'{}')||{}}catch{return {}}};
const savePrefs=p=>{try{localStorage.setItem(PREF,JSON.stringify(p))}catch{}};

export function createVoice(o){
  if(typeof document!=='undefined'&&!document.querySelector('link[data-office-voice]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/office-voice.css';l.dataset.officeVoice='';document.head.append(l)}
  const prefs={ptt:false,mic:'',speaker:'',...readPrefs()};delete prefs.near;
  const V={
    peer:'',peers:new Map(),conns:new Map(),room:ROOM_OUT,near:false,muted:false,deafened:false,pttHeld:false,suspended:false,disposed:false,
    mic:null,silent:null,ctx:null,master:null,local:null,share:null,ice:null,iceAt:0,sent:'',sending:null,anchors:[],group:null,walls:[],screen:null,
    rings:new Map(),levels:new Map(),reconcileAt:0,mixAt:0,hiddenTimer:0,needGesture:false,confirm:null,full:null,lastSharer:'',
  };
  const api=(body)=>fetch(`/api/office/${encodeURIComponent(o.env())}/rtc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(Error(d.error||'Voice signalling failed'),{code:d.code,status:r.status});return d});
  async function iceServers(){
    if(V.ice&&Date.now()-V.iceAt<(V.ice.ttl||3600)*500)return V.ice.iceServers;
    try{const r=await fetch(`/api/office/${encodeURIComponent(o.env())}/rtc`,{cache:'no-store'});if(r.ok){V.ice=await r.json();V.iceAt=Date.now()}}catch{}
    return V.ice?.iceServers||[{urls:['stun:stun.l.google.com:19302']}];
  }

  // ---------- audio ----------
  // One AudioContext; it starts suspended until a click, key or tap (browsers' autoplay rules), so the first
  // gesture in the office resumes it and plays whatever was waiting.
  function audio(){
    if(V.ctx||V.disposed)return V.ctx;
    const AC=globalThis.AudioContext||globalThis.webkitAudioContext;if(!AC)return null;
    try{V.ctx=new AC();V.master=V.ctx.createGain();V.master.connect(V.ctx.destination);if(prefs.speaker&&V.ctx.setSinkId)V.ctx.setSinkId(prefs.speaker).catch(()=>{})}catch{V.ctx=null}
    return V.ctx;
  }
  const gesture=()=>{
    const ctx=audio();if(ctx?.state==='suspended')ctx.resume().catch(()=>{});
    for(const c of V.conns.values())c.el?.play?.().catch(()=>{});
    V.screenVideo?.play?.().catch(()=>{});
    if(V.needGesture){V.needGesture=false;paint()}
  };
  o.root.addEventListener('pointerdown',gesture,true);o.root.addEventListener('keydown',gesture,true);o.root.addEventListener('touchend',gesture,true);
  // What your microphone sends: the mic while you talk, otherwise a silent track, so a call exists before the
  // browser has asked for permission (or when it was refused: you can still listen).
  function silentTrack(){
    if(V.silent?.readyState==='live')return V.silent;
    const ctx=audio();if(!ctx)return null;
    const dst=ctx.createMediaStreamDestination();V.silent=dst.stream.getAudioTracks()[0];return V.silent;
  }
  const sendTrack=()=>V.mic?.getAudioTracks()[0]||silentTrack();
  const inCall=()=>!!announce(V.room)||nearOn();
  const nearOn=()=>V.near&&!V.suspended&&!announce(V.room)&&V.room.phase==='out';
  const micLive=()=>inCall()&&!!V.mic&&!V.muted&&!V.deafened&&(!prefs.ptt||V.pttHeld);
  function applyMic(){
    const t=V.mic?.getAudioTracks()[0];if(t)t.enabled=micLive();
    if(V.master)V.master.gain.value=V.deafened?0:1;
    for(const c of V.conns.values())if(c.el&&!c.src)c.el.muted=V.deafened;
    paint();
  }
  async function getMic(){
    if(V.mic)return true;
    if(!navigator.mediaDevices?.getUserMedia)return false;
    try{
      const want={echoCancellation:true,noiseSuppression:true,autoGainControl:true,...(prefs.mic?{deviceId:{ideal:prefs.mic}}:{})};
      const stream=await navigator.mediaDevices.getUserMedia({audio:want});
      if(V.disposed||!inCallWanted()){stream.getTracks().forEach(t=>t.stop());return true}
      V.mic=stream;
      const ctx=audio();
      if(ctx){const src=ctx.createMediaStreamSource(stream),an=ctx.createAnalyser();an.fftSize=512;src.connect(an);V.local={src,an,buf:new Uint8Array(an.fftSize)}}
      const t=stream.getAudioTracks()[0];
      for(const c of V.conns.values())c.audioSender?.replaceTrack(t).catch(()=>{});
      applyMic();return true;
    }catch(e){return false}
  }
  // In a room (or asking to be) or with proximity on: the mic is wanted.
  const inCallWanted=()=>V.room.phase!=='out'||nearOn();
  function releaseMic(){
    if(!V.mic)return;
    for(const c of V.conns.values()){const s=silentTrack();if(s)c.audioSender?.replaceTrack(s).catch(()=>{})}
    V.mic.getTracks().forEach(t=>t.stop());V.mic=null;try{V.local?.src.disconnect()}catch{}V.local=null;
    // A released mic is asked for again next time (the browser remembers a granted permission).
    if(V.room.mic==='on')V.room={...V.room,mic:'unknown'};
  }

  // ---------- your voice state, as the others see it ----------
  const myState=()=>({room:announce(V.room),near:nearOn(),dnd:!!o.quiet?.(),muted:V.muted||V.deafened||!V.mic,share:!!V.share});
  function postState(force=false){
    if(!V.peer||V.disposed)return;
    const s=myState(),sig=JSON.stringify(s);if(!force&&sig===V.sent)return;
    V.sent=sig;
    const peer=V.peer;
    V.sending=api({from:peer,type:'state',data:s}).catch(e=>{if(V.peer===peer&&V.sent===sig)V.sent=''}).finally(()=>{V.sending=null});
  }
  const me=()=>({peer:V.peer,key:o.meKey(),...myState()});

  // ---------- calls ----------
  // One peer's messages go out in order (an offer before its candidates): each POST waits for the one before.
  const chains=new Map();
  function signal(to,type,data){
    const from=V.peer;
    const next=(chains.get(to)||Promise.resolve()).then(()=>from===V.peer&&api({from,to,type,data}))
      .catch(e=>{if(e.status===404||e.code==='not_in_call')hangup(to,false)});
    chains.set(to,next);next.then(()=>{if(chains.get(to)===next)chains.delete(to)});
    return next;
  }
  // answering: the call starts with their offer, so our tracks go in once it is set (no offer of our own).
  async function open(peer,{answering=false}={}){
    if(V.conns.has(peer))return V.conns.get(peer);
    const c={peer,pc:null,polite:isPolite(V.peer,peer),makingOffer:false,ignoreOffer:false,pending:[],audioSender:null,videoSender:null,video:null,el:null,src:null,gain:null,panner:null,an:null,buf:null};
    V.conns.set(peer,c);
    const servers=await iceServers();
    if(V.conns.get(peer)!==c)return null;
    const pc=c.pc=new RTCPeerConnection({iceServers:servers});
    pc.onicecandidate=e=>{if(e.candidate)signal(peer,'ice',e.candidate.toJSON())};
    pc.onnegotiationneeded=async()=>{
      try{c.makingOffer=true;await pc.setLocalDescription();await signal(peer,'offer',pc.localDescription.toJSON())}
      catch{}finally{c.makingOffer=false}
    };
    pc.ontrack=e=>onTrack(c,e);
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==='failed')pc.restartIce?.();
      if(pc.connectionState==='closed'&&V.conns.get(peer)===c)hangup(peer,false);
      paint();
    };
    if(!answering)addTracks(c);
    return c;
  }
  function addTracks(c){
    const t=sendTrack();
    if(!c.audioSender&&t)c.audioSender=c.pc.addTrack(t,new MediaStream([t]));
    else if(!c.audioSender&&!c.recv){c.recv=c.pc.addTransceiver('audio',{direction:'recvonly'})} // no WebAudio: listen only
    const st=V.share?.getVideoTracks()[0],p=V.peers.get(c.peer);
    if(st&&!c.videoSender&&p?.room&&p.room===announce(V.room))c.videoSender=c.pc.addTrack(st,V.share);
  }
  async function onDescription(peer,desc){
    let c=V.conns.get(peer);
    if(!c){
      // An offer for a call we do not want (yet): say no, and the caller tries again when it is wanted.
      if(desc?.type!=='offer'||!wanted(peer).has(peer)){signal(peer,'bye',null);return}
      c=await open(peer,{answering:true});if(!c)return;
    }
    if(!c.pc){await new Promise(r=>setTimeout(r,50));return V.conns.get(peer)===c?onDescription(peer,desc):undefined}
    const pc=c.pc;
    try{
      const collision=desc.type==='offer'&&(c.makingOffer||pc.signalingState!=='stable');
      c.ignoreOffer=!c.polite&&collision;if(c.ignoreOffer)return;
      await pc.setRemoteDescription(desc);
      for(const cand of c.pending.splice(0))await pc.addIceCandidate(cand).catch(()=>{});
      if(desc.type==='offer'){addTracks(c);await pc.setLocalDescription();await signal(peer,'answer',pc.localDescription.toJSON())}
    }catch(e){console.warn('office voice: negotiation',e?.name||e)}
  }
  async function onIce(peer,cand){
    const c=V.conns.get(peer);if(!c||!cand)return;
    if(!c.pc||!c.pc.remoteDescription){c.pending.push(cand);if(c.pending.length>200)c.pending.shift();return}
    try{await c.pc.addIceCandidate(cand)}catch{if(!c.ignoreOffer)console.warn('office voice: candidate refused')}
  }
  function onTrack(c,e){
    const track=e.track,stream=e.streams?.[0]||new MediaStream([track]);
    if(track.kind==='video'){
      c.video=track;
      for(const ev of ['mute','unmute','ended'])track.addEventListener(ev,refreshScreen);
      refreshScreen();return;
    }
    if(c.el)return; // one voice per call
    const el=new Audio();el.autoplay=true;el.srcObject=stream;
    const ctx=audio();
    if(ctx){
      // Chrome only feeds a remote WebRTC stream into WebAudio while a media element plays it, so a muted one does.
      el.muted=true;
      const src=ctx.createMediaStreamSource(stream),gain=ctx.createGain(),panner=ctx.createPanner(),an=ctx.createAnalyser();
      panner.panningModel='equalpower';panner.distanceModel='linear';panner.rolloffFactor=0;panner.refDistance=1;panner.maxDistance=1e4;
      an.fftSize=512;src.connect(an);src.connect(gain).connect(panner).connect(V.master);
      Object.assign(c,{src,gain,panner,an,buf:new Uint8Array(an.fftSize)});
    }else el.muted=V.deafened;
    if(prefs.speaker&&el.setSinkId&&!ctx)el.setSinkId(prefs.speaker).catch(()=>{});
    c.el=el;
    el.play().catch(()=>{V.needGesture=true;paint()});
    if(ctx?.state==='suspended'){V.needGesture=true;paint()}
  }
  function hangup(peer,tell=true){
    const c=V.conns.get(peer);if(!c)return;V.conns.delete(peer);
    if(tell&&V.peer)signal(peer,'bye',null);
    try{c.pc?.close()}catch{}
    try{c.src?.disconnect();c.gain?.disconnect();c.panner?.disconnect()}catch{}
    if(c.el){c.el.srcObject=null}
    V.levels.delete(peer);
    refreshScreen();paint();
  }
  const distanceTo=p=>{const a=o.people().get(p.key),m=o.me();return a&&m?Math.hypot(a.obj.position.x-m.x,a.obj.position.z-m.z):null};
  // extra: a caller we have no call with yet, judged like a call already up (the keep distance), so the two
  // sides' slightly different views of where people stand do not bounce the call.
  const wanted=(extra)=>V.peer&&!V.suspended?wantedPeers(me(),[...V.peers.values()],distanceTo,new Set([...V.conns.keys(),...(extra?[extra]:[])])):new Set();
  // Bring the calls in line with who should be in one: the side with the smaller id opens a call.
  function reconcile(){
    const want=wanted();
    for(const peer of [...V.conns.keys()])if(!want.has(peer))hangup(peer);
    for(const peer of want)if(!V.conns.has(peer)&&!isPolite(V.peer,peer))open(peer);
  }

  // ---------- rooms ----------
  function setRoom(ev){
    const before=V.room;V.room=roomReduce(V.room,ev);
    if(before===V.room)return;
    if(V.room.phase==='asking')getMic().then(ok=>{if(V.room.phase==='asking'&&!V.disposed){
      V.room=roomReduce(V.room,{type:'mic',ok});
      if(!ok)o.toast?.('Microphone blocked: you can listen. Allow it in the browser\'s site settings to talk.',true);
      after();
    }});
    if(before.phase!=='out'&&V.room.room!==before.room&&V.share)stopShare(false);
    after();
  }
  function after(){
    if(!inCallWanted()&&!V.suspended)releaseMic();
    postState();applyMic();reconcile();paint();refreshSign();
  }

  // ---------- the meeting room ----------
  const glass=cutaway(new THREE.MeshLambertMaterial({color:'#bfe3ee',transparent:true,opacity:.28,depthWrite:false,side:THREE.DoubleSide}));
  const frameMat=cutaway(new THREE.MeshLambertMaterial({color:'#7d8d92',flatShading:true}));
  const floorMat=new THREE.MeshLambertMaterial({color:'#dfeaf0',flatShading:true});
  const tableMat=new THREE.MeshLambertMaterial({color:'#ece7df',flatShading:true});
  const screenOff=new THREE.MeshBasicMaterial({color:'#1d2421'});
  const box=new THREE.BoxGeometry(1,1,1),plane=new THREE.PlaneGeometry(1,1),ringGeo=new THREE.RingGeometry(0.5,0.64,32);
  const part=(geo,m,[x,y,z],[sx,sy,sz])=>{const p=new THREE.Mesh(geo,m);p.position.set(x,y,z);p.scale.set(sx,sy,sz);return p};
  function layout(){
    if(V.group){o.clear(V.group);V.group=null}
    if(V.screen&&V.screen.material!==screenOff){V.screen.material.map?.dispose();V.screen.material.dispose()}
    V.screen=null;V.screenId=undefined;
    V.walls=[];
    let info;try{info=o.layout()}catch{return}
    V.anchors=meetingAnchors(info);
    const a=V.anchors[0];if(!a)return;
    const g=new THREE.Group();g.position.set(a.x,a.y||0,a.z);g.rotation.y=a.facing;V.group=g;o.world.add(g);
    const {w,d}=a,H=2.3,T=0.1,door=2.4;
    const wall=(x,z,ww,dd)=>{
      if(a.glass){g.add(part(box,glass,[x,H/2,z],[ww,H,dd]));g.add(part(box,frameMat,[x,H,z],[ww,0.06,dd+0.02]))}
      // cam 0: the glass stops people, never the camera (office-world-core.js wallsFrom).
      const p=toWorld(a,x,z);V.walls.push(Object.assign(officeBox(p.x,p.z,a.facing,ww,dd,H),a.glass?{cam:0}:{}));
    };
    if(a.glass){
      g.add(part(box,floorMat,[0,0.025,0],[w,0.05,d]));
      wall(0,-d/2,w,T);wall(-w/2,0,T,d);wall(w/2,0,T,d);
      const side=(w-door)/2;wall(-(door/2+side/2),d/2,side,T);wall(door/2+side/2,d/2,side,T);
      for(const [x,z] of [[-w/2,-d/2],[w/2,-d/2],[-w/2,d/2],[w/2,d/2],[-door/2,d/2],[door/2,d/2]])g.add(part(box,frameMat,[x,H/2,z],[0.12,H,0.12]));
      // The table, and a collider for it.
      g.add(part(box,tableMat,[0,0.72,0.4],[3.2,0.08,1.3]),part(box,frameMat,[0,0.36,0.4],[0.3,0.72,0.3]));
      const t=toWorld(a,0,0.4);V.walls.push(officeBox(t.x,t.z,a.facing,3.2,1.3,0.76));
    }
    // The wall screen: dark until someone shares.
    const sw=Math.min(4,w-1.2),sh=sw*9/16,screen=part(plane,screenOff,[0,1.25+sh/2,-d/2+T/2+0.02],[sw,sh,1]);
    screen.userData={voiceScreen:true,w:sw,h:sh};g.add(screen);V.screen=screen;
    g.add(part(box,frameMat,[0,1.25+sh/2,-d/2+T/2+0.005],[sw+0.12,sh+0.12,0.02]));
    const sign=new THREE.Object3D();sign.position.set(door/2+0.9,0,d/2+0.05);g.add(sign);
    V.sign=o.label(sign,`<span class="of-room ofv-sign" style="--c:#4f9fb8"><b>${esc(a.name)}</b><small></small></span>`,{y:H+0.25,cls:'room'});
    o.interact?.register({id:'voice:screen',position:()=>{const p=toWorld(a,0,-d/2+1.6);return {x:p.x,y:0,z:p.z}},radius:2.6,height:2.4,priority:1,
      enabled:()=>!!sharer(),label:()=>sharer()?.me?'View your shared screen':`View ${sharerName()}'s screen`,onInteract:()=>{openFull();return closeFull}});
    o.interact?.register({id:'voice:share',position:()=>{const p=toWorld(a,0,0.4);return {x:p.x,y:0,z:p.z}},radius:2.4,height:1.4,
      enabled:()=>!!announce(V.room),label:()=>V.share?'Stop sharing your screen':'Share your screen',onInteract:()=>{V.share?stopShare():startShare()}});
    refreshSign();refreshScreen();
  }
  function refreshSign(){
    const a=V.anchors[0];if(!V.sign||!a)return;
    const keys=new Set([...V.peers.values()].filter(p=>p.room===a.id).map(p=>p.key));
    if(announce(V.room)===a.id)keys.add(o.meKey());
    const n=keys.size,el=V.sign.el.querySelector('small'),text=n?` · Live: ${n} in ${a.name}`:' · walk in to talk';
    if(el.textContent!==text)el.textContent=text;
    V.sign.el.firstElementChild.classList.toggle('live',n>0);
  }

  // ---------- screen sharing ----------
  // One screen per room. The sharer's own browser shows its own capture; everyone else in the room shows the
  // video track from the sharer's call.
  const sharer=()=>{
    const room=announce(V.room);if(!room)return null;
    if(V.share)return {peer:V.peer,key:o.meKey(),me:true};
    for(const p of V.peers.values())if(p.share&&p.room===room)return p;
    return null;
  };
  const sharerName=()=>{const s=sharer();return s?.me?'your':s?o.nameOf(s.key):''};
  function screenStream(){
    const s=sharer();if(!s)return null;
    if(s.me)return V.share;
    const t=V.conns.get(s.peer)?.video;
    return t&&t.readyState==='live'&&!t.muted?new MediaStream([t]):null;
  }
  function refreshScreen(){
    if(!V.screen)return;
    const stream=screenStream(),id=stream?stream.getVideoTracks()[0]?.id:'';
    if(id===V.screenId)return;V.screenId=id;
    if(V.screen.material!==screenOff){V.screen.material.map?.dispose();V.screen.material.dispose();V.screen.material=screenOff}
    if(!stream){if(V.screenVideo)V.screenVideo.srcObject=null;if(V.full)closeFull();paint();return}
    const v=V.screenVideo||=Object.assign(document.createElement('video'),{muted:true,playsInline:true,autoplay:true});
    v.srcObject=stream;v.play().catch(()=>{});
    const tex=new THREE.VideoTexture(v);tex.colorSpace=THREE.SRGBColorSpace;
    V.screen.material=new THREE.MeshBasicMaterial({map:tex,toneMapped:false});
    // Letterbox the picture into the screen.
    v.onloadedmetadata=v.onresize=()=>{
      const {w,h}=V.screen.userData,ar=v.videoWidth/v.videoHeight||16/9;
      const sw=Math.min(w,h*ar),sh=sw/ar;V.screen.scale.set(sw,sh,1);
    };
    if(V.full)V.full.querySelector('video').srcObject=stream;
    paint();
  }
  // Someone else sharing in this room: ask first (confirmed: they chose "Share instead"); theirs then ends.
  function startShare(confirmed=false){
    if(!announce(V.room)){o.toast?.('Walk into the meeting room to share your screen',true);return}
    if(!navigator.mediaDevices?.getDisplayMedia){o.toast?.('Screen sharing is not available in this browser',true);return}
    const other=sharer();
    if(other&&!other.me&&!confirmed){V.confirm=o.nameOf(other.key);paint();return}
    V.confirm=null;paint();
    navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:15,max:30}},audio:false}).then(stream=>{
      if(V.disposed||!announce(V.room)){stream.getTracks().forEach(t=>t.stop());return}
      const t=stream.getVideoTracks()[0];if(!t)return;
      try{t.contentHint='detail'}catch{}
      t.addEventListener('ended',()=>{if(V.share===stream)stopShare()});
      V.share=stream;
      for(const c of V.conns.values())if(c.pc)addTracks(c);
      postState();refreshScreen();paint();
    }).catch(e=>{if(e?.name!=='NotAllowedError'&&e?.name!=='AbortError')o.toast?.('Could not share your screen',true);paint()});
  }
  function stopShare(tell=true){
    const s=V.share;if(!s)return;V.share=null;
    s.getTracks().forEach(t=>t.stop());
    for(const c of V.conns.values())if(c.videoSender){try{c.pc.removeTrack(c.videoSender)}catch{}c.videoSender=null}
    if(tell)postState();refreshScreen();paint();
  }
  function openFull(){
    const stream=screenStream();if(!stream)return;
    closeFull();
    const el=document.createElement('div');el.className='ofv-full';el.setAttribute('role','dialog');el.setAttribute('aria-label','Shared screen');
    el.innerHTML=`<div class="ofv-full-top"><b>${esc(sharer()?.me?'Your screen':`${sharerName()}'s screen`)}</b><span class="sp"></span>
      <button type="button" class="ib" data-ofv="fs" aria-label="Full screen" data-tip="Full screen">${ICON.expand}</button>
      <button type="button" class="ib" data-ofv="closeFull" aria-label="Close (Esc)" data-tip="Close (Esc)">${ICON.x}</button></div><video autoplay playsinline muted></video>`;
    const v=el.querySelector('video');v.srcObject=stream;v.play().catch(()=>{});
    el.addEventListener('click',e=>{const b=e.target.closest('[data-ofv]');if(b?.dataset.ofv==='closeFull')closeFull();if(b?.dataset.ofv==='fs')(v.requestFullscreen?.()||Promise.resolve()).catch(()=>{})});
    o.root.append(el);V.full=el;el.querySelector('[data-ofv="closeFull"]').focus({preventScroll:true});
  }
  function closeFull(){if(!V.full)return false;V.full.querySelector('video').srcObject=null;V.full.remove();V.full=null;o.root.focus?.({preventScroll:true});return true}

  // ---------- the HUD ----------
  const hud=document.createElement('div');hud.className='ofv';hud.setAttribute('role','group');hud.setAttribute('aria-label','Voice');
  o.stage.append(hud);
  hud.addEventListener('click',e=>{
    const b=e.target.closest('[data-ofv]');if(!b)return;
    const f={
      mute:()=>{V.muted=!V.muted;applyMic();postState()},
      deafen:()=>{V.deafened=!V.deafened;applyMic();postState()},
      near:()=>toggleNear(),
      share:()=>V.share?stopShare():startShare(),
      take:()=>startShare(true),
      cancelTake:()=>{V.confirm=null;paint()},
      view:()=>openFull(),
      go:()=>goToRoom(),
      gesture:()=>gesture(),
      settings:()=>toggleSettings(),
    }[b.dataset.ofv];
    f?.();
  });
  // "Go to the meeting room": out of your room's door, round the common area, in through its door.
  function goToRoom(){
    const a=V.anchors[0],m=o.me();if(!a||!o.walkTo)return;
    // Along real paths when the office can plan them (office-travel-core.js): any world, never through a wall.
    if(o.goTo){const p=toWorld(a,0,a.d/2-1.9);V.route=null;o.goTo(p.x,p.z);paint();return}
    const {commonR=10}=(()=>{try{return o.layout()}catch{return {}}})(),ring=commonR+2;
    const door=toWorld(a,0,a.d/2+1.6),inside=toWorld(a,0,a.d/2-1.6),ang=Math.atan2(door.z,door.x),r=Math.hypot(m.x,m.z);
    let route=[];
    // A world with corridors says where the walk bends (office-layout.js route()).
    const planned=(()=>{try{return o.layout().world?.route?.({x:m.x,z:m.z},door)}catch{return null}})();
    if(planned?.length)route=[...planned,inside];
    else{
      if(r>ring){const k=ring/r;route.push({x:m.x*k,z:m.z*k})}
      if(Math.hypot(door.x,door.z)>ring)route.push({x:Math.cos(ang)*ring,z:Math.sin(ang)*ring});
      route.push(door,inside);
    }
    V.route=route;V.routeAt=0;o.walkTo(route[0].x,route[0].z);paint();
  }
  function followRoute(m){
    const p=V.route?.[V.routeAt];if(!p)return;
    if(Math.hypot(p.x-m.x,p.z-m.z)<0.7){V.routeAt++;const q=V.route[V.routeAt];if(q)o.walkTo(q.x,q.z);else{V.route=null;paint()}return}
    if(o.walking&&!o.walking()){V.route=null;paint()} // they steered themselves: the walk is over
  }
  function toggleNear(){
    V.near=!V.near;gesture(); // per visit: never on by itself
    if(V.near&&!o.quiet?.()&&V.room.phase==='out')getMic().then(ok=>{if(!ok&&V.near)o.toast?.('Microphone blocked: you can listen nearby. Allow it in the browser\'s site settings to talk.',true);after()});
    if(V.near&&o.quiet?.())o.toast?.('You are in Do not disturb: nobody is connected until you change it');
    after();
  }
  function paint(){
    if(V.disposed)return;
    const room=announce(V.room),near=nearOn(),call=room||near,asking=V.room.phase==='asking';
    const live=micLive(),n=[...V.conns.values()].filter(c=>c.pc?.connectionState==='connected').length;
    const a=V.anchors.find(x=>x.id===room);
    const micText=!call?'':!V.mic?(asking?'Asking for your mic…':'Listening only'):V.deafened?'Deafened':V.muted?'Muted':prefs.ptt&&!V.pttHeld?'Hold V to talk':'Mic on';
    const where=room?`In ${esc(a?.name||'the meeting room')}${n?` · ${n+1} connected`:''}`:near?(o.quiet?.()?'Nearby voice paused: Do not disturb':`Nearby voice${n?` · ${n} connected`:': walk up to someone'}`):'';
    const sh=room?sharer():null;
    const html=`${where?`<span class="ofv-where">${where}</span>`:''}
      ${V.needGesture&&call?`<button type="button" class="txt primary ofv-tap" data-ofv="gesture">Tap to hear</button>`:''}
      ${call?`<button type="button" class="ofv-mic${live?' on':''}${V.mic&&!live?' off':''}" data-ofv="mute" aria-pressed="${V.muted}" aria-label="${V.muted?'Unmute':'Mute'} (M)" data-tip="${V.muted?'Unmute':'Mute'} (M)">${live||!V.mic&&!V.muted?ICON.mic:ICON.micOff}<span>${micText}</span></button>
        <button type="button" class="ib" data-ofv="deafen" aria-pressed="${V.deafened}" aria-label="${V.deafened?'Undeafen':'Deafen'}" data-tip="${V.deafened?'Undeafen':'Deafen: hear nobody'}">${V.deafened?ICON.headOff:ICON.head}</button>`:''}
      ${room?`<button type="button" class="ib${V.share?' on':''}" data-ofv="share" aria-pressed="${!!V.share}" aria-label="${V.share?'Stop sharing':'Share screen'}" data-tip="${V.share?'Stop sharing':'Share screen'}">${ICON.screen}</button>`:''}
      ${sh&&!sh.me&&screenStream()?`<button type="button" class="ib" data-ofv="view" aria-label="View the shared screen" data-tip="View ${esc(o.nameOf(sh.key))}'s screen">${ICON.expand}</button>`:''}
      ${room||!V.anchors[0]||V.route?'':`<button type="button" class="ib" data-ofv="go" aria-label="Go to the ${esc(V.anchors[0].name.toLowerCase())}" data-tip="Go to the ${esc(V.anchors[0].name.toLowerCase())}">${ICON.door}</button>`}
      ${room?'':`<button type="button" class="ofv-near${V.near?' on':''}" data-ofv="near" aria-pressed="${V.near}">${ICON.near}<span>Talk to people nearby</span></button>`}
      <button type="button" class="ib" data-ofv="settings" aria-label="Voice settings" aria-expanded="${!!V.settings}" data-tip="Voice settings">${ICON.gear}</button>
      ${V.confirm?`<div class="ofv-confirm" role="alertdialog" aria-label="Take over the screen"><span>${esc(V.confirm)} is sharing their screen. Share yours instead?</span>
        <button type="button" class="txt primary" data-ofv="take">Share instead</button><button type="button" class="txt" data-ofv="cancelTake">Cancel</button></div>`:''}`;
    if(V.hudHtml!==html){V.hudHtml=html;hud.innerHTML=html;if(V.settings)hud.append(V.settings)}
    hud.classList.toggle('call',!!call);
  }
  async function toggleSettings(){
    if(V.settings){V.settings.remove();V.settings=null;paint();return}
    const el=document.createElement('div');el.className='ofv-settings';V.settings=el;
    let devices=[];try{devices=await navigator.mediaDevices?.enumerateDevices()||[]}catch{}
    const mics=devices.filter(d=>d.kind==='audioinput'),outs=devices.filter(d=>d.kind==='audiooutput');
    const canSink=!!(globalThis.AudioContext?.prototype?.setSinkId||globalThis.HTMLMediaElement?.prototype?.setSinkId);
    const opt=(list,sel,none)=>`<option value="">${none}</option>`+list.map((d,i)=>`<option value="${esc(d.deviceId)}"${d.deviceId===sel?' selected':''}>${esc(d.label||`Device ${i+1}`)}</option>`).join('');
    el.innerHTML=`<b>Voice</b>
      <label>Microphone<select data-ofv-set="mic">${opt(mics,prefs.mic,'Default microphone')}</select></label>
      ${canSink&&outs.length?`<label>Speaker<select data-ofv-set="speaker">${opt(outs,prefs.speaker,'Default speaker')}</select></label>`:''}
      <label class="ofv-check"><input type="checkbox" data-ofv-set="ptt"${prefs.ptt?' checked':''}> Push to talk (hold V)</label>
      <p class="ofv-note">Walk into the meeting room to join its call. M mutes. Voice goes straight between browsers and is never recorded.${mics.length&&!mics[0].label?' Device names show once the browser may use your microphone.':''}</p>`;
    el.addEventListener('change',e=>{
      const t=e.target,k=t.dataset.ofvSet;if(!k)return;
      if(k==='ptt'){prefs.ptt=t.checked;savePrefs(prefs);applyMic();return}
      prefs[k]=t.value;savePrefs(prefs);
      if(k==='mic'&&V.mic){releaseMic();getMic().then(()=>after())}
      if(k==='speaker'){if(V.ctx?.setSinkId)V.ctx.setSinkId(t.value).catch(()=>{});else for(const c of V.conns.values())c.el?.setSinkId?.(t.value).catch(()=>{})}
    });
    el.addEventListener('keydown',e=>e.stopPropagation());
    paint();hud.append(el);el.querySelector('select,input')?.focus({preventScroll:true});
  }

  // ---------- speaking rings ----------
  const level=(an,buf)=>{an.getByteTimeDomainData(buf);let s=0;for(let i=0;i<buf.length;i++){const v=(buf[i]-128)/128;s+=v*v}return Math.sqrt(s/buf.length)};
  function ring(key){
    let r=V.rings.get(key);
    if(!r){r=new THREE.Mesh(ringGeo,new THREE.MeshBasicMaterial({color:'#38c172',transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide}));r.rotation.x=-Math.PI/2;r.renderOrder=3;o.scene.add(r);V.rings.set(key,r)}
    return r;
  }

  // ---------- each frame ----------
  function frame(dt){
    if(V.disposed||!V.peer)return;
    const m=o.me();
    if(V.route)followRoute(m);
    if(!V.suspended&&V.anchors.length){const id=roomAt(V.anchors,m.x,m.z,V.room.room);if(id!==V.room.room||(!id&&V.room.phase!=='out'))setRoom(id?{type:'enter',room:id}:{type:'exit'})}
    const t=performance.now();
    if(t-V.reconcileAt>RECONCILE_MS){V.reconcileAt=t;if(o.quiet?.()!==JSON.parse(V.sent||'{}').dnd)postState();reconcile();refreshSign()}
    // Who is speaking, and how loud and from where nearby voices sound.
    const loud=new Map();
    if(V.local&&micLive())loud.set(o.meKey(),level(V.local.an,V.local.buf));
    const room=announce(V.room),mix=t-V.mixAt>80;if(mix)V.mixAt=t;
    for(const c of V.conns.values()){
      const p=V.peers.get(c.peer);if(!p)continue;
      if(c.an)loud.set(p.key,Math.max(loud.get(p.key)||0,level(c.an,c.buf)));
      if(!mix||!c.gain)continue;
      const a=o.people().get(p.key);
      let g=1,pan=0;
      if(!room&&a){const r=proximityMix({x:m.x,z:m.z,heading:o.facing()},{x:a.obj.position.x,z:a.obj.position.z});g=r.gain;pan=r.pan}
      const now=V.ctx.currentTime;c.gain.gain.setTargetAtTime(g,now,0.08);
      c.panner.positionX.setTargetAtTime(pan,now,0.08);c.panner.positionY.value=0;c.panner.positionZ.setTargetAtTime(-Math.sqrt(Math.max(0,1-pan*pan)),now,0.08);
    }
    for(const [key,r] of V.rings){if(!loud.has(key)&&r.material.opacity<0.01&&!o.people().has(key)){o.scene.remove(r);r.material.dispose();V.rings.delete(key)}}
    for(const [key,a] of o.people()){
      const lv=loud.get(key)||0;if(!lv&&!V.rings.has(key))continue;
      const r=ring(key),on=lv>SPEAKING;
      r.position.set(a.obj.position.x,(a.obj.position.y||0)+0.05,a.obj.position.z);
      const target=on?Math.min(0.95,0.45+lv*4):0;r.material.opacity+=(target-r.material.opacity)*Math.min(1,dt*14);
      const s=1+(on?Math.min(0.35,lv*3):0);r.scale.setScalar(s);r.visible=r.material.opacity>0.01;
      a.tag?.el?.firstElementChild?.classList.toggle('ofv-speaking',on);
    }
  }

  // ---------- events from the office stream ----------
  function event(d){
    if(!d||V.disposed)return;
    if(d.type==='welcome'){
      // A new connection to the office (the first, or after a reconnect): a new peer id, calls start over.
      for(const peer of [...V.conns.keys()])hangup(peer,false);
      V.peer=d.peer;V.peers=new Map((d.peers||[]).map(p=>[p.peer,p]));V.sent='';postState(true);paint();refreshSign();refreshScreen();return;
    }
    if(d.type==='state'){
      if(d.peer===V.peer){if(d.taken&&V.share){stopShare(false);V.sent='';postState();o.toast?.('Someone else is sharing their screen now')}return}
      V.peers.set(d.peer,d);refreshSign();refreshScreen();
      if(V.conns.has(d.peer)){const c=V.conns.get(d.peer);if(c.pc&&V.share)addTracks(c)}
      reconcile();paint();return;
    }
    if(d.type==='gone'){V.peers.delete(d.peer);hangup(d.peer,false);refreshSign();refreshScreen();return}
    if(d.type==='offer'||d.type==='answer')onDescription(d.from,d.data);
    else if(d.type==='ice')onIce(d.from,d.data);
    else if(d.type==='bye')hangup(d.from,false);
  }

  // ---------- keys, the tab, closing ----------
  function keyDown(e){
    if(e.code==='KeyM'&&!e.repeat){V.muted=!V.muted;applyMic();postState();if(inCall())o.toast?.(V.muted?'Muted':'Mic on');return true}
    if(e.code==='KeyV'&&prefs.ptt){if(!V.pttHeld){V.pttHeld=true;applyMic()}return true}
    return false;
  }
  function keyUp(e){if(e.code==='KeyV'&&V.pttHeld){V.pttHeld=false;applyMic()}}
  const blur=()=>{if(V.pttHeld){V.pttHeld=false;applyMic()}};
  addEventListener('blur',blur);
  // Hidden for more than two minutes: every call ends and the mic is released, until the tab is back.
  function suspend(){
    if(V.suspended)return;V.suspended=true;
    stopShare(false);for(const peer of [...V.conns.keys()])hangup(peer);
    V.room=roomReduce(V.room,{type:'suspend'});releaseMic();postState();paint();refreshSign();
  }
  const visibility=()=>{
    clearTimeout(V.hiddenTimer);
    if(document.hidden)V.hiddenTimer=setTimeout(suspend,HIDDEN_MS);
    else if(V.suspended){V.suspended=false;if(nearOn())getMic().then(()=>after());after()}
  };
  document.addEventListener('visibilitychange',visibility);
  paint();
  return {
    event,layout,frame,keyDown,keyUp,
    get walls(){return V.walls},
    // Is (x, z) inside the meeting room? (a Chief of Staff waits at its desk while its person is in a meeting)
    inMeeting:(x,z)=>!!roomAt(V.anchors,x,z),
    escape:()=>{if(V.confirm){V.confirm=null;paint();return true}if(V.settings){toggleSettings();return true}return closeFull()},
    pick(ray){if(!V.screen||!sharer())return false;if(!ray.intersectObject(V.screen,false).length)return false;openFull();return true},
    // For tests and the docs: what this browser is doing.
    debug:()=>({peer:V.peer,room:V.room,near:nearOn(),muted:V.muted,deafened:V.deafened,sharing:!!V.share,mic:!!V.mic,
      peers:[...V.peers.values()],conns:[...V.conns.values()].map(c=>({peer:c.peer,state:c.pc?.connectionState||'new',audio:!!c.el,video:!!c.video&&c.video.readyState==='live'&&!c.video.muted,gain:c.gain?.gain.value})),
      screen:!!screenStream(),anchors:V.anchors}),
    dispose(){
      if(V.disposed)return;
      stopShare(false);for(const peer of [...V.conns.keys()])hangup(peer,false);
      V.disposed=true;releaseMic();V.silent?.stop();closeFull();
      clearTimeout(V.hiddenTimer);document.removeEventListener('visibilitychange',visibility);removeEventListener('blur',blur);
      o.root.removeEventListener('pointerdown',gesture,true);o.root.removeEventListener('keydown',gesture,true);o.root.removeEventListener('touchend',gesture,true);
      for(const r of V.rings.values()){o.scene.remove(r);r.material.dispose()}V.rings.clear();
      if(V.group)o.clear(V.group);
      if(V.screen?.material!==screenOff){V.screen?.material.map?.dispose();V.screen?.material.dispose()}
      for(const x of [glass,frameMat,floorMat,tableMat,screenOff,box,plane,ringGeo])x.dispose();
      if(V.screenVideo)V.screenVideo.srcObject=null;
      V.ctx?.close().catch(()=>{});hud.remove();
    },
  };
}
