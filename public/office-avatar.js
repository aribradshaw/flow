// People in the 3D office (docs/concepts/12-office.md): a stylized low-poly character built from a look
// (office-look-core.js). Every part is parametric: nothing is loaded, and the same look always builds the
// same person.
//
// One person is one skinned mesh with vertex colours and one shared material: one draw call. A second,
// lighter mesh on the same skeleton takes over beyond LOD_DISTANCE. The face is made of small shapes on
// their own bones, so eyes blink and expressions change by moving bones, never by rebuilding geometry.
//
//   const person=createAvatar(look,{dim})     -> THREE.Group, about 1.75 tall, facing +z, feet at y=0
//   person.userData.update(t,state)            once per frame (animateAvatar)
//   person.userData.setLook(look)              rebuild in place for a new look
//   person.userData.stats()                    {tris, lodTris, bones, height: the top of their head, hair or hat}
//   person.userData.dispose()
//   avatarStats(look)                          the same numbers without keeping a mesh (tests, the editor)
import * as THREE from './vendor/three/three.module.min.js';
import {cleanLook} from './office-look-core.js';

export const LOD_DISTANCE = 15;
export const TRI_BUDGET = 2500, LOD_TRI_BUDGET = 600;

// ---------- colour ----------
const _c = new THREE.Color();
const col = hex => { _c.set(hex); return [_c.r, _c.g, _c.b]; }; // linear, as vertex colours are
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (a, f) => [Math.min(1, a[0] * f), Math.min(1, a[1] * f), Math.min(1, a[2] * f)];
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const WHITE = col('#f6f3ec'), DARK = col('#22252b'), GOLD = col('#e2b53f'), NAVY = col('#1c2440'), INK = col('#15110f');
const TEETH = col('#fbf8f0'), TONGUE = col('#d9667a'), MOUTH_IN = col('#5a1f1d'), BLUSH = col('#ff5d73');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const spow = (v, e) => Math.sign(v) * Math.abs(v) ** e;
const noise = (a, b = 0) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };

// ---------- the mesh builder ----------
// Vertices carry a colour and up to two bones. grid() joins rows of vertices into a smooth surface; fan()
// and strip() lay flat shapes on a surface (a face on a head, a pocket on a chest).
function createBuilder() {
  const P = [], N = [], C = [], SI = [], SW = [], I = [];
  return {
    P, N, C, SI, SW, I,
    get count() { return P.length / 3; },
    get tris() { return I.length / 3; },
    v(x, y, z, c, b0, w = 1, b1 = 0) { P.push(x, y, z); N.push(0, 0, 0); C.push(c[0], c[1], c[2]); SI.push(b0, b1, 0, 0); SW.push(w, 1 - w, 0, 0); return P.length / 3 - 1; },
    vn(x, y, z, n, c, b0) { const i = this.v(x, y, z, c, b0); N[i * 3] = n[0]; N[i * 3 + 1] = n[1]; N[i * 3 + 2] = n[2]; return i; },
    // Smooth normals for the triangles from index i0 on, over the vertices from v0 on.
    normals(i0, v0) {
      for (let i = v0 * 3; i < N.length; i++) N[i] = 0;
      for (let i = i0; i < I.length; i += 3) {
        const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const k of [a, b, c]) { N[k] += nx; N[k + 1] += ny; N[k + 2] += nz; }
      }
      for (let i = v0 * 3; i < N.length; i += 3) { const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1; N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; }
    },
  };
}
// rows: bottom to top, each a list of {p:[x,y,z], c, b:[bone, weight, bone2]}, columns counter-clockwise seen
// from above. A row with .cut starts a new band (a colour edge, a hem): it is not joined to the row below.
function grid(B, rows, {wrap = true, poleT = null, poleB = null, flip = false} = {}) {
  const v0 = B.count, i0 = B.I.length, put = v => B.v(v.p[0], v.p[1], v.p[2], v.c, v.b[0], v.b[1] ?? 1, v.b[2] ?? 0);
  const ids = rows.map(r => r.map(put)), n = rows[0].length, cols = wrap ? n : n - 1;
  const tri = (a, b, c) => flip ? B.I.push(a, c, b) : B.I.push(a, b, c);
  for (let i = 0; i < ids.length - 1; i++) {
    if (rows[i + 1].cut) continue;
    const lo = ids[i], hi = ids[i + 1];
    for (let k = 0; k < cols; k++) { const k2 = (k + 1) % n; tri(lo[k], hi[k], lo[k2]); tri(lo[k2], hi[k], hi[k2]); }
  }
  if (poleT) { const c = put(poleT), top = ids.at(-1); for (let k = 0; k < cols; k++) tri(top[k], c, top[(k + 1) % n]); }
  if (poleB) { const c = put(poleB), bot = ids[0]; for (let k = 0; k < cols; k++) tri(bot[(k + 1) % n], c, bot[k]); }
  B.normals(i0, v0);
  // A colour edge on a smooth surface keeps one normal on both sides of the cut.
  for (let i = 1; i < ids.length; i++) if (rows[i].cut && !rows[i].hard) for (let k = 0; k < n; k++) {
    const a = ids[i][k] * 3, b = ids[i - 1][k] * 3, N = B.N;
    const x = N[a] + N[b], y = N[a + 1] + N[b + 1], z = N[a + 2] + N[b + 2], l = Math.hypot(x, y, z) || 1;
    N[a] = N[b] = x / l; N[a + 1] = N[b + 1] = y / l; N[a + 2] = N[b + 2] = z / l;
  }
}
// rings: bottom to top, each {y, rx, rz, x, z, c, b, e (squareness: 2 round, more is boxier), f(a) radius
// factor, cut}. capT / capB: how far the closing pole stands off the last ring (0 flat, null open).
// m: a Matrix4 for the finished part. arc: [from, to] for an open part.
function loft(B, rings, {sides = 8, e = 2, capT = null, capB = null, m = null, arc = null, flip = false, post = null} = {}) {
  const A0 = arc ? arc[0] : Math.PI / 2, span = arc ? arc[1] - arc[0] : Math.PI * 2, n = arc ? sides + 1 : sides, v = new THREE.Vector3();
  const place = p => { if (m) { v.set(p[0], p[1], p[2]).applyMatrix4(m); p = [v.x, v.y, v.z]; } if (post) post(p); return p; };
  const rows = rings.map(r => {
    const ex = 2 / (r.e || e), row = [];
    for (let k = 0; k < n; k++) {
      const a = A0 + k / sides * span, f = r.f ? r.f(a) : 1;
      row.push({p: place([(r.x || 0) + spow(Math.cos(a), ex) * r.rx * f, r.y, (r.z || 0) + spow(Math.sin(a), ex) * (r.rz ?? r.rx) * f]),
        c: typeof r.c === 'function' ? r.c(a) : r.c, b: r.w ? r.w(a) : r.b});
    }
    if (r.cut) row.cut = true; if (r.hard) row.hard = true;
    return row;
  });
  const pole = (r, d) => ({p: place([r.x || 0, r.y + d, r.z || 0]), c: typeof r.c === 'function' ? r.c(Math.PI / 2) : r.c, b: r.w ? r.w(Math.PI / 2) : r.b});
  grid(B, rows, {wrap: !arc, flip, poleT: capT === null ? null : pole(rings.at(-1), capT), poleB: capB === null ? null : pole(rings[0], -capB)});
}
function ball(B, [cx, cy, cz], [rx, ry, rz], c, b, {sides = 6, stacks = 4, m = null, e = 2} = {}) {
  const rings = [];
  for (let j = 1; j < stacks; j++) { const t = -Math.cos(Math.PI * j / stacks), s = Math.sqrt(1 - t * t); rings.push({x: cx, z: cz, y: cy + t * ry, rx: rx * s, rz: rz * s, c, b}); }
  const d = ry * (1 - Math.cos(Math.PI / stacks));
  loft(B, rings, {sides, e, m, capT: d, capB: d});
}
// Flat shapes on a surface S = {z(x,y), n(x,y), back}: points are [x, y] seen from the front.
const onSurface = (B, S, c, b, eps) => (x, y) => { const n = S.n(x, y); return B.vn(x, y, S.back ? -S.z(x, y) - eps : S.z(x, y) + eps, S.back ? [n[0], n[1], -n[2]] : n, c, b); };
function fan(B, S, pts, c, b, eps = 0.007) { // a convex outline, counter-clockwise
  const put = onSurface(B, S, c, b, eps), cx = pts.reduce((n, p) => n + p[0], 0) / pts.length, cy = pts.reduce((n, p) => n + p[1], 0) / pts.length;
  const c0 = put(cx, cy), ids = pts.map(p => put(p[0], p[1]));
  for (let i = 0; i < ids.length; i++) { const a = ids[i], d = ids[(i + 1) % ids.length]; if (S.back) B.I.push(c0, d, a); else B.I.push(c0, a, d); }
}
function strip(B, S, pairs, c, b, eps = 0.007) { // [[top],[bottom]] pairs, left to right
  const put = onSurface(B, S, c, b, eps), ids = pairs.map(([t, m]) => [put(t[0], t[1]), put(m[0], m[1])]);
  for (let i = 0; i < ids.length - 1; i++) {
    const [t0, b0] = ids[i], [t1, b1] = ids[i + 1];
    if (S.back) B.I.push(t0, b1, b0, t0, t1, b1); else B.I.push(t0, b0, b1, t0, b1, t1);
  }
}
const ell = (cx, cy, rx, ry, n, e = 2) => Array.from({length: n}, (_, i) => { const a = i / n * Math.PI * 2; return [cx + spow(Math.cos(a), 2 / e) * rx, cy + spow(Math.sin(a), 2 / e) * ry]; });
const plane = z => ({z: () => z, n: () => [0, 0, 1]});

// ---------- proportions ----------
// The head: a soft, slightly boxy egg around (0, HY, 0), a little narrower at the jaw.
const HY = 1.59, RX = 0.172, RY = 0.2, RZ = 0.176, HE = 2.3, HV = 2.5;
const headS = t => (1 - Math.min(1, Math.abs(t)) ** HV) ** (1 / HV);
const headRx = t => RX * headS(t) * (t < 0 ? 1 - 0.17 * (-t) ** 1.6 : 1);
const headRz = t => RZ * headS(t) * (t < 0 ? 1 - 0.07 * (-t) ** 1.6 : 1);
const headN = (x, y, z) => { const nx = x / (RX * RX), ny = (y - HY) / (RY * RY), nz = z / (RZ * RZ), l = Math.hypot(nx, ny, nz) || 1; return [nx / l, ny / l, nz / l]; };
// A point on the head at angle a (front is PI/2) and height t (-1 chin .. 1 crown), pushed out by off.
function headPoint(a, t, off = 0) {
  const x = spow(Math.cos(a), 2 / HE) * headRx(t), z = spow(Math.sin(a), 2 / HE) * headRz(t), y = HY + t * RY, n = headN(x, y, z);
  return [x + n[0] * off, y + n[1] * off, z + n[2] * off];
}
const headZ = (x, y) => { const t = (y - HY) / RY, rx = headRx(t); return headRz(t) * (1 - Math.min(1, Math.abs(x) / rx) ** HE) ** (1 / HE); };
const HEAD = {z: headZ, n: (x, y) => headN(x, y, headZ(x, y))};
const EX = 0.073, EY = HY - 0.014, MY = HY - 0.112, NY = HY - 0.064;

const BUILDS = {
  slim: {ch: 0.89, wa: 0.84, hip: 0.9, dp: 0.88, limb: 0.87},
  regular: {ch: 1, wa: 1, hip: 1, dp: 1, limb: 1},
  broad: {ch: 1.2, wa: 1.1, hip: 1.04, dp: 1.1, limb: 1.18},
  soft: {ch: 1.08, wa: 1.32, hip: 1.2, dp: 1.3, limb: 1.14},
};
const HEIGHTS = {short: 0.94, medium: 1, tall: 1.055};
// How much a top adds to the body under it, and where its sleeves and hem end.
const TOPS = {
  tee: {add: 0.007, sleeve: 1.165, hem: 0.93},
  tank: {add: 0.006, sleeve: null, hem: 0.93},
  buttonup: {add: 0.008, sleeve: 0.885, hem: 0.915},
  hoodie: {add: 0.018, sleeve: 0.885, hem: 0.9},
  sweater: {add: 0.016, sleeve: 0.885, hem: 0.905},
  blazer: {add: 0.015, sleeve: 0.885, hem: 0.845},
};
function dimsOf(look) {
  const d = BUILDS[look.build] || BUILDS.regular;
  // The body's half width and half depth at each height: [y, rx, rz].
  const body = [[0.805, 0.12 * d.hip, 0.08 * d.dp], [0.85, 0.172 * d.hip, 0.104 * d.dp], [0.9, 0.18 * d.hip, 0.122 * d.dp], [0.96, 0.17 * d.wa, 0.123 * d.dp],
    [1.03, 0.166 * d.wa, 0.122 * d.dp], [1.12, 0.174 * (d.wa + d.ch) / 2, 0.128 * d.dp], [1.22, 0.188 * d.ch, 0.134 * d.dp], [1.3, 0.182 * d.ch, 0.124 * d.dp],
    [1.345, 0.126 * d.ch, 0.092], [1.385, 0.064, 0.062]];
  const bodyAt = y => {
    if (y <= body[0][0]) return body[0];
    for (let i = 1; i < body.length; i++) if (y <= body[i][0]) { const a = body[i - 1], b = body[i], t = (y - a[0]) / (b[0] - a[0]); return [y, lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
    return body.at(-1);
  };
  return {...d, body, bodyAt, armX: 0.182 * d.ch + 0.018, legX: 0.094 * d.hip, scale: HEIGHTS[look.height] || 1, top: TOPS[look.top] || TOPS.tee};
}
const TE = 2.3; // the torso is a little boxier than the head
function torsoSurface(D, add) {
  const z = (x, y) => { const [, rx, rz] = D.bodyAt(y); return (rz + add) * (1 - Math.min(1, Math.abs(x) / (rx + add)) ** TE) ** (1 / TE); };
  return {z, n: (x, y) => { const [, rx, rz] = D.bodyAt(y), nx = x / (rx * rx), nz = z(x, y) / (rz * rz), l = Math.hypot(nx, nz) || 1; return [nx / l, 0, nz / l]; }};
}

const SHOULDER_Y = 1.295, ELBOW_Y = 1.045, HIP_Y = 0.86, KNEE_Y = 0.47, ANKLE_Y = 0.09;
// The parts are modelled on plain proportions; stylize() then gives everyone a larger head on a shorter
// body: legs and torso are shortened, and the head (with its face, hair and hat) grows about the neck.
const HEAD_SCALE = 1.2, LEG_K = 0.89, TORSO_K = 0.96, NECK_Y = 1.4;
const bodyY = y => y <= ANKLE_Y ? y : y <= 0.87 ? ANKLE_Y + (y - ANKLE_Y) * LEG_K : ANKLE_Y + (0.87 - ANKLE_Y) * LEG_K + (y - 0.87) * TORSO_K;
const stylize = (p, head) => head ? [p[0] * HEAD_SCALE, bodyY(NECK_Y) + (p[1] - NECK_Y) * HEAD_SCALE, p[2] * HEAD_SCALE] : [p[0], bodyY(p[1]), p[2]];

// ---------- the skeleton ----------
// [name, parent, x, y, z] in the bind pose (model space); x mirrors with the body's width.
const BONES = ['hips', 'spine', 'head', 'armL', 'foreL', 'armR', 'foreR', 'legL', 'shinL', 'footL', 'legR', 'shinR', 'footR',
  'eyeL', 'eyeR', 'browL', 'browR', 'mouth', 'mouthO', 'joy', 'blush', 'tail'];
const BI = Object.fromEntries(BONES.map((n, i) => [n, i]));
const PARENT = {spine: 'hips', head: 'spine', armL: 'spine', foreL: 'armL', armR: 'spine', foreR: 'armR', legL: 'hips', shinL: 'legL', footL: 'shinL',
  legR: 'hips', shinR: 'legR', footR: 'shinR', eyeL: 'head', eyeR: 'head', browL: 'head', browR: 'head', mouth: 'head', mouthO: 'head', joy: 'head', blush: 'head', tail: 'head'};
function bindPose(D) {
  const ez = headZ(EX, EY), ax = D.armX, lx = D.legX;
  const HEAD_BONES = new Set(['eyeL', 'eyeR', 'browL', 'browR', 'mouth', 'mouthO', 'joy', 'blush', 'tail']);
  return Object.fromEntries(Object.entries({
    hips: [0, 0.87, 0], spine: [0, 1.0, 0], head: [0, NECK_Y, 0],
    armL: [ax, SHOULDER_Y, 0], foreL: [ax, ELBOW_Y, 0], armR: [-ax, SHOULDER_Y, 0], foreR: [-ax, ELBOW_Y, 0],
    legL: [lx, HIP_Y, 0], shinL: [lx, KNEE_Y, 0], footL: [lx, ANKLE_Y, 0], legR: [-lx, HIP_Y, 0], shinR: [-lx, KNEE_Y, 0], footR: [-lx, ANKLE_Y, 0],
    eyeL: [EX, EY, ez], eyeR: [-EX, EY, ez], browL: [EX, EY + 0.054, headZ(EX, EY + 0.054)], browR: [-EX, EY + 0.054, headZ(EX, EY + 0.054)],
    mouth: [0, MY, headZ(0, MY)], mouthO: [0, MY, headZ(0, MY)], joy: [0, EY, headZ(0, EY)], blush: [0, EY - 0.06, headZ(0.09, EY - 0.06)],
    tail: [0, HY + 0.08, -0.16],
  }).map(([name, p]) => [name, stylize(p, HEAD_BONES.has(name))]));
}

// ---------- parts ----------
// trim: set while a look that came out over its triangle budget is rebuilt with fewer sides on the body,
// so the heaviest combinations of hair, hat and clothes still fit; the face keeps its detail.
let trim = false;
// Bands of colour up a tube: ys are the heights it needs, ringAt(y, c) one ring, colorAbove(y) the band that starts at y.
function banded(ys, ringAt, colorAbove) {
  const rings = [], list = [...new Set(ys.map(y => +y.toFixed(4)))].sort((a, b) => a - b);
  let prev = null;
  list.forEach((y, i) => {
    const c = i === list.length - 1 ? prev : colorAbove(y);
    if (prev && c !== prev) { rings.push(ringAt(y, prev)); rings.push({...ringAt(y, c), cut: true}); } else rings.push(ringAt(y, c));
    prev = c;
  });
  return rings;
}

function buildHead(B, L, K, lod) {
  const sides = lod ? 8 : 16, M = lod ? 5 : 10, skin = K.skin, rows = [];
  const beardTint = L.beard === 'stubble' ? mix(skin, mul(K.hair, 0.7), 0.34) : null;
  for (let j = 1; j < M; j++) {
    const t = -Math.cos(Math.PI * j / M), row = [];
    for (let k = 0; k < sides; k++) {
      const a = Math.PI / 2 + k / sides * Math.PI * 2;
      // A little darker under the chin; a stubble shadow over the jaw.
      let c = t < -0.55 ? mul(skin, 0.95) : skin;
      if (beardTint && t < -0.28 && Math.sin(a) > -0.15) c = mix(c, beardTint, smooth((-0.28 - t) * 4) * (Math.sin(a) > 0.2 || t < -0.5 ? 1 : 0.6));
      row.push({p: headPoint(a, t), c, b: [BI.head]});
    }
    rows.push(row);
  }
  grid(B, rows, {poleT: {p: [0, HY + RY, 0], c: skin, b: [BI.head]}, poleB: {p: [0, HY - RY, 0], c: mul(skin, 0.93), b: [BI.head]}});
  // The neck, bending between the body and the head.
  loft(B, [{y: 1.335, rx: 0.055, c: mul(skin, 0.9), b: [BI.spine]}, {y: 1.4, rx: 0.05, c: mul(skin, 0.92), b: [BI.head, 0.5, BI.spine]}, {y: 1.45, rx: 0.05, c: mul(skin, 0.92), b: [BI.head]}], {sides: lod ? 5 : 8});
  if (lod) return;
  for (const s of [1, -1]) ball(B, [s * (headRx(-0.12) - 0.002), HY - 0.03, -0.012], [0.02, 0.042, 0.03], mul(skin, 0.96), [BI.head], {sides: 6, stacks: 3});
}

function buildFace(B, L, K, lod) {
  const skin = K.skin, dark = lum(skin) < 0.09;
  const eyeInk = mix(col(L.eyeColor), INK, 0.7), lash = mix(mul(skin, 0.25), INK, 0.7);
  const eye = (s, bone) => {
    const cx = s * EX, cy = EY;
    if (lod) { fan(B, HEAD, ell(cx, cy, 0.026, 0.034, 4), eyeInk, bone, 0.012); return; }
    if (L.eyes === 'almond') {
      fan(B, HEAD, ell(cx, cy, 0.034, 0.0255, 10, 1.8), WHITE, bone, 0.006);
      fan(B, HEAD, ell(cx, cy - 0.0005, 0.0235, 0.0245, 10), mix(col(L.eyeColor), INK, 0.12), bone, 0.008);
      fan(B, HEAD, ell(cx, cy - 0.0005, 0.0135, 0.014, 8), INK, bone, 0.0095);
      // The upper lid.
      const lid = []; for (let i = 0; i <= 6; i++) { const a = Math.PI - i / 6 * Math.PI, x = cx + spow(Math.cos(a), 2 / 1.8) * 0.036, y = cy + spow(Math.sin(a), 2 / 1.8) * 0.0265; lid.push([[x, y + 0.006], [x, y - 0.004]]); }
      strip(B, HEAD, lid, lash, bone, 0.0105);
    } else if (L.eyes === 'sleepy') {
      const top = cy + 0.008;
      fan(B, HEAD, ell(cx, cy - 0.004, 0.025, 0.028, 10).map(p => [p[0], Math.min(p[1], top)]), eyeInk, bone, 0.007);
      strip(B, HEAD, [[[cx - 0.031, top + 0.004], [cx - 0.031, top - 0.002]], [[cx, top + 0.006], [cx, top - 0.001]], [[cx + 0.031, top + 0.004], [cx + 0.031, top - 0.002]]], lash, bone, 0.0095);
    } else {
      const round = L.eyes === 'round';
      fan(B, HEAD, ell(cx, cy, round ? 0.03 : 0.0245, round ? 0.03 : 0.036, 14), eyeInk, bone, 0.007);
    }
    // One highlight, on the same side of both eyes.
    fan(B, HEAD, ell(cx + 0.008, cy + (L.eyes === 'sleepy' ? -0.002 : 0.012), 0.0085, 0.0085, 7), WHITE, bone, 0.0115);
  };
  eye(1, BI.eyeL); eye(-1, BI.eyeR);
  if (lod) return;
  // Closed, smiling eyes for joy: hidden until an expression shows them.
  for (const s of [1, -1]) {
    const arc = []; for (let i = 0; i <= 6; i++) { const a = Math.PI * (0.86 - 0.72 * i / 6), cx = s * EX, cy = EY - 0.014; arc.push([[cx + Math.cos(a) * 0.031, cy + Math.sin(a) * 0.031], [cx + Math.cos(a) * 0.021, cy + Math.sin(a) * 0.021]]); }
    strip(B, HEAD, arc, eyeInk, BI.joy, 0.008);
  }
  // Eyebrows.
  const browC = L.hair === 'bald' && L.beard === 'none' ? mul(skin, dark ? 0.45 : 0.5) : mix(mul(K.hair, lum(K.hair) > 0.5 ? 0.52 : lum(K.hair) > 0.3 ? 0.66 : 0.85), INK, lum(K.hair) < 0.05 && dark ? 0.4 : 0.1);
  const BROW = {soft: [0.007, 0.0095, 0, 0.6], straight: [0, 0.009, -0.001, 0.85], arched: [0.015, 0.0075, 0.004, 0.55], thick: [0.005, 0.0145, 0, 0.8]}[L.brows];
  for (const s of [1, -1]) {
    const pts = [];
    for (let i = 0; i <= 4; i++) {
      const u = (s > 0 ? i : 4 - i) / 2 - 1, x = s * (EX + u * 0.03), y = EY + 0.054 + BROW[0] * (1 - u * u) + BROW[2] * u, th = BROW[1] * (u > 0 ? lerp(1, BROW[3], u) : 1) / 2;
      pts.push([[x, y + th], [x, y - th]]);
    }
    strip(B, HEAD, pts, browC, s > 0 ? BI.browL : BI.browR, 0.0075);
  }
  // The nose.
  const noseC = mix(mul(skin, 0.93), col('#c2543f'), 0.07), nz = headZ(0, NY);
  if (L.nose === 'wedge') {
    const a = [0, NY + 0.034, headZ(0, NY + 0.034) - 0.002], l = [-0.021, NY - 0.014, headZ(0.021, NY - 0.014)], r = [0.021, NY - 0.014, headZ(0.021, NY - 0.014)], tip = [0, NY - 0.012, nz + 0.03];
    const v0 = B.count, i0 = B.I.length, put = p => B.v(p[0], p[1], p[2], noseC, BI.head);
    for (const [p, q, w] of [[a, l, tip], [a, tip, r], [l, r, tip]]) B.I.push(put(p), put(q), put(w));
    B.normals(i0, v0);
  } else ball(B, [0, NY, nz + 0.004], L.nose === 'round' ? [0.029, 0.021, 0.021] : [0.019, 0.018, 0.019], noseC, [BI.head], {sides: 6, stacks: 3});
  // The mouth at rest, and an open laughing one that expressions swap in.
  const lip = mix(mul(skin, dark ? 0.42 : 0.36), col('#6e2420'), dark ? 0.25 : 0.5);
  const curve = (w, yOf, th, n = 6) => { const pts = []; for (let i = 0; i <= n; i++) { const u = i / n * 2 - 1, x = u * w, y = MY + yOf(u), h = th * (1 - 0.55 * u * u) / 2; pts.push([[x, y + h], [x, y - h]]); } return pts; };
  if (L.mouth === 'grin') {
    const pts = []; for (let i = 0; i <= 8; i++) { const a = Math.PI + i / 8 * Math.PI; pts.push([Math.cos(a) * 0.04, MY + 0.011 + Math.sin(a) * 0.03]); }
    fan(B, HEAD, pts, MOUTH_IN, BI.mouth, 0.007);
    strip(B, HEAD, [[[-0.034, MY + 0.011], [-0.03, MY]], [[0, MY + 0.011], [0, MY - 0.002]], [[0.034, MY + 0.011], [0.03, MY]]], TEETH, BI.mouth, 0.009);
  } else if (L.mouth === 'neutral') strip(B, HEAD, curve(0.028, () => 0, 0.0085, 4), lip, BI.mouth);
  else if (L.mouth === 'smirk') strip(B, HEAD, curve(0.034, u => 0.009 * u - 0.006 * (1 - u * u), 0.0085), lip, BI.mouth);
  else strip(B, HEAD, curve(0.041, u => -0.014 * (1 - u * u) + 0.005, 0.009), lip, BI.mouth);
  const open = []; for (let i = 0; i <= 8; i++) { const a = Math.PI + i / 8 * Math.PI; open.push([Math.cos(a) * 0.046, MY + 0.016 + Math.sin(a) * 0.044]); }
  fan(B, HEAD, open, MOUTH_IN, BI.mouthO, 0.007);
  strip(B, HEAD, [[[-0.04, MY + 0.016], [-0.035, MY + 0.003]], [[0, MY + 0.016], [0, MY + 0.001]], [[0.04, MY + 0.016], [0.035, MY + 0.003]]], TEETH, BI.mouthO, 0.009);
  fan(B, HEAD, ell(0, MY - 0.017, 0.022, 0.011, 6), TONGUE, BI.mouthO, 0.009);
  // Blush (always built: the heart emote shows it on anyone) and freckles.
  const blushC = mix(skin, BLUSH, dark ? 0.3 : 0.4);
  for (const s of [1, -1]) fan(B, HEAD, ell(s * 0.1, EY - 0.058, 0.03, 0.017, 8), blushC, BI.blush, 0.006);
  if (L.freckles) {
    const fc = mix(skin, col('#6f3f22'), dark ? 0.35 : 0.5);
    for (const s of [1, -1]) for (const [dx, dy] of [[0.085, -0.036], [0.107, -0.03], [0.096, -0.05]]) fan(B, HEAD, ell(s * dx, EY + dy, 0.0048, 0.0048, 4), fc, BI.head, 0.0075);
  }
  // Facial hair.
  const hairC = K.hair, mz = headZ(0, MY + 0.025);
  const stache = big => { for (const s of [1, -1]) ball(B, [0, 0, 0], big ? [0.033, 0.014, 0.015] : [0.026, 0.012, 0.013], mul(hairC, lum(hairC) > 0.3 ? 0.66 : 0.85), [BI.head], {sides: 5, stacks: 3, m: new THREE.Matrix4().makeRotationZ(s * -0.22).setPosition(s * (big ? 0.026 : 0.022), MY + 0.027, mz + 0.004)}); };
  if (L.beard === 'mustache') stache(true);
  if (L.beard === 'goatee' || L.beard === 'full') {
    stache(false);
    const full = L.beard === 'full', half = full ? 1.5 : 0.52, cols = full ? 8 : 4, R = 3, rows = [];
    for (let j = R; j >= 0; j--) {
      const u = j / R, row = [];
      for (let k = 0; k <= cols; k++) {
        const da = (k / cols * 2 - 1) * half, a = Math.PI / 2 + da, edge = Math.abs(da) / half;
        const tTop = full ? lerp(-0.64, -0.02, smooth(edge) ** 1.25) : -0.66, t = lerp(tTop, -0.985, u), off = 0.006 + (full ? 0.02 : 0.016) * Math.sin(Math.PI * Math.min(1, u * 0.9 + 0.12)) * (1 - 0.5 * edge);
        const p = headPoint(a, t, off); p[1] -= 0.03 * u * u * (1 - edge * edge); p[2] += 0.008 * u * (1 - edge);
        row.push({p, c: mul(hairC, 0.92 + 0.1 * (1 - u)), b: [BI.head]});
      }
      rows.push(row);
    }
    grid(B, rows, {wrap: false});
  }
  // Glasses: flat frames on a plane in front of the eyes, with arms back to the ears.
  if (L.glasses !== 'none') {
    const G = plane(headZ(EX, EY) + 0.02), shades = L.glasses === 'shades', sq = L.glasses !== 'round', frame = shades ? col('#111216') : DARK;
    const rx = sq ? 0.045 : 0.04, ry = sq ? 0.034 : 0.04, e = sq ? 4 : 2, n = 12;
    for (const s of [1, -1]) {
      const cx = s * EX, cy = EY - 0.002, outer = ell(cx, cy, rx, ry, n, e), inner = ell(cx, cy, rx - 0.0075, ry - 0.0075, n, e);
      if (shades) { fan(B, G, outer, frame, BI.head, 0); fan(B, G, [[cx - 0.02, cy + 0.018], [cx - 0.004, cy + 0.02], [cx - 0.022, cy + 0.006]].reverse(), col('#3a3f4b'), BI.head, 0.001); }
      else for (let i = 0; i < n; i++) { const j = (i + 1) % n, put = p => B.vn(p[0], p[1], G.z(), [0, 0, 1], frame, BI.head), a = put(outer[i]), b = put(inner[i]), c = put(inner[j]), d = put(outer[j]); B.I.push(a, c, b, a, d, c); }
      // The arm, seen from the side.
      const x0 = s * (EX + rx - 0.004), x1 = s * (headRx(-0.05) + 0.004), put = (x, y, z) => B.vn(x, y, z, [s, 0, 0], frame, BI.head);
      const a = put(x0, cy + 0.01, G.z()), b = put(x0, cy + 0.002, G.z()), c = put(x1, cy + 0.004, -0.02), d = put(x1, cy + 0.012, -0.02);
      if (s > 0) B.I.push(a, b, c, a, c, d); else B.I.push(a, c, b, a, d, c);
    }
    strip(B, G, [[[-EX + rx - 0.006, EY + 0.008], [-EX + rx - 0.006, EY + 0.001]], [[0, EY + 0.012], [0, EY + 0.005]], [[EX - rx + 0.006, EY + 0.008], [EX - rx + 0.006, EY + 0.001]]], frame, BI.head, 0);
  }
}

// Hair and hats are shells over the head: for each angle round the head, a path from the crown down to an
// edge (a hairline, a brim line), which may go on below the head as hanging hair.
const HAIR = {
  short: {vol: 0.024, crown: 0.012, tf: 0.5, ts: -0.02, tb: -0.5, tuft: [0.015, 0.13, 0.05, 0.08, -0.12]},
  buzz: {vol: 0.01, tf: 0.56, ts: 0.1, tb: -0.42, scalp: 0.3},
  sidepart: {vol: 0.027, crown: 0.01, tf: 0.48, ts: -0.06, tb: -0.52, sweep: 0.2, lean: 0.012, tuft: [0.05, 0.14, 0.05, 0.085, -0.3]},
  curly: {vol: 0.05, tf: 0.5, ts: -0.14, tb: -0.52, rows: 8, round: [0.218, 0.2, 0.218, 0.03, -0.012, 0.13, 1.2, 2.05]},
  afro: {vol: 0.105, tf: 0.47, ts: -0.12, tb: -0.5, rows: 9, round: [0.268, 0.252, 0.264, 0.045, -0.02, 0.085, 1.3, 2.25]},
  long: {vol: 0.026, tf: 0.5, ts: -0.1, tb: -0.1, sweep: 0.16, drape: {from: 0.38, side: 1.37, back: 1.2, flare: 0.05, curl: 0.12}, rows: 9},
  bob: {vol: 0.032, tf: 0.3, ts: -0.1, tb: -0.1, wave: 0.012, drape: {from: 0.5, side: 1.435, back: 1.42, flare: 0.04, curl: 0.4}, rows: 8},
  ponytail: {vol: 0.017, tf: 0.55, ts: 0.0, tb: -0.46, tail: true},
  bun: {vol: 0.017, tf: 0.55, ts: 0.0, tb: -0.46, bun: true},
  braids: {vol: 0.021, tf: 0.5, ts: -0.1, tb: -0.5, braids: true},
  mohawk: {vol: 0.01, tf: 0.56, ts: 0.12, tb: -0.4, scalp: 0.32, crest: true},
  bald: null,
};
// Where a hat's edge sits on the head, lower at the back.
const hatLine = (a, base) => base + 0.15 * Math.sin(a);
const HAT_LINE = {cap: 0.2, beanie: 0.12, bucket: 0.2, captain: 0.22};
function hairlineOf(S, a) {
  const f = Math.sin(a), sd = Math.cos(a);
  let t = f >= 0 ? lerp(S.ts, S.tf, smooth(f) ** 0.8) : lerp(S.ts, S.tb, smooth(-f));
  if (S.sweep) t -= S.sweep * sd * Math.max(0, f);
  if (S.wave) t += S.wave * Math.sin(a * 4) * Math.max(0, f);
  return t;
}
function buildHair(B, L, K, lod) {
  const S = HAIR[L.hair]; if (!S) return;
  const hat = HAT_LINE[L.hat] ?? null, A = lod ? 8 : 16, R = (lod ? (S.drape ? 4 : 3) : hat !== null ? (S.drape ? 7 : 5) : S.rows || 7) - (trim && !lod ? 1 : 0), hc = K.hair;
  const base = S.scalp ? mix(hc, K.skin, S.scalp) : hc, vol = Math.max(S.vol, lod ? 0.018 : 0);
  const rows = Array.from({length: R + 1}, () => []), cols = [];
  for (let k = 0; k < A; k++) {
    const a = Math.PI / 2 + k / A * Math.PI * 2, f = Math.sin(a), sd = Math.cos(a), tH = hairlineOf(S, a);
    const drape = S.drape && f < S.drape.from ? lerp(S.drape.side, S.drape.back, smooth(-f * 1.3)) : 0;
    const yH = HY + tH * RY, headLen = Math.acos(clamp(tH, -1, 1)) * 0.2, dLen = drape ? Math.max(0, yH - drape) : 0, uh = headLen / (headLen + dLen);
    const tint = 0.97 + 0.07 * noise(k, 3);
    const at = u => {
      let p, w = [BI.head], off;
      const under = t => hat !== null && t > hatLine(a, hat) - 0.04;
      if (S.round) {
        // A ball of hair round the head: the face looks out of its lower front.
        const [rx, ry, rz, cy, cz, lump, front, back] = S.round, phi = u * lerp(front, back, smooth(0.5 - f * 0.5));
        // Lumps: every other point of the ball stands out a little, so it catches the light in clumps.
        const j = Math.round(u * R), rr = (1 + lump * (((k + j) % 2 ? 0.5 : -0.5) + 0.5 * (noise(k * 1.3, j * 2.1) - 0.5))) * (hat !== null && Math.cos(phi) > 0.25 ? 0.72 : 1);
        p = [Math.sin(phi) * Math.cos(a) * rx * rr, HY + cy + Math.cos(phi) * ry * rr, cz + Math.sin(phi) * Math.sin(a) * rz * rr];
      } else if (u <= uh || !dLen) {
        const q = dLen ? u / uh : u, t = Math.cos(Math.acos(clamp(tH, -1, 1)) * q);
        off = vol * (dLen ? 1 : 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, q * 1.08)));
        off += (S.crown || 0) * (1 - q) + (S.lean || 0) * sd * (1 - q * 0.5) + (S.bump ? S.bump * (noise(k * 1.7, Math.round(q * R)) - 0.4) : 0);
        if (under(t)) off = 0.004;
        p = headPoint(a, t, Math.max(0.004, off));
      } else {
        // Hanging hair: straight down from where it leaves the head, flaring a little, curling in at the tips.
        const v = (u - uh) / (1 - uh), top = headPoint(a, tH, vol), r = 1 + S.drape.flare * Math.sin(v * Math.PI * 0.9) - S.drape.curl * smooth((v - 0.55) / 0.45) * 0.35;
        p = [top[0] * r, lerp(top[1], drape, v), top[2] * r - 0.02 * v * Math.max(0, -f)];
        // The lower part rests on the back and shoulders, so it follows the body more than the head.
        w = [BI.head, 1 - 0.75 * smooth(v), BI.spine];
      }
      return {p, c: mul(base, tint * (1.07 - 0.2 * u)), b: w};
    };
    for (let j = 1; j <= R; j++) rows[j].push(at(j / R));
    // The edge turns in, so hair has thickness where it ends.
    const end = at(1), n = headN(end.p[0], Math.max(end.p[1], HY - RY * 0.3), end.p[2]), tuck = dLen ? 0.022 : Math.max(0.004, vol - 0.004);
    cols.push({p: S.round ? headPoint(a, tH, 0.004) : [end.p[0] - n[0] * tuck, end.p[1] + (dLen ? 0.012 : 0), end.p[2] - n[2] * tuck], c: mul(base, 0.72), b: end.b});
  }
  const shell = [cols, ...rows.slice(1).reverse()];
  shell[1].cut = false;
  grid(B, shell, {poleT: {p: S.round ? [0, HY + S.round[3] + S.round[1] * (hat !== null ? 0.72 : 1), S.round[4]] : headPoint(Math.PI / 2, 1, hat !== null ? 0.004 : vol * 0.55 + (S.crown || 0)), c: mul(base, 1.07), b: [BI.head]}});
  if (hat !== null && !S.tail && !S.braids) return; // a hat covers whatever stands on top
  const q = lod ? {sides: 5, stacks: 3} : {sides: 6, stacks: 4};
  if (S.tuft && hat === null) {
    const [x, up, fwd, len, tilt] = S.tuft, m = new THREE.Matrix4().makeRotationZ(tilt).setPosition(x, HY + RY * 0.86, fwd);
    ball(B, [0, 0, 0], [up, 0.05, len], mul(hc, 1.06), [BI.head], {...q, sides: lod ? 5 : 8, m});
  }
  if (S.bun && hat === null) {
    ball(B, [0, HY + 0.165, -0.115], [0.078, 0.07, 0.078], mul(hc, 1.03), [BI.head], {...q, sides: lod ? 5 : 8});
    if (!lod) loft(B, [{y: HY + 0.118, z: -0.098, rx: 0.05, c: K.accent, b: [BI.head]}, {y: HY + 0.136, z: -0.104, rx: 0.052, c: K.accent, b: [BI.head]}], {sides: 8});
  }
  if (S.tail) {
    const b = [BI.tail];
    if (!lod) ball(B, [0, HY + 0.085, -0.19], [0.034, 0.032, 0.03], K.accent, b, {sides: 6, stacks: 3});
    ball(B, [0, HY + 0.045, -0.235], [0.05, 0.062, 0.05], mul(hc, 1.02), b, q);
    ball(B, [0, HY - 0.07, -0.262], [0.046, 0.085, 0.044], mul(hc, 0.95), b, q);
    if (!lod) ball(B, [0, HY - 0.175, -0.26], [0.03, 0.06, 0.03], mul(hc, 0.88), b, {sides: 6, stacks: 3});
  }
  if (S.braids) for (const s of [1, -1]) {
    const pts = [[0.158, 1.5, -0.035], [0.166, 1.425, 0.005], [0.158, 1.345, 0.065], [0.144, 1.265, 0.104]];
    if (lod) { ball(B, [s * 0.16, 1.38, 0.03], [0.034, 0.15, 0.05], hc, [BI.head, 0.5, BI.spine], {sides: 4, stacks: 3}); continue; }
    pts.forEach(([x, y, z], i) => {
      const r = 0.037 - i * 0.003, w = i < 1 ? [BI.head] : i === 1 ? [BI.head, 0.6, BI.spine] : [BI.spine];
      ball(B, [s * x, y, z], [r, 0.048, r], mul(hc, i % 2 ? 0.9 : 1.04), w, {sides: 5, stacks: 3});
    });
    ball(B, [s * 0.139, 1.205, 0.11], [0.022, 0.022, 0.022], K.accent, [BI.spine], {sides: 5, stacks: 3});
  }
  if (S.crest && hat === null) {
    // A fin along the middle of the head, from the forehead over the top to the nape.
    const N = lod ? 5 : 9, L0 = [], L1 = [], T = [];
    for (let i = 0; i <= N; i++) {
      const ph = lerp(-1.05, 2.05, i / N), y = Math.cos(ph), z = -Math.sin(ph), t = y, h = (0.085 + 0.022 * Math.sin(i * 2.4)) * Math.sin(Math.PI * (0.08 + 0.84 * i / N)) ** 0.6;
      const a = z >= 0 ? Math.PI / 2 : -Math.PI / 2, base = headPoint(a, clamp(t, -0.4, 1), -0.012), n = headN(base[0], base[1], base[2]);
      const c0 = mul(hc, 0.9), c1 = mul(hc, 1.1);
      L0.push({p: [0.03, base[1], base[2]], c: c0, b: [BI.head]}); L1.push({p: [-0.03, base[1], base[2]], c: c0, b: [BI.head]});
      T.push({p: [0, base[1] + n[1] * h, base[2] + n[2] * h], c: c1, b: [BI.head]});
    }
    grid(B, [L0, T, L1], {wrap: false, flip: true});
  }
}

function buildHat(B, L, K, lod) {
  if (L.hat === 'none') return;
  const A = lod ? 8 : 16, hc = K.hat, head = [BI.head], S = HAIR[L.hair];
  if (L.hat === 'headphones') {
    // A band over the top (clear of the hair) and a cup on each ear.
    const top = (S ? (S.round ? S.round[1] + S.round[3] - RY + 0.01 : Math.max(S.vol, 0.014) + (S.crown || 0) + (S.tuft ? 0.03 : 0) + (S.crest ? 0.09 : 0)) : 0) + 0.012, side = (S ? (S.round ? S.round[0] - RX : S.vol * 0.8) : 0) + 0.01;
    const N = lod ? 3 : 7, rows = [], rx = RX + side, ry = RY + top, cy = HY - 0.02, band = col('#2c2f36');
    for (let i = 0; i <= N; i++) {
      const ph = Math.PI * i / N, c = Math.cos(ph), s = Math.sin(ph), x = c * rx, y = cy + s * (ry + 0.02), ox = c * 0.012, oy = s * 0.012;
      rows.push([{p: [x + ox, y + oy, 0.012], c: band, b: head}, {p: [x + ox, y + oy, -0.03], c: band, b: head}, {p: [x, y, -0.03], c: band, b: head}, {p: [x, y, 0.012], c: band, b: head}]);
    }
    grid(B, rows, {flip: true});
    for (const s of [1, -1]) {
      ball(B, [s * (rx + 0.002), cy - 0.012, -0.01], [0.036, 0.064, 0.058], hc, head, {sides: lod ? 4 : 7, stacks: 3});
    }
    return;
  }
  const under = S && L.hair !== 'buzz' && L.hair !== 'mohawk' ? 0.008 : 0, line = HAT_LINE[L.hat];
  // A dome from the crown down to the hat's line; edge(k) is the ring it ends on.
  const dome = (vol, {lift = 0, flat = 0, R = lod ? 2 : trim ? 4 : 5, c = hc, cuff = 0} = {}) => {
    const rows = Array.from({length: R + 1}, () => []);
    for (let k = 0; k < A; k++) {
      const a = Math.PI / 2 + k / A * Math.PI * 2, tE = hatLine(a, line), panel = 1 + 0.035 * (k % 2 ? 1 : -1) * (L.hat === 'cap' && !lod ? 1 : 0);
      for (let j = 1; j <= R; j++) {
        const q = j / R, t = Math.cos(Math.acos(tE) * q), p = headPoint(a, t, vol + under + (cuff && q > 0.72 ? cuff : 0));
        p[1] += lift * (1 - q) ** 0.6 - flat * (1 - q) ** 2;
        rows[j].push({p, c: mul(c, panel * (cuff && q > 0.72 ? 0.86 : 1) * (1.04 - 0.1 * q)), b: head});
      }
    }
    const edge = rows[R].map(v => v.p);
    grid(B, rows.slice(1).reverse(), {poleT: {p: [0, HY + RY + vol + under + lift - flat, 0], c: mul(c, 1.04), b: head}});
    return edge;
  };
  // A brim from the dome's edge: out by len(a) and down by drop.
  const brim = (edge, len, drop, c, from = 0, to = A - 1, fwd = 0) => {
    const inner = [], outer = [];
    for (let k = from; k <= to; k++) {
      const i = (k % A + A) % A, a = Math.PI / 2 + i / A * Math.PI * 2, p = edge[i], l = len(a, k);
      let dx = Math.cos(a) * (1 - fwd), dz = Math.sin(a) * (1 - fwd) + fwd; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      inner.push({p: [p[0] - dx * 0.006, p[1] + 0.004, p[2] - dz * 0.006], c, b: head});
      outer.push({p: [p[0] + dx * l, p[1] - drop * l, p[2] + dz * l], c: mul(c, 0.92), b: head});
    }
    grid(B, [outer, inner], {wrap: to - from === A - 1});
  };
  if (L.hat === 'cap') {
    const edge = dome(0.02), w = lod ? 2 : 3;
    brim(edge, (a, k) => 0.12 * Math.cos((k / w) * Math.PI / 2 * 0.9) ** 0.6, 0.16, mul(hc, 0.82), -w, w, 0.7);
    if (!lod) ball(B, [0, HY + RY + 0.03 + under, 0], [0.016, 0.01, 0.016], mul(hc, 0.82), head, {sides: 6, stacks: 3});
  } else if (L.hat === 'beanie') {
    dome(0.026, {lift: 0.03, cuff: 0.014});
    ball(B, [0, HY + RY + 0.085 + under, -0.01], [0.042, 0.04, 0.042], mix(hc, WHITE, 0.55), head, {sides: lod ? 5 : 6, stacks: lod ? 3 : 4});
  } else if (L.hat === 'bucket') {
    const edge = dome(0.024, {flat: 0.022});
    brim(edge, () => 0.075, 0.62, mul(hc, 0.9));
  } else if (L.hat === 'captain') {
    // A dark band, a wide white top that rises at the front, a short peak and a gold badge.
    const rows = [[], [], [], []];
    for (let k = 0; k < A; k++) {
      const a = Math.PI / 2 + k / A * Math.PI * 2, f = Math.sin(a), tE = hatLine(a, line), lo = headPoint(a, tE, 0.02 + under), hi = headPoint(a, tE + 0.3, 0.03 + under);
      hi[1] = lo[1] + 0.058;
      // The top clears the crown of the head (and the hair under it) all the way round.
      const out = 1.2 + 0.05 * f, crown = [hi[0] * out, HY + RY - 0.012 + 0.03 * f, hi[2] * out + 0.012];
      rows[0].push({p: lo, c: NAVY, b: head}); rows[1].push({p: hi, c: NAVY, b: head});
      rows[2].push({p: hi, c: mul(hc, 0.9), b: head}); rows[3].push({p: crown, c: hc, b: head});
    }
    rows[2].cut = true; rows[2].hard = true;
    grid(B, rows, {poleT: {p: [0, HY + RY + 0.03 + under, 0.01], c: mul(hc, 1.03), b: head}});
    brim(rows[0].map(v => v.p), (a, k) => 0.075 * Math.cos((k / 3) * Math.PI / 2 * 0.9) ** 0.6, 0.42, INK, lod ? -2 : -3, lod ? 2 : 3, 0.7);
    if (!lod) {
      const z0 = Math.max(rows[0][0].p[2], rows[1][0].p[2]), y0 = (rows[0][0].p[1] + rows[1][0].p[1]) / 2;
      fan(B, plane(z0 + 0.006), ell(0, y0 + 0.01, 0.026, 0.03, 6), GOLD, BI.head, 0);
    }
  }
}

function buildTorso(B, L, K, D, lod) {
  const sides = lod ? (trim ? 5 : 6) : trim ? 9 : 12, T = D.top, add = T.add, top = K.top, acc = K.accent, hips = [BI.hips], spine = [BI.spine];
  const ring = (y, c, extra = 0, b = null) => { const [, rx, rz] = D.bodyAt(y); return {y, rx: rx + extra, rz: rz + extra, e: TE, c, b: b || (y < 0.9 ? hips : y < 1.02 ? [BI.spine, smooth((y - 0.9) / 0.12), BI.hips] : spine)}; };
  // The hips, in the colour of the bottoms.
  const pc = K.bottoms;
  loft(B, (lod ? [0.805, 0.9, 0.99] : [0.805, 0.85, 0.92, 0.995]).map(y => ring(y, y > 0.95 ? mul(pc, 0.9) : pc, 0.004, y < 0.97 ? hips : null)), {sides, e: TE, capB: 0.012, capT: 0});
  // The top, from its hem to the neck, with its pattern as bands.
  const stripe = L.pattern === 'stripes', block = L.pattern === 'block', band = L.pattern === 'band';
  const colorAbove = y => {
    if (y < T.hem + 0.03 && (L.top === 'hoodie' || L.top === 'sweater') && !lod) return K.rib;
    if (L.top === 'tank' && y >= 1.285) return K.skinBody;
    if (stripe && y >= 1.03 && y < 1.3) return lod ? (y >= 1.12 && y < 1.21 ? acc : top) : Math.floor((y - 1.03) / 0.09 + 1e-6) % 2 ? acc : top;
    if (block && y >= 1.2) return acc;
    if (band && y >= 1.13 && y < 1.215) return acc;
    return top;
  };
  const ys = [T.hem, ...(lod ? [1.22, 1.3, 1.385] : stripe ? [1.345, 1.385] : [1.0, 1.12, 1.22, 1.3, 1.345, 1.385]).filter(y => y > T.hem + 0.02)];
  if ((L.top === 'hoodie' || L.top === 'sweater') && !lod) ys.push(T.hem + 0.03);
  if (L.top === 'tank') ys.push(1.285);
  if (stripe) ys.push(...(lod ? [1.12, 1.21] : [1.03, 1.12, 1.21, 1.3]));
  if (block) ys.push(1.2);
  if (band) ys.push(1.13, 1.215);
  const rings = banded(ys, (y, c) => ring(y, c === K.skinBody ? c : y < T.hem + 0.05 ? mul(c, 0.93) : c, c === K.skinBody ? 0 : add + (y <= T.hem + 0.001 ? 0.006 : 0)), colorAbove);
  loft(B, rings, {sides, e: TE, capT: 0});
  if (lod) return;
  const S = torsoSurface(D, add), SB = {...S, back: true}, sp = BI.spine;
  if (L.top === 'tank') for (const s of [1, -1]) for (const surf of [S, SB]) strip(B, surf, [[[s * 0.085 - 0.02, 1.37], [s * 0.085 - 0.02, 1.283]], [[s * 0.085 + 0.02, 1.36], [s * 0.085 + 0.02, 1.283]]], top, sp, 0.004);
  if (L.top === 'buttonup') {
    const light = mul(top, 1.12), btn = mul(top, 0.45);
    strip(B, S, [[[-0.013, 1.345], [-0.013, T.hem + 0.01]], [[0.013, 1.345], [0.013, T.hem + 0.01]]], light, sp, 0.004);
    for (const y of [1.27, 1.19, 1.11, 1.03]) fan(B, S, ell(0, y, 0.0075, 0.0075, 4), btn, sp, 0.006);
    for (const s of [1, -1]) fan(B, S, s > 0 ? [[0.004, 1.375], [0.016, 1.3], [0.075, 1.352]] : [[-0.004, 1.375], [-0.075, 1.352], [-0.016, 1.3]], light, sp, 0.009);
  }
  if (L.top === 'blazer') {
    const shirt = acc, lapel = mul(top, 0.8);
    fan(B, S, [[0, 1.085], [0.05, 1.372], [-0.05, 1.372]], shirt, sp, 0.004);
    for (const s of [1, -1]) fan(B, S, s > 0 ? [[0.004, 1.085], [0.088, 1.33], [0.045, 1.374]] : [[-0.004, 1.085], [-0.045, 1.374], [-0.088, 1.33]], lapel, sp, 0.008);
    for (const y of [1.04, 0.975]) fan(B, S, ell(0.014, y, 0.0085, 0.0085, 5), mul(top, 0.45), sp, 0.006);
    for (const s of [1, -1]) fan(B, S, s > 0 ? [[0.004, 1.378], [0.012, 1.335], [0.05, 1.36]] : [[-0.004, 1.378], [-0.05, 1.36], [-0.012, 1.335]], mul(shirt, 1.1), sp, 0.011);
  }
  if (L.top === 'hoodie') {
    // The hood bunched behind the neck, the pocket and the drawstrings.
    ball(B, [0, 1.372, -0.085], [0.1, 0.05, 0.075], mul(top, 0.9), [BI.spine], {sides: 8, stacks: 4});
    strip(B, S, [-1, -0.6, -0.2, 0.2, 0.6, 1].map(u => [[u * 0.072, 1.1], [u * 0.098, 1.0]]), mul(top, 0.86), sp, 0.004);
    for (const s of [1, -1]) strip(B, S, [[[s * 0.036 - 0.005, 1.34], [s * 0.036 - 0.005, 1.225]], [[s * 0.036 + 0.005, 1.34], [s * 0.036 + 0.005, 1.225]]], K.cord, sp, 0.005);
  }
  if (L.top === 'sweater') loft(B, [{y: 1.36, rx: 0.07, rz: 0.066, c: K.rib, b: spine}, {y: 1.395, rx: 0.068, rz: 0.064, c: K.rib, b: spine}, {y: 1.415, rx: 0.058, rz: 0.055, c: mul(K.rib, 0.9), b: [BI.head, 0.4, BI.spine]}], {sides: 8});
  if (L.top === 'tee' || L.top === 'tank') loft(B, [{y: 1.368, rx: 0.066, rz: 0.062, c: mul(top, 0.84), b: spine}, {y: 1.39, rx: 0.06, rz: 0.057, c: mul(top, 0.84), b: spine}], {sides: 8});
  if (L.pattern === 'badge' && L.top !== 'blazer') { fan(B, S, ell(0.088, 1.215, 0.029, 0.029, 8), acc, sp, 0.005); fan(B, S, ell(0.088, 1.215, 0.013, 0.013, 5), mix(acc, WHITE, 0.6), sp, 0.007); }
  if (L.pattern === 'badge' && L.top === 'blazer') fan(B, S, [[0.07, 1.25], [0.115, 1.25], [0.11, 1.225], [0.075, 1.225]], mix(acc, WHITE, 0.4), sp, 0.006);
}

function buildArms(B, L, K, D, lod) {
  const sides = lod ? (trim ? 4 : 5) : trim ? 6 : 8, T = D.top, l = D.limb;
  const R = [[0.865, 0.046], [0.93, 0.05], [1.01, 0.054], [ELBOW_Y, 0.056], [1.08, 0.058], [1.16, 0.061], [1.25, 0.062], [1.3, 0.057], [1.335, 0.038]];
  const rAt = y => { for (let i = 1; i < R.length; i++) if (y <= R[i][0]) return lerp(R[i - 1][1], R[i][1], (y - R[i - 1][0]) / (R[i][0] - R[i - 1][0])); return R.at(-1)[1]; };
  const long = T.sleeve !== null && T.sleeve < 1, cuff = long && L.top !== 'blazer' ? K.rib : null;
  const colorAbove = y => {
    if (T.sleeve === null || y < T.sleeve) return K.skinBody;
    if (cuff && y < T.sleeve + 0.035) return cuff;
    if (L.pattern === 'block') return K.accent;
    if (L.pattern === 'stripes' && !lod && y >= 1.12 && y < 1.21) return K.accent;
    if (L.pattern === 'band' && y >= 1.13 && y < 1.215) return K.accent;
    return K.top;
  };
  for (const s of [1, -1]) {
    const x = s * D.armX, arm = s > 0 ? BI.armL : BI.armR, fore = s > 0 ? BI.foreL : BI.foreR;
    const ys = lod ? [0.865, ELBOW_Y, 1.25, 1.335] : [0.865, 1.0, ELBOW_Y, 1.09, 1.25, 1.3, 1.335];
    if (T.sleeve !== null) ys.push(T.sleeve);
    if (cuff && !lod) ys.push(T.sleeve + 0.035);
    if (!lod) { if (L.pattern === 'stripes' && T.sleeve !== null) ys.push(1.12, 1.21); if (L.pattern === 'band' && T.sleeve !== null) ys.push(1.13, 1.215); }
    const rings = banded(ys, (y, c) => {
      const skin = c === K.skinBody, r = rAt(y) * l + (skin ? 0 : T.add + (y <= (T.sleeve ?? 9) + 0.001 && !long ? 0.006 : 0));
      const w = Math.abs(y - ELBOW_Y) < 0.001 ? [arm, 0.5, fore] : y > ELBOW_Y ? [arm] : [fore];
      return {y, x, rx: r, c: skin ? c : y > 1.3 ? c : mul(c, 0.98), b: w};
    }, colorAbove);
    loft(B, rings, {sides, capT: 0.016});
    // A mitt of a hand, with a thumb.
    ball(B, [x, 0.795, 0.006], [0.038 * l, 0.072, 0.055 * l], K.skinBody, [fore], {sides: lod ? 4 : 7, stacks: lod ? 3 : 4});
    if (!lod) ball(B, [x - s * 0.006, 0.815, 0.052], [0.02, 0.034, 0.024], K.skinBody, [fore], {sides: 6, stacks: 3});
  }
}

function buildLegs(B, L, K, D, lod) {
  const sides = lod ? (trim ? 4 : 5) : trim ? 6 : 8, l = D.limb, pc = K.bottoms, skin = K.skinBody;
  const R = [[ANKLE_Y, 0.052], [0.16, 0.059], [0.3, 0.07], [0.42, 0.074], [KNEE_Y, 0.076], [0.52, 0.079], [0.66, 0.089], [0.8, 0.098], [0.87, 0.1]];
  const rAt = y => { for (let i = 1; i < R.length; i++) if (y <= R[i][0]) return lerp(R[i - 1][1], R[i][1], (y - R[i - 1][0]) / (R[i][0] - R[i - 1][0])); return R.at(-1)[1]; };
  // Where the trouser leg ends, how much it adds at the hip and at its end, and its cuff.
  const P = {jeans: {end: 0.1, add: [0.012, 0.016], cuff: 0.04, cuffC: mul(pc, 1.3)}, chinos: {end: 0.14, add: [0.01, 0.006]}, shorts: {end: 0.545, add: [0.014, 0.02]},
    skirt: {end: 0.82, add: [0.006, 0.006]}, joggers: {end: 0.15, add: [0.02, 0.006], cuff: 0.035, cuffC: mul(pc, 0.82)}}[L.bottoms];
  const colorAbove = y => y < P.end ? skin : P.cuff && y < P.end + P.cuff ? P.cuffC : pc;
  for (const s of [1, -1]) {
    const x = s * D.legX, leg = s > 0 ? BI.legL : BI.legR, shin = s > 0 ? BI.shinL : BI.shinR;
    const ys = lod ? [ANKLE_Y, KNEE_Y, 0.87] : [ANKLE_Y, 0.28, 0.42, KNEE_Y, 0.52, 0.68, 0.87];
    ys.push(P.end); if (P.cuff && !lod) ys.push(P.end + P.cuff);
    const rings = banded(ys.filter(y => y >= ANKLE_Y), (y, c) => {
      const bare = c === skin, u = clamp((0.87 - y) / (0.87 - P.end), 0, 1), r = rAt(y) * l + (bare ? 0 : lerp(P.add[0], P.add[1], u) + (c === P.cuffC && L.bottoms === 'jeans' ? 0.005 : 0));
      return {y, x, rx: r, c: bare ? c : mul(c, y > 0.8 ? 0.94 : 1), b: Math.abs(y - KNEE_Y) < 0.001 ? [leg, 0.5, shin] : y > KNEE_Y ? [leg] : [shin]};
    }, colorAbove);
    loft(B, rings, {sides, capT: 0});
  }
  if (L.bottoms === 'skirt') {
    // The skirt swings with the legs: each side follows its own leg more towards the hem.
    const n = lod ? 6 : trim ? 10 : 12, hem = 0.6, rows = (lod ? [[0.985, 1.0, 0], [0.8, 1.25, 0.4], [hem, 1.5, 0.62]] : [[0.985, 1.0, 0], [0.9, 1.1, 0.25], [0.76, 1.3, 0.5], [hem, 1.5, 0.62]]).reverse().map(([y, f, sw], i) => {
      const [, rx, rz] = D.bodyAt(Math.max(y, 0.9));
      return {y, rx: (rx + 0.01) * f, rz: (rz + 0.012) * f * 1.04, e: 2.3, c: i === 0 ? mul(pc, 0.88) : pc, w: a => [BI.hips, 1 - sw * Math.min(1, Math.abs(Math.cos(a)) * 1.6 + 0.25), Math.cos(a) > 0 ? BI.legL : BI.legR]};
    });
    loft(B, rows, {sides: n, e: 2.3});
  }
}

function buildShoes(B, L, K, D, lod) {
  const sc = K.shoes, low = L.shoes === 'loafers' || L.shoes === 'sandals';
  const soleC = L.shoes === 'sneakers' ? WHITE : L.shoes === 'sandals' ? mul(sc, 0.75) : mul(sc, 0.45), soleH = L.shoes === 'loafers' ? 0.016 : L.shoes === 'sandals' ? 0.02 : 0.028;
  const rot = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  for (const s of [1, -1]) {
    const x = s * D.legX, foot = [s > 0 ? BI.footL : BI.footR];
    // The upper: half tubes from heel to toe, [z, half width, height].
    const prof = lod ? [[-0.08, 0.046, 0.08], [0.0, 0.06, 0.092], [0.11, 0.058, 0.055], [0.178, 0.034, 0.034]]
      : low ? [[-0.084, 0.036, 0.054], [-0.05, 0.054, 0.07], [0.0, 0.058, 0.068], [0.068, 0.06, 0.055], [0.13, 0.056, 0.044], [0.178, 0.036, 0.032]]
        : [[-0.088, 0.04, 0.066], [-0.056, 0.056, 0.094], [0.0, 0.06, 0.1], [0.056, 0.062, 0.078], [0.122, 0.061, 0.062], [0.172, 0.047, 0.047]];
    const sandal = L.shoes === 'sandals', strapAt = z => z > -0.01 && z < 0.03 || z > 0.1 && z < 0.14;
    const rings = [];
    prof.forEach(([z, w, h], i) => {
      const base = soleH - 0.004, c = sandal ? (strapAt(z) ? sc : K.skinBody) : i === prof.length - 1 && L.shoes === 'sneakers' ? mix(sc, WHITE, 0.45) : sc;
      rings.push({y: z, x, z: -base, rx: w, rz: h - base, c, b: foot});
    });
    loft(B, rings, {sides: lod ? 3 : 5, arc: [Math.PI, Math.PI * 2], m: rot, capT: 0.02, capB: 0.012});
    if (lod) continue;
    // The sole: the foot's outline, a little wider than the upper.
    const outline = a => 1 - 0.2 * Math.max(0, -Math.sin(a));
    loft(B, [{y: 0, x, z: 0.045, rx: 0.067, rz: 0.142, f: outline, e: 2.4, c: mul(soleC, 0.9), b: foot}, {y: soleH, x, z: 0.045, rx: 0.067, rz: 0.142, f: outline, e: 2.4, c: soleC, b: foot}], {sides: 8, capB: 0});
    if (L.shoes === 'boots') loft(B, [{y: 0.085, x, z: -0.008, rx: 0.064, rz: 0.07, c: sc, b: foot}, {y: 0.2, x, z: -0.004, rx: 0.074, rz: 0.078, c: sc, b: [s > 0 ? BI.shinL : BI.shinR]}, {y: 0.3, x, rx: 0.08, rz: 0.082, c: mul(sc, 0.9), b: [s > 0 ? BI.shinL : BI.shinR]}], {sides: 8, capT: 0});
  }
}

// ---------- one person's geometry ----------
function buildGeometry(look, lod = false) {
  let out = buildOnce(look, lod);
  if (out.tris > (lod ? LOD_TRI_BUDGET : TRI_BUDGET)) { out.geometry.dispose(); trim = true; try { out = buildOnce(look, lod); } finally { trim = false; } }
  return out;
}
function buildOnce(look, lod) {
  const L = look, D = dimsOf(L), B = createBuilder(), skin = col(L.skin), top = col(L.topColor);
  const K = {skin, skinBody: mul(skin, 0.97), hair: col(L.hairColor), hat: col(L.hatColor), top, accent: col(L.accent), bottoms: col(L.bottomsColor), shoes: col(L.shoesColor),
    rib: mul(top, 0.84), cord: lum(top) > 0.5 ? mul(top, 0.6) : WHITE};
  buildLegs(B, L, K, D, lod); buildShoes(B, L, K, D, lod); buildTorso(B, L, K, D, lod); buildArms(B, L, K, D, lod);
  const body = B.count;
  buildHead(B, L, K, lod); buildFace(B, L, K, lod); buildHair(B, L, K, lod); buildHat(B, L, K, lod);
  for (let i = 0, P = B.P; i < P.length; i += 3) { const p = stylize([P[i], P[i + 1], P[i + 2]], i / 3 >= body); P[i] = p[0]; P[i + 1] = p[1]; P[i + 2] = p[2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(B.N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(B.C, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(B.SI, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(B.SW, 4));
  g.setIndex(B.I);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.4);
  let crown = 0; for (let i = 1; i < B.P.length; i += 3) if (B.P[i] > crown) crown = B.P[i];
  return {geometry: g, tris: B.tris, dims: D, top: crown * D.scale};
}
export function avatarStats(look) {
  const L = cleanLook(look), hi = buildGeometry(L, false), lo = buildGeometry(L, true), out = {tris: hi.tris, lodTris: lo.tris, bones: BONES.length};
  hi.geometry.dispose(); lo.geometry.dispose();
  return out;
}

// ---------- the material ----------
// One for everyone (and one for dimmed, offline people): Lambert like the rest of the office, plus a soft
// rim so a figure reads against the pale floor from any side.
const materials = new Map();
function materialOf(dim) {
  let m = materials.get(dim);
  if (!m) {
    m = new THREE.MeshLambertMaterial({vertexColors: true, side: THREE.DoubleSide, ...(dim ? {transparent: true, opacity: 0.45, forceSinglePass: true} : {})});
    m.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
        'float flowRim = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 2.4);\n\toutgoingLight *= mix(0.78, 1.0, smoothstep(-0.8, 0.15, normal.y));\n\toutgoingLight += (diffuseColor.rgb * 0.62 + vec3(0.07)) * flowRim * smoothstep(-0.3, 0.4, normal.y);\n\t#include <opaque_fragment>');
    };
    m.customProgramCacheKey = () => 'flow-avatar-rim-3';
    materials.set(dim, m);
  }
  return m;
}
export function disposeAvatars() { for (const m of materials.values()) m.dispose(); materials.clear(); live.clear(); farFrom = LOD_DISTANCE; }
// How far the full mesh is drawn, for everyone at once. The office brings it in when frames run long
// (a slow tablet), so a crowd falls back to the light meshes before it drops frames.
const live = new Set();
let farFrom = LOD_DISTANCE;
export const avatarLodDistance = () => farFrom;
export function setAvatarLodDistance(d) { farFrom = clamp(d, 0.5, LOD_DISTANCE); for (const lod of live) lod.levels[1].distance = farFrom; }
// frameSeconds: this frame's length. Call once per drawn frame; returns the distance in use.
const pace = {slow: 0, fast: 0, avg: 1 / 60};
export function paceAvatars(frameSeconds) {
  if (!(frameSeconds > 0) || frameSeconds > 0.25) return farFrom; // a hidden tab or a stall is not a slow device
  pace.avg += (frameSeconds - pace.avg) * 0.05;
  pace.slow = pace.avg > 0.024 ? pace.slow + 1 : 0; pace.fast = pace.avg < 0.0175 ? pace.fast + 1 : 0;
  if (pace.slow > 90 && farFrom > 4) { setAvatarLodDistance(farFrom > 9 ? 9 : 4); pace.slow = 0; }
  else if (pace.fast > 600 && farFrom < LOD_DISTANCE) { setAvatarLodDistance(farFrom < 9 ? 9 : LOD_DISTANCE); pace.fast = 0; }
  return farFrom;
}

// ---------- a person ----------
export function createAvatar(look, {dim = false, lodDistance = null} = {}) {
  const root = new THREE.Group(), rig = {b: null, bind: null, s: newState(), look: null};
  let parts = null;
  function build(next) {
    const L = cleanLook(next), hi = buildGeometry(L, false), lo = buildGeometry(L, true), D = hi.dims;
    const inner = new THREE.Group(), pose = bindPose(D), bones = {}, list = [];
    inner.scale.setScalar(D.scale);
    for (const name of BONES) {
      const bone = new THREE.Bone(), p = pose[name], q = PARENT[name] ? pose[PARENT[name]] : [0, 0, 0];
      bone.name = name; bone.position.set(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      (PARENT[name] ? bones[PARENT[name]] : inner).add(bone); bones[name] = bone; list.push(bone);
    }
    inner.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(list), bindMatrix = inner.matrixWorld.clone(), material = materialOf(dim);
    const mesh = g => { const m = new THREE.SkinnedMesh(g, material); m.bind(skeleton, bindMatrix); m.raycast = () => {}; m.boundingSphere = g.boundingSphere.clone(); m.frustumCulled = true; return m; };
    const lod = new THREE.LOD(), full = mesh(hi.geometry), light = mesh(lo.geometry);
    lod.addLevel(full, 0); lod.addLevel(light, lodDistance ?? farFrom, 0.08);
    inner.add(lod); root.add(inner);
    parts?.dispose();
    if (lodDistance === null) live.add(lod);
    parts = {inner, lod, full, light, skeleton, tris: hi.tris, lodTris: lo.tris, height: hi.top, dispose() { inner.removeFromParent(); live.delete(lod); hi.geometry.dispose(); lo.geometry.dispose(); skeleton.dispose(); }};
    Object.assign(rig, {b: bones, bind: Object.fromEntries(BONES.map(n => [n, bones[n].position.clone()])), look: L, scale: D.scale,
      // The first figures' rig, for anything that still reaches for these pivots.
      body: bones.hips, torso: bones.spine, head: bones.head, armL: bones.armL, armR: bones.armR, legL: bones.legL, legR: bones.legR});
    animateAvatar(rig, rig.s.t || 0, {snap: true});
  }
  build(look);
  Object.assign(root.userData, {
    rig,
    update: (t, st) => animateAvatar(rig, t, st),
    setLook: build,
    look: () => rig.look,
    stats: () => ({tris: parts.tris, lodTris: parts.lodTris, bones: BONES.length, height: parts.height}),
    // level: 0 full, 1 light, null by distance.
    forceLod(level) { parts.lod.autoUpdate = level === null; if (level !== null) { parts.full.visible = level === 0; parts.light.visible = level === 1; } },
    dispose() { parts?.dispose(); parts = null; },
  });
  return root;
}

// ---------- animation ----------
const EMOTE_MS = 1700, WALK = 5.2, RUN = 8.5;
let people = 0;
const newState = () => ({born: people++, t: 0, go: 0, run: 0, air: 0, ph: 0, seed: 0, blinkAt: 0, blink: 0, lookAt: 0, yaw: 0, pitch: 0, yawTo: 0, pitchTo: 0, shiftAt: 0, shift: 0, shiftTo: 0,
  joy: 0, open: 0, brow: 0, wink: 0, blush: 0, grin: 0, talk: 0, tail: 0, tailV: 0, fidgetAt: 0, fidget: '', fidgetT: 9});
// update(t, state) each frame. state (all optional):
//   speed (units/s; or moving:true for a walk)   a walk that blends into a run; 0 is idle, with fidgets
//   grounded, jumping                            the jump pose while off the ground
//   emote: {kind, at}                            wave, thumbs, clap or heart for a moment, with its expression
//   cycle                                        the stride phase in radians, when the mover tracks distance
//   phase                                        a per-person offset, so a crowd is not in step; a mover that
//                                                advances it as it walks (office-npc.js) is followed as the stride
//   expression: 'joy' | 'wink' | 'smile'         hold a face without an emote
//   gaze: {yaw, pitch}                           turn the head towards something (radians, relative)
//   talking: true                                the mouth moves, as while their speech bubble shows
//   snap: true                                   settle at once instead of easing (a still picture)
export function animateAvatar(rig, t, {moving = false, speed = moving ? WALK : 0, grounded = true, jumping = false, emote = null, phase = 0, cycle = NaN, expression = '', gaze = null, talking = false, snap = false} = {}) {
  const b = rig?.b; if (!b || !Number.isFinite(t)) return;
  if (!Number.isFinite(speed)) speed = 0;
  const s = rig.s, dt = clamp(t - s.t, 0, 0.1); s.t = t;
  if (!s.seed) { s.seed = 1 + (s.born * 37.713 + Math.abs(Math.sin(phase * 91.7 + 1.3)) * 100) % 1000; s.blinkAt = t + 1 + noise(s.seed) * 3; s.lookAt = t + 2 + noise(s.seed, 2) * 3; s.shiftAt = t + 3 + noise(s.seed, 3) * 5; }
  const ease = (k, rate) => snap ? 1 : 1 - Math.exp(-rate * dt * k);
  const go = speed > 0.15, air = jumping || !grounded;
  s.go += ((go ? 1 : 0) - s.go) * ease(1, 10); s.run += (clamp((speed - WALK) / (RUN - WALK), 0, 1) - s.run) * ease(1, 8); s.air += ((air ? 1 : 0) - s.air) * ease(1, 16);
  // The first figures added phase to a clock; movers came to advance it with distance. A phase that moves is the stride.
  if (!Number.isFinite(phase)) phase = 0;
  if (s.phaseWas !== undefined && phase !== s.phaseWas) s.driven = true;
  s.phaseWas = phase;
  const given = Number.isFinite(cycle) ? cycle : s.driven ? phase : NaN, own = s.driven ? s.born * 1.7 : phase;
  if (Number.isFinite(given)) s.ph = given; else s.ph += dt * speed * 2.2;
  const g = s.go * Math.min(1, 0.35 + speed / WALK * 0.65), r = s.run, idle = 1 - s.go, ph = s.ph + (Number.isFinite(given) ? 0 : own), sp = Math.sin(ph), cp = Math.cos(ph);
  phase = own;

  // --- idle: breathing, a weight shift now and then, looking around ---
  const br = Math.sin(t * 1.7 + phase);
  if (t > s.shiftAt) { s.shiftTo = s.shiftTo ? 0 : noise(s.seed, t) < 0.5 ? -1 : 1; s.shiftAt = t + 4 + noise(s.seed + 1, t) * 6; }
  if (t > s.lookAt) { const n = noise(s.seed + 2, t); s.yawTo = n < 0.4 ? 0 : (noise(s.seed + 3, t) - 0.5) * 1.0; s.pitchTo = (noise(s.seed + 4, t) - 0.5) * 0.14; s.lookAt = t + 1.6 + noise(s.seed + 5, t) * 4; }
  s.shift += (s.shiftTo * idle - s.shift) * ease(1, 2.2);
  const yawTo = gaze ? clamp(gaze.yaw || 0, -1.1, 1.1) : s.yawTo * idle, pitchTo = gaze ? clamp(gaze.pitch || 0, -0.5, 0.5) : s.pitchTo * idle;
  s.yaw += (yawTo - s.yaw) * ease(1, 3.2); s.pitch += (pitchTo - s.pitch) * ease(1, 3.2);
  const sh = s.shift;

  // --- walking and running ---
  const A = lerp(0.52, 0.9, r) * g, swingL = Math.max(0, cp), swingR = Math.max(0, -cp);
  const knee = lerp(0.95, 1.75, r) * g, lift = lerp(0.06, 0.32, r) * g;
  let legL = -A * sp - lift * swingL, legR = A * sp - lift * swingR;
  let shinL = knee * swingL ** 0.85 + 0.1 * g, shinR = knee * swingR ** 0.85 + 0.1 * g;
  let footL = 0.7 * (-legL - shinL) + g * (0.38 * Math.max(0, -sp) * (1 - swingL) - 0.26 * Math.max(0, sp)), footR = 0.7 * (-legR - shinR) + g * (0.38 * Math.max(0, sp) * (1 - swingR) - 0.26 * Math.max(0, -sp));
  const B_ = lerp(0.5, 0.95, r) * g;
  let armLx = B_ * sp + 0.03 * idle * Math.sin(t * 0.9 + phase), armRx = -B_ * sp - 0.03 * idle * Math.sin(t * 0.9 + phase + 1);
  let armLz = 0.13 + 0.05 * idle + 0.04 * r * g + 0.012 * br * idle, armRz = -armLz;
  let foreLx = -(lerp(0.22, 1.45, r) * g + 0.35 * g * Math.max(0, -sp) + 0.22 * idle), foreRx = -(lerp(0.22, 1.45, r) * g + 0.35 * g * Math.max(0, sp) + 0.22 * idle);
  let foreLz = 0, foreRz = 0, armLy = 0, armRy = 0;
  let hipY = lerp(0.02, 0.045, r) * g * Math.cos(2 * ph) + 0.004 * br * idle, hipX = 0.02 * sh;
  let hipRy = -0.13 * sp * g, hipRz = 0.035 * sp * g - 0.05 * sh;
  let spineX = 0.03 * g + 0.07 * r * g + 0.012 * br * idle, spineY = 0.26 * sp * g + 0.3 * s.yaw, spineZ = 0.06 * sh - 0.02 * sp * g;
  let headX = -0.5 * spineX + 0.03 * g * Math.cos(2 * ph + 0.6) + s.pitch, headY = -0.15 * sp * g + 0.7 * s.yaw, headZr = 0.03 * sh;
  let legLz = 0.025 * sh, legRz = 0.025 * sh;
  // Standing with the weight on one leg bends the other knee.
  if (sh > 0) { legR -= 0.14 * sh; shinR += 0.3 * sh; footR -= 0.12 * sh; } else { legL += 0.14 * sh; shinL -= 0.3 * sh; footL += 0.12 * sh; }

  // --- a fidget now and then: a glance at the wrist, a stretch of the shoulders, a rock on the heels ---
  if (!s.fidgetAt) s.fidgetAt = t + 6 + noise(s.seed, 8) * 10;
  if (t > s.fidgetAt && idle > 0.95 && !emote) { s.fidget = ['watch', 'roll', 'rock'][Math.floor(noise(s.seed + 9, t) * 3) % 3]; s.fidgetT = 0; s.fidgetAt = t + 9 + noise(s.seed + 10, t) * 14; }
  s.fidgetT += dt;
  const FID = {watch: 2.0, roll: 1.5, rock: 1.6}[s.fidget] || 0;
  if (s.fidgetT < FID && idle > 0.5) {
    const u = s.fidgetT / FID, e = smooth(u / 0.22) * smooth((1 - u) / 0.25) * idle;
    if (s.fidget === 'watch') { armLx = lerp(armLx, -0.5, e); armLz = lerp(armLz, -0.12, e); foreLx = lerp(foreLx, -1.5, e); foreLz = lerp(foreLz, -0.5, e); headX += 0.3 * e; headY += -0.22 * e; }
    else if (s.fidget === 'roll') { const w = Math.sin(u * Math.PI * 2); spineX -= 0.07 * e; armLz += 0.12 * e * (0.5 + 0.5 * w); armRz -= 0.12 * e * (0.5 + 0.5 * w); armLx += 0.25 * e * w; armRx += 0.25 * e * w; headX -= 0.12 * e; }
    else { const w = Math.sin(u * Math.PI * 3); hipY += 0.022 * e * Math.max(0, w); footL += 0.2 * e * Math.max(0, w); footR += 0.2 * e * Math.max(0, w); spineX += 0.03 * e * w; armLx -= 0.08 * e * w; armRx -= 0.08 * e * w; }
  }

  // --- in the air ---
  const j = s.air;
  if (j > 0.001) {
    const to = (v, w) => lerp(v, w, j);
    legL = to(legL, -0.95); shinL = to(shinL, 1.35); footL = to(footL, 0.45); legR = to(legR, -0.3); shinR = to(shinR, 0.95); footR = to(footR, 0.5);
    armLx = to(armLx, -0.2); armRx = to(armRx, -0.2); armLz = to(armLz, 2.3); armRz = to(armRz, -2.3); foreLx = to(foreLx, -0.35); foreRx = to(foreRx, -0.35);
    hipY = to(hipY, 0); spineX = to(spineX, -0.06); headX = to(headX, -0.1);
  }

  // --- emotes, each with its face ---
  let joy = expression === 'joy' ? 1 : 0, open = expression === 'joy' ? 1 : 0, wink = expression === 'wink' ? 1 : 0, brow = expression ? 0.6 : 0, grin = expression === 'smile' || expression === 'wink' ? 1 : 0, blush = 0;
  const et = emote ? (performance.now() - emote.at) / 1000 : 9;
  if (emote && et >= 0 && et * 1000 < EMOTE_MS) {
    const k = emote.kind, e = smooth(et / 0.16) * smooth((EMOTE_MS / 1000 - et) / 0.25), to = (v, w) => lerp(v, w, e);
    if (k === 'wave') {
      armRz = to(armRz, -1.9); armRx = to(armRx, -0.15); foreRx = to(foreRx, -0.1); foreRz = to(foreRz, -0.95 + 0.45 * Math.sin(et * 13));
      headZr = to(headZr, -0.1); spineZ = to(spineZ, -0.04); brow = e; grin = e;
    } else if (k === 'clap') {
      const c = 0.5 + 0.5 * Math.sin(et * 24);
      armLx = to(armLx, -0.95); armRx = to(armRx, -0.95); armLz = to(armLz, -0.08); armRz = to(armRz, 0.08);
      foreLx = to(foreLx, -0.85); foreRx = to(foreRx, -0.85); foreLz = to(foreLz, -(0.5 + 0.22 * c)); foreRz = to(foreRz, 0.5 + 0.22 * c);
      hipY += e * 0.012 * c; joy = e; open = e; brow = e;
    } else if (k === 'thumbs') {
      armRx = to(armRx, -0.7); armRz = to(armRz, -0.34); foreRx = to(foreRx, -1.42 - 0.1 * Math.sin(et * 9)); headZr = to(headZr, 0.08); spineY = to(spineY, 0.12);
      wink = e; grin = e; brow = e * 0.7;
    } else if (k === 'heart') {
      // Both hands on the heart, swaying.
      const sway = Math.sin(et * 5.5);
      armLx = to(armLx, -0.7); armRx = to(armRx, -0.7); armLz = to(armLz, -0.2); armRz = to(armRz, 0.2); foreLx = to(foreLx, -1.25); foreRx = to(foreRx, -1.25);
      foreLz = to(foreLz, -0.95); foreRz = to(foreRz, 0.95); hipY += e * Math.abs(sway) * 0.03; spineZ = to(spineZ, 0.07 * sway); headZr = to(headZr, 0.12 * sway);
      joy = e; open = e; blush = e; brow = e;
    }
  }

  // --- the face ---
  if (t > s.blinkAt) { s.blink = 0.22; s.blinkAt = t + (noise(s.seed + 6, t) < 0.16 ? 0.3 : 2.2 + noise(s.seed + 7, t) * 3.8); }
  s.blink = Math.max(0, s.blink - dt);
  const lid = s.blink > 0 ? 1 - Math.abs(s.blink - 0.11) / 0.11 : 0; // 0 open .. 1 shut
  for (const [key, v, rate] of [['joy', joy, 16], ['open', open, 16], ['wink', wink, 18], ['brow', brow, 10], ['grin', grin, 10], ['blush', Math.max(blush, rig.look?.blush ? 1 : 0), 6]]) s[key] += (v - s[key]) * ease(1, rate);
  const tiny = v => Math.max(0.001, v), eyes = tiny(1 - s.joy), glance = clamp(s.yaw - headY, -0.4, 0.4) * 0.012;
  b.eyeL.scale.set(eyes, eyes * tiny(1 - 0.92 * lid), eyes); b.eyeR.scale.set(eyes, eyes * tiny(1 - 0.92 * Math.max(lid, s.wink)), eyes);
  b.eyeL.position.x = rig.bind.eyeL.x + glance; b.eyeR.position.x = rig.bind.eyeR.x + glance;
  b.joy.scale.setScalar(tiny(s.joy));
  // Talking: the open mouth flaps, small and quick.
  s.talk += ((talking ? 1 : 0) - s.talk) * ease(1, 12);
  const say = s.talk * (1 - s.open), flap = 0.2 + 0.5 * Math.abs(Math.sin(t * 11.3 + s.seed)) * (0.55 + 0.45 * Math.sin(t * 3.9 + s.seed));
  const m = tiny((1 - s.open) * (1 - say)) * (1 + 0.28 * s.grin);
  b.mouth.scale.set(m, m, m); b.blush.scale.setScalar(tiny(s.blush));
  if (say > 0.01) b.mouthO.scale.set(tiny(0.62 * say), tiny(flap * say), tiny(say)); else b.mouthO.scale.setScalar(tiny(s.open));
  b.browL.position.y = rig.bind.browL.y + 0.014 * s.brow; b.browR.position.y = rig.bind.browR.y + 0.014 * s.brow - 0.006 * s.wink;

  // --- hair that swings: a spring that lags behind the body ---
  const tailTo = -0.3 * g * Math.cos(2 * ph + 0.9) * (1 + r) + 0.25 * j + 0.03 * Math.sin(t * 1.3 + phase) - 0.5 * (headX - s.pitch);
  s.tailV += ((tailTo - s.tail) * 60 - s.tailV * 9) * dt; s.tail += s.tailV * dt;
  b.tail.rotation.set(clamp(s.tail, -0.7, 0.9), 0, 0.5 * (spineZ + 0.1 * sp * g));

  // --- apply ---
  const bind = rig.bind;
  b.hips.position.set(bind.hips.x + hipX, bind.hips.y + hipY, bind.hips.z); b.hips.rotation.set(0, hipRy, hipRz);
  b.spine.rotation.set(spineX, spineY, spineZ);
  b.spine.scale.set(1, 1 + 0.012 * br * idle, 1 + 0.02 * br * idle);
  b.head.rotation.set(headX, headY, headZr);
  b.armL.rotation.set(armLx, armLy, armLz); b.armR.rotation.set(armRx, armRy, armRz);
  b.foreL.rotation.set(foreLx, 0, foreLz); b.foreR.rotation.set(foreRx, 0, foreRz);
  const toes = 0.13 * idle + 0.03;
  b.legL.rotation.set(legL, toes, legLz); b.legR.rotation.set(legR, -toes, legRz);
  b.shinL.rotation.x = shinL; b.shinR.rotation.x = shinR; b.footL.rotation.x = footL; b.footR.rotation.x = footR;
}
