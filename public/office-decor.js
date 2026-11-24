// Decorating your own room in the 3D office (docs/concepts/12-office.md). Props are built here from
// boxes and cones; the rules live in office-decor-core.js, which the server uses too. A prop's group
// faces +z at rot 0 and turns by propYaw, the same quarter-turns the collision footprint swaps on.
import * as THREE from './vendor/three/three.module.min.js';
import {esc} from './ui.js';
import {officeBox} from './office-controls.js';
import {toWorld} from './office-layout.js';
import {ART,CATALOGUE,FLOORS,MATERIALS,MAX_PROPS,PRESET_NAMES,WALLS,cleanTheme,covers,frameFromAnchor,newPropId,placementIssue,propYaw,reservedZones,sanitizeSign,snapFloor,snapWall,solidBoxes} from './office-decor-core.js';

const listeners=new Set();
// office-npc.js (when the world has one) reads the same boxes the player collides with.
export function onDecorObstacles(fn){listeners.add(fn);return ()=>listeners.delete(fn)}

const unit={};
const geo=k=>unit[k]||=k==='box'?new THREE.BoxGeometry(1,1,1):k==='cyl'?new THREE.CylinderGeometry(1,1,1,8):k==='cone'?new THREE.ConeGeometry(1,1,7):k==='ball'?new THREE.IcosahedronGeometry(1,1):new THREE.TorusGeometry(0.5,0.12,6,10);
const mats=new Map();
const lambert=(color,opts)=>{const k=color+'|'+(opts?JSON.stringify(opts):'');let m=mats.get(k);if(!m){m=new THREE.MeshLambertMaterial({color,flatShading:true,...opts});mats.set(k,m)}return m};
const C={
  pot:'#b5835a',leaf:'#5f9e6e',soil:'#6b4a32',wood:'#b98d63',dark:'#2a3330',gold:'#e0b34a',
  water:'#3d9ec4',glass:'#b7e0ea',cream:'#f4efe6',ink:'#1d2421',cloth:'#c45c6a',shade:'#f7f5f1',
};
function piece(parent,kind,color,x,y,z,sx,sy,sz,opts){
  const m=new THREE.Mesh(geo(kind),lambert(color,opts));m.position.set(x,y,z);m.scale.set(sx,sy,sz);parent.add(m);return m;
}
const shadowOf=parent=>{const m=piece(parent,'cyl','#000000',0,0.025,0,0.35,0.02,0.35,{transparent:true,opacity:0.12,depthWrite:false});m.material.transparent=true;return m};

// Each builder fits inside the catalogue footprint (width x, depth z, height y) and faces +z.
const BUILD={
  'plant-fern'(g){piece(g,'cyl',C.pot,0,0.16,0,0.16,0.32,0.16);piece(g,'cyl',C.soil,0,0.32,0,0.13,0.04,0.13);piece(g,'cone',C.leaf,0,0.7,0,0.26,0.7,0.26);piece(g,'cone','#3f7d4a',-0.12,0.55,0.08,0.16,0.5,0.16);shadowOf(g)},
  'plant-cactus'(g){piece(g,'cyl',C.pot,0,0.1,0,0.14,0.2,0.14);piece(g,'box','#6aaa55',0,0.5,0,0.16,0.55,0.16);piece(g,'box','#6aaa55',0.14,0.48,0,0.16,0.08,0.1);piece(g,'box','#7cbc62',0.22,0.62,0,0.08,0.22,0.1);shadowOf(g)},
  'plant-tree'(g){piece(g,'cyl',C.pot,0,0.12,0,0.2,0.24,0.2);piece(g,'cyl','#6b4a32',0,0.55,0,0.08,0.7,0.08);piece(g,'ball','#3f7d4a',0,1.15,0,0.32,0.38,0.32);piece(g,'ball','#5f9e6e',0.12,1.28,0.06,0.2,0.22,0.2);shadowOf(g)},
  rug(g,p){piece(g,'box',p.color||'#c4a574',0,0.015,0,1.8,0.02,1.15)},
  lamp(g){piece(g,'cyl',C.dark,0,0.04,0,0.12,0.06,0.12);piece(g,'cyl','#c9d0cc',0,0.7,0,0.03,1.2,0.03);piece(g,'cone',C.shade,0,1.25,0,0.16,0.22,0.16);piece(g,'ball','#fff4c4',0,1.15,0,0.05,0.05,0.05,{emissive:'#ffe08a'});shadowOf(g)},
  bookshelf(g){piece(g,'box',C.wood,0,0.85,0,0.9,1.7,0.35);piece(g,'box',C.cream,0,0.9,0.02,0.78,1.45,0.22);for(const [y,c] of [[0.4,'#3d6fb6'],[0.7,'#a8524c'],[1.05,'#d9a441'],[1.35,'#5f9e6e']])piece(g,'box',c,-0.22,y,0.08,0.08,0.22,0.16);shadowOf(g)},
  sofa(g){piece(g,'box','#8d9aa3',0,0.28,0,1.6,0.32,0.7);piece(g,'box','#6e7c86',0,0.52,-0.22,1.6,0.4,0.16);piece(g,'box','#6e7c86',-0.74,0.42,0.05,0.12,0.36,0.62);piece(g,'box','#6e7c86',0.74,0.42,0.05,0.12,0.36,0.62);shadowOf(g)},
  armchair(g){piece(g,'box',C.cloth,0,0.28,0,0.75,0.32,0.7);piece(g,'box','#a34b58',0,0.55,-0.22,0.75,0.42,0.16);piece(g,'box','#a34b58',-0.34,0.4,0.04,0.1,0.32,0.58);piece(g,'box','#a34b58',0.34,0.4,0.04,0.1,0.32,0.58);shadowOf(g)},
  'coffee-table'(g){piece(g,'box',C.wood,0,0.32,0,0.95,0.06,0.55);for(const x of [-0.4,0.4])for(const z of [-0.2,0.2])piece(g,'box',C.dark,x,0.15,z,0.06,0.28,0.06);shadowOf(g)},
  poster(g,p){piece(g,'box',C.ink,0,1.35,0,0.8,0.65,0.06);piece(g,'box',p.color||ART[0],0,1.35,0.02,0.68,0.52,0.02)},
  trophy(g){piece(g,'box',C.dark,0,0.06,0,0.22,0.08,0.22);piece(g,'cyl',C.gold,0,0.28,0,0.05,0.28,0.05);piece(g,'ball',C.gold,0,0.46,0,0.1,0.08,0.1);shadowOf(g)},
  aquarium(g){piece(g,'box','#d8e4e8',0,0.08,0,0.9,0.08,0.4);piece(g,'box',C.water,0,0.32,0,0.82,0.4,0.32,{transparent:true,opacity:0.55});piece(g,'box',C.glass,0,0.36,0,0.9,0.5,0.4,{transparent:true,opacity:0.28,depthWrite:false});piece(g,'ball','#e07b39',-0.15,0.28,0.05,0.05,0.04,0.06);shadowOf(g)},
  arcade(g){piece(g,'box','#2c3a44',0,0.7,0,0.7,1.4,0.7);piece(g,'box','#12181c',0,1.15,0.28,0.5,0.42,0.04);piece(g,'box','#3d6fb6',0,1.15,0.3,0.4,0.3,0.02,{emissive:'#1d3f7a'});piece(g,'box','#e07b39',0,0.55,0.32,0.2,0.06,0.04);shadowOf(g)},
  beanbag(g){piece(g,'ball','#6b5ca5',0,0.26,0,0.34,0.24,0.34);piece(g,'ball','#5a4c90',0,0.38,0.08,0.22,0.14,0.2);shadowOf(g)},
  'standing-desk'(g){piece(g,'box',C.wood,0,1.02,0,1.15,0.06,0.55);piece(g,'box',C.dark,-0.48,0.52,0,0.06,1.0,0.4);piece(g,'box',C.dark,0.48,0.52,0,0.06,1.0,0.4);piece(g,'box','#9ad0ff',0,1.22,-0.12,0.42,0.28,0.04);shadowOf(g)},
  whiteboard(g){piece(g,'box','#8aa0a8',0,1.45,0,1.2,0.8,0.06);piece(g,'box','#fbfdfc',0,1.45,0.02,1.08,0.68,0.02);piece(g,'box','#d97857',-0.2,1.5,0.04,0.28,0.02,0.01)},
  neon(g,p,opts){piece(g,'box','#14191c',0,1.7,0,1.15,0.32,0.06);const face=piece(g,'box',p.color||ART[4],0,1.7,0.025,1.05,0.22,0.01);if(!opts?.ghost)face.material=neonMaterial(p.color||ART[4],p.text||'')},
  trinket(g){piece(g,'cyl',C.cream,0,0.05,0,0.07,0.08,0.07);piece(g,'ball','#d97857',0,0.12,0,0.045,0.045,0.045);shadowOf(g)},
};
const textures=[];
function neonMaterial(color,text){
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,256,64);ctx.fillStyle=color;ctx.font='700 28px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text||' ',128,34);
  const map=new THREE.CanvasTexture(canvas);if('colorSpace' in map&&THREE.SRGBColorSpace)map.colorSpace=THREE.SRGBColorSpace;
  const m=new THREE.MeshBasicMaterial({map,transparent:true,depthWrite:false});textures.push(m);return m;
}
function sweepTextures(){for(const m of textures){m.map?.dispose();m.dispose()}textures.length=0}
function releaseMaps(group){
  group?.traverse(o=>{
    const m=o.material;if(!m?.map)return;
    m.map.dispose();m.dispose();
    const i=textures.indexOf(m);if(i>=0)textures.splice(i,1);
  });
}
function buildProp(prop,opts){
  const g=new THREE.Group();g.position.set(prop.x,0,prop.z);g.rotation.y=propYaw(prop.rot||0);
  (BUILD[prop.kind]||BUILD.trinket)(g,prop,opts);
  g.traverse(o=>{o.userData.propId=prop.id});g.userData.propId=prop.id;return g;
}

// office: root(), me(), pos(){x,z}, rooms() Map, liveCount(key), anchor(key), api(path,body),
// toast(msg,bad), camera(), canvas(), refresh(), repaint(key).
export function createDecor(office){
  const saved=new Map();
  let editing=false,hand=null,selected=null,dirty=false,epoch=0,timer=0,lastPoint=null,ghost=null,ghostKey='';
  let acked={theme:null,props:[]};
  const panel=document.createElement('aside');panel.className='of-decor';panel.hidden=true;panel.setAttribute('aria-label','Decorate your room');
  panel.addEventListener('pointerdown',e=>e.stopPropagation());
  panel.addEventListener('keydown',e=>e.stopPropagation());
  office.root().append(panel);
  const ray=new THREE.Raycaster(),ndc=new THREE.Vector2(),plane=new THREE.Plane(new THREE.Vector3(0,1,0),0),hit=new THREE.Vector3();
  const ghostOk=new THREE.MeshBasicMaterial({color:'#3fbf7f',transparent:true,opacity:0.45,depthWrite:false});
  const ghostBad=new THREE.MeshBasicMaterial({color:'#e05a4f',transparent:true,opacity:0.45,depthWrite:false});
  const selectMat=new THREE.MeshBasicMaterial({color:'#1f8a70',wireframe:true});

  const mine=()=>office.me();
  const roomOf=key=>office.rooms()?.get(key)||null;
  function entry(key){if(!saved.has(key))saved.set(key,{theme:null,props:[]});return saved.get(key)}
  function frameFor(key){return frameFromAnchor(office.anchor?.(key))}
  function zonesFor(key){return reservedZones(frameFor(key),{desks:office.liveCount?.(key)||0})}
  // Inverse of toWorld: room local x is across, z is toward the door.
  function toLocal(room,x,z){
    const dx=x-room.center.x,dz=z-room.center.z,c=Math.cos(room.facing),s=Math.sin(room.facing);
    return {x:dx*c-dz*s,z:dx*s+dz*c};
  }
  function ownRoom(){
    const key=mine(),room=key&&roomOf(key);if(!room)return null;
    const p=office.pos(),loc=toLocal(room,p.x,p.z),f=frameFor(key);
    if(Math.abs(loc.x)>=f.width/2-0.05||Math.abs(loc.z)>=f.depth/2-0.05)return null;
    return room;
  }
  function floorPoint(e){
    const cam=office.camera(),cv=office.canvas();if(!cam||!cv)return null;
    const r=cv.getBoundingClientRect();if(!r.width||!r.height)return null;
    ndc.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);
    ray.setFromCamera(ndc,cam);
    return ray.ray.intersectPlane(plane,hit)?hit.clone():null;
  }
  function poseFor(kind,local,rot){
    const frame=frameFor(mine());
    if(CATALOGUE[kind]?.wall)return snapWall(local.x,local.z,kind,frame);
    return snapFloor(local.x,local.z,rot||0);
  }
  function issueFor(prop){return placementIssue(prop,frameFor(mine()),zonesFor(mine()))}

  function load(list){
    const next=new Map();
    for(const row of list||[])next.set(row.member,{theme:row.theme??null,props:Array.isArray(row.props)?row.props.map(p=>({...p})):[]});
    const key=mine();
    if(dirty&&key&&saved.has(key))next.set(key,saved.get(key));
    saved.clear();for(const [k,v] of next)saved.set(k,v);
    if(!dirty)acked=key&&saved.get(key)?{theme:saved.get(key).theme,props:saved.get(key).props.map(p=>({...p}))}:{theme:null,props:[]};
  }
  function remote(row){
    if(!row?.member)return;
    if(row.member===mine()&&dirty)return;
    saved.set(row.member,{theme:row.theme??null,props:Array.isArray(row.props)?row.props.map(p=>({...p})):[]});
    if(row.member===mine())acked={theme:row.theme??null,props:(row.props||[]).map(p=>({...p}))};
    const room=roomOf(row.member);if(room)buildRoom(row.member,room);
    office.refresh?.();office.repaint?.(row.member);
  }
  function buildRoom(key,room){
    releaseMaps(room.decorGroup);room.decorGroup?.removeFromParent();
    const data=saved.get(key);if(!data){room.navBoxes=[];return}
    const g=new THREE.Group();room.decorGroup=g;room.group.add(g);
    dress(g,data.theme,frameFor(key));
    for(const prop of data.props||[]){
      const mesh=buildProp(prop);g.add(mesh);
      if(prop.id===selected)markSelected(mesh,prop);
    }
  }
  function markSelected(mesh,prop){
    const spec=CATALOGUE[prop.kind],wire=new THREE.Mesh(geo('box'),selectMat);
    wire.scale.set(spec.w+0.05,spec.h+0.05,spec.d+0.05);wire.position.y=spec.h/2;mesh.add(wire);
  }
  function dress(g,theme,frame){
    if(!theme)return;
    if(theme.material==='wood'){
      for(let i=-4;i<=4;i++)piece(g,'box','#000000',0,0.07,i*0.85,frame.width-0.6,0.01,0.03,{transparent:true,opacity:0.12,depthWrite:false});
    }else if(theme.material==='tile'){
      const step=0.9;
      for(let x=-frame.width/2+step;x<frame.width/2;x+=step)piece(g,'box','#ffffff',x,0.07,0,0.02,0.01,frame.depth-0.5,{transparent:true,opacity:0.18,depthWrite:false});
      for(let z=-frame.depth/2+step;z<frame.depth/2;z+=step)piece(g,'box','#ffffff',0,0.07,z,frame.width-0.5,0.01,0.02,{transparent:true,opacity:0.18,depthWrite:false});
    }
  }
  function mount(){
    sweepTextures();ghost=null;ghostKey='';
    for(const [key,room] of office.rooms()||[])buildRoom(key,room);
    office.refresh?.();
  }
  function stamp(){
    const rooms=office.rooms();if(!rooms)return;
    const report=[];
    for(const [key,room] of rooms){
      room.boxes=(room.boxes||[]).filter(b=>!b.decor);
      const boxes=solidBoxes(saved.get(key)?.props||[]);
      room.navBoxes=boxes;
      const c=Math.cos(room.facing),s=Math.sin(room.facing);
      for(const b of boxes){
        const box=officeBox(room.center.x+b.x*c+b.z*s,room.center.z-b.x*s+b.z*c,room.facing,b.w,b.d,b.h+(room.center.y||0));
        box.decor=true;room.boxes.push(box);
      }
      report.push({member:key,boxes});
    }
    for(const fn of listeners)fn(report);
  }
  function blocked(member,x,z){
    const room=roomOf(member);if(!room?.navBoxes?.length)return false;
    const loc=toLocal(room,x,z);
    return covers(room.navBoxes,loc.x,loc.z,0.34);
  }
  function schedule(){
    dirty=true;const token=++epoch;clearTimeout(timer);
    timer=setTimeout(()=>save(token),200);
  }
  async function save(token){
    const key=mine();if(!key)return;
    const body={theme:entry(key).theme,props:entry(key).props.map(p=>({...p}))};
    try{
      const res=await office.api('decorate',body);
      if(token!==epoch)return;
      dirty=false;
      const next={theme:res.theme??null,props:res.props||body.props};
      saved.set(key,next);acked={theme:next.theme,props:next.props.map(p=>({...p}))};
      const room=roomOf(key);if(room)buildRoom(key,room);
      office.refresh?.();office.repaint?.(key);
    }catch(e){
      if(token!==epoch)return;
      dirty=false;saved.set(key,{theme:acked.theme,props:acked.props.map(p=>({...p}))});selected=null;
      const room=roomOf(key);if(room)buildRoom(key,room);
      office.refresh?.();office.repaint?.(key);paint();
      office.toast?.(e.message||'Could not save the room',true);
    }
  }
  function tryPlace(pose){
    const key=mine(),data=entry(key);
    if(data.props.length>=MAX_PROPS){office.toast?.('A room holds up to 40 props.',true);return}
    const prop={id:newPropId(),kind:hand.kind,...pose};
    if(CATALOGUE[hand.kind].color)prop.color=hand.color;
    if(CATALOGUE[hand.kind].text)prop.text=sanitizeSign(hand.text);
    const issue=issueFor(prop);
    if(issue){office.toast?.(issue.message,true);return}
    data.props.push(prop);selected=prop.id;
    const room=roomOf(key);if(room)buildRoom(key,room);
    office.refresh?.();schedule();paint();
  }
  function rotate(){
    const spec=hand&&CATALOGUE[hand.kind];
    if(hand&&!spec?.wall){hand={...hand,rot:((hand.rot||0)+1)%4};ghostKey='';return}
    const key=mine(),data=key&&saved.get(key),prop=data?.props.find(p=>p.id===selected);
    if(!prop||CATALOGUE[prop.kind]?.wall)return;
    const next=(prop.rot+1)%4,issue=issueFor({...prop,rot:next});
    if(issue){office.toast?.(issue.message,true);return}
    prop.rot=next;const room=roomOf(key);if(room)buildRoom(key,room);schedule();
  }
  function removeSelected(){
    if(hand){hand=null;ghostKey='';dropGhost();paint();return}
    const key=mine(),data=key&&saved.get(key);if(!data||!selected)return;
    const n=data.props.length;data.props=data.props.filter(p=>p.id!==selected);
    if(data.props.length===n)return;
    selected=null;const room=roomOf(key);if(room)buildRoom(key,room);office.refresh?.();schedule();paint();
  }
  function dropGhost(){ghost?.removeFromParent();ghost=null;ghostKey=''}
  function syncGhost(){
    const room=ownRoom();
    if(!editing||!hand||!room||!lastPoint){dropGhost();return}
    const loc=toLocal(room,lastPoint.x,lastPoint.z);
    const pose=poseFor(hand.kind,loc,hand.rot||0);if(!pose){dropGhost();return}
    const draft={id:'ppreview0',kind:hand.kind,...pose};
    if(CATALOGUE[hand.kind].color)draft.color=hand.color;
    if(CATALOGUE[hand.kind].text)draft.text=sanitizeSign(hand.text);
    const bad=!!issueFor(draft),key=JSON.stringify({...draft,bad});
    if(key!==ghostKey){
      dropGhost();
      ghost=buildProp(draft,{ghost:true});ghost.traverse(o=>{if(o.isMesh)o.material=bad?ghostBad:ghostOk});
      room.group.add(ghost);ghostKey=key;
    }
  }
  function selectAt(e){
    const room=roomOf(mine());if(!room?.decorGroup){selected=null;return}
    const point=floorPoint(e);if(!point)return;
    const cam=office.camera();ray.setFromCamera(ndc,cam);
    const hitMesh=ray.intersectObject(room.decorGroup,true)[0];
    selected=hitMesh?.object.userData.propId||null;
    buildRoom(mine(),room);paint();
  }
  function paint(){
    const data=mine()?entry(mine()):{theme:null,props:[]};
    const theme=data.theme,count=data.props.length,spec=hand&&CATALOGUE[hand.kind];
    const swatch=(list,attr,cur)=>list.map(c=>`<button type="button" class="of-swatch" data-${attr}="${esc(c)}" style="background:${esc(c)}" aria-label="${esc(c)}" aria-pressed="${c===cur}"></button>`).join('');
    panel.innerHTML=`<div class="of-dh">Your room <span>${count} / ${MAX_PROPS}</span><button type="button" class="txt" data-decor="done">Done</button></div>
      <p class="of-note">Click to place. R rotates, Delete removes, Esc leaves. Props snap to a 0.25 m grid.</p>
      <div class="of-dh">Theme</div>
      <div class="of-presets">${PRESET_NAMES.map(n=>`<button type="button" data-preset="${esc(n)}" aria-pressed="${theme?.preset===n}">${esc(n)}</button>`).join('')}</div>
      <div class="of-dh">Floor</div><div class="of-swatches">${swatch(FLOORS,'floor',theme?.floor)}</div>
      <div class="of-dh">Wall</div><div class="of-swatches">${swatch(WALLS,'wall',theme?.wall)}</div>
      <label class="of-mat">Material <select data-material aria-label="Wall and floor material">${MATERIALS.map(m=>`<option value="${m}"${theme?.material===m?' selected':''}>${m}</option>`).join('')}</select></label>
      <div class="of-dh">Props</div>
      <div class="of-cat">${Object.entries(CATALOGUE).map(([k,v])=>`<button type="button" data-kind="${esc(k)}" aria-pressed="${hand?.kind===k}">${esc(v.label)}</button>`).join('')}</div>
      ${spec?.color?`<div class="of-dh">Color</div><div class="of-swatches">${swatch(ART,'art',hand.color)}</div>`:''}
      ${spec?.text?`<label class="of-mat">Sign <input data-sign maxlength="20" aria-label="Neon sign text" value="${esc(hand.text||'')}"></label>`:''}`;
    panel.querySelector('[data-decor="done"]').onclick=()=>stop();
    for(const b of panel.querySelectorAll('[data-preset]'))b.onclick=()=>applyTheme(b.dataset.preset);
    const base=()=>({floor:theme?.floor||FLOORS[0],wall:theme?.wall||WALLS[0],material:theme?.material||MATERIALS[0]});
    for(const b of panel.querySelectorAll('[data-floor]'))b.onclick=()=>applyTheme({...base(),floor:b.dataset.floor});
    for(const b of panel.querySelectorAll('[data-wall]'))b.onclick=()=>applyTheme({...base(),wall:b.dataset.wall});
    panel.querySelector('[data-material]').onchange=e=>applyTheme({...base(),material:e.target.value});
    for(const b of panel.querySelectorAll('[data-kind]'))b.onclick=()=>pickKind(b.dataset.kind);
    for(const b of panel.querySelectorAll('[data-art]'))b.onclick=()=>{if(hand){hand={...hand,color:b.dataset.art};ghostKey='';paint()}};
    const sign=panel.querySelector('[data-sign]');
    sign?.addEventListener('input',()=>{if(hand){hand={...hand,text:sign.value};ghostKey=''}});
  }
  function pickKind(kind){
    const spec=CATALOGUE[kind];if(!spec)return;
    hand={kind,rot:0,color:spec.color?ART[kind==='neon'?4:0]:undefined,text:spec.text?'Hi':undefined};
    selected=null;ghostKey='';paint();
  }
  function applyTheme(theme){
    let cleaned;try{cleaned=cleanTheme(theme)}catch(e){office.toast?.(e.message,true);return}
    entry(mine()).theme=cleaned;office.repaint?.(mine());
    const room=roomOf(mine());if(room)buildRoom(mine(),room);
    schedule();paint();
  }
  function start(){if(!ownRoom())return;editing=true;panel.hidden=false;paint();syncButton()}
  function stop(){editing=false;hand=null;selected=null;dropGhost();panel.hidden=true;syncButton()}
  function syncButton(){
    const btn=office.root().querySelector('[data-of="decorate"]');if(!btn)return;
    const inside=!!ownRoom();
    btn.hidden=!inside;btn.textContent=editing?'Done':'Decorate';btn.setAttribute('aria-pressed',String(editing));
  }
  function frame(){
    if(editing&&!ownRoom())stop();
    syncButton();syncGhost();
  }
  return {
    load,remote,mount,stamp,blocked,frame,
    editing:()=>editing,
    themeOf:key=>saved.get(key)?.theme||null,
    toggle(){if(editing)stop();else start()},
    escape(){if(!editing)return false;stop();return true},
    key(e){
      if(!editing)return false;
      if(e.key==='r'||e.key==='R'){e.preventDefault();rotate();return true}
      if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();removeSelected();return true}
      return false;
    },
    hover(e){if(!editing)return;lastPoint=floorPoint(e);syncGhost()},
    pointer(e){
      if(!editing)return false;
      lastPoint=floorPoint(e);
      if(hand){const room=ownRoom();if(room&&lastPoint){const pose=poseFor(hand.kind,toLocal(room,lastPoint.x,lastPoint.z),hand.rot||0);if(pose)tryPlace(pose)}}
      else selectAt(e);
      return true;
    },
    project(x,z){
      const room=roomOf(mine()),cam=office.camera(),cv=office.canvas();if(!room||!cam||!cv)return null;
      const p=toWorld({x:room.center.x,z:room.center.z,facing:room.facing},x,z);
      const v=new THREE.Vector3(p.x,0.4,p.z).project(cam),r=cv.getBoundingClientRect();
      return {x:r.left+(v.x+1)/2*r.width,y:r.top+(1-v.y)/2*r.height,behind:v.z>1};
    },
    debug(){const key=mine(),data=key&&saved.get(key);return {editing,inside:!!ownRoom(),theme:data?.theme||null,props:data?.props||[],hand:hand?.kind||''}},
    dispose(){stop();clearTimeout(timer);panel.remove();sweepTextures();ghostOk.dispose();ghostBad.dispose();selectMat.dispose();for(const m of mats.values())m.dispose();mats.clear();for(const g of Object.values(unit))g.dispose?.()},
  };
}
