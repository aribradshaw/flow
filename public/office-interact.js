// "Press E": what you are near in the 3D office, and what E (gamepad X / Square, or tapping the prompt) does there.
//
//   const interact=createInteractions({scene, camera, stage, player:()=>({x,z,heading}), facing:()=>yaw})
//   interact.register({
//     id,                       unique; registering the same id again replaces it
//     object3D | position(),    where it is: an Object3D (its world position, followed every frame) or a function
//                               returning {x, y, z}. An Object3D taken out of the scene drops its entry by itself.
//     radius,                   how near you must be, in metres (default 2.2)
//     label() | label,          the prompt's text, e.g. "Talk to Chief of Staff", "Open #449", "Wave at Joe"
//     priority,                 breaks ties between things in range: higher wins (default 0)
//     height,                   where the prompt floats above its position (default 2)
//     enabled(),                optional: false hides it for now
//     onInteract(),             what E does. Return a close function, or {close, isOpen} (isOpen lets E open it
//                               again after it was closed some other way), for what it opened: E again, Esc
//                               (see closeOpen) or walking out of range closes it. Return false when its target
//                               is gone: the entry is dropped, toast(message) says so and stale(id) lets the
//                               owner rebuild it.
//     self,                     true only for something that is the player: anything else within 0.3 m of the
//                               player is never offered (a prop that walked onto you, a stale position)
//   })
//   interact.unregister(id)     interact.unregisterWhere(id=>bool)
//   interact.update()           once per frame: picks the target and places the prompt and highlight (positions
//                               are read from the live objects every frame; a position that is not finite skips it)
//   interact.trigger()          E pressed: interacts, or closes what the last interaction opened
//   interact.closeOpen()        -> true when something an interaction opened was closed (call it on Esc)
//   interact.gamepad(pad)       once per frame with navigator.getGamepads()[i]: X / Square (button 2) is E
//   interact.current()          the targeted entry or null
//   interact.dispose()
// The target is the nearest one in range that is roughly in front of your avatar or the camera (anything
// within a metre counts whatever the angle), with priority deciding between close calls. Nothing fires
// while typing: the caller only calls trigger() for E outside inputs.
import * as THREE from './vendor/three/three.module.min.js';

export function createInteractions({scene,camera,stage,player,facing,toast=()=>{},stale=()=>{},touch=()=>matchMedia('(pointer: coarse)').matches}){
  const items=new Map(),v=new THREE.Vector3(),p=new THREE.Vector3();
  let target=null,open=null,padDown=false;
  const prompt=document.createElement('button');prompt.type='button';prompt.className='of-prompt-e';prompt.hidden=true;
  // The chip does what E does (pointerdown is kept from the canvas underneath, which would walk or orbit).
  prompt.addEventListener('pointerdown',e=>e.stopPropagation());
  prompt.addEventListener('click',e=>{e.stopPropagation();e.preventDefault();trigger()});
  stage.append(prompt);
  // A soft ring on the floor under the target.
  const ring=new THREE.Mesh(new THREE.RingGeometry(0.62,0.78,40),new THREE.MeshBasicMaterial({color:'#ffd27a',transparent:true,opacity:.55,depthWrite:false,side:THREE.DoubleSide}));
  ring.rotation.x=-Math.PI/2;ring.visible=false;ring.renderOrder=2;scene.add(ring);
  const inScene=o=>{for(let x=o;x;x=x.parent)if(x===scene)return true;return false};
  const where=it=>{try{if(it.object3D){it.object3D.getWorldPosition(v);return v}const q=it.position();return q?v.set(q.x,q.y||0,q.z):null}catch{return null}};
  const finite=q=>!!q&&Number.isFinite(q.x)&&Number.isFinite(q.y)&&Number.isFinite(q.z);
  const text=it=>typeof it.label==='function'?it.label():it.label||'Interact';
  function pick(){
    const me=player(),dirs=[me.heading,facing?.()].filter(Number.isFinite).map(a=>[Math.sin(a),Math.cos(a)]);
    let best=null,bestScore=Infinity;
    for(const [id,it] of items){
      if(it.object3D&&!inScene(it.object3D)){items.delete(id);continue}
      if(it.enabled&&!it.enabled())continue;
      const q=where(it);if(!finite(q))continue;
      const dx=q.x-me.x,dz=q.z-me.z,d=Math.hypot(dx,dz);if(d>(it.radius??2.2)||(d<0.3&&!it.self))continue;
      const front=d<1?1:Math.max(...dirs.map(([sx,sz])=>(dx*sx+dz*sz)/d));if(front<0.25)continue;
      const score=d+(1-front)*0.8-(it.priority||0)*0.75;if(score<bestScore){bestScore=score;best=it}
    }
    return best;
  }
  function trigger(){
    // What the last interaction opened may have been closed another way (its own close button): then E opens again.
    if(open&&open.isOpen&&!open.isOpen())open=null;
    if(open){const f=open;open=null;f.close?.();return true}
    if(!target||!items.has(target.id))return false;
    const it=target,label=text(it);let r;
    try{r=it.onInteract?.()}catch(e){console.error('office interact',it.id,e);r=false}
    if(r===false){items.delete(it.id);target=null;toast(`${label}: it isn't here any more.`);stale(it.id);return true}
    const close=typeof r==='function'?r:r?.close,isOpen=typeof r?.isOpen==='function'?r.isOpen:null;
    open=close?{id:it.id,close,isOpen}:null;
    return true;
  }
  return {
    register(def){if(!def?.id)throw Error('interact.register needs an id');items.set(def.id,{radius:2.2,priority:0,height:2,...def});return def.id},
    unregister(id){items.delete(id);if(target?.id===id)target=null},
    unregisterWhere(fn){for(const id of [...items.keys()])if(fn(id))this.unregister(id)},
    current:()=>target,
    trigger,
    closeOpen(){if(!open)return false;const f=open;open=null;f.close?.();return true},
    gamepad(pad){const down=!!pad?.buttons?.[2]?.pressed;if(down&&!padDown)trigger();padDown=down},
    update(){
      // Walking away closes what the last interaction opened.
      if(open&&open.isOpen&&!open.isOpen())open=null;
      if(open){const it=items.get(open.id),me=player(),q=it&&where(it);if(!it||!finite(q)||Math.hypot(q.x-me.x,q.z-me.z)>(it.radius??2.2)*1.6){const f=open;open=null;f.close?.()}}
      target=pick();
      if(!target){prompt.hidden=true;ring.visible=false;return}
      const q=where(target);if(!finite(q)){target=null;prompt.hidden=true;ring.visible=false;return}ring.position.set(q.x,0.03,q.z);ring.visible=true;ring.material.opacity=.4+.2*Math.sin(performance.now()/260);
      p.copy(q);p.y+=target.height;p.project(camera);
      if(p.z>1){prompt.hidden=true;return}
      const label=(open?.id===target.id?'Close':text(target));
      if(prompt.dataset.label!==label||prompt.dataset.touch!==String(touch())){prompt.dataset.label=label;prompt.dataset.touch=String(touch());prompt.innerHTML=`${touch()?'':'<kbd>E</kbd>'}<span></span>`;prompt.querySelector('span').textContent=label}
      prompt.hidden=false;prompt.style.transform=`translate(${((p.x+1)/2*stage.clientWidth).toFixed(1)}px,${((1-p.y)/2*stage.clientHeight).toFixed(1)}px) translate(-50%,-100%)`;
    },
    dispose(){prompt.remove();scene.remove(ring);ring.geometry.dispose();ring.material.dispose();items.clear()},
  };
}
