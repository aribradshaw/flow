// Room decor and avatar looks: the shared rules (public/office-decor-core.js), who may save a room,
// and that a saved room survives the file store. The page and the server both call these functions.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as THREE from '../public/vendor/three/three.module.min.js';
import {officeState,officeHub} from '../lib/office.mjs';
import {officeStorage} from '../lib/office-storage.mjs';
import {toWorld} from '../public/office-layout.js';
import {ART,MAX_PROPS,PRESETS,cleanDecor,cleanLook,cleanTheme,figureFromLook,frameFromAnchor,newPropId,propForward,propYaw,sanitizeSign,snapWall} from '../public/office-decor-core.js';

const id=n=>'p'+String(n).padStart(8,'a');
const prop=(over)=>({id:id(1),kind:'plant-fern',x:4.5,z:0,rot:0,...over});
const fern=over=>({props:[prop(over)]});

test('props stay on the allow-list, snap to the grid, and clamp rotation',()=>{
  assert.throws(()=>cleanDecor(fern({kind:'throne'})),{code:'unknown_kind'});
  assert.throws(()=>cleanDecor(fern({id:'desk-1'})),{code:'invalid_decor'});
  assert.throws(()=>cleanDecor({props:[prop({color:'#ffffff'})]}),{code:'invalid_decor'});
  assert.throws(()=>cleanDecor({member:'someone',props:[]}),{code:'invalid_decor'});
  assert.throws(()=>cleanDecor({props:[prop(),prop({id:id(1)})]}),{code:'invalid_decor'});
  assert.throws(()=>cleanDecor({props:Array.from({length:MAX_PROPS+1},(_,i)=>prop({id:id(i)}))}),{code:'too_many'});
  const saved=cleanDecor({props:[prop({x:4.62,z:0.13,rot:5.6})]});
  assert.deepEqual([saved.props[0].x,saved.props[0].z,saved.props[0].rot],[4.5,0.25,3]);
  assert.equal(saved.theme,null);
  assert.deepEqual(cleanTheme('Cozy'),{...PRESETS.Cozy,preset:'Cozy'});
  assert.throws(()=>cleanTheme({floor:'#000000',wall:PRESETS.Cozy.wall,material:'wood'}),{code:'invalid_decor'});
});

test('sign text is stripped, flattened and capped at 20 characters',()=>{
  assert.equal(sanitizeSign('  <b>Hello</b>  there friend!!  '),'Hello there friend!!');
  assert.equal(sanitizeSign('a\u0000b<tag>&d'),'abd');
  assert.equal(sanitizeSign('x'.repeat(40)).length,20);
  const pose=snapWall(5.9,0,'neon');
  const neon={id:id(2),kind:'neon',color:ART[4],text:'  <i>Ahoy</i>  there friend!! ',...pose};
  const saved=cleanDecor({props:[neon]});
  assert.equal(saved.props[0].text,'Ahoy there friend!!');
  assert.ok(saved.props[0].text.length<=20);
  assert.throws(()=>cleanDecor({props:[{...neon,color:'#00ff00'}]}),{code:'invalid_decor'});
});

test('a prop cannot block the door, a desk, the board or a path, or leave the room',()=>{
  assert.equal(cleanDecor(fern()).props.length,1);
  for(const [where,spot] of [['door',{x:0,z:3.2}],['desk',{x:0,z:-3.1}],['path',{x:0,z:0.5}],['outside',{x:8,z:0}]]){
    const err=(()=>{try{cleanDecor(fern(spot));return null}catch(e){return e}})();
    assert.ok(err,where);assert.equal(err.code,where==='outside'?'outside':'blocked',where);
    if(where!=='outside')assert.match(err.message,/block/i,where);
  }
  // A rug is not solid, so it may lie on a desk. A poster must hang on a wall, not across the board.
  assert.equal(cleanDecor({props:[{id:id(3),kind:'rug',x:0,z:-3.1}]}).props.length,1);
  const side=snapWall(5.9,0,'poster');
  assert.equal(side.rot,3);
  assert.equal(cleanDecor({props:[{id:id(4),kind:'poster',color:ART[0],...side}]}).props[0].x,side.x);
  const back=snapWall(0,-4,'poster');
  assert.throws(()=>cleanDecor({props:[{id:id(5),kind:'poster',color:ART[1],...back}]}),e=>e.code==='blocked'&&/board/.test(e.message));
  // A world anchor can only shrink the classic room.
  const wide=frameFromAnchor({width:40,depth:40,doorW:10,boardW:30});
  assert.ok(wide.width<=12&&wide.depth<=9);
  assert.throws(()=>cleanDecor(fern({x:5.2,z:0}),{frame:{width:8,depth:8}}),{code:'outside'});
});

test('prop facing matches Three.js: rot 0 looks +z, rot 1 looks +x',()=>{
  const expect={0:{x:0,z:1},1:{x:1,z:0},2:{x:0,z:-1},3:{x:-1,z:0}};
  for(const rot of [0,1,2,3]){
    const fwd=new THREE.Vector3(0,0,1).applyAxisAngle(new THREE.Vector3(0,1,0),propYaw(rot));
    assert.ok(Math.abs(fwd.x-expect[rot].x)<1e-6&&Math.abs(fwd.z-expect[rot].z)<1e-6,'rot '+rot);
    assert.deepEqual(propForward(rot),expect[rot]);
  }
  // Room local (lx, lz) round-trips through toWorld. Facing π/2 turns local +x toward world -z.
  const room={x:10,z:20,facing:Math.PI/2};
  const w=toWorld(room,3,4);
  const dx=w.x-room.x,dz=w.z-room.z,c=Math.cos(room.facing),s=Math.sin(room.facing);
  assert.ok(Math.abs((dx*c-dz*s)-3)<1e-9&&Math.abs((dx*s+dz*c)-4)<1e-9);
});

test('a saved look is a palette choice, and reset clears it',()=>{
  const look={skin:'#f7d9c4',hair:'#2b1d14',hairStyle:1,topStyle:'hoodie',top:'#3d6fb6',bottoms:'#2d3a4a',accessory:'glasses'};
  assert.deepEqual(cleanLook(look),look);
  assert.equal(cleanLook({reset:true}),null);
  assert.deepEqual(figureFromLook(look),{skin:look.skin,hair:look.hair,shirt:look.top,pants:look.bottoms,style:1,top:'hoodie',accessory:'glasses'});
  assert.equal(figureFromLook(null),null);
  assert.throws(()=>cleanLook({...look,skin:'#000000'}),{code:'invalid_look'});
  assert.throws(()=>cleanLook({...look,cape:'red'}),{code:'invalid_look'});
  assert.throws(()=>cleanLook({reset:true,skin:look.skin}),{code:'invalid_look'});
  assert.throws(()=>cleanLook({skin:look.skin}),{code:'invalid_look'});
});

test('only the room owner can save it, a failed write is not broadcast, and the file keeps it',async()=>{
  const ann={email:'ann@example.test',name:'Ann'},bo={email:'bo@example.test',name:'Bo'};
  const ctx={id:'env1',name:'Studio',ownerEmail:ann.email,members:[ann,bo].map(u=>({email:u.email,name:u.name})),projects:[],agents:[]};
  const dir=await mkdtemp(tmpdir()+'/office-decor-');
  const storage=await officeStorage({dir,secret:'office fixture'});
  let failWrite=false;
  const wrapped={
    room:env=>storage.room(env),
    decor(env,member,data){if(failWrite)throw Object.assign(new Error('disk'),{status:500});return storage.decor(env,member,data)},
  };
  const state=officeState();
  const hub=officeHub({state,context:{env:async()=>ctx},storage:wrapped,heartbeatMs:60e3});
  const streams=[];
  function connect(user){
    let buf='';const events=[];
    const res={destroyed:false,writeHead(){},end(){},on(){},write(s){buf+=s;let i;while((i=buf.indexOf('\n\n'))>=0){const block=buf.slice(0,i);buf=buf.slice(i+2);const type=/^event: (.+)$/m.exec(block)?.[1],data=/^data: (.+)$/m.exec(block)?.[1];if(type)events.push({type,data:JSON.parse(data)})}}};
    streams.push(res);
    return hub.connect('env1',user,{ok:true,all:true,projectIds:new Set()},{headers:{},url:'/events',on(){}},res).then(()=>events);
  }
  try{
    assert.throws(()=>hub.decorate('env1',ann,fern()),{status:409});
    const [annEvents,boEvents]=await Promise.all([connect(ann),connect(bo)]);
    const annKey=annEvents.find(e=>e.type==='snapshot').data.me.key;
    const boKey=boEvents.find(e=>e.type==='snapshot').data.me.key;
    const placed=await hub.decorate('env1',ann,{theme:'Cozy',props:[prop()]});
    assert.equal(placed.theme.preset,'Cozy');
    assert.equal(placed.props[0].kind,'plant-fern');
    assert.equal(boEvents.filter(e=>e.type==='decor').at(-1).data.member,annKey);
    const boPlaced=await hub.decorate('env1',bo,{props:[prop({id:id(9),x:-4.5})]});
    assert.equal(boPlaced.props[0].x,-4.5);
    const room=await storage.room('env1');
    assert.equal(room.decor.find(r=>r.member===annKey).data.props[0].kind,'plant-fern');
    assert.equal(room.decor.find(r=>r.member===boKey).data.props[0].x,-4.5);
    assert.throws(()=>hub.decorate('env1',bo,{member:annKey,props:[prop({x:-4.5})]}),{code:'invalid_decor'});
    assert.equal((await storage.room('env1')).decor.find(r=>r.member===annKey).data.props[0].x,4.5,'Bo cannot rewrite Ann');
    failWrite=true;
    const before=boEvents.filter(e=>e.type==='decor').length;
    await assert.rejects(hub.decorate('env1',ann,{props:[prop({x:-4.5})]}));
    assert.equal(boEvents.filter(e=>e.type==='decor').length,before,'a failed write is not broadcast');
    assert.equal((await storage.room('env1')).decor.find(r=>r.member===annKey).data.props[0].x,4.5);
    const again=await connect(ann);
    const snap=again.find(e=>e.type==='snapshot').data;
    assert.equal(snap.decor.find(r=>r.member===annKey).props[0].x,4.5);
    assert.equal(snap.decor.find(r=>r.member===annKey).theme.preset,'Cozy');
  }finally{hub.close();state.close();await rm(dir,{recursive:true,force:true})}
});

test('prop ids are short and opaque',()=>{
  const a=newPropId(),b=newPropId();
  assert.match(a,/^p[a-z0-9]{8}$/);
  assert.notEqual(a,b);
});
