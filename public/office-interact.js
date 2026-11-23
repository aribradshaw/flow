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
//     onInteract(),             what E does. Return a close function (or nothing) for what it opened: E again,
//                               Esc (see closeOpen) or walking out of range runs it.
//   })
//   interact.unregister(id)     interact.unregisterWhere(id=>bool)
//   interact.update()           once per frame: picks the target and places the prompt and highlight
//   interact.trigger()          E pressed: interacts, or closes what the last interaction opened
//   interact.closeOpen()        -> true when something an interaction opened was closed (call it on Esc)
//   interact.gamepad(pad)       once per frame with navigator.getGamepads()[i]: X / Square (button 2) is E
//   interact.current()          the targeted entry or null
//   interact.dispose()
// The target is the nearest one in range that is roughly in front of your avatar or the camera (anything
// within a metre counts whatever the angle), with priority deciding between close calls. Nothing fires
// while typing: the caller only calls trigger() for E outside inputs.
import * as THREE from './vendor/three/three.module.min.js';

export function createInteractions({scene,camera,stage,player,facing,touch=()=>matchMedia('(pointer: coarse)').matches}){
  const items=new Map(),v=new THREE.Vector3(),p=new THREE.Vector3();
  let target=null,open=null,padDown=false;
  const prompt=document.createElement('button');prompt.type='button';prompt.className='of-prompt-e';prompt.hidden=true;
  prompt.addEventListener('click',e=>{e.stopPropagation();trigger()});
  stage.append(prompt);
  // A soft ring on the floor under the target.
  const ring=new THREE.Mesh(new THREE.RingGeometry(0.62,0.78,40),new THREE.MeshBasicMaterial({color:'#ffd27a',transparent:true,opacity:.55,depthWrite:false,side:THREE.DoubleSide}));
  ring.rotation.x=-Math.PI/2;ring.visible=false;ring.renderOrder=2;scene.add(ring);
  const inScene=o=>{for(let x=o;x;x=x.parent)if(x===scene)return true;return false};
  const where=it=>{if(it.object3D){it.object3D.getWorldPosition(v);return v}const q=it.position();return v.set(q.x,q.y||0,q.z)};
  const text=it=>typeof it.label==='function'?it.label():it.label||'Interact';
  function pick(){
    const me=player(),dirs=[me.heading,facing?.()].filter(Number.isFinite).map(a=>[Math.sin(a),Math.cos(a)]);
    let best=null,bestScore=Infinity;
    for(const [id,it] of items){
      if(it.object3D&&!inScene(it.object3D)){items.delete(id);continue}
      if(it.enabled&&!it.enabled())continue;
      const q=where(it),dx=q.x-me.x,dz=q.z-me.z,d=Math.hypot(dx,dz);if(d>(it.radius??2.2))continue;
      const front=d<1?1:Math.max(...dirs.map(([sx,sz])=>(dx*sx+dz*sz)/d));if(front<0.25)continue;
      const score=d+(1-front)*0.8-(it.priority||0)*0.75;if(score<bestScore){bestScore=score;best=it}
    }
    return best;
  }
  function trigger(){
    if(open){const f=open;open=null;f.close?.();return true}
    if(!target)return false;
    const close=target.onInteract?.();open={id:target.id,close:typeof close==='function'?close:null};
    if(!open.close)open=null;
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
      if(open){const it=items.get(open.id),me=player(),q=it&&where(it);if(!it||Math.hypot(q.x-me.x,q.z-me.z)>(it.radius??2.2)*1.6){const f=open;open=null;f.close?.()}}
      target=pick();
      if(!target){prompt.hidden=true;ring.visible=false;return}
      const q=where(target);ring.position.set(q.x,0.03,q.z);ring.visible=true;ring.material.opacity=.4+.2*Math.sin(performance.now()/260);
      p.copy(q);p.y+=target.height;p.project(camera);
      if(p.z>1){prompt.hidden=true;return}
      const label=(open?.id===target.id?'Close':text(target));
      if(prompt.dataset.label!==label||prompt.dataset.touch!==String(touch())){prompt.dataset.label=label;prompt.dataset.touch=String(touch());prompt.innerHTML=`${touch()?'':'<kbd>E</kbd>'}<span></span>`;prompt.querySelector('span').textContent=label}
      prompt.hidden=false;prompt.style.transform=`translate(${((p.x+1)/2*stage.clientWidth).toFixed(1)}px,${((1-p.y)/2*stage.clientHeight).toFixed(1)}px) translate(-50%,-100%)`;
    },
    dispose(){prompt.remove();scene.remove(ring);ring.geometry.dispose();ring.material.dispose();items.clear()},
  };
}
