import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classicLayout,toWorld,ROOM_W,ROOM_D,DOOR_W,BACK_WALL_H,MAIN_WALL_H} from '../public/office-layout.js';

const local=(frame,p)=>{const dx=p.x-frame.x,dz=p.z-frame.z,c=Math.cos(frame.facing),s=Math.sin(frame.facing);return {x:dx*c-dz*s,z:dx*s+dz*c}};
const keys=n=>Array.from({length:n},(_,i)=>'m'+i);

test('room boards hang flush on each back wall, inside the room and facing in, never across the door',()=>{
  for(const n of [1,2,5,12]){
    const world=classicLayout(keys(n)),{rooms,main}=world.boardAnchors();
    assert.deepEqual(rooms.map(r=>r.key),keys(n));
    for(const a of rooms){
      const room=world.rooms.find(r=>r.key===a.key),p=local(room,a);
      assert.ok(Math.abs(p.x)<1e-9,'centred on the back wall');
      assert.ok(p.z>-ROOM_D/2&&p.z<-ROOM_D/2+0.3,'just off the back wall, inside: '+p.z);
      assert.ok(Math.abs(a.nx-Math.sin(room.facing))<1e-9&&Math.abs(a.nz-Math.cos(room.facing))<1e-9,'faces into the room');
      assert.ok(a.width<ROOM_W-1&&a.y+a.height/2<BACK_WALL_H&&a.y-a.height/2>0.9,'fits its wall above the desks');
    }
    assert.ok(main.width>=6&&main.y+main.height/2<MAIN_WALL_H);
  }
});

test('the main board has its own slot in the ring, facing the middle, clear of every room and door',()=>{
  for(const n of [0,1,2,3,6,12,20]){
    const world=classicLayout(keys(n)),w=world.mainWall,{main}=world.boardAnchors();
    // it faces the middle of the common area
    const toMiddle=Math.hypot(w.x,w.z);
    assert.ok(Math.abs(main.nx+w.x/toMiddle)<1e-9&&Math.abs(main.nz+w.z/toMiddle)<1e-9);
    for(const room of world.rooms){
      // the wall's corners (with a 1.2 m path) stay outside every room's footprint, and its door
      for(const sx of [-1,1])for(const sz of [-1,1]){
        const corner=toWorld(w,sx*(w.width/2+1.2),sz*w.depth/2),p=local(room,corner);
        assert.ok(Math.abs(p.x)>ROOM_W/2||Math.abs(p.z)>ROOM_D/2+1,`n=${n}: the main wall stays out of a room`);
      }
      const door=toWorld(room,0,ROOM_D/2+DOOR_W);
      assert.ok(Math.hypot(door.x-w.x,door.z-w.z)>w.width/2+3,`n=${n}: no door opens onto the main wall`);
    }
    // a door to another office halfway to the next room (office-portals.js) has a path past the wall's end
    if(n){
      const a=Math.atan2(w.z,w.x),step=Math.PI*2/(n+1);
      for(const s of [-1,1]){
        const gap={x:Math.cos(a+s*step/2)*world.radius,z:Math.sin(a+s*step/2)*world.radius},p=local({...w},gap);
        assert.ok(Math.abs(p.x)-w.width/2>=1.1+1.7,`n=${n}: a door beside the main wall has room`);
      }
    }
  }
});

test('more rooms widen the ring rather than squeeze the rooms',()=>{
  const a=classicLayout(keys(4)),b=classicLayout(keys(16));
  assert.ok(b.radius>a.radius);
  const gap=(w,i,j)=>Math.hypot(w.rooms[i].x-w.rooms[j].x,w.rooms[i].z-w.rooms[j].z);
  assert.ok(gap(b,0,1)>=ROOM_W+2.9);
});
