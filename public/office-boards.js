import * as THREE from './vendor/three/three.module.min.js';
import {cardsForOfficeBoard,cardsInOffice,officeMemberRefs,planOfficeDrop,workingCards} from './office-boards-core.js';
import {nextWake,initials,memberColor,moveCard} from './devops-core.js';
import {nodeById,peopleFor} from './devops.js';
import {delegate} from './agentflow-core.js';
import {canEdit} from './share.js';
import {change,latestUndo,store,subscribeWorkspace} from './store.js';

const W=1200,H=474,WIDTH=8.8,HEIGHT=3.48,NEAR=9;
const HEIGHT_LABEL=70,TOP=103,ROW=106,INSET=22;
const projected=new THREE.Vector3();
const paintText=(ctx,text,x,y,font,color,max=Infinity)=>{
  ctx.font=font;ctx.fillStyle=color;
  let fitted=text;
  if(ctx.measureText(fitted).width>max){
    while(fitted.length&&ctx.measureText(fitted+'…').width>max)fitted=fitted.slice(0,-1);
    fitted+='…';
  }
  ctx.fillText(fitted,x,y);
};
function paintTitle(ctx,title,x,y,max){
  const font='bold 26px system-ui';
  ctx.font=font;
  if(ctx.measureText(title).width<=max){paintText(ctx,title,x,y+69,font,'#172b39');return}
  let split=0;
  for(const word of title.matchAll(/\S+(?=\s)/gu)){
    const end=word.index+word[0].length;
    if(ctx.measureText(title.slice(0,end)).width>max)break;
    split=end;
  }
  if(!split){paintText(ctx,title,x,y+69,font,'#172b39',max);return}
  paintText(ctx,title.slice(0,split),x,y+55,font,'#172b39');
  paintText(ctx,title.slice(split).trimStart(),x,y+83,font,'#172b39',max);
}
const round=(ctx,x,y,w,h,r,color)=>{
  ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();
};
function officeCardTile(card,projects,memberNames){
  const color=projects.get(card.project)?.color;
  return {id:card.id,number:card.number,title:card.title,color:/^#[0-9a-f]{6}$/i.test(color)?color:'#64748b',
    people:[...new Set(card.assignees.map(a=>a.node))].slice(0,5).map(id=>({id,name:memberNames.get(id)||nodeById(id)?.name||'?'}))};
}

function makeBoard(anchor,member,stands){
  const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=4;
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(WIDTH,HEIGHT),
    new THREE.MeshBasicMaterial({map:texture,toneMapped:false}));
  const frame=new THREE.Group(),finish=new THREE.MeshLambertMaterial({color:'#465c68'});
  const mount=(w,h,d,x,y,z)=>{
    const part=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),finish);
    part.position.set(x,y,z);frame.add(part);
  };
  mount(WIDTH+.08,HEIGHT+.08,.1,0,0,-.06);
  if(stands){
    for(const x of [-3.5,3.5]){
      mount(.13,2.02,.16,x,-1.1,-.16);
      mount(.55,.08,.62,x,-2.01,-.16);
    }
  }
  anchor.add(frame,mesh);
  return {anchor,member,mesh,frame,finish,ctx:canvas.getContext('2d'),columns:[],signature:''};
}

function drawBoard(board,columns){
  const {ctx,mesh}=board,heading=board.member?board.member.name+' · DevOps':'AgentFlow · DevOps';
  const sig=JSON.stringify([heading,columns]);
  if(sig===board.signature)return;
  board.signature=sig;
  round(ctx,0,0,W,H,22,'#314450');
  round(ctx,9,9,W-18,H-18,15,'#f8fafc');
  paintText(ctx,heading,INSET+10,49,'bold 32px system-ui','#20323d',W-65);
  const laneWidth=(W-2*INSET)/columns.length;
  board.columns=columns.map(({id,name,tiles},i)=>{
    const x=INSET+i*laneWidth+5,w=laneWidth-10;
    round(ctx,x,HEIGHT_LABEL,w,H-HEIGHT_LABEL-INSET,12,'#e8eef3');
    paintText(ctx,name,x+13,94,'bold 24px system-ui','#344c5c',w-26);
    if(!tiles.length)paintText(ctx,'—',x+13,145,'26px system-ui','#657787');
    tiles.forEach((tile,row)=>{
      const y=TOP+row*ROW;
      round(ctx,x+7,y,w-14,ROW-10,8,'#fff');
      round(ctx,x+7,y,7,ROW-10,4,tile.color);
      paintText(ctx,'#'+tile.number,x+25,y+28,'bold 21px system-ui','#445969');
      paintTitle(ctx,tile.title,x+25,y,w-47);
      tile.people.forEach(({id,name},j)=>{
        const [bg,fg]=memberColor(id),cx=x+w-30-j*29;
        ctx.beginPath();ctx.arc(cx,y+22,12,0,Math.PI*2);ctx.fillStyle=bg;ctx.fill();
        ctx.textAlign='center';paintText(ctx,initials(name),cx,y+26,'bold 12px system-ui',fg);ctx.textAlign='left';
      });
    });
    return {id,name,tiles,x,w};
  });
  mesh.material.map.needsUpdate=true;
}

export function createOfficeBoards({env,world,camera,position,agents,openCard,seatCard}){
  let dirty=true,wake=null,carrying=new Map(),visibleNumbers=new Set();
  const boards=new Map(),badges=new Map();
  const unsubscribe=subscribeWorkspace(()=>{dirty=true});
  const disposeBoard=board=>{
    board.anchor.remove(board.mesh,board.frame);
    board.finish.dispose();board.frame.traverse(o=>o.geometry?.dispose());
    board.mesh.material.map.dispose();board.mesh.material.dispose();board.mesh.geometry.dispose();
    if(board.ownsAnchor)board.anchor.removeFromParent();
  };
  function rebuild(rooms,{commonRadius,boardAnchor}){
    for(const board of boards.values())disposeBoard(board);
    boards.clear();
    const add=(key,member,parent,x,y,z)=>{
      const anchor=boardAnchor?.(key);
      const mount=anchor||new THREE.Object3D();
      if(!anchor){mount.position.set(x,y,z);parent.add(mount)}
      const board=makeBoard(mount,member,!member&&!anchor);board.ownsAnchor=!anchor;boards.set(key,board);
    };
    for(const [key,room] of rooms)add(key,room.member,room.group,0,2.12,-4.36);
    add(null,null,world,0,2.08,-commonRadius+0.55);
    dirty=true;
  }
  function refresh(){
    const now=Date.now();
    if(!dirty&&(wake===null||now<wake))return;
    dirty=false;
    const db=store.db,visible=cardsInOffice(db,env,canEdit),roster=agents();
    const delegated=new Set(roster.flatMap(a=>a.cards||a.boardCards||[]));
    const names=new Map(db.devops.columns.map(c=>[c.id,c.name])),projects=new Map(db.projects.map(p=>[p.id,p]));
    const members=new Map(),memberNames=new Map();
    for(const board of boards.values()){
      if(!board.member)continue;
      const personIds=officeMemberRefs(db,board.member);
      members.set(board,{...board.member,personIds});
      for(const id of personIds)memberNames.set(id,board.member.name);
    }
    for(const board of boards.values()){
      const picks=cardsForOfficeBoard(visible,{member:members.get(board),delegated,now});
      drawBoard(board,[...picks].map(([id,cards])=>({id,name:names.get(id)||id,tiles:cards.map(c=>officeCardTile(c,projects,memberNames))})));
    }
    carrying=workingCards(visible,roster,{now});
    visibleNumbers=new Set(visible.map(card=>card.number));
    wake=nextWake(visible,now);
  }
  function hit(ray){
    const intersections=ray.intersectObjects([...boards.values()].map(b=>b.mesh));
    const first=intersections[0];
    if(!first?.uv)return null;
    const board=[...boards.values()].find(b=>b.mesh===first.object);
    const p=board.anchor.getWorldPosition(projected),pos=position();
    const near=Math.hypot(p.x-pos.x,p.z-pos.z)<=NEAR;
    // The back is a whiteboard surface, but its text and controls only work from the front.
    if(board.anchor.worldToLocal(projected.copy(camera.position)).z<=0)return null;
    const x=first.uv.x*W,y=(1-first.uv.y)*H;
    const column=board.columns.find(c=>x>=c.x&&x<=c.x+c.w&&y>=HEIGHT_LABEL&&y<=H-INSET);
    const row=(y-TOP)/ROW;
    const tile=column&&row>=0&&(row%1)*ROW<ROW-10?column.tiles[Math.floor(row)]:null;
    return {tile,column,near,point:first.point,distance:first.distance};
  }
  function pick(intersection){
    if(!intersection?.near||!intersection.tile)return false;
    openCard(intersection.tile.id);return true;
  }
  function frame(labels){
    refresh();
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
  return {hit,pick,rebuild,frame,invalidate(){dirty=true},
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
