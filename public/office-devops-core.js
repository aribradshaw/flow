// The real DevOps board on the 3D office's main wall (office-devops.js): how big it is and where the camera
// stands to work on it. Plain math, no Three.js or DOM, so node can test it.
//
// The board is laid out once, in CSS pixels, like the DevOps tab, and hung on its mount (boardAnchors().main in
// office-layout.js) at a scale of metres per pixel. Its shape follows the screen: as wide for its height as the
// space the office gives a focused board, between FOCUS_MIN_ASPECT and the mount's own shape. So when you focus it
// the board fills that space with one CSS pixel per screen pixel, and is crisp.
export const FOCUS_INSET=12;          // px kept clear round a focused board
export const FOCUS_MIN_ASPECT=1.3;     // the narrowest board, width / height
export const FOCUS_MIN_WIDTH=720;      // px: below this a focused board is laid out wider and shown smaller

const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const even=n=>2*Math.round(n/2);

// mount: {width, height} in metres (the most the wall takes); stage: {width, height} in CSS px.
// -> {px: {w, h} (CSS px, even), m: {w, h} (metres on the wall), scale (metres per CSS px), screen (on-screen
//     pixels per CSS px when focused: 1 unless the stage is too small)}
export function boardFit(mount,stage){
  const fw=Math.max(1,stage.width-2*FOCUS_INSET),fh=Math.max(1,stage.height-2*FOCUS_INSET);
  const widest=mount.width/mount.height,aspect=clamp(fw/fh,Math.min(FOCUS_MIN_ASPECT,widest),widest);
  let w=fw/fh>aspect?fh*aspect:fw;
  if(w<FOCUS_MIN_WIDTH)w=FOCUS_MIN_WIDTH;
  const px={w:even(w),h:even(w/aspect)};
  const m=mount.height*aspect<=mount.width?{w:mount.height*aspect,h:mount.height}:{w:mount.width,h:mount.width/aspect};
  return {px,m,scale:m.w/px.w,screen:Math.min(1,fw/px.w,fh/px.h)};
}

// Where the camera stands to face a focused board squarely, in the board's own frame: d metres out along its
// normal, shifted (x right, y up, in metres) so its top-left corner lands on a whole screen pixel (left, top).
// stage: {width, height} in CSS px; fov: the camera's vertical field of view in degrees.
export function focusPose(fit,stage,fov){
  const k=fit.screen,perPx=fit.scale/k; // metres per screen pixel at the board
  const d=fit.scale*(stage.height/2)/(Math.tan(fov*Math.PI/360)*k);
  const w=fit.px.w*k,h=fit.px.h*k;
  const left=Math.round((stage.width-w)/2),top=Math.round((stage.height-h)/2);
  // The board's centre lands at (left + w/2, top + h/2); the camera moves the other way.
  const dx=left+w/2-stage.width/2,dy=top+h/2-stage.height/2;
  return {d,x:-dx*perPx,y:dy*perPx,left,top};
}

// Eases a focus blend from 0 (the office camera) to 1 (facing the board), framerate independent.
export function stepBlend(blend,target,dt,seconds=0.55){
  const next=blend+(target>blend?1:-1)*dt/seconds;
  return target>blend?Math.min(target,next):Math.max(target,next);
}
export const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
