// The worlds of the 3D office (docs/concepts/12-office.md). office.js owns the people, the agents and the
// camera; a world owns everything they stand in. Every world answers the same interface:
//
//   layout(keys, {commonR})          lay out for these members (the owner first) and rebuild the scenery. Answers
//                                    the plan, in the shape of office-layout.js: rooms [{key, x, y, z, facing}],
//                                    mainWall, boardAnchors(), meterAnchors(), radius, and doors(portals) when the world places them
//   walls    [box]                   what else stops people and the camera (officeBox: height is the top)
//   terrain  {ground, floor, limit}  for office-controls.js to walk decks and stairs; null on one flat floor
//   ground(x, z)                     floor height there, or null where there is no floor (water)
//   floors   [Mesh]                  what a click or tap lands on
//   spawn, respawn(pos)              where people arrive, and come back after falling in
//   signs    [{x, y, z, text}]       names of places
//   center                           what the overview looks at
//   sea                              water level (-Infinity without water); splash(pos, t)
//   common(radius)                   the common area grew or shrank with the AgentFlow org
//   update(t, dt, {camera, motion})  each frame: water, sky, the deck's sway (motion: false stops it)
//   dispose()
//
// The layout math is in office-world-core.js (no Three.js, tested by node); this file and
// office-world-yacht.js draw it.
import * as THREE from './vendor/three/three.module.min.js';
import {classicWorld,worldId,WORLDS,DEFAULT_WORLD,wallsFrom} from './office-world-core.js';
import {createYachtWorld} from './office-world-yacht.js';
export {WORLDS,DEFAULT_WORLD,worldId,wallsFrom};

// The office as it always was: rooms in a ring on a flat floor, the common area's rug in the middle.
function createClassicWorld({scene}){
  const bg='#eef2ef',mat=c=>new THREE.MeshLambertMaterial({color:c,flatShading:true});
  scene.background=new THREE.Color(bg);scene.fog=new THREE.Fog(bg,45,110);
  const hemi=new THREE.HemisphereLight('#ffffff','#b9c4bf',2.2),sun=new THREE.DirectionalLight('#ffffff',1.6);sun.position.set(12,30,18);
  const ground=new THREE.Mesh(new THREE.CircleGeometry(120,48),mat('#dfe6e2'));ground.rotation.x=-Math.PI/2;ground.name='ground';
  const rug=new THREE.Mesh(new THREE.CircleGeometry(1,40),mat('#cfe3d2'));rug.rotation.x=-Math.PI/2;rug.position.y=0.01;rug.scale.setScalar(10);
  scene.add(hemi,sun,ground,rug);
  let core=classicWorld([]);
  const world={
    id:'classic',name:'Office',background:bg,sea:-Infinity,floors:[ground],stats:{triangles:0},terrain:null,
    layout(keys,opts={}){core=classicWorld(keys,opts);return core},
    common(radius){rug.scale.setScalar(radius)},
    update(t,dt,{camera}={}){if(camera)scene.fog.far=Math.max(110,camera.position.y+Math.max(12,core.radius+8))},
    get walls(){return core.walls},get signs(){return core.signs},get spawn(){return core.spawn},get center(){return core.center},
    ground:(x,z)=>core.ground(x,z),respawn:p=>core.respawn(p),splash(){},
    dispose(){for(const o of [hemi,sun,ground,rug]){scene.remove(o);o.geometry?.dispose();o.material?.dispose()}scene.fog=null},
  };
  return world;
}
// ctx: {scene, deck} — deck is the group office.js adds rooms, people and agents to.
export const createWorld=(id,ctx)=>worldId(id)==='yacht'?createYachtWorld(ctx):createClassicWorld(ctx);
