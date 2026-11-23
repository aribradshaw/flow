// Room decor and avatar looks for the 3D office. Plain data, no Three.js, so the server and
// node tests share it with the page. Props are placed in a room's own frame (x across, z toward
// the door). The classic room is office-layout.js. A world may also answer decorAnchors():
// [{key, width, depth, doorW, boardW, blocked:[{role, x, z, w, d}]}] in that same frame.
// The server never accepts a room bigger than the classic one. The page also applies a world's
// tighter anchor, so a prop cannot sit outside the room the world built.
import {ROOM_W,ROOM_D,DOOR_W,ROOM_BOARD} from './office-layout.js';

export const MAX_PROPS=40,GRID=0.25,SIGN_MAX=20;
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};
const round=n=>Math.round(n*1000)/1000;
export const snap=n=>round(Math.round(n/GRID)*GRID);

// kind -> footprint in metres. wall pieces hang on a wall. solid ones block walking and NPC routes.
// color / text are the only optional fields, and only on the kinds that say so.
export const CATALOGUE={
  'plant-fern':{w:0.55,d:0.55,h:1.15,solid:true,label:'Fern'},
  'plant-cactus':{w:0.4,d:0.4,h:0.9,solid:true,label:'Cactus'},
  'plant-tree':{w:0.7,d:0.7,h:1.7,solid:true,label:'Tree'},
  rug:{w:1.8,d:1.15,h:0.02,solid:false,label:'Rug'},
  lamp:{w:0.35,d:0.35,h:1.45,solid:true,label:'Lamp'},
  bookshelf:{w:0.9,d:0.35,h:1.7,solid:true,label:'Bookshelf'},
  sofa:{w:1.6,d:0.7,h:0.8,solid:true,label:'Sofa'},
  armchair:{w:0.75,d:0.7,h:0.85,solid:true,label:'Armchair'},
  'coffee-table':{w:0.95,d:0.55,h:0.4,solid:true,label:'Coffee table'},
  poster:{w:0.8,d:0.06,h:0.65,solid:false,wall:true,color:true,label:'Poster'},
  trophy:{w:0.28,d:0.28,h:0.55,solid:true,label:'Trophy'},
  aquarium:{w:0.9,d:0.4,h:0.6,solid:true,label:'Aquarium'},
  arcade:{w:0.7,d:0.7,h:1.6,solid:true,label:'Arcade cabinet'},
  beanbag:{w:0.7,d:0.7,h:0.5,solid:true,label:'Bean bag'},
  'standing-desk':{w:1.15,d:0.55,h:1.15,solid:true,label:'Standing desk'},
  whiteboard:{w:1.2,d:0.06,h:0.8,solid:false,wall:true,label:'Whiteboard'},
  neon:{w:1.15,d:0.06,h:0.32,solid:false,wall:true,color:true,text:true,label:'Neon sign'},
  trinket:{w:0.22,d:0.22,h:0.22,solid:true,label:'Trinket'},
};
export const PROP_KINDS=Object.keys(CATALOGUE);
export const ART=['#d97857','#3d6fb6','#5f9e6e','#d9a441','#6b5ca5','#e07b39','#2f8f8a','#f4efe6','#1d2421','#c45c6a'];
export const FLOORS=['#f4efe6','#c4a574','#8aa0a8','#1d2a33','#d8c3a5','#6f8f72','#e7e2d6','#3e4a44','#7fa3ad'];
export const WALLS=['#f7f5f1','#efe6d6','#d5e0e4','#162028','#f3e6d0','#e7efe4','#243038','#fbf8f2','#e4eef0'];
export const MATERIALS=['paint','wood','plaster','tile'];
export const PRESETS={
  Minimal:{floor:'#f4efe6',wall:'#f7f5f1',material:'plaster'},
  Cozy:{floor:'#c4a574',wall:'#efe6d6',material:'wood'},
  Neon:{floor:'#1d2a33',wall:'#162028',material:'tile'},
  Nautical:{floor:'#7fa3ad',wall:'#e4eef0',material:'paint'},
};
export const PRESET_NAMES=Object.keys(PRESETS);

// Avatar looks. Colours match office-figures.js so a saved look is the same mesh the office draws.
export const SKINS=['#f7d9c4','#eec1a0','#dca47c','#c08259','#94603f','#68412a'];
export const HAIR_COLORS=['#2b1d14','#4a3120','#7a4b2a','#b9874b','#ddc48d','#1c1c1c','#8f8f8f','#a3412f'];
export const HAIR_STYLES=[0,1,2,3];
export const HAIR_STYLE_NAMES=['Short','Long','Fringe','Crop'];
export const TOP_STYLES=['tee','hoodie','shirt'];
export const TOP_COLORS=['#3d6fb6','#5f9e6e','#a8524c','#d9a441','#6b5ca5','#2f8f8a','#d87881','#556270','#c96f3b','#3f7d3d','#8a6fb8','#e07b39'];
export const BOTTOM_COLORS=['#2d3a4a','#3b3b3b','#4a3a2a','#2f4a3a','#5a5f6a','#283044'];
export const ACCESSORIES=['none','cap','headphones','glasses'];
const LOOK_FIELDS={skin:SKINS,hair:HAIR_COLORS,hairStyle:HAIR_STYLES,topStyle:TOP_STYLES,top:TOP_COLORS,bottoms:BOTTOM_COLORS,accessory:ACCESSORIES};

const PROP_FIELDS=new Set(['id','kind','x','z','rot','color','text']);
const DECOR_FIELDS=new Set(['theme','props','preset']);
const THEME_FIELDS=new Set(['floor','wall','material','preset']);
const BLOCKED={door:'That would block the door.',desk:'That would block a desk.',board:'That would block the board.',path:'That would block a path.'};

export function classicFrame(){
  return {width:ROOM_W,depth:ROOM_D,doorW:DOOR_W,boardW:ROOM_BOARD.width,extras:[]};
}
function num(v,lo,hi,fallback){
  const n=typeof v==='number'?v:Number(v);
  if(!Number.isFinite(n))return fallback;
  return Math.max(lo,Math.min(hi,n));
}
// A world anchor may only shrink the classic room (or add blocked boxes). It cannot open a larger one.
export function frameFromAnchor(anchor){
  const base=classicFrame();
  if(!anchor||typeof anchor!=='object')return base;
  const width=num(anchor.width,4,base.width,base.width);
  const depth=num(anchor.depth,4,base.depth,base.depth);
  const doorW=num(anchor.doorW,1.2,Math.min(base.doorW,width-1),base.doorW);
  const boardW=num(anchor.boardW,1,Math.min(base.boardW,width-0.4),Math.min(base.boardW,width-0.4));
  const extras=[];
  const rawBlocked=Array.isArray(anchor.blocked)?anchor.blocked:Array.isArray(anchor.extras)?anchor.extras:[];
  for(const b of rawBlocked.slice(0,32)){
    if(!b||typeof b!=='object')continue;
    const role=BLOCKED[b.role]?b.role:'path';
    const w=num(b.w,0.2,width,0),d=num(b.d,0.2,depth,0),x=num(b.x,-width,width,NaN),z=num(b.z,-depth,depth,NaN);
    if(w&&d&&Number.isFinite(x)&&Number.isFinite(z))extras.push({role,x,z,w,d});
  }
  return {width,depth,doorW,boardW,extras};
}

// The first row of desks stays clear even before anyone is reporting, so a later agent still has a place.
export function deskSlots(count){
  const n=Math.max(0,Math.min(16,count|0));
  const cols=n>8?4:3,sx=n>8?2.6:3.2,slots=n>8?n:Math.max(n,3),out=[];
  for(let i=0;i<slots;i++){
    const col=i%cols,row=Math.floor(i/cols);
    out.push({role:'desk',x:round((col-(cols-1)/2)*sx),z:round(-ROOM_D/2+1.4+row*2.1),w:1.7,d:0.8});
  }
  return out;
}
export function reservedZones(frame,{desks=0}={}){
  const f=frame||classicFrame(),hx=f.width/2,hz=f.depth/2;
  const door={role:'door',x:0,z:round(hz-1.05),w:round(f.doorW+0.7),d:2.3};
  const path={role:'path',x:0,z:0.4,w:1.35,d:round(hz-1.2)};
  // Coffee corner the idle agents walk to (office-activity.js), kept as a path.
  const lounge={role:'path',x:round(-hx+1.7),z:round(hz-1.6),w:2,d:2};
  const board={role:'board',x:0,z:round(-hz+0.45),w:round(Math.min(f.boardW+0.2,f.width-0.4)),d:1};
  return [door,path,lounge,board,...deskSlots(desks).filter(b=>Math.abs(b.x)<hx&&Math.abs(b.z)<hz),...(f.extras||[])];
}

export function footprint(prop){
  const spec=CATALOGUE[prop.kind],odd=(prop.rot|0)%2===1;
  return {id:prop.id,x:prop.x,z:prop.z,w:odd?spec.d:spec.w,d:odd?spec.w:spec.d,h:spec.h,solid:!!spec.solid,wall:!!spec.wall,kind:prop.kind};
}
const overlap=(a,b,pad=0)=>Math.abs(a.x-b.x)*2<(a.w+b.w+pad)&&Math.abs(a.z-b.z)*2<(a.d+b.d+pad);
function insideRoom(box,frame,wall){
  const hx=frame.width/2,hz=frame.depth/2,slop=wall?0.02:0,inset=wall?0:0.15;
  return box.x-box.w/2>=-hx-slop+inset&&box.x+box.w/2<=hx+slop-inset&&box.z-box.d/2>=-hz-slop+inset&&box.z+box.d/2<=hz+slop-inset;
}
function againstWall(box,frame){
  const hx=frame.width/2,hz=frame.depth/2,near=(edge,bound)=>Math.abs(edge-bound)<=0.18;
  return near(box.x-box.w/2,-hx)||near(box.x+box.w/2,hx)||near(box.z-box.d/2,-hz)||near(box.z+box.d/2,hz);
}
export function placementIssue(prop,frame,zones){
  const box=footprint(prop);
  if(!insideRoom(box,frame,box.wall))return {code:'outside',message:'That sits outside the room.'};
  if(box.wall){
    if(!againstWall(box,frame))return {code:'outside',message:'Hang that on a wall.'};
    for(const zone of zones)if((zone.role==='door'||zone.role==='board')&&overlap(box,zone,0.02))return {code:'blocked',message:BLOCKED[zone.role]};
    return null;
  }
  if(!box.solid)return null;
  for(const zone of zones)if(overlap(box,zone,0.05))return {code:'blocked',message:BLOCKED[zone.role]||BLOCKED.path};
  return null;
}
// A person (or an NPC) standing at x,z in room space, with a body radius, against solid props.
export function covers(boxes,x,z,radius=0.32){
  return boxes.some(b=>{
    const dx=Math.max(0,Math.abs(x-b.x)-b.w/2),dz=Math.max(0,Math.abs(z-b.z)-b.d/2);
    return dx*dx+dz*dz<radius*radius;
  });
}
export function solidBoxes(props){return (props||[]).filter(p=>CATALOGUE[p.kind]?.solid).map(footprint)}

export function sanitizeSign(text){
  let s=String(text??'');
  s=s.replace(/[\u0000-\u001F\u007F]/g,'').replace(/<[^>]*>/g,'').replace(/[<>&]/g,'');
  return [...s.replace(/\s+/g,' ').trim()].slice(0,SIGN_MAX).join('');
}
function cleanProp(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail(400,'invalid_decor','Bad prop');
  for(const k of Object.keys(raw))if(!PROP_FIELDS.has(k))fail(400,'invalid_decor','Unknown prop field');
  const spec=CATALOGUE[raw.kind];
  if(!spec)fail(400,'unknown_kind','Unknown prop');
  if(typeof raw.id!=='string'||!/^p[a-z0-9]{8}$/.test(raw.id))fail(400,'invalid_decor','Bad prop id');
  if(typeof raw.x!=='number'||typeof raw.z!=='number'||!Number.isFinite(raw.x)||!Number.isFinite(raw.z))fail(400,'invalid_decor','Prop position must be a number');
  if(Math.abs(raw.x)>ROOM_W||Math.abs(raw.z)>ROOM_D)fail(400,'outside','That sits outside the room.');
  let rot=raw.rot===undefined?0:raw.rot;
  if(typeof rot!=='number'||!Number.isFinite(rot))fail(400,'invalid_decor','Rotation must be a number');
  rot=Math.max(0,Math.min(3,Math.round(rot)));
  // Floor pieces sit on the 0.25 m grid. A wall piece keeps the grid along the wall and sits flush
  // against it (that coordinate is not on the grid, so a second snap would push it through the wall).
  let x=snap(raw.x),z=snap(raw.z);
  if(spec.wall){const hung=snapWall(raw.x,raw.z,raw.kind);x=hung.x;z=hung.z;rot=hung.rot}
  const prop={id:raw.id,kind:raw.kind,x,z,rot};
  if(spec.color){if(!ART.includes(raw.color))fail(400,'invalid_decor','Color is not in the palette');prop.color=raw.color}
  else if(raw.color!=null)fail(400,'invalid_decor','That prop has no color');
  if(spec.text)prop.text=sanitizeSign(raw.text);
  else if(raw.text!=null&&raw.text!=='')fail(400,'invalid_decor','That prop has no sign');
  return prop;
}
export function cleanTheme(theme){
  if(theme==null||theme==='')return null;
  if(typeof theme==='string'){if(!PRESETS[theme])fail(400,'invalid_decor','Unknown theme');return {...PRESETS[theme],preset:theme}}
  if(typeof theme!=='object'||Array.isArray(theme))fail(400,'invalid_decor','Bad theme');
  for(const k of Object.keys(theme))if(!THEME_FIELDS.has(k))fail(400,'invalid_decor','Unknown theme field');
  const preset=typeof theme.preset==='string'&&PRESETS[theme.preset]?theme.preset:'';
  const base=preset?PRESETS[preset]:{};
  const floor=theme.floor??base.floor,wall=theme.wall??base.wall,material=theme.material??base.material;
  if(!FLOORS.includes(floor)||!WALLS.includes(wall)||!MATERIALS.includes(material))fail(400,'invalid_decor','Theme color or material is not in the palette');
  return {floor,wall,material,...(preset&&PRESETS[preset].floor===floor&&PRESETS[preset].wall===wall&&PRESETS[preset].material===material?{preset}:{})};
}
// input: {theme?, preset?, props:[]}. desks is how many live agents the room is holding.
// frame is the room anchor (classic, or a tighter world anchor).
export function cleanDecor(input,{desks=0,frame}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'invalid_decor','Decor must be an object');
  for(const k of Object.keys(input))if(!DECOR_FIELDS.has(k))fail(400,'invalid_decor','Unknown decor field');
  if(!Array.isArray(input.props))fail(400,'invalid_decor','Props must be a list');
  if(input.props.length>MAX_PROPS)fail(400,'too_many','A room holds up to 40 props');
  const theme=cleanTheme(input.theme??input.preset??null);
  const room=frameFromAnchor(frame);
  const zones=reservedZones(room,{desks});
  const props=[],ids=new Set();
  for(const raw of input.props){
    const prop=cleanProp(raw);
    if(ids.has(prop.id))fail(400,'invalid_decor','Duplicate prop');
    ids.add(prop.id);
    const issue=placementIssue(prop,room,zones);
    if(issue)fail(400,issue.code,issue.message);
    props.push(prop);
  }
  return {theme,props};
}
export function cleanLook(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'invalid_look','Look must be an object');
  if(input.reset===true){
    if(Object.keys(input).some(k=>k!=='reset'))fail(400,'invalid_look','Unknown look field');
    return null;
  }
  for(const k of Object.keys(input))if(!LOOK_FIELDS[k])fail(400,'invalid_look','Unknown look field');
  const out={};
  for(const [k,allow] of Object.entries(LOOK_FIELDS)){
    if(!allow.includes(input[k]))fail(400,'invalid_look','That '+k.replace(/[A-Z]/g,c=>' '+c.toLowerCase())+' is not in the palette');
    out[k]=input[k];
  }
  return out;
}
// What makeHuman (office-figures.js) wants from a saved look. Null keeps the deterministic default.
export function figureFromLook(look){
  if(!look)return null;
  return {skin:look.skin,hair:look.hair,shirt:look.top,pants:look.bottoms,style:look.hairStyle,top:look.topStyle,accessory:look.accessory};
}

const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
// Quarter-turns about Y. rot 0 faces +z (back wall), 1 faces +x, 2 faces -z, 3 faces -x.
// Three.js sends local +z to (sin θ, 0, cos θ) for θ = rot * π/2.
export function propYaw(rot){return ((rot%4+4)%4)*Math.PI/2}
export function propForward(rot){const y=propYaw(rot),axis=n=>{const r=round(n);return Object.is(r,-0)?0:r};return {x:axis(Math.sin(y)),z:axis(Math.cos(y))}}
// Hang a wall piece on the nearest wall, facing into the room. rot is quarter-turns about Y.
export function snapWall(x,z,kind,frame=classicFrame()){
  const spec=CATALOGUE[kind];if(!spec?.wall)return null;
  const hx=frame.width/2,hz=frame.depth/2,thin=spec.d/2,long=spec.w/2;
  const alongX=snap(clamp(x,-hx+long+0.05,hx-long-0.05));
  const alongZ=snap(clamp(z,-hz+long+0.05,hz-long-0.05));
  const walls=[
    {rot:0,x:alongX,z:round(-hz+thin)},
    {rot:2,x:alongX,z:round(hz-thin)},
    {rot:1,x:round(-hx+thin),z:alongZ},
    {rot:3,x:round(hx-thin),z:alongZ},
  ];
  let best=walls[0],score=Math.hypot(walls[0].x-x,walls[0].z-z);
  for(const w of walls.slice(1)){const s=Math.hypot(w.x-x,w.z-z);if(s<score){best=w;score=s}}
  return best;
}
export function snapFloor(x,z,rot=0){
  return {x:snap(x),z:snap(z),rot:Math.max(0,Math.min(3,Math.round(rot)||0))};
}
export function newPropId(){
  let s='';
  while(s.length<8)s+=Math.random().toString(36).slice(2);
  return 'p'+s.slice(0,8);
}
