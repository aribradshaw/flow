// The 3D office's E-to-interact picker (public/office-interact.js) with a stub DOM: nearest in front wins,
// priority breaks close calls, E toggles what it opened, walking away closes it, removed objects drop out.
import {test} from 'node:test';
import assert from 'node:assert/strict';

const el=()=>({hidden:false,dataset:{},style:{},innerHTML:'',addEventListener(){},append(){},remove(){},querySelector:()=>({textContent:''})});
globalThis.document={createElement:el};globalThis.matchMedia=()=>({matches:false});
const THREE=await import('../public/vendor/three/three.module.min.js');
const {createInteractions}=await import('../public/office-interact.js');

function setup(){
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,1,0.1,100);camera.position.set(0,10,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const me={x:0,z:0,heading:0};// facing +z
  const ix=createInteractions({scene,camera,stage:{...el(),clientWidth:800,clientHeight:600},player:()=>me,facing:()=>NaN});
  const at=(x,z)=>{const o=new THREE.Object3D();o.position.set(x,0,z);scene.add(o);o.updateMatrixWorld();return o};
  return {scene,me,ix,at};
}

test('the nearest thing in range and in front is the target; behind and too far are not',()=>{
  const {me,ix,at}=setup();
  ix.register({id:'ahead',object3D:at(0,1.8),label:'Talk to Ahead',onInteract(){}});
  ix.register({id:'behind',object3D:at(0,-1.5),label:'Behind',onInteract(){}});
  ix.register({id:'far',object3D:at(0,5),label:'Far',onInteract(){}});
  ix.update();assert.equal(ix.current()?.id,'ahead');
  me.heading=Math.PI;ix.update();assert.equal(ix.current()?.id,'behind','turning round targets what is now in front');
  ix.register({id:'touching',position:()=>({x:0.5,y:0,z:0.3}),label:'Touching',onInteract(){}});
  ix.update();assert.equal(ix.current()?.id,'touching','within a metre counts whatever the angle');
  ix.unregister('touching');me.heading=0;
  ix.register({id:'vip',object3D:at(0.2,2.0),priority:2,label:'VIP',onInteract(){}});
  ix.update();assert.equal(ix.current()?.id,'vip','priority wins a close call');
  ix.register({id:'off',object3D:at(0,0.9),enabled:()=>false,label:'Off',onInteract(){}});
  ix.update();assert.equal(ix.current()?.id,'vip');
});

test('E opens and E closes; walking away closes; Esc closes; removed objects drop out; gamepad X is E',()=>{
  const {scene,me,ix,at}=setup();let opened=0,closed=0;
  const o=at(0,1.5);ix.register({id:'a',object3D:o,radius:2,label:'A',onInteract(){opened++;return ()=>closed++}});
  ix.update();assert.ok(ix.trigger());assert.deepEqual([opened,closed],[1,0]);
  ix.trigger();assert.deepEqual([opened,closed],[1,1],'E again closes it');
  ix.trigger();me.z=-3;ix.update();assert.deepEqual([opened,closed],[2,2],'walking away closes it');
  me.z=0;ix.update();ix.trigger();assert.equal(ix.closeOpen(),true);assert.equal(closed,3);assert.equal(ix.closeOpen(),false);
  ix.gamepad({buttons:[{},{},{pressed:true}]});ix.gamepad({buttons:[{},{},{pressed:true}]});assert.equal(opened,4,'a held button fires once');
  ix.closeOpen();scene.remove(o);ix.update();assert.equal(ix.current(),null);assert.equal(ix.trigger(),false);
  assert.throws(()=>ix.register({label:'no id'}));
});

test('stale targets: a gone target toasts and drops, a moved one is followed live, one on top of you is not offered, a panel closed elsewhere opens again',()=>{
  const {me,ix,at}=setup(),toasts=[],stale=[];
  // A fresh picker with toast and stale hooks.
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();scene.add(camera);
  const ix2=createInteractions({scene,camera,stage:{...el(),clientWidth:800,clientHeight:600},player:()=>me,facing:()=>NaN,toast:m=>toasts.push(m),stale:id=>stale.push(id)});
  const o=new THREE.Object3D();o.position.set(0,0,1.6);scene.add(o);
  ix2.register({id:'agent',object3D:o,label:'Check on Flygon Builder',onInteract:()=>false});
  ix2.update();assert.equal(ix2.current()?.id,'agent');
  assert.equal(ix2.trigger(),true);assert.deepEqual(toasts,['Check on Flygon Builder: it isn\'t here any more.']);assert.deepEqual(stale,['agent']);
  ix2.update();assert.equal(ix2.current(),null,'dropped');
  // Re-registered by its owner on a different object that later moves away: positions are read every frame.
  const p=new THREE.Object3D();p.position.set(0,0,1.5);scene.add(p);
  ix2.register({id:'agent',object3D:p,label:'Check on Flygon Builder',onInteract(){}});
  ix2.update();assert.equal(ix2.current()?.id,'agent');p.position.set(8,0,8);ix2.update();assert.equal(ix2.current(),null,'it walked off');
  // Something standing exactly where you are (a stale position) is never offered, unless it is you.
  ix2.register({id:'onme',position:()=>({x:me.x+0.1,y:0,z:me.z}),label:'On me',onInteract(){}});
  ix2.update();assert.equal(ix2.current(),null);
  ix2.register({id:'onme',position:()=>({x:me.x+0.1,y:0,z:me.z}),self:true,label:'Me',onInteract(){}});ix2.update();assert.equal(ix2.current()?.id,'onme');
  ix2.unregister('onme');ix2.register({id:'nan',position:()=>({x:NaN,y:0,z:1}),label:'NaN',onInteract(){}});ix2.update();assert.equal(ix2.current(),null,'a broken position is skipped');
  // A panel closed with its own button: the next E opens it again instead of "closing" it.
  let shown=false,opens=0;p.position.set(0,0,1.5);
  ix2.register({id:'agent',object3D:p,label:'Check on Flygon Builder',onInteract:()=>{shown=true;opens++;return {close:()=>{shown=false},isOpen:()=>shown}}});
  ix2.update();ix2.trigger();assert.equal(shown,true);shown=false;ix2.trigger();assert.deepEqual([shown,opens],[true,2]);
  ix2.trigger();assert.equal(shown,false,'E closes what is open');
  ix.dispose();
});
