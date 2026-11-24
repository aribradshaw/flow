// Wall meters for the 3D office: one small screen by each room's door, and one beside the
// common board. Canvas textures repaint only when the numbers change.
//
// Mounts come from the world layout's meterAnchors() (key null is the office meter):
// {x, y, z, nx, nz, width, height}, the same shape as a board mount. A returned
// Object3D is used as the parent. Otherwise meterAnchors() in office-meters-core.js
// places the screen in the room's own frame. E is office-interact when that is passed in.
import * as THREE from './vendor/three/three.module.min.js';
import {esc} from './ui.js';
import {cardsInOffice,officeMemberRefs} from './office-boards-core.js';
import {store,subscribeWorkspace} from './store.js';
import {browserTimeZone,cardsForMember,formatPoints,formatUsage,meterAnchors,meterCounts,sumSeries,tallyAgents} from './office-meters-core.js';

const W=720,H=400,NEAR=4.2;
const INK='#14201c',PAPER='#f4f7f5',MUTED='#9fb0a8',RUN='#8ee0a8',WAIT='#ffc14d',LINE='#2a3a34',SPARK='#7dcea0';
const tmp=new THREE.Vector3();

const round=(ctx,x,y,w,h,r,color)=>{ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill()};
function paintText(ctx,text,x,y,font,color,max=Infinity){
  ctx.font=font;ctx.fillStyle=color;ctx.textAlign='left';ctx.textBaseline='alphabetic';
  let fitted=String(text);
  if(ctx.measureText(fitted).width>max){
    while(fitted.length&&ctx.measureText(fitted+'…').width>max)fitted=fitted.slice(0,-1);
    fitted+='…';
  }
  ctx.fillText(fitted,x,y);
}
export function drawSpark(ctx,x,y,w,h,series){
  round(ctx,x,y,w,h,8,LINE);
  const pad=8,left=x+pad,right=x+w-pad,top=y+pad,bot=y+h-pad;
  ctx.beginPath();ctx.moveTo(left,bot);ctx.lineTo(right,bot);ctx.strokeStyle='#3d5248';ctx.lineWidth=2;ctx.stroke();
  const n=series?.length||0;
  if(!n){paintText(ctx,'24h',left,top+16,'16px system-ui',MUTED);return}
  let max=1;
  for(const v of series)if(v>max)max=v;
  ctx.beginPath();
  for(let i=0;i<n;i++){
    const px=left+(n===1?0:i/(n-1))*(right-left),py=bot-(series[i]/max)*(bot-top);
    if(i)ctx.lineTo(px,py);else ctx.moveTo(px,py);
  }
  ctx.strokeStyle=SPARK;ctx.lineWidth=3;ctx.stroke();
}
function drawMeter(ctx,meter){
  ctx.clearRect(0,0,W,H);
  round(ctx,0,0,W,H,18,INK);
  round(ctx,10,10,W-20,H-20,12,'#1b2924');
  paintText(ctx,meter.title||'Office',24,46,'bold 32px system-ui',PAPER,W-180);
  ctx.beginPath();ctx.arc(W-40,36,11,0,Math.PI*2);ctx.fillStyle=meter.running?RUN:'#3a4a44';ctx.fill();
  const col=W/2;
  paintText(ctx,String(meter.running),24,118,'bold 72px system-ui',RUN);
  paintText(ctx,'running',24,148,'22px system-ui',MUTED);
  paintText(ctx,String(meter.waiting),col,118,'bold 72px system-ui',WAIT);
  paintText(ctx,'waiting',col,148,'22px system-ui',MUTED);
  const rows=[['Today',meter.shippedToday+' cards'],['This week',formatPoints(meter.pointsWeek)+' pts'],['Model use',meter.usageText||'—']];
  if(meter.waitingOnYou!=null)rows.push(['On you',String(meter.waitingOnYou)]);
  const rowTop=176,rowH=28;
  rows.forEach(([k,v],i)=>{
    const y=rowTop+i*rowH;
    paintText(ctx,k,24,y,'20px system-ui',MUTED);
    ctx.textAlign='right';ctx.font='bold 20px system-ui';ctx.fillStyle=PAPER;ctx.fillText(v,W-24,y);ctx.textAlign='left';
  });
  const sparkY=rowTop+rows.length*rowH+6;
  drawSpark(ctx,24,sparkY,W-48,Math.max(36,H-sparkY-16),meter.spark);
}

function signature(meter){
  return JSON.stringify([meter.title,meter.running,meter.waiting,meter.shippedToday,meter.pointsWeek,meter.usageText,meter.waitingOnYou,meter.spark]);
}

export function createOfficeMeters({world,root,label,unlabel,env,position,members,live,sparks,meKey,anchor,interact}){
  const screens=new Map();
  const bezelMat=new THREE.MeshLambertMaterial({color:'#24302c',flatShading:true});
  let dirty=true,paintedMinute=-1,openKey=null,usedAt=0;
  const unsubscribe=subscribeWorkspace(()=>{dirty=true});
  const popup=document.createElement('aside');
  popup.className='of-meter';popup.hidden=true;popup.setAttribute('aria-label','Office meter');
  root.append(popup);
  const sparkCanvas=document.createElement('canvas');sparkCanvas.width=560;sparkCanvas.height=96;

  function disposeScreen(screen){
    screen.mesh.removeFromParent();screen.bezel.removeFromParent();screen.group.removeFromParent();
    screen.mesh.material.map.dispose();screen.mesh.material.dispose();screen.mesh.geometry.dispose();screen.bezel.geometry.dispose();
    if(screen.hint)unlabel(screen.hint);
  }
  function makeScreen(key,parent,pose,size){
    const group=new THREE.Group();
    group.name='meter-'+key;
    if(pose){
      group.position.set(pose.x,pose.y||0,pose.z);
      // A PlaneGeometry faces local +z. atan2(nx, nz) aims that +z along the mount normal,
      // the same turn a board uses. Check: normal (0, 1) -> rotation 0, plane faces +z.
      group.rotation.y=Number.isFinite(pose.nx)&&Number.isFinite(pose.nz)?Math.atan2(pose.nx,pose.nz):pose.ry||0;
    }
    parent.add(group);
    const w=size.w||size.width,h=size.h||size.height;
    const bezel=new THREE.Mesh(new THREE.BoxGeometry(w+0.06,h+0.06,0.04),bezelMat);
    const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,toneMapped:false}));
    mesh.position.z=0.03;mesh.name='meter';group.add(bezel,mesh);
    const hint=label(group,'<span class="of-meter-key">E · details</span>',{y:h/2+0.22,cls:'meter',near:6});
    const screen={key,group,bezel,mesh,ctx:canvas.getContext('2d'),hint,signature:'',meter:null};
    screens.set(key,screen);return screen;
  }
  function taken(key){
    const a=anchor?.(key);
    if(!a)return null;
    if(a.isObject3D)return a;
    return Number.isFinite(a.x)&&Number.isFinite(a.z)?a:null;
  }
  function addScreen(key,mount,fallbackParent,fallbackPose){
    if(mount?.isObject3D)return makeScreen(key,mount,null,fallbackPose);
    if(mount)return makeScreen(key,world,mount,{w:mount.width||mount.w||fallbackPose.w,h:mount.height||mount.h||fallbackPose.h});
    return makeScreen(key,fallbackParent,fallbackPose,fallbackPose);
  }
  function rebuild(rooms,{commonRadius=10,roomD=9}={}){
    currentInteract()?.unregisterWhere?.(id=>String(id).startsWith('meter:'));
    for(const s of screens.values())disposeScreen(s);
    screens.clear();
    const place=meterAnchors({roomD,commonRadius});
    for(const [key,room] of rooms)addScreen(key,taken(key),room.group,place.room);
    addScreen('office',taken(null)??taken('office'),world,place.office);
    dirty=true;
    if(openKey&&!screens.has(openKey))close();
    bindScreens();
  }
  function compute(){
    const db=store.db,now=Date.now(),timeZone=browserTimeZone();
    const cards=(cardsInOffice(db,env())||[]).map(x=>x.card);
    const who=members()||[],agents=live()||new Map(),lines=sparks()||{};
    const byRoom=new Map();
    for(const m of who){
      const counts=meterCounts({agents:agents.get(m.key)||[],cards:cardsForMember(cards,officeMemberRefs(db,m)),now,timeZone});
      byRoom.set(m.key,{...counts,title:m.name||'Room',usageText:formatUsage(counts.usage),waitingOnYou:null,spark:lines[m.key]||[]});
    }
    const all=[...agents.values()].flat();
    const office=meterCounts({agents:all,cards,now,timeZone});
    const mine=tallyAgents(agents.get(meKey())||[]);
    return {byRoom,office:{...office,title:'Office',usageText:formatUsage(office.usage),waitingOnYou:mine.waiting,spark:sumSeries(who.map(m=>lines[m.key]))}};
  }
  function paint(screen,meter){
    const sig=signature(meter);
    if(sig===screen.signature)return;
    screen.signature=sig;screen.meter=meter;
    drawMeter(screen.ctx,meter);
    screen.mesh.material.map.needsUpdate=true;
    if(screen.key===openKey)fillPopup(meter);
  }
  function frame(){
    const minute=Math.floor(Date.now()/60000);
    if(!dirty&&minute===paintedMinute)return;
    dirty=false;paintedMinute=minute;
    let stats;try{stats=compute()}catch(err){console.error('office meters',err);return}
    for(const [key,screen] of screens){
      const meter=key==='office'?stats.office:stats.byRoom.get(key);
      if(meter)paint(screen,meter);
    }
  }
  function hit(ray){
    const meshes=[...screens.values()].map(s=>s.mesh);
    if(!meshes.length)return null;
    const first=ray.intersectObjects(meshes,false)[0];
    if(!first)return null;
    const screen=[...screens.values()].find(s=>s.mesh===first.object);
    screen.mesh.getWorldPosition(tmp);
    const pos=position();
    return {screen,key:screen.key,near:Math.hypot(tmp.x-pos.x,tmp.z-pos.z)<=NEAR,point:first.point,distance:first.distance};
  }
  function closest(){
    const pos=position();let best=null,bestD=NEAR;
    for(const screen of screens.values()){
      screen.mesh.getWorldPosition(tmp);
      const d=Math.hypot(tmp.x-pos.x,tmp.z-pos.z);
      if(d<=bestD){bestD=d;best=screen}
    }
    return best;
  }
  function fillPopup(meter){
    const you=meter.waitingOnYou==null?'':`<div class="of-row"><span>On you</span><b>${meter.waitingOnYou} waiting</b></div>`;
    const note=meter.usageText==='—'?'<p class="of-note">No reporter sent model use today. The office bridge does not send it yet.</p>':'';
    popup.innerHTML=`<div class="of-ph"><b>${esc(meter.title||'Meter')}</b><span class="sp"></span><button type="button" class="ib" data-of="closeMeter" aria-label="Close">×</button></div>
      <div class="of-pb">
        <div class="of-row"><span>Running</span><b>${meter.running}</b></div>
        <div class="of-row"><span>Waiting</span><b>${meter.waiting}</b></div>
        <div class="of-row"><span>Today</span><b>${meter.shippedToday} cards shipped</b></div>
        <div class="of-row"><span>This week</span><b>${esc(formatPoints(meter.pointsWeek))} pts</b></div>
        <div class="of-row"><span>Model use</span><b>${esc(meter.usageText||'—')}</b></div>
        ${you}${note}
      </div>`;
    popup.querySelector('.of-pb').append(sparkCanvas);
    const ctx=sparkCanvas.getContext('2d');ctx.clearRect(0,0,sparkCanvas.width,sparkCanvas.height);
    drawSpark(ctx,0,0,sparkCanvas.width,sparkCanvas.height,meter.spark);
  }
  function open(screen){
    if(!screen?.meter&&screen){dirty=true;frame()}
    if(!screen?.meter)return;
    openKey=screen.key;popup.hidden=false;fillPopup(screen.meter);
  }
  function close(){if(openKey==null)return false;openKey=null;popup.hidden=true;return true}
  // E, from the office keys or from office-interact. A second call on the same keypress does nothing,
  // so the two paths cannot open and then immediately close.
  function use(){
    const nowMs=performance.now();
    if(nowMs-usedAt<50)return true;
    const screen=closest();
    if(!screen)return false;
    usedAt=nowMs;
    if(openKey===screen.key)close();else open(screen);
    return true;
  }
  function currentInteract(){
    const api=typeof interact==='function'?interact():interact;
    return api?.register?api:null;
  }
  // E opens the popup only while the player is in range (office-interact.js). Returning
  // {close, isOpen} lets a second E, Esc, or walking away close it, and does not orbit.
  function bindScreens(){
    const api=currentInteract();if(!api)return;
    for(const screen of screens.values()){
      api.register({
        id:'meter:'+screen.key,object3D:screen.group,radius:3.2,priority:1,height:0.7,
        label:screen.key==='office'?'Office meter':'Room meter',
        onInteract(){
          open(screen);
          return {close(){if(openKey===screen.key)close()},isOpen:()=>openKey===screen.key};
        },
      });
    }
  }
  return {rebuild,frame,invalidate(){dirty=true},hit,pick(h){if(!h?.near||!h.screen)return false;open(h.screen);return true},use,close,isOpen:()=>openKey!=null,dispose(){
    unsubscribe();close();popup.remove();
    currentInteract()?.unregisterWhere?.(id=>String(id).startsWith('meter:'));
    for(const s of screens.values())disposeScreen(s);screens.clear();bezelMat.dispose();
  }};
}
