// See-through walls for the 3D office (docs/concepts/12-office.md "Yacht"): on a narrow deck a wall, a roof or
// the deck above often stands between the camera and you. Materials patched with cutaway() drop the pixels in a
// circle round you that are nearer the camera than you are and stand above your floor, with a dithered edge, so
// you always see yourself and what is beside you; whatever is right in front of the lens goes the same way. One set of uniforms for every patched material; radius 0
// turns it off (the classic office, where the camera stays inside the walls instead).
import * as THREE from './vendor/three/three.module.min.js';

// eye: your chest in view space; floor: the world height of the deck you stand on.
export const CUT={eye:{value:new THREE.Vector3()},radius:{value:0},floor:{value:0}};
const v=new THREE.Vector3();
// Once per frame, after the camera is placed. chest: a world-space point; radius 0: off.
export function aimCutaway(camera,chest,floor,radius){
  CUT.radius.value=radius;if(!radius)return;
  camera.updateMatrixWorld();CUT.eye.value.copy(v.copy(chest).applyMatrix4(camera.matrixWorldInverse));CUT.floor.value=floor;
}
export function cutaway(material){
  if(material.userData.cutaway)return material;
  material.userData.cutaway=true;
  material.onBeforeCompile=shader=>{
    shader.uniforms.uCutEye=CUT.eye;shader.uniforms.uCutR=CUT.radius;shader.uniforms.uCutFloor=CUT.floor;
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying float vCutY;varying vec3 vCutP;')
      .replace('#include <project_vertex>','#include <project_vertex>\nvCutP=mvPosition.xyz;vCutY=dot(viewMatrix[1].xyz,mvPosition.xyz)+cameraPosition.y;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform vec3 uCutEye;uniform float uCutR,uCutFloor;varying float vCutY;varying vec3 vCutP;')
      .replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
  if(uCutR>0.0&&vCutY>uCutFloor+0.4){
    float pd=-vCutP.z,cd=-uCutEye.z;
    if(pd>0.0&&pd<cd-0.35){
      float d=length(vCutP.xy/pd-uCutEye.xy/cd)*cd,k=min(smoothstep(uCutR*0.7,uCutR,d),smoothstep(2.2,4.6,length(vCutP)));
      if(k<fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715)))))discard;
    }
  }`);
  };
  material.customProgramCacheKey=()=>'cutaway';
  return material;
}
