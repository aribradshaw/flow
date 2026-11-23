// Camera and input for the 3D office. Angles follow Three.js: yaw zero puts the boom on +Z.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
export const clampPitch = pitch => clamp(pitch, 0.08, 1.22);

// Collision boxes are centered on their parent group's horizontal frame (rotation around Y).
export function officeBox(x, z, yaw, width, depth, height) {
  return {x, z, c: Math.cos(yaw), s: Math.sin(yaw), halfX: width / 2, halfZ: depth / 2, height, bound: Math.hypot(width, depth) / 2 + 0.32};
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
  let zoom = 6.4, overviewZoom = 1, distance = zoom, clearance = 1;
  let idle = 0, overview = false, auto = true;
  let panX = 0, panZ = 0, centerX = 0, centerZ = 0, leadX = 0, leadZ = 0;
  const pivot = {x: 0, y: 1.1, z: 0}, origin = {...pivot}, end = {...pivot};

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
      if (overview) overviewZoom = clamp(overviewZoom * factor, 0.45, 1.6);
      else zoom = clamp(zoom * factor, 2.9, 22);
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
      overviewZoom = 1;
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
      distance = damp(distance, overview ? radius * 1.12 * overviewZoom / viewScale : zoom, 9, dt);

      // Keep the pivot near the player during quick turns and only follow part of a jump.
      centerX = damp(centerX, overview ? 0 : position.x, 10, dt);
      centerZ = damp(centerZ, overview ? 0 : position.z, 10, dt);
      pivot.x = centerX + panX;
      pivot.y = damp(pivot.y, overview ? 0 : 1.1 + position.y * 0.38, 9, dt);
      pivot.z = centerZ + panZ;
      leadX = damp(leadX, overview ? 0 : vx * 0.19, 6, dt);
      leadZ = damp(leadZ, overview ? 0 : vz * 0.19, 6, dt);

      const horizontal = Math.cos(pitch) * distance, s = Math.sin(yaw), c = Math.cos(yaw);
      Object.assign(origin, pivot);
      // A lagging or panned pivot can overlap a wall. Start that boom above its top.
      for (const wall of walls) {
        if (origin.y > wall.height + 0.18) continue;
        const x = origin.x - wall.x, z = origin.z - wall.z;
        if (Math.abs(x * wall.c - z * wall.s) <= wall.halfX + 0.18 &&
            Math.abs(x * wall.s + z * wall.c) <= wall.halfZ + 0.18) origin.y = wall.height + 0.19;
      }
      end.x = origin.x + s * horizontal;
      end.y = origin.y + Math.sin(pitch) * distance;
      end.z = origin.z + c * horizontal;
      const safe = cameraClearance(origin, end, walls);
      clearance = Math.min(safe, damp(clearance, safe, 5, dt));
      camera.position.set(
        origin.x + (end.x - origin.x) * clearance,
        origin.y + (end.y - origin.y) * clearance,
        origin.z + (end.z - origin.z) * clearance,
      );
      const shoulder = overview ? 0 : clamp((7 - distance) * 0.13, 0, 0.48) * clearance;
      // Aim slightly forward even with a compressed boom so the viewing axis stays defined.
      camera.lookAt(pivot.x + leadX + c * shoulder - s * 0.2, pivot.y, pivot.z + leadZ - s * shoulder - c * 0.2);
    },
  };
}

export function bindOfficePointer(canvas, rig, {pick, hover, recenter, grab}) {
  let held=null;
  const pointers = new Map();
  let moved = false;
  const pair = () => {
    const [a, b] = pointers.values();
    return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, gap: Math.hypot(a.x - b.x, a.y - b.y)};
  };
  canvas.addEventListener('pointerdown', e => {
    if(held)return;
    if(!pointers.size&&e.button===0&&e.pointerType!=='touch'&&!e.altKey){
      const interaction=grab?.(e);
      if(interaction){
        held={id:e.pointerId,interaction};
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();return;
      }
    }
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
    if(held){if(held.id===e.pointerId)held.interaction.move(e);return}
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
    if(held?.id===e.pointerId){
      const {interaction}=held;held=null;interaction.end(e);return;
    }
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!p || moved || Math.hypot(e.clientX - p.x, e.clientY - p.y) >= 5) return;
    if (p.pick) pick(e);
    if (p.middle) recenter();
  });
  const cancelGrab=()=>{
    if(!held)return false;
    const {id,interaction}=held;held=null;interaction.cancel();
    if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);
    return true;
  };
  for (const event of ['pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(event, e => {
      pointers.delete(e.pointerId);
      if(held?.id===e.pointerId)cancelGrab();
    });
  }
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if(held)return;
    const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
    rig.zoomBy(Math.exp(e.deltaY * units * 0.0012));
  }, {passive:false});
  return {cancelGrab,get grabbing(){return !!held},get orbiting() { return [...pointers.values()].some(p => p.orbit); }};
}

export const WALK_SPEED = 5.2;
export const RUN_SPEED = 8.5;
export const FIXED_STEP = 1 / 120;
const BODY_RADIUS = 0.32, GRAVITY = 19, COYOTE_TIME = 0.11, JUMP_BUFFER = 0.14;
const SKIN = 0.0001, LIMIT = 110;
const INTERPOLATED_FIELDS = ['x', 'y', 'z', 'speed', 'squash'];

function supportBelow(state, boxes) {
  let floor = 0;
  for (const b of boxes) {
    if (b.height > state.y + SKIN || b.height <= floor) continue;
    const x = state.x - b.x, z = state.z - b.z;
    const dx = Math.max(0, Math.abs(x * b.c - z * b.s) - b.halfX);
    const dz = Math.max(0, Math.abs(x * b.s + z * b.c) - b.halfZ);
    if (dx * dx + dz * dz < BODY_RADIUS * BODY_RADIUS) floor = b.height;
  }
  return floor;
}

// Resolve a moving circle against the closest point of each oriented box. Push along
// the contact normal and remove only the inward component so tangential motion survives.
function slideAgainstOffice(state, boxes) {
  for (let pass = 0; pass < 3; pass++) {
    let hit = false;
    for (const b of boxes) {
      if (state.y >= b.height - SKIN) continue;
      const ox = state.x - b.x, oz = state.z - b.z;
      if (Math.abs(ox) > b.bound || Math.abs(oz) > b.bound) continue;
      const x = ox * b.c - oz * b.s, z = ox * b.s + oz * b.c;
      let nx = x - clamp(x, -b.halfX, b.halfX);
      let nz = z - clamp(z, -b.halfZ, b.halfZ);
      const squared = nx * nx + nz * nz;
      if (squared >= BODY_RADIUS * BODY_RADIUS) continue;
      let penetration;
      if (squared > 1e-12) {
        const length = Math.sqrt(squared);
        nx /= length;
        nz /= length;
        penetration = BODY_RADIUS - length;
      } else {
        // A desk can appear around a player when a live agent starts reporting.
        const edgeX = b.halfX - Math.abs(x), edgeZ = b.halfZ - Math.abs(z);
        nx = edgeX < edgeZ ? Math.sign(x) || 1 : 0;
        nz = nx ? 0 : Math.sign(z) || 1;
        penetration = BODY_RADIUS + Math.min(edgeX, edgeZ);
      }
      const wx = nx * b.c + nz * b.s, wz = -nx * b.s + nz * b.c;
      state.x += wx * (penetration + SKIN);
      state.z += wz * (penetration + SKIN);
      const inward = Math.min(0, state.vx * wx + state.vz * wz);
      state.vx -= inward * wx;
      state.vz -= inward * wz;
      hit = true;
    }
    if (!hit) break;
  }

  const radius = Math.hypot(state.x, state.z);
  if (radius > LIMIT) {
    const x = state.x / radius, z = state.z / radius;
    state.x = LIMIT * x;
    state.z = LIMIT * z;
    const outward = Math.max(0, state.vx * x + state.vz * z);
    state.vx -= outward * x;
    state.vz -= outward * z;
  }
}

export function createOfficeCharacter() {
  const state = {x:0,y:0,z:0,vx:0,vy:0,vz:0,heading:0,speed:0,grounded:true,jumping:false,sprinting:false,squash:0,flip:0};
  const before = {...state}, rendered = {...state};
  let time = 0, grace = COYOTE_TIME, buffer = 0, airJump = true, flipTime = 0;

  function step(dt, {x, z, sprint, jumpHeld}, boxes) {
    Object.assign(before, state);
    state.squash *= Math.exp(-13 * dt);
    buffer = Math.max(0, buffer - dt);
    grace = state.grounded ? COYOTE_TIME : Math.max(0, grace - dt);

    const jump = () => {
      const first = state.grounded || grace > 0;
      if (!buffer || (!first && !airJump)) return;
      state.vy = first ? 7.4 : 6.4;
      state.grounded = false;
      state.jumping = true;
      if (!first) {
        airJump = false;
        flipTime = 0.44;
      }
      buffer = grace = 0;
    };
    jump();
    if (!jumpHeld && state.vy > 0) state.vy *= Math.exp(-12 * dt);

    const magnitude = Math.hypot(x, z);
    if (magnitude > 0.001) {
      const facing = Math.atan2(x, z), turn = angleDelta(state.heading, facing);
      state.heading += turn * (1 - Math.exp(-(state.speed < 0.8 ? 20 : 13) * dt));
      const turnBlend = 1 - 0.35 * Math.abs(turn) / Math.PI;
      const targetSpeed = (sprint ? RUN_SPEED : WALK_SPEED) * Math.min(1, magnitude) * turnBlend;
      const dx = x / magnitude * targetSpeed - state.vx;
      const dz = z / magnitude * targetSpeed - state.vz;
      const acceleration = state.grounded ? 32 : 15;
      const blend = Math.min(1, acceleration * dt / Math.max(SKIN, Math.hypot(dx, dz)));
      state.vx += dx * blend;
      state.vz += dz * blend;
    } else {
      const speed = Math.hypot(state.vx, state.vz);
      const remainder = Math.max(0, 1 - (state.grounded ? 34 : 5) * dt / Math.max(SKIN, speed));
      state.vx *= remainder;
      state.vz *= remainder;
    }

    state.x += state.vx * dt;
    state.z += state.vz * dt;
    slideAgainstOffice(state, boxes);
    const floor = supportBelow(state, boxes);
    state.vy -= GRAVITY * dt;
    state.y += state.vy * dt;
    if (state.y <= floor && state.vy <= 0) {
      if (!state.grounded && state.vy < -1) state.squash = clamp(-state.vy * 0.019, 0.03, 0.19);
      state.y = floor;
      state.vy = 0;
      state.grounded = true;
      state.jumping = false;
      airJump = true;
      // A buffered press with both jumps spent can fire as soon as the feet land.
      jump();
    } else {
      state.grounded = false;
    }

    state.speed = Math.hypot(state.vx, state.vz);
    state.sprinting = sprint && state.speed > WALK_SPEED;
    if (flipTime > 0) {
      flipTime = Math.max(0, flipTime - dt);
      const progress = 1 - flipTime / 0.44;
      state.flip = Math.PI * 2 * (progress * progress * (3 - 2 * progress));
    } else {
      state.flip = 0;
    }
  }

  return {
    state,
    reset(position, heading) {
      Object.assign(state, {x:position.x,y:position.y,z:position.z,vx:0,vy:0,vz:0,heading,speed:0,
        grounded:true,jumping:false,sprinting:false,squash:0,flip:0});
      Object.assign(before, state);
      time = buffer = flipTime = 0;
      grace = COYOTE_TIME;
      airJump = true;
    },
    jump() { buffer = JUMP_BUFFER; },
    clearJump() { buffer = 0; },
    advance(dt, input, boxes) {
      time += clamp(dt, 0, 0.05);
      while (time >= FIXED_STEP) {
        step(FIXED_STEP, input, boxes);
        time -= FIXED_STEP;
      }
      const alpha = time / FIXED_STEP;
      Object.assign(rendered, state);
      for (const field of INTERPOLATED_FIELDS) {
        rendered[field] = before[field] + (state[field] - before[field]) * alpha;
      }
      rendered.heading = before.heading + angleDelta(before.heading, state.heading) * alpha;
      rendered.flip = before.flip + angleDelta(before.flip, state.flip) * alpha;
      return rendered;
    },
  };
}

const MOVE_KEYS = {
  KeyW:'forward', ArrowUp:'forward', KeyS:'back', ArrowDown:'back',
  KeyA:'left', ArrowLeft:'left', KeyD:'right', ArrowRight:'right',
};
const INPUT_KEYS = new Set([...Object.keys(MOVE_KEYS), 'ShiftLeft', 'ShiftRight', 'Space']);

export function officeStick(x, y, deadzone = 0.18) {
  const length = Math.hypot(x, y);
  if (length <= deadzone) return [0, 0];
  const scale = (Math.min(length, 1) - deadzone) / ((1 - deadzone) * length);
  return [x * scale, y * scale];
}

export function createOfficeInput() {
  const keys = new Set(), taps = new Map();
  let doubleTap = '', padJump = false;
  return {
    keyDown(code, now, repeat, jump) {
      if (!INPUT_KEYS.has(code)) return false;
      if (!repeat && !keys.has(code)) {
        const direction = MOVE_KEYS[code];
        if (direction) {
          if (now - (taps.get(direction) ?? -Infinity) < 270) doubleTap = code;
          taps.set(direction, now);
        }
        if (code === 'Space') jump();
      }
      keys.add(code);
      return true;
    },
    keyUp(code) {
      const had = keys.delete(code);
      if (code === doubleTap) doubleTap = '';
      return had;
    },
    clear() {
      keys.clear();
      taps.clear();
      doubleTap = '';
    },
    sample(gamepad, jump) {
      const right = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
      const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
      const axes = gamepad?.axes;
      const [padX, padY] = officeStick(axes?.[0] || 0, axes?.[1] || 0);
      const [orbitX, orbitY] = officeStick(axes?.[2] || 0, axes?.[3] || 0);
      const press = !!gamepad?.buttons[0]?.pressed;
      if (press && !padJump) jump();
      padJump = press;
      return {
        right: right || forward ? right : padX,
        forward: right || forward ? forward : -padY,
        orbitX, orbitY,
        jumpHeld: keys.has('Space') || press,
        sprint: !!(doubleTap || keys.has('ShiftLeft') || keys.has('ShiftRight') ||
          gamepad?.buttons[1]?.pressed),  // B / Circle (X / Square is interact: office-interact.js)
      };
    },
  };
}
