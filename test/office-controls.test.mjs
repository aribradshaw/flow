import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cameraClearance, clampPitch, createOfficeCharacter, createOfficeInput, FIXED_STEP, officeBox, officeStick, RUN_SPEED, WALK_SPEED} from '../public/office-controls.js';

test('camera pitch clamps away from horizontal and vertical extremes', () => {
  assert.equal(clampPitch(0.6), 0.6);
  assert.ok(clampPitch(-20) > 0);
  assert.ok(clampPitch(20) < Math.PI / 2);
});

test('camera boom stops before the nearest wall and clears doorways and wall tops', () => {
  const wall = officeBox(0, 2, 0, 4, 0.2, 1.1);
  const near = officeBox(0, 1, 0, 4, 0.2, 1.1);
  const origin = {x:0, y:1, z:0}, end = {x:0, y:1, z:5};
  assert.ok(Math.abs(cameraClearance(origin, end, [wall, near]) - 0.144) < 1e-8);
  assert.equal(cameraClearance({...origin, x:3}, {...end, x:3}, [wall]), 1);
  assert.equal(cameraClearance({...origin, y:2}, {...end, y:2}, [wall]), 1);
});

test('camera casts against the wall orientation rather than a world-aligned bounding box', () => {
  const wall = officeBox(2, 0, Math.PI / 4, 4, 0.2, 1.1);
  assert.equal(cameraClearance({x:0,y:1,z:-1.1}, {x:1.1,y:1,z:-1.1}, [wall]), 1);
  assert.ok(cameraClearance({x:0,y:1,z:0}, {x:4,y:1,z:0}, [wall]) < 0.5);
});

const idle = {x:0,z:0,sprint:false,jumpHeld:false};

function step(character, frames = 1, input = {}, boxes = []) {
  for (let i = 0; i < frames; i++) character.advance(FIXED_STEP, {...idle, ...input}, boxes);
  return character.state;
}

test('walk and sprint accelerate, turn, and brake with an interpolated pose', () => {
  const player = createOfficeCharacter();
  assert.equal(player.advance(FIXED_STEP / 2, {...idle,x:1}, []).x, 0);
  const first = player.advance(FIXED_STEP, {...idle,x:1}, []);
  assert.ok(first.x > 0 && first.x < player.state.x);
  assert.ok(player.state.speed > 0 && player.state.speed < WALK_SPEED);
  assert.ok(player.state.heading > 0 && player.state.heading < Math.PI / 2);
  assert.ok(Math.abs(step(player, 80, {x:1}).speed - WALK_SPEED) < 0.001);
  assert.ok(Math.abs(step(player, 80, {x:1,sprint:true}).speed - RUN_SPEED) < 0.001);
  assert.ok(player.state.sprinting);
  assert.ok(step(player).speed > 0);
  assert.equal(step(player, 40).speed, 0);
});

test('walking off a desk allows a coyote jump without consuming the air jump', () => {
  const player = createOfficeCharacter();
  const desk = officeBox(0, 0, 0, 1.7, 0.8, 0.76);
  player.reset({x:0,y:0.76,z:0}, 0);
  for (let i = 0; i < 90 && player.state.grounded; i++) step(player, 1, {z:1}, [desk]);
  assert.equal(player.state.grounded, false);
  assert.ok(player.state.y > 0.7);
  step(player, 6, {z:1}, [desk]);
  player.jump();
  assert.ok(step(player, 1, {jumpHeld:true}, [desk]).vy > 7);
  assert.equal(player.state.flip, 0);
  step(player, 12, {jumpHeld:true}, [desk]);
  player.jump();
  assert.ok(step(player, 4, {jumpHeld:true}, [desk]).flip > 0);
});

test('an early release lowers the apex, and a buffered third press fires on landing', () => {
  const short = createOfficeCharacter(), full = createOfficeCharacter();
  short.jump();
  full.jump();
  let shortPeak = 0, fullPeak = 0;
  for (let i = 0; i < 120; i++) {
    shortPeak = Math.max(shortPeak, step(short, 1, {jumpHeld:i < 5}).y);
    fullPeak = Math.max(fullPeak, step(full, 1, {jumpHeld:true}).y);
  }
  assert.ok(fullPeak > 1.3 && shortPeak < fullPeak * 0.65);

  full.jump();
  step(full, 16, {jumpHeld:true});
  full.jump();
  step(full, 1, {jumpHeld:true});
  for (let i = 0; i < 160 && !(full.state.vy < 0 && full.state.y < 0.48); i++) step(full, 1, {jumpHeld:true});
  assert.ok(!full.state.grounded && full.state.y > 0);
  full.jump();
  assert.ok(step(full, 1, {jumpHeld:true}).vy < 0);
  assert.ok(step(full, 13, {jumpHeld:true}).vy > 0);
  assert.ok(full.state.squash > 0);
  assert.equal(full.state.grounded, false);
});

test('a circle slides along a rotated wall and can round a desk corner', () => {
  const player = createOfficeCharacter();
  const wall = officeBox(0, 0, Math.PI / 2, 8, 0.2, 1.1);
  player.reset({x:-1,y:0,z:-1}, 0);
  const atWall = step(player, 90, {x:1,z:1}, [wall]);
  assert.ok(atWall.x <= -0.419 && atWall.x >= -0.425);
  assert.ok(atWall.z > 1 && atWall.vz > 2);
  assert.ok(Math.abs(atWall.vx) < 1e-8);

  const desk = officeBox(0, 0, 0, 1.7, 0.8, 0.76);
  player.reset({x:-1.2,y:0,z:-1}, 0);
  const around = step(player, 100, {x:0.48,z:1}, [desk]);
  assert.ok(around.z > 1 && around.x > -1);
});

test('movement input applies radial deadzones and recognizes a held second tap', () => {
  assert.deepEqual(officeStick(0.1,0.1), [0,0]);
  assert.ok(Math.abs(Math.hypot(...officeStick(1,1))-1) < 1e-8);
  const keys = createOfficeInput(), jump = () => assert.fail('movement does not jump');
  keys.keyDown('ArrowUp',0,false,jump);
  keys.keyUp('ArrowUp');
  keys.keyDown('KeyW',180,false,jump);
  assert.ok(keys.sample(null,jump).sprint);
  keys.keyUp('KeyW');
  assert.equal(keys.sample(null,jump).sprint,false);
});
