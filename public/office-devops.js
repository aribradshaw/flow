// The 3D office's main whiteboard is the real DevOps board (docs/concepts/12-office.md): the DevOps tab's own
// #devopsView, lent to the office while it is open (devops.js lendBoard) and hung on the main mount with Three.js'
// CSS3DRenderer (public/vendor/three, MIT). One board, one layout: right-click menus, snooze, drag between columns,
// filters, search, sort, undo and its shortcuts are the tab's own. Nothing here draws cards.
//
// Far away the board is live but inert, and the 3D scene gets the pointer. Its DOM sits under the WebGL canvas,
// which is transparent only where the board is (a "hole": a plane drawn with alpha 0 and no blending), so people
// walking in front of it still hide it. Focused (E, or a click on it) the camera flies to face it squarely at one
// CSS pixel per screen pixel (office-devops-core.js), the board comes above the canvas and takes the mouse and
// keys; Esc, "Back to office" or a click beside it returns. Once the camera is there, the board is placed flat
// (.of-css3d.flat: the same pixels, as a plain 2D translate): browsers do not hit-test content under a CSS
// perspective reliably, and flat it rasters sharp.
//
//   const board=createOfficeDevops({stage, root, world, camera, position() (the viewer's feet), frameParts(width, height) (its frame, an Object3D), envName(), local(), here(), openHere(),
//     openCard(id), onFocus(on), onResize() (its width changed with the screen's shape)})
//   board.rebuild(mount)   hang it on a mount ({x, y, z, nx, nz, width, height}, in world's frame); lends the board the first time
//   board.spot()           where someone stands to look at it (office-npc.js): {x, z, yaw} in world's frame
//   board.setVisible(on)   hidden (during a replay) it is not drawn, clicked or focused
//   board.hit(ray)         -> {distance, point} when the ray meets its front and you are near enough to see it, else null
//   board.focus()          -> {close, isOpen} (for office-interact.js), or null when there is no board yet
//   board.unfocus()   board.focused()
//   board.windowKey(e)     the office's capture-phase keydown while focused: true (the office does nothing more)
//   board.frame(dt, rigMoved)   once per frame after the office camera: blends the camera towards the board
//   board.render(scene)    after the WebGL render: places the board
//   board.resize(w, h)     board.dispose()   (gives the board back to the DevOps tab, where it was)
import * as THREE from './vendor/three/three.module.min.js';
import {CSS3DRenderer,CSS3DObject} from './vendor/three/CSS3DRenderer.js';
import {boardFit,focusPose,stepBlend,ease} from './office-devops-core.js';
import {lendBoard,returnBoard,key as boardKey,escape as boardEscape} from './devops.js';
import {matches} from './shortcuts.js';
import {menuOpen,closeMenu} from './menu.js';
import {closePicker,hideTip,esc} from './ui.js';

const isTyping=el=>el?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable=false])');

export function createOfficeDevops({stage,root,world,camera,position,frameParts,envName=()=>'',local=()=>true,here=()=>'',openHere=null,openCard,onFocus=()=>{},onResize=()=>{}}){
  const css=new CSS3DRenderer();css.domElement.className='of-css3d';stage.prepend(css.domElement);
  const veil=document.createElement('div');veil.className='of-board-veil';veil.addEventListener('click',()=>unfocus());stage.append(veil);
  const host=document.createElement('div');host.className='of-board-host';host.inert=true;host.tabIndex=-1;
  host.innerHTML=`<div class="of-board-head"><b class="of-board-title"></b><span class="sp"></span><button type="button" class="txt of-board-back" data-board-back>Back to office <kbd>Esc</kbd></button></div>
    <div class="of-board-gate" hidden role="group" aria-label="Board of another environment"></div>`;
  const title=host.querySelector('.of-board-title'),gate=host.querySelector('.of-board-gate');
  host.querySelector('[data-board-back]').addEventListener('click',()=>unfocus());
  // CSS3DObject styles its element for the scene; pointer events and selection are this module's to decide.
  const object=new CSS3DObject(host);host.style.pointerEvents='';host.style.userSelect='';
  // The CSS layer renders a copy of the world scaled up uniformly (the same picture) so that one unit is one board
  // pixel, the scale CSS 3D expects: in metres the board would sit a few CSS units from the eye.
  const cssScene=new THREE.Scene(),cssCamera=new THREE.PerspectiveCamera();cssScene.add(object);
  const hole=new THREE.MeshBasicMaterial({color:0x000000,opacity:0,blending:THREE.NoBlending,fog:false,toneMapped:false});
  let mount=null,fit=null,group=null,mesh=null,lent=false,focused=false,blend=0,settled=false,dismissed=false,showing=true,size={width:1,height:1},gateSig='';
  // center, normal, right, up: the board in the scene this frame (world may move: a yacht's deck sways).
  const center=new THREE.Vector3(),up=new THREE.Vector3(),quat=new THREE.Quaternion(),scl=new THREE.Vector3(),rigPos=new THREE.Vector3(),rigQuat=new THREE.Quaternion(),aimPos=new THREE.Vector3(),aimQuat=new THREE.Quaternion();
  const m4=new THREE.Matrix4(),frustum=new THREE.Frustum(),sphere=new THREE.Sphere(),v=new THREE.Vector3(),right=new THREE.Vector3(),normal=new THREE.Vector3();

  function hang(){
    if(!mount)return;
    fit=boardFit(mount,size);
    host.style.width=fit.px.w+'px';host.style.height=fit.px.h+'px';
    drop();
    group=new THREE.Group();group.position.set(mount.x,mount.y,mount.z);group.rotation.set(0,Math.atan2(mount.nx,mount.nz),0);group.visible=showing;
    group.add(frameParts(fit.m.w,fit.m.h));
    mesh=new THREE.Mesh(new THREE.PlaneGeometry(fit.m.w,fit.m.h),hole);mesh.userData.officeBoard='main';group.add(mesh);
    world.add(group);
    sphere.radius=Math.hypot(fit.m.w,fit.m.h)/2;
    sync();
  }
  function sync(){
    group.updateWorldMatrix(true,false);group.matrixWorld.decompose(center,quat,scl);
    normal.set(0,0,1).applyQuaternion(quat);up.set(0,1,0).applyQuaternion(quat);right.crossVectors(up,normal).normalize();
    object.position.copy(center).divideScalar(fit.scale);object.quaternion.copy(quat);
  }
  function drop(){
    if(!group)return;
    group.removeFromParent();group.traverse(o=>{o.geometry?.dispose();if(o.material&&o.material!==hole)o.material.dispose()});group=mesh=null;
  }
  function rebuild(m){
    mount=m;hang();
    place(); // puts the board in the document before it is lent its view
    if(!lent){lent=true;lendBoard(host,{openCard})}
  }
  function hit(ray){
    if(!mesh||!showing)return null;
    // From across the office (or through the rooms) a click is for walking, not for the board.
    const p=position();if(Math.hypot(p.x-center.x,p.z-center.z)>Math.max(16,fit.m.w*2.1))return null;
    const first=ray.intersectObject(mesh,false)[0];
    return first?{distance:first.distance,point:first.point}:null;
  }
  // The gate: the office is another environment's, but the DevOps board is the one of the environment you have
  // open. It says so, and opens that environment's board through the app's own environment switch.
  function paintGate(){
    const show=!local()&&!dismissed,sig=show?[envName(),here(),!!openHere].join('|'):'';
    if(sig===gateSig)return;gateSig=sig;gate.hidden=!show;if(!show)return;
    gate.innerHTML=`<p><b>${esc(envName())}</b> has its own DevOps board. The board here is <b>${esc(here()||'your environment')}</b>’s, the environment you have open.</p>
      <div class="of-board-gate-b">${openHere?`<button type="button" class="txt primary" data-gate="open">Open ${esc(envName())}’s board</button>`:''}<button type="button" class="txt" data-gate="stay">Use ${esc(here()||'this')} board</button></div>`;
    gate.querySelector('[data-gate=open]')?.addEventListener('click',()=>openHere());
    gate.querySelector('[data-gate=stay]').addEventListener('click',()=>{dismissed=true;paintGate();host.focus({preventScroll:true})});
  }
  // Keys while focused reach the board: its own handlers first, then (bubbling to <body>) the DevOps shortcuts.
  // The app's document handler would send them to the tab under the office, so only Save, Undo and Redo go on.
  function bodyKey(e){
    if(!focused||e.target.closest?.('dialog[open]'))return;
    const typing=isTyping(e.target);
    if(matches(e,'global.save')||!typing&&(matches(e,'global.undo')||matches(e,'global.redo')))return;
    e.stopPropagation();
    if(typing||e.defaultPrevented||e.key==='Escape')return;
    boardKey(e);
  }
  function windowKey(e){
    if(e.key!=='Escape')return true;
    // A lifted card (drag.js), a menu or a picker closes first, on its own.
    if(e.defaultPrevented||menuOpen()||document.querySelector('.picker'))return true;
    e.preventDefault();e.stopPropagation();
    if(boardEscape())return true;
    if(host.contains(e.target)&&isTyping(e.target)){e.target.blur();host.focus({preventScroll:true});return true}
    unfocus();return true;
  }
  function focus(){
    if(!mesh||!showing)return null;
    if(!focused){
      focused=true;host.inert=false;root.classList.add('of-board-focus');
      document.body.addEventListener('keydown',bodyKey);
      host.focus({preventScroll:true});onFocus(true);
    }
    return {close:unfocus,isOpen:()=>focused};
  }
  function unfocus(){
    if(!focused)return;
    focused=false;settled=false;host.style.willChange='transform';css.domElement.classList.remove('flat');
    closeMenu(false);closePicker();hideTip();
    document.body.removeEventListener('keydown',bodyKey);
    if(host.contains(document.activeElement))root.focus({preventScroll:true});
    host.inert=true;root.classList.remove('of-board-focus');onFocus(false);
  }
  function frame(dt,rigMoved){
    if(rigMoved||blend===0){rigPos.copy(camera.position);rigQuat.copy(camera.quaternion)}
    blend=fit?stepBlend(blend,focused?1:0,dt):0;
    if(group)sync();
    if(blend>0){
      const pose=focusPose(fit,size,camera.fov);
      aimPos.copy(center).addScaledVector(normal,pose.d).addScaledVector(right,pose.x).addScaledVector(up,pose.y);
      m4.lookAt(aimPos,v.copy(aimPos).sub(normal),up);aimQuat.setFromRotationMatrix(m4);
      const k=ease(blend);
      camera.position.lerpVectors(rigPos,aimPos,k);camera.quaternion.slerpQuaternions(rigQuat,aimQuat,k);
    }
    // Settled on the board: placed flat, so it takes the pointer and rasters at its final, 1:1 scale.
    const still=focused&&blend===1;
    if(still!==settled){
      settled=still;host.style.willChange=still?'':'transform';css.domElement.classList.toggle('flat',still);
      if(still){const p=focusPose(fit,size,camera.fov);host.style.setProperty('--x',p.left+'px');host.style.setProperty('--y',p.top+'px');host.style.setProperty('--k',String(fit.screen))}
    }
    const t=`${envName()||'This office'} · DevOps`;if(title.textContent!==t)title.textContent=t;
    paintGate();
  }
  function place(){
    cssCamera.projectionMatrix.copy(camera.projectionMatrix);cssCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    cssCamera.position.copy(camera.position).divideScalar(fit.scale);cssCamera.quaternion.copy(camera.quaternion);cssCamera.updateMatrixWorld();
    css.render(cssScene,cssCamera);
  }
  function render(){
    if(!fit)return;
    camera.updateMatrixWorld();
    // Off screen, or seen from behind its wall: hidden, so the browser skips it.
    sphere.center.copy(center);
    frustum.setFromProjectionMatrix(m4.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
    const shown=showing&&(focused||frustum.intersectsSphere(sphere)&&v.copy(camera.position).sub(center).dot(normal)>0.05);
    const vis=shown?'':'hidden';if(host.style.visibility!==vis)host.style.visibility=vis;
    if(shown&&!settled)place();
  }
  function resize(width,height){
    const was=fit?.m.w;size={width,height};css.setSize(width,height);settled=false;css.domElement.classList.remove('flat');
    if(mount){hang();if(Math.abs(fit.m.w-was)>0.01)onResize()}
  }
  function dispose(){
    unfocus();
    if(lent){lent=false;returnBoard()}
    cssScene.remove(object);css.domElement.remove();veil.remove();host.remove();
    drop();hole.dispose();
  }
  function setVisible(on){showing=on;if(group)group.visible=on;if(!on)unfocus()}
  const spot=()=>mount?{x:mount.x+mount.nx*1.6,z:mount.z+mount.nz*1.6,yaw:Math.atan2(mount.nx,mount.nz)}:null;
  host.style.willChange='transform';
  return {rebuild,hit,focus,unfocus,focused:()=>focused,windowKey,frame,render,resize,setVisible,spot,dispose,width:()=>fit?.m.w||0};
}
