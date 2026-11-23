// Where things go in the classic 3D office (docs/concepts/12-office.md). Plain math, no Three.js, so node
// can test it; office.js draws what this lays out.
//
// Rooms stand in a ring round the common area, doors facing the middle. The ring has two slots more than
// there are rooms: the main board's feature wall takes the slot across from the owner's room, so it is a wall in
// the ring like the rooms are, never in front of a door or across a path; the glass meeting room
// (office-voice.js) takes the slot just before the owner's room.
//
// Meeting anchors. Every world answers meetingAnchors(): [{id, name, x, z, facing, w, d, glass}], the rooms whose
// call you join by walking in (office-voice-core.js), glass: office-voice.js draws its glass walls and table.
//
// Board anchors. Every world answers boardAnchors(): {rooms:[{key, ...mount}], main: mount}, where a mount
// is {x, y, z (the board's centre in world space), nx, nz (the unit normal it faces: into its room, or the
// common area), width, height (the most its wall takes)}. A mount sits just off its wall's face, so a board
// on it is flush and never stands in the walk path. Rooms are keyed by member key, in the order given.
// meterAnchors() is the same shape: a small screen inside each room's door wall (opposite the name sign,
// clear of the door) and one on the common-area face of the main board's wall. nx, nz is the way the
// screen faces. The room screen's turn matches meterAnchors() in office-meters-core.js.
// TODO(yacht world): yachtWorld() must answer boardAnchors() too: each cabin's inboard bulkhead for its
// room board, and the lounge's forward bulkhead (or the bridge's back wall) for the main board.
// TODO(yacht world): meetingAnchors() too (a lounge or the bridge, glass:false where the deck has its own walls);
// until then the yacht has proximity voice but no meeting room.
export const ROOM_W=12,ROOM_D=9,WALL_T=0.2,WALL_H=1.1,BACK_WALL_H=3.9,DOOR_W=3;
export const MAIN_WALL_H=5.2,MAIN_WALL_T=0.4;
export const ROOM_BOARD={width:9.2,height:2.6,y:2.42};
export const MEETING_W=9,MEETING_D=7;
// Same local pose as the fallback in office-meters-core.js: inside the front wall, at −x (the name
// sign is at +x), yawed so a +z-facing plane looks into the room and toward the door.
const ROOM_METER={width:1.62,height:0.9,y:2.15,x:-2.5,yaw:Math.PI-0.42};
const OFFICE_METER={width:1.98,height:1.1,y:2.08};
const OFF=0.07; // a board's face this far off its wall: the frame's depth
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));

// A point in a room-like group's own frame (x across, z towards the middle) to world space.
export function toWorld({x,z,facing},lx,lz){
  const c=Math.cos(facing),s=Math.sin(facing);
  return {x:x+lx*c+lz*s,z:z-lx*s+lz*c};
}

export function classicLayout(keys,{commonR=10}={}){
  const n=keys.length,slots=n+2;
  const R=Math.max(17,commonR+ROOM_D/2+5,slots*(ROOM_W+3)/(2*Math.PI)+6);
  const mainSlot=Math.floor(slots/2),meetSlot=mainSlot===slots-1?0:slots-1,step=Math.PI*2/slots;
  const at=i=>{const a=-Math.PI/2+i*step,x=Math.cos(a)*R,z=Math.sin(a)*R;return {x,z,facing:Math.atan2(-x,-z)}};
  const rooms=[];
  for(let i=0,k=0;i<slots;i++)if(i!==mainSlot&&i!==meetSlot)rooms.push({key:keys[k++],...at(i)});
  // Its front lines up with the rooms' fronts.
  const meetAt=at(meetSlot),meeting={id:'meeting',name:'Meeting room',...meetAt,...toWorld(meetAt,0,(ROOM_D-MEETING_D)/2),w:MEETING_W,d:MEETING_D,glass:true};
  // The feature wall stands in its slot a little behind the rooms' fronts. Either side of it, halfway to
  // the next room, is where a door to another office can stand (office-portals.js): the wall ends a door's
  // half width and a 1.8 m path short of that.
  const slot=at(mainSlot),depth=R-1.5;
  const half=slots>1?R*Math.sin(step/2):20;
  const wallW=clamp(2*(half-1.1-1.8),8,15.5);
  const mainWall={...slot,...toWorld(slot,0,R-depth),width:wallW,depth:MAIN_WALL_T,height:MAIN_WALL_H};
  const mainBoard={width:Math.min(14,wallW-1.4),height:3.9,y:2.5};
  function mount(room,lx,lz,size){
    const p=toWorld(room,lx,lz);
    return {x:p.x,y:size.y,z:p.z,nx:Math.sin(room.facing),nz:Math.cos(room.facing),width:size.width,height:size.height};
  }
  return {
    radius:R,rooms,mainWall,
    meetingAnchors:()=>[{...meeting}],
    boardAnchors:()=>({
      rooms:rooms.map(r=>({key:r.key,...mount(r,0,-ROOM_D/2+WALL_T/2+OFF,ROOM_BOARD)})),
      main:mount(mainWall,0,MAIN_WALL_T/2+OFF,mainBoard),
    }),
    meterAnchors:()=>({
      rooms:rooms.map(r=>({key:r.key,...roomMeterMount(r)})),
      main:officeMeterMount(mainWall,mainBoard.width),
    }),
  };
}

// A room meter's mount. Local +z is out the door, so the screen sits just inside that wall.
// Its normal is the fallback yaw, added to the room's facing: into the room and toward the door.
export function roomMeterMount(room){
  const lz=ROOM_D/2-0.55,ry=(room.facing||0)+ROOM_METER.yaw,p=toWorld(room,ROOM_METER.x,lz);
  return {x:p.x,y:(room.y||0)+ROOM_METER.y,z:p.z,nx:Math.sin(ry),nz:Math.cos(ry),width:ROOM_METER.width,height:ROOM_METER.height};
}
// The office meter, on the common-area face of the main wall, as far toward +x as the wall allows
// so it stays off the portal gaps beside the wall. It faces the same way as the main board.
export function officeMeterMount(mainWall,boardWidth){
  const w=OFFICE_METER.width,half=mainWall.width/2;
  const want=(boardWidth||Math.min(14,mainWall.width-1.4))/2+0.25+w/2;
  const lx=Math.min(want,half-w/2-0.08);
  const p=toWorld(mainWall,lx,MAIN_WALL_T/2+OFF+0.04);
  const facing=mainWall.facing||0;
  return {x:p.x,y:(mainWall.y||0)+OFFICE_METER.y,z:p.z,nx:Math.sin(facing),nz:Math.cos(facing),width:w,height:OFFICE_METER.height};
}
