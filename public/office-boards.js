// DevOps whiteboards in the 3D office (docs/concepts/12-office.md). The world says where they hang
// (boardAnchors() in office-layout.js): one on each room's back wall with that member's cards, and the main
// board on the common area's feature wall with the whole board of the environment the office is open in.
// Each board is a canvas texture sized to the board (about 1.7 px per cm, mipmapped) and is redrawn only
// when what it shows changes: its cards, or near/far, since from far away a board shows its title and counts.
import * as THREE from './vendor/three/three.module.min.js';
import {boardLanes,cardsInOffice,officeMemberRefs,planOfficeDrop,workingCards,ROOM_COLUMNS,MAIN_COLUMNS} from './office-boards-core.js';
import {nextWake,initials,memberColor,moveCard} from './devops-core.js';
import {nodeById,peopleFor} from './devops.js';
import {delegate} from './agentflow-core.js';
import {canEdit} from './share.js';
import {change,latestUndo,store,subscribeWorkspace} from './store.js';

const PX_PER_CM=1.7,MAX_PX=2048,LIMIT=6;
const INK='#0f1c24',SUB='#4a5d6a',FAINT='#7d8c96',LANE='#e9eef2',LINE='#c6d0d7',SURFACE='#fbfcfd';
const ACCENT={requests:'#475569',doing:'#2563eb',blocked:'#dc2626',uat:'#7c3aed',done:'#15803d'};
const LANE_NAMES={done:'Done · recent'};
const projected=new THREE.Vector3();

function fit(ctx,text,max){
  if(ctx.measureText(text).width<=max)return text;
  let s=text;while(s.length&&ctx.measureText(s+'…').width>max)s=s.slice(0,-1);
  return s+'…';
}
function paintText(ctx,text,x,y,font,color,max=Infinity,align='left'){
  ctx.font=font;ctx.fillStyle=color;ctx.textAlign=align;ctx.fillText(fit(ctx,String(text),max),x,y);ctx.textAlign='left';
}
// Up to two lines, cut at a word where it can be.
function wrap(ctx,text,max){
  if(ctx.measureText(text).width<=max)return [text];
  let split=0;
  for(const m of text.matchAll(/\S+/gu)){const end=m.index+m[0].length;if(ctx.measureText(text.slice(0,end)).width>max)break;split=end}
  if(!split)return [fit(ctx,text,max)];
  return [text.slice(0,split),fit(ctx,text.slice(split).trimStart(),max)];
}
const round=(ctx,x,y,w,h,r,fill,stroke,lw=1)=>{
  ctx.beginPath();ctx.roundRect(x,y,w,h,r);
  if(fill){ctx.fillStyle=fill;ctx.fill()}
  if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=lw;ctx.stroke()}
};

export function officeCardTile(card,projects,{names=new Map(),agents=[]}={}){
  const color=projects.get(card.project)?.color;
  const people=[...new Set(card.assignees.map(a=>a.node))].map(id=>({id,name:names.get(id)||nodeById(id)?.name||'?'}));
  return {id:card.id,number:card.number,title:card.title,color:/^#[0-9a-f]{6}$/i.test(color)?color:'#64748b',
    people:[...people,...agents.map(a=>({id:a.id,name:a.name||'Agent',agent:true}))].slice(0,5)};
}

// ---------- the physical board ----------
function makeBoard(world,mount,{key,member}){
  const anchor=new THREE.Object3D();
  anchor.position.set(mount.x,mount.y,mount.z);anchor.rotation.y=Math.atan2(mount.nx,mount.nz);world.add(anchor);
  const W=Math.round(mount.width*100),H=Math.round(mount.height*100),scale=Math.min(PX_PER_CM,MAX_PX/W);
  const canvas=document.createElement('canvas');canvas.width=Math.round(W*scale);canvas.height=Math.round(H*scale);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=8;
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(mount.width,mount.height),
    new THREE.MeshBasicMaterial({map:texture,toneMapped:false,fog:false}));
  // An aluminium frame, a marker tray along the bottom and three markers, in the office's flat style.
  const frameMat=new THREE.MeshLambertMaterial({color:'#3d4c56',flatShading:true});
  const parts=new THREE.Group(),box=(w,h,d,x,y,z,m=frameMat)=>{const o=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);o.position.set(x,y,z);parts.add(o);return o};
  const rim=member?0.07:0.11;
  box(mount.width+rim*2,mount.height+rim*2,0.05,0,0,-0.035);
  box(Math.min(3,mount.width*0.4),0.04,0.13,mount.width*0.22,-mount.height/2-rim-0.01,0.05);
  const markers=['#dc2626','#2563eb','#15803d'].map((c,i)=>{
    const m=new THREE.MeshLambertMaterial({color:c,flatShading:true});
    box(0.16,0.035,0.035,mount.width*0.22-0.4+i*0.3,-mount.height/2-rim+0.03,0.06,m);return m;
  });
  anchor.add(parts,mesh);
  const far=Math.max(16,mount.width*2.1);
  return {key,member,anchor,mesh,parts,mats:[frameMat,...markers],ctx:canvas.getContext('2d'),W,H,scale,
    near:Math.max(9,mount.width*0.95),farAt:far,far:false,view:null,signature:'',columns:[],hits:[]};
}
function disposeBoard(board){
  board.anchor.removeFromParent();
  board.parts.traverse(o=>o.geometry?.dispose());for(const m of board.mats)m.dispose();
  board.mesh.material.map.dispose();board.mesh.material.dispose();board.mesh.geometry.dispose();
}

// ---------- drawing ----------
// Laid out in centimetres of board; the canvas is scaled to its pixels.
function drawBoard(board){
  const {ctx,W,H,view,far}=board;
  if(!view)return;
  const sig=JSON.stringify([far,view]);
  if(sig===board.signature)return;
  board.signature=sig;
  ctx.setTransform(board.scale,0,0,board.scale,0,0);
  ctx.fillStyle=SURFACE;ctx.fillRect(0,0,W,H);
  board.columns=[];board.hits=[];
  if(far)drawFar(board);else drawNear(board);
  board.mesh.material.map.needsUpdate=true;
}
function drawFar({ctx,W,H,view}){
  const u=H/240;
  paintText(ctx,view.title,W/2,H*0.25,`bold ${36*u}px system-ui`,INK,W-40*u,'center');
  const n=view.lanes.length,w=(W-30*u)/n;
  view.lanes.forEach((lane,i)=>{
    const cx=15*u+w*(i+0.5);
    paintText(ctx,lane.name,cx,H*0.53,`bold ${22*u}px system-ui`,SUB,w-12*u,'center');
    paintText(ctx,String(lane.total),cx,H*0.87,`bold ${66*u}px system-ui`,ACCENT[lane.id]||INK,w,'center');
  });
}
function drawNear(board){
  const {ctx,W,H,view}=board,u=view.main?Math.max(1,Math.min(1.3,W/1080)):1.1;
  const pad=10*u,gap=6*u,laneTop=36*u,headH=27*u,tileH=47*u,moreH=21*u;
  // The main board's title is centred: it reads as the room's headline, and clears corner UI on screen.
  if(view.main)paintText(ctx,view.title,W/2,pad+17*u,`bold ${18*u}px system-ui`,INK,W*0.5,'center');
  else paintText(ctx,view.title,pad+2*u,pad+17*u,`bold ${18*u}px system-ui`,INK,W*0.62);
  paintText(ctx,view.subtitle,W-pad-2*u,pad+16*u,`600 ${12*u}px system-ui`,SUB,view.main?W*0.22:W*0.34,'right');
  const capacity=Math.max(1,Math.floor((H-laneTop-pad-headH-6*u+gap)/(tileH+gap)));
  const weights=view.lanes.map(l=>l.total?1:0.5),sum=weights.reduce((a,b)=>a+b,0)||1;
  const span=W-2*pad-gap*(view.lanes.length-1);
  let x=pad;
  view.lanes.forEach((lane,i)=>{
    const w=span*weights[i]/sum,show=lane.total>capacity?capacity-1:Math.min(lane.tiles.length,capacity);
    const more=lane.total-show,body=show?show*(tileH+gap)+(more>0?moreH:0):24*u;
    round(ctx,x,laneTop,w,headH+body+4*u,8*u,LANE);
    // header: an accent tick, the name and the count
    const accent=ACCENT[lane.id]||SUB;
    round(ctx,x+7*u,laneTop+8*u,4*u,12*u,2*u,accent);
    ctx.font=`bold ${11.5*u}px system-ui`;const count=String(lane.total),pw=ctx.measureText(count).width+12*u;
    round(ctx,x+w-pw-7*u,laneTop+6*u,pw,16*u,8*u,lane.total?accent:'#b7c2ca');
    paintText(ctx,count,x+w-pw/2-7*u,laneTop+18.5*u,`bold ${11.5*u}px system-ui`,'#fff',pw,'center');
    paintText(ctx,lane.name,x+16*u,laneTop+19*u,`bold ${12.5*u}px system-ui`,INK,w-pw-30*u);
    if(!show)paintText(ctx,'Nothing here',x+16*u,laneTop+headH+14*u,`italic ${11*u}px system-ui`,FAINT,w-24*u);
    lane.tiles.slice(0,show).forEach((tile,row)=>{
      const tx=x+5*u,ty=laneTop+headH+row*(tileH+gap),tw=w-10*u;
      round(ctx,tx,ty+1.5*u,tw,tileH,6*u,'#d5dde3');
      round(ctx,tx,ty,tw,tileH,6*u,'#fff',LINE,1.2*u);
      round(ctx,tx,ty,6*u,tileH,[6*u,0,0,6*u],tile.color);
      const dots=tile.people.length;
      paintText(ctx,'#'+tile.number,tx+13*u,ty+13*u,`bold ${10*u}px system-ui`,SUB,tw-30*u-dots*15*u);
      tile.people.forEach((p,j)=>{
        const [bg,fg]=memberColor(p.id),cx=tx+tw-11*u-j*15*u,cy=ty+9.5*u,r=6.5*u;
        ctx.beginPath();
        if(p.agent)ctx.roundRect(cx-r,cy-r,r*2,r*2,2*u);else ctx.arc(cx,cy,r,0,Math.PI*2);
        ctx.fillStyle=p.agent?'#334155':bg;ctx.fill();
        paintText(ctx,initials(p.name),cx,cy+2.6*u,`bold ${6.8*u}px system-ui`,p.agent?'#fff':fg,r*2,'center');
      });
      ctx.font=`bold ${12*u}px system-ui`;
      wrap(ctx,tile.title,tw-22*u).forEach((line,k)=>paintText(ctx,line,tx+13*u,ty+28*u+k*13.5*u,`bold ${12*u}px system-ui`,INK));
      board.hits.push({x:tx,y:ty,w:tw,h:tileH,tile});
    });
    if(more>0&&show)paintText(ctx,`+${more} more…`,x+w/2,laneTop+headH+show*(tileH+gap)+13*u,`bold ${11*u}px system-ui`,SUB,w-20*u,'center');
    board.columns.push({id:lane.id,name:lane.column,tiles:lane.tiles.slice(0,show),x,w,y:laneTop,h:H-laneTop});
    x+=w+gap;
  });
}

// ---------- the boards ----------
// opts: {env, envName, world (the group boards hang in), camera, position() (the viewer's feet),
//        envName() (the main board's title: the office's environment), agents() (AgentFlow agents with their
//        card queues), openCard(id), seatCard(label) (the card a seated
//        session works on, for its name tag)}
export function createOfficeBoards({env,envName=()=>'',world,camera,position,agents,openCard,seatCard}){
  let dirty=true,wake=null,carrying=new Map(),visibleNumbers=new Set();
  const boards=new Map(),badges=new Map();
  let showing=true;
  const unsubscribe=subscribeWorkspace(()=>{dirty=true});
  // anchors: {rooms:[{key, member, ...mount}], main: mount}, from the world's boardAnchors().
  function rebuild(anchors){
    for(const board of boards.values())disposeBoard(board);
    boards.clear();
    for(const a of anchors.rooms||[])boards.set(a.key,makeBoard(world,a,{key:a.key,member:a.member}));
    if(anchors.main)boards.set(null,makeBoard(world,anchors.main,{key:null,member:null}));
    for(const b of boards.values())b.anchor.visible=showing;
    dirty=true;
  }
  function refresh(){
    const now=Date.now();
    if(!dirty&&(wake===null||now<wake))return;
    dirty=false;
    const db=store.db,visible=cardsInOffice(db,env,canEdit),roster=agents();
    const names=new Map(db.devops.columns.map(c=>[c.id,c.name])),projects=new Map(db.projects.map(p=>[p.id,p]));
    const people=new Map(),refs=new Map();
    for(const board of boards.values())if(board.member){
      const ids=officeMemberRefs(db,board.member);refs.set(board,ids);for(const id of ids)people.set(id,board.member.name);
    }
    const queued=new Map();
    for(const a of roster)if(a.status!=='retired')for(const id of a.cards||a.boardCards||[]){if(!queued.has(id))queued.set(id,[]);queued.get(id).push(a)}
    const tile=card=>officeCardTile(card,projects,{names:people,agents:queued.get(card.id)||[]});
    for(const board of boards.values()){
      const member=board.member&&{...board.member,personIds:refs.get(board)};
      const lanes=boardLanes(visible,{columns:member?ROOM_COLUMNS:MAIN_COLUMNS,member,limit:LIMIT,now});
      const open=lanes.filter(l=>l.id!=='done').reduce((n,l)=>n+l.total,0),done=lanes.find(l=>l.id==='done')?.total||0;
      board.view={main:!member,
        title:member?member.name:`${envName()||'This office'} · DevOps`,
        subtitle:member?`${open} open ${open===1?'card':'cards'}`:`${open} open · ${done} done lately`,
        lanes:lanes.map(l=>({id:l.id,column:names.get(l.id)||l.id,name:LANE_NAMES[l.id]||names.get(l.id)||l.id,total:l.total,tiles:l.cards.map(tile)}))};
    }
    carrying=workingCards(visible,roster,{now});
    visibleNumbers=new Set(visible.map(card=>card.number));
    wake=nextWake(visible,now);
  }
  function hit(ray){
    const first=ray.intersectObjects([...boards.values()].map(b=>b.mesh))[0];
    if(!first?.uv)return null;
    const board=[...boards.values()].find(b=>b.mesh===first.object);
    const p=board.anchor.getWorldPosition(projected),pos=position();
    const near=Math.hypot(p.x-pos.x,p.z-pos.z)<=board.near;
    // The back of a board is its frame: cards work only from the front.
    if(board.anchor.worldToLocal(projected.copy(camera.position)).z<=0)return null;
    const x=first.uv.x*board.W,y=(1-first.uv.y)*board.H;
    const column=board.far?null:board.columns.find(c=>x>=c.x&&x<=c.x+c.w&&y>=c.y);
    const tile=board.far?null:board.hits.find(h=>x>=h.x&&x<=h.x+h.w&&y>=h.y&&y<=h.y+h.h)?.tile||null;
    return {tile,column,near,board:board.key,point:first.point,distance:first.distance};
  }
  function pick(intersection){
    if(!intersection?.near||!intersection.tile)return false;
    openCard(intersection.tile.id);return true;
  }
  function frame(labels){
    refresh();
    for(const board of boards.values()){
      const d=board.anchor.getWorldPosition(projected).distanceTo(camera.position);
      if(board.far?d<board.farAt*0.9:d>board.farAt)board.far=!board.far;
      drawBoard(board);
    }
    const live=new Set();
    for(const entry of labels){
      const id=entry.el.querySelector('[data-af-id]')?.dataset.afId||entry.obj.userData.officeAgentId;
      const seat=seatCard?.(entry);
      const card=seat&&visibleNumbers.has(seat.number)?seat:carrying.get(id);
      if(!card)continue;
      live.add(entry);
      let badge=badges.get(entry);
      if(!badge){
        badge=document.createElement('span');badge.className='of-card-carry';entry.el.append(badge);badges.set(entry,badge);
      }
      const number='#'+card.number;
      if(badge.textContent!==number)badge.textContent=number;
      if(badge.title!==card.title)badge.title=card.title;
    }
    for(const [entry,badge] of badges)if(!live.has(entry)){badge.remove();badges.delete(entry)}
  }
  // The card E opens at a board: the first card in the lane in front of you, else in the nearest lane with cards.
  function tileNear(key,pos){
    const board=boards.get(key);if(!board||board.far)return null;
    const x=(board.anchor.worldToLocal(projected.set(pos.x,board.anchor.position.y,pos.z)).x+board.W/200)*100;
    let best=null,gap=Infinity;
    for(const c of board.columns)if(c.tiles.length){const d=x<c.x?c.x-x:x>c.x+c.w?x-c.x-c.w:0;if(d<gap){gap=d;best=c.tiles[0]}}
    return best;
  }
  return {hit,pick,rebuild,frame,tileNear,invalidate(){dirty=true},setVisible(value){showing=value;for(const b of boards.values())b.anchor.visible=value},
    dispose(){unsubscribe();for(const b of boards.values())disposeBoard(b);boards.clear();for(const b of badges.values())b.remove()}};
}

// Drag claims the left pointer through office-controls. Targets are rechecked against the current
// projection at release so a sync pull, a revoked share, or a full queue cannot stale the mutation.
export function createOfficeCardDrag({root,env,local,hitAt,targetAt,openCard}){
  const ghost=document.createElement('div'),highlight=document.createElement('div'),notice=document.createElement('div');
  ghost.className='of-card-ghost';highlight.className='of-card-drop';notice.className='of-card-notice';
  ghost.hidden=highlight.hidden=notice.hidden=true;
  ghost.setAttribute('aria-hidden','true');highlight.setAttribute('aria-hidden','true');
  const status=document.createElement('span'),undo=document.createElement('button');
  status.setAttribute('role','status');undo.type='button';undo.textContent='Undo';
  notice.append(status,undo);root.append(ghost,highlight,notice);
  let timer;
  function notify(message,reverse){
    clearTimeout(timer);status.textContent=message;notice.hidden=false;undo.hidden=!reverse;
    undo.onclick=reverse?()=>{
      if(reverse())notify('Office card change undone');
      else notify('Open DevOps to undo earlier workspace changes');
    }:null;
    timer=setTimeout(()=>{notice.hidden=true},reverse?8000:2600);
  }
  function plan(id,e){
    const db=store.db,card=db.devops.cards.find(c=>c.id===id),target=targetAt(e);
    if(!card||!target||!canEdit(card))return null;
    const personIds=target.type==='person'?peopleFor(card).map(p=>p.id):[];
    const action=planOfficeDrop(db,card,target,{editable:true,personIds,local:local()&&db.environment?.id===env,replace:e.shiftKey});
    return action?{card,target,action}:null;
  }
  function grab(e){
    const hit=hitAt(e)?.board,tile=hit?.tile;
    if(!hit?.near||!tile)return null;
    const db=store.db,card=db.devops.cards.find(c=>c.id===tile.id);
    if(!card||!canEdit(card))return null;
    const x=e.clientX,y=e.clientY;
    let dragging=false;
    const clean=()=>{ghost.hidden=highlight.hidden=true;root.classList.remove('of-card-dragging')};
    const far=e=>Math.hypot(e.clientX-x,e.clientY-y)>=5;
    const move=e=>{
      if(!dragging&&!far(e))return;
      if(!dragging){
        dragging=true;ghost.textContent=`#${tile.number}  ${tile.title}`;ghost.style.borderColor=tile.color;
        ghost.hidden=false;root.classList.add('of-card-dragging');
      }
      const drop=plan(tile.id,e);
      ghost.style.transform=`translate(${e.clientX+16}px,${e.clientY+14}px)`;
      highlight.hidden=!drop;
      if(drop){
        const {target}=drop;
        highlight.textContent=target.name;
        highlight.style.transform=`translate(${target.x??e.clientX}px,${target.y??e.clientY}px) translate(-50%,-100%)`;
      }
    };
    const end=e=>{
      clean();
      if(!dragging&&!far(e)){openCard(tile.id);return}
      const drop=plan(tile.id,e);
      if(!drop)return;
      const {card,target,action}=drop;
      change(()=>{
        if(action.type==='move'){moveCard(store.db.devops,card.id,action.column);return}
        if(action.type==='delegate')delegate(store.db.agentflow,card.id,action.agents);
        if(action.type==='assign')card.assignees.push({node:action.node,role:action.role});
        card.updated=new Date().toISOString();
      });
      const verb={move:'Moved',assign:'Assigned',delegate:'Delegated'}[action.type];
      notify(`${verb} #${card.number} to ${target.name}`,latestUndo());
    };
    return {move,end,cancel:clean};
  }
  return {grab,dispose(){clearTimeout(timer);ghost.remove();highlight.remove();notice.remove()}};
}
