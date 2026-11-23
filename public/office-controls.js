// Camera and input for the 3D office. Angles follow Three.js: yaw zero puts the boom on +Z.
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
export const clampPitch = pitch => clamp(pitch, 0.08, 1.22);

// Collision boxes are centered on their parent group's horizontal frame (rotation around Y).
export function officeBox(x, z, yaw, width, depth, height) {
  return {x, z, c: Math.cos(yaw), s: Math.sin(yaw), halfX: width / 2, halfZ: depth / 2, height};
}

// Intersect the camera segment with each oriented wall via the slab test. Inflate walls
// to leave room for the near plane, including when the orbit grazes a wall corner.
export function cameraClearance(from, to, walls, padding = 0.18) {
  let fraction = 1;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  for (const {x, z, c, s, halfX, halfZ, height} of walls) {
    const ox = from.x - x, oz = from.z - z;
    const origins = [ox * c - oz * s, from.y - height / 2, ox * s + oz * c];
    const deltas = [dx * c - dz * s, dy, dx * s + dz * c];
    const extents = [halfX + padding, height / 2 + padding, halfZ + padding];
    let enter = 0, exit = fraction;
    for (let i = 0; i < 3 && enter <= exit; i++) {
      const o = origins[i], d = deltas[i], e = extents[i];
      if (Math.abs(d) < 1e-8) {
        if (Math.abs(o) > e) exit = -1;
      } else {
        const a = (-e - o) / d, b = (e - o) / d;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
      }
    }
    if (enter <= exit) fraction = enter;
  }
  return fraction;
}

export function createOfficeCamera(camera) {
  let yaw = 0, wantedYaw = 0, pitch = 0.4, wantedPitch = pitch;
  let zoom = 6.4, distance = zoom, clearance = 1;
  let idle = 0, overview = false, auto = true;
  let panX = 0, panZ = 0, centerX = 0, centerZ = 0, leadX = 0, leadZ = 0;
  const pivot = {x: 0, y: 1.1, z: 0}, end = {...pivot};

  function recenter(heading) {
    wantedYaw = heading + Math.PI;
    panX = panZ = 0;
    idle = 0;
  }

  return {
    get yaw() { return yaw; },
    get overview() { return overview; },
    reset(position, heading) {
      recenter(heading);
      yaw = wantedYaw;
      pivot.x = position.x;
      pivot.y = 1.1;
      pivot.z = position.z;
      centerX = position.x;
      centerZ = position.z;
    },
    rotate(y, p = 0) {
      wantedYaw += y;
      wantedPitch = clampPitch(wantedPitch + p);
      idle = 0;
    },
    recenter,
    zoomBy(factor) {
      zoom = clamp(zoom * factor, 2.9, 22);
      idle = 0;
    },
    pan(dx, dy, viewportHeight = 600) {
      const unitsPerPixel = 0.85 * distance / viewportHeight;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      panX = clamp(panX - unitsPerPixel * (dx * c + dy * s), -90, 90);
      panZ = clamp(panZ + unitsPerPixel * (dx * s - dy * c), -90, 90);
      idle = 0;
    },
    toggleOverview() {
      overview = !overview;
      panX = panZ = 0;
      idle = 0;
      return overview;
    },
    setAuto(value) { auto = value; },
    update(dt, position, heading, vx, vz, walls, radius, {held = false, align = true} = {}) {
      idle = held ? 0 : idle + dt;
      if (!overview && auto && align && idle > 1.25 && Math.hypot(vx, vz) > 0.4) {
        wantedYaw += angleDelta(wantedYaw, heading + Math.PI) * (1 - Math.exp(-2.4 * dt));
        panX = damp(panX, 0, 2.4, dt);
        panZ = damp(panZ, 0, 2.4, dt);
      }

      yaw += angleDelta(yaw, wantedYaw) * (1 - Math.exp(-16 * dt));
      pitch = damp(pitch, overview ? 1.54 : wantedPitch, 9, dt);
      const viewScale = Math.tan(camera.fov * Math.PI / 360) * Math.min(1, camera.aspect);
      distance = damp(distance, overview ? radius * 1.12 / viewScale : zoom, 9, dt);

      // Keep the pivot near the player during quick turns and only follow part of a jump.
      centerX = damp(centerX, overview ? 0 : position.x, 10, dt);
      centerZ = damp(centerZ, overview ? 0 : position.z, 10, dt);
      pivot.x = centerX + panX;
      pivot.y = damp(pivot.y, overview ? 0 : 1.1 + position.y * 0.38, 9, dt);
      pivot.z = centerZ + panZ;
      leadX = damp(leadX, overview ? 0 : vx * 0.19, 6, dt);
      leadZ = damp(leadZ, overview ? 0 : vz * 0.19, 6, dt);

      const horizontal = Math.cos(pitch) * distance, s = Math.sin(yaw), c = Math.cos(yaw);
      end.x = pivot.x + s * horizontal;
      end.y = pivot.y + Math.sin(pitch) * distance;
      end.z = pivot.z + c * horizontal;
      const safe = cameraClearance(pivot, end, walls);
      clearance = Math.min(safe, damp(clearance, safe, 5, dt));
      camera.position.set(
        pivot.x + (end.x - pivot.x) * clearance,
        pivot.y + (end.y - pivot.y) * clearance,
        pivot.z + (end.z - pivot.z) * clearance,
      );
      const shoulder = overview ? 0 : clamp((7 - distance) * 0.13, 0, 0.48) * clearance;
      // Aim slightly forward even with a compressed boom so the viewing axis stays defined.
      camera.lookAt(pivot.x + leadX + c * shoulder - s * 0.2, pivot.y, pivot.z + leadZ - s * shoulder - c * 0.2);
    },
  };
}

export function bindOfficePointer(canvas, rig, {pick, hover, recenter}) {
  const pointers = new Map();
  let moved = false;
  const pair = () => {
    const [a, b] = pointers.values();
    return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, gap: Math.hypot(a.x - b.x, a.y - b.y)};
  };
  canvas.addEventListener('pointerdown', e => {
    if (e.button > 2 || (pointers.size && e.pointerType !== 'touch') || pointers.size >= 2) return;
    if (!pointers.size) moved = false;
    else moved = true;
    const touch = e.pointerType === 'touch';
    const orbit = touch || e.button !== 0 || e.altKey;
    pointers.set(e.pointerId, {x:e.clientX, y:e.clientY, orbit, pick:e.button === 0 && (touch || !orbit), middle:e.button === 1});
    canvas.setPointerCapture(e.pointerId);
    if (orbit && !touch) e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) { if (e.pointerType === 'mouse') hover(e); return; }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    moved = true;
    const before = pointers.size === 2 ? pair() : null;
    p.x = e.clientX;
    p.y = e.clientY;
    if (before) {
      const after = pair();
      if (after.gap > 8 && before.gap > 8) rig.zoomBy(before.gap / after.gap);
      rig.pan(after.x - before.x, after.y - before.y, Math.max(1, canvas.clientHeight));
    } else if (p.orbit) rig.rotate(-dx * 0.007, dy * 0.006);
  });
  canvas.addEventListener('pointerup', e => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!p || moved || Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 5) return;
    if (p.pick) pick(e);
    if (p.middle) recenter();
  });
  for (const event of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(event, e => pointers.delete(e.pointerId));
  }
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
    rig.zoomBy(Math.exp(e.deltaY * units * 0.0012));
  }, {passive:false});
  return {get orbiting() { return [...pointers.values()].some(p => p.orbit); }};
}
