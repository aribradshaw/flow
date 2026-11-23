import * as THREE from './vendor/three/three.module.min.js';
import {cardsForOfficeBoard,cardsInOffice,officeMemberRefs,workingCards} from './office-boards-core.js';
import {nextWake,initials,memberColor} from './devops-core.js';
import {nodeById} from './devops.js';
import {store,subscribeWorkspace} from './store.js';

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
const round=(ctx,x,y,w,h,r,color)=>{
  ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();
};
export function officeCardTile(card,projects){
  const color=projects.get(card.project)?.color;
  return {id:card.id,number:card.number,title:card.title,color:/^#[0-9a-f]{6}$/i.test(color)?color:'#64748b',
    people:[...new Set(card.assignees.map(a=>a.node))].slice(0,5).map(id=>({id,name:nodeById(id)?.name||'?'}))};
}

function makeBoard(anchor,member){
  const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=4;
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(WIDTH,HEIGHT),
    new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,toneMapped:false}));
  anchor.add(mesh);
  return {anchor,member,mesh,ctx:canvas.getContext('2d'),columns:[],signature:''};
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
      paintText(ctx,tile.title,x+25,y+64,'bold 28px system-ui','#172b39',w-45);
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

export function createOfficeBoards({env,world,camera,position,agents,openCard}){
  let dirty=true,wake=null,carrying=new Map();
  const boards=new Map(),badges=new Map();
  const unsubscribe=subscribeWorkspace(()=>{dirty=true});
  const disposeBoard=board=>{
    board.anchor.remove(board.mesh);
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
      const board=makeBoard(mount,member);board.ownsAnchor=!anchor;boards.set(key,board);
    };
    for(const [key,room] of rooms)add(key,room.member,room.group,0,2.12,-4.36);
    add(null,null,world,0,2.08,-commonRadius+0.55);
    dirty=true;
  }
  function refresh(){
    const now=Date.now();
    if(!dirty&&(wake===null||now<wake))return;
    dirty=false;
    const db=store.db,visible=cardsInOffice(db,env),roster=agents();
    const delegated=new Set(roster.flatMap(a=>a.cards||[]));
    const names=new Map(db.devops.columns.map(c=>[c.id,c.name])),projects=new Map(db.projects.map(p=>[p.id,p]));
    for(const board of boards.values()){
      const member=board.member&&{...board.member,personIds:officeMemberRefs(db,board.member)};
      const picks=cardsForOfficeBoard(visible,{member,delegated,now});
      drawBoard(board,[...picks].map(([id,cards])=>({id,name:names.get(id)||id,tiles:cards.map(c=>officeCardTile(c,projects))})));
    }
    carrying=workingCards(visible,roster,{now});
    wake=nextWake(visible.map(x=>x.card),now);
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
      const card=carrying.get(id);
      if(!card)continue;
      live.add(entry);
      let badge=badges.get(entry);
      if(!badge){
        badge=document.createElement('span');badge.className='of-card-carry';entry.el.append(badge);badges.set(entry,badge);
      }
      const number='#'+card.number;
      if(badge.textContent!==number){badge.textContent=number;badge.title=card.title}
    }
    for(const [entry,badge] of badges)if(!live.has(entry)){badge.remove();badges.delete(entry)}
  }
  return {hit,pick,rebuild,frame,invalidate(){dirty=true},
    dispose(){unsubscribe();for(const b of boards.values())disposeBoard(b);boards.clear();for(const b of badges.values())b.remove()}};
}
