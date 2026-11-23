import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cameraClearance, clampPitch, officeBox} from '../public/office-controls.js';

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
