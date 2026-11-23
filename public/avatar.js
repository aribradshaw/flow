// Drawing an avatar (docs/concepts/13-avatars.md). One module for both pictures of a person, from the same
// spec (avatar-spec.js) and the same derived look (lookFromSpec: the office's option ids and clamped colours):
//
//   renderAvatar3D(THREE, spec, {lod, dim, seed})  -> THREE.Group: the office's skinned, animated person
//                                                     (office-avatar.js builds it)
//   renderAvatarPortrait(spec, {size, as, seed})    -> a head-and-shoulders picture: a data: URL (as:'url',
//                                                     the default) or SVG markup (as:'svg')
//   portraitKey(spec)                               -> the portrait cache key: the renderer version plus the
//                                                     spec's hash, stable across sessions and machines
//
// The portrait is SVG drawn from the spec, not an offscreen Three.js render: it needs no WebGL context, so
// the DevOps board, chat and the account menu never load Three.js, and the server draws the very same
// picture (lib/avatars.mjs) for the places that already carry a photo URL. It is a few KB, sharp at any
// size, and the same spec always gives the same bytes. Portraits are cached per portraitKey.
//
// This module imports nothing that touches the DOM or Three.js. The 3D builder needs Three.js, so it
// registers itself (registerAvatar3D, called by office-avatar.js for the copy of Three.js it was built
// with); renderAvatar3D uses the builder registered for the THREE it is given.
import {lookFromSpec, readAvatar, avatarHash} from './avatar-spec.js';

export const PORTRAIT_VERSION = 1;

// ---------- 3D ----------
const builders = new Map();
export function registerAvatar3D(THREE, build) { if (THREE && typeof build === 'function') builders.set(THREE, build); }
// lod: 'auto' (the light mesh from a distance, as in the office), 'full' or 'light' (always that mesh).
export function renderAvatar3D(THREE, spec, {lod = 'auto', dim = false, seed = ''} = {}) {
  const build = builders.get(THREE);
  if (!build) throw Error('No 3D avatar builder is registered for this Three.js: import office-avatar.js first');
  const person = build(lookFromSpec(readAvatar(spec, seed), seed), {dim});
  if (lod === 'full' || lod === 'light') person.userData.forceLod?.(lod === 'full' ? 0 : 1);
  return person;
}

// ---------- colour ----------
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const hex = c => '#' + c.map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
const shade = (h, f) => hex(rgb(h).map(n => n * f));
const mixc = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((n, i) => n + (y[i] - n) * t)); };
const lum = h => { const [r, g, b] = rgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const INK = '#22252b', WHITE = '#f6f3ec', MOUTH_IN = '#5a1f1d', TEETH = '#fbf8f0', BLUSH = '#ff5d73', GOLD = '#e2b53f', LIP = '#8a3b33';

// ---------- the portrait ----------
// A 100 x 100 picture that reads inside a circle: the head centred, shoulders along the bottom.
const CX = 50, CY = 46, RX = 24, RY = 26;
const f1 = n => Math.round(n * 10) / 10;
const P = (strings, ...vals) => strings.reduce((s, x, i) => s + x + (i < vals.length ? (typeof vals[i] === 'number' ? f1(vals[i]) : vals[i]) : ''), '');
const el = (tag, attrs) => '<' + tag + Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => ` ${k}="${typeof v === 'number' ? f1(v) : v}"`).join('') + '/>';
const path = (d, fill, extra = {}) => el('path', {d, fill, ...extra});
const line = (d, stroke, w, extra = {}) => el('path', {d, fill: 'none', stroke, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...extra});

const SHOULDERS = {slim: [19, 81], regular: [15, 85], broad: [10, 90], soft: [12, 88]};

function background(L) { return el('rect', {width: 100, height: 100, fill: mixc(L.topColor, '#ffffff', 0.78)}); }

// Hair behind the head and shoulders (long styles, the afro, a ponytail, braids).
function hairBack(L, hc) {
  const dark = shade(hc, 0.82);
  switch (L.hair) {
    case 'long': return path(P`M${CX - 27},40 C${CX - 30},62 ${CX - 30},80 ${CX - 25},92 L${CX + 25},92 C${CX + 30},80 ${CX + 30},62 ${CX + 27},40 Z`, dark);
    case 'bob': return path(P`M${CX - 27},40 C${CX - 29},56 ${CX - 28},68 ${CX - 22},72 L${CX + 22},72 C${CX + 28},68 ${CX + 29},56 ${CX + 27},40 Z`, dark);
    case 'afro': return el('circle', {cx: CX, cy: 38, r: 35, fill: hc}) + bumps(CX, 38, 35, 18, 4.2, hc);
    case 'curly': return bumps(CX, 42, 27, 16, 4.5, dark);
    case 'ponytail': return el('ellipse', {cx: CX + 25, cy: 60, rx: 7, ry: 15, fill: dark, transform: P`rotate(-12 ${CX + 25} 60)`});
    case 'braids': return [-1, 1].map(s => [0, 1, 2, 3].map(i => el('ellipse', {cx: CX + s * 24, cy: 62 + i * 8, rx: 4.6, ry: 5, fill: i % 2 ? dark : hc})).join('')).join('');
    case 'bun': return el('circle', {cx: CX, cy: 17, r: 9, fill: hc}) + line(P`M${CX - 6},19 Q${CX},23 ${CX + 6},19`, dark, 1.2);
    default: return '';
  }
}
function bumps(cx, cy, r, n, br, fill) {
  let s = '';
  for (let i = 0; i < n; i++) { const a = Math.PI + (i / (n - 1)) * Math.PI; s += el('circle', {cx: cx + Math.cos(a) * r, cy: cy + Math.sin(a) * r * 0.95, r: br, fill}); }
  return s;
}

function torso(L, skin) {
  const [l, r] = SHOULDERS[L.build] || SHOULDERS.regular, top = L.topColor, deep = shade(top, 0.84), accent = L.accent;
  const body = P`M${l},100 L${l},93 C${l},84 ${l + 10},79.5 ${CX - 11},78.5 L${CX + 11},78.5 C${r - 10},79.5 ${r},84 ${r},93 L${r},100 Z`;
  let s = '<clipPath id="t">' + path(body, '#000') + '</clipPath>';
  // A tank top leaves the shoulders bare.
  if (L.top === 'tank') {
    s += path(body, shade(skin, 0.97));
    s += path(P`M${CX - 17},100 L${CX - 17},84 Q${CX - 15},79 ${CX - 12},79.5 Q${CX},90 ${CX + 12},79.5 Q${CX + 15},79 ${CX + 17},84 L${CX + 17},100 Z`, top);
  } else {
    if (L.top === 'hoodie') s += path(P`M${CX - 19},82 Q${CX},70 ${CX + 19},82 Q${CX},90 ${CX - 19},82 Z`, deep);
    s += path(body, top);
  }
  // The pattern, inside the top.
  const pat = {
    stripes: () => [86, 91.5, 97].map(y => el('rect', {x: 0, y, width: 100, height: 2.4, fill: accent})).join(''),
    block: () => el('rect', {x: 0, y: 91, width: 100, height: 9, fill: accent}),
    band: () => el('rect', {x: 0, y: 87, width: 100, height: 4, fill: accent}),
    badge: () => el('circle', {cx: CX - 14, cy: 89, r: 3.2, fill: accent}),
  }[L.pattern];
  if (pat) s += `<g clip-path="url(#t)">${pat()}</g>`;
  // Necklines.
  switch (L.top) {
    case 'tee': s += path(P`M${CX - 8},78.5 Q${CX},86 ${CX + 8},78.5 Z`, shade(skin, 0.9)) + line(P`M${CX - 8.5},78.6 Q${CX},86.6 ${CX + 8.5},78.6`, deep, 1.6); break;
    case 'sweater': s += path(P`M${CX - 8},78.5 Q${CX},85 ${CX + 8},78.5 Z`, shade(skin, 0.9)) + line(P`M${CX - 9},78.6 Q${CX},86 ${CX + 9},78.6`, deep, 3); break;
    case 'buttonup':
      s += path(P`M${CX - 7},78.5 L${CX},88 L${CX + 7},78.5 Z`, shade(skin, 0.9));
      s += path(P`M${CX - 9},77.5 L${CX - 1},86 L${CX - 7.5},88 Z`, mixc(top, '#ffffff', 0.35)) + path(P`M${CX + 9},77.5 L${CX + 1},86 L${CX + 7.5},88 Z`, mixc(top, '#ffffff', 0.35));
      s += [91, 96].map(y => el('circle', {cx: CX, cy: y, r: 0.9, fill: deep})).join('');
      break;
    case 'hoodie':
      s += path(P`M${CX - 7},78.5 Q${CX},84 ${CX + 7},78.5 Z`, shade(skin, 0.9));
      s += line(P`M${CX - 4},82 L${CX - 4.5},92`, lum(top) > 0.5 ? shade(top, 0.6) : WHITE, 1.2) + line(P`M${CX + 4},82 L${CX + 4.5},92`, lum(top) > 0.5 ? shade(top, 0.6) : WHITE, 1.2);
      break;
    case 'blazer':
      s += path(P`M${CX - 9},78.5 L${CX},96 L${CX + 9},78.5 Z`, WHITE);
      s += path(P`M${CX - 8},78.5 L${CX - 3},84 L${CX - 7},86 L${CX - 2},96 L${CX - 12},80 Z`, deep) + path(P`M${CX + 8},78.5 L${CX + 3},84 L${CX + 7},86 L${CX + 2},96 L${CX + 12},80 Z`, deep);
      s += path(P`M${CX - 2},79.5 L${CX + 2},79.5 L${CX + 1},86 L${CX},88 L${CX - 1},86 Z`, accent);
      break;
    case 'tank': break;
  }
  return s;
}

function head(L, skin) {
  const ear = shade(skin, 0.94);
  return el('rect', {x: CX - 7, y: 64, width: 14, height: 16, rx: 4, fill: shade(skin, 0.88)})
    + el('ellipse', {cx: CX - RX + 0.5, cy: 50, rx: 4, ry: 5.5, fill: ear}) + el('ellipse', {cx: CX + RX - 0.5, cy: 50, rx: 4, ry: 5.5, fill: ear})
    + path(P`M${CX},${CY - RY} C${CX + RX * 0.95},${CY - RY} ${CX + RX},${CY - RY * 0.35} ${CX + RX},${CY + 2} C${CX + RX},${CY + RY * 0.62} ${CX + RX * 0.5},${CY + RY} ${CX},${CY + RY} C${CX - RX * 0.5},${CY + RY} ${CX - RX},${CY + RY * 0.62} ${CX - RX},${CY + 2} C${CX - RX},${CY - RY * 0.35} ${CX - RX * 0.95},${CY - RY} ${CX},${CY - RY} Z`, skin);
}

const EY = 48, EXo = 9.5, BY = 41.5, NY = 54, MY = 60.5;
function eyes(L, skin) {
  const c = L.eyeColor, lid = shade(skin, 0.82);
  return [-1, 1].map(s => {
    const x = CX + s * EXo;
    const spark = el('circle', {cx: x + 1, cy: EY - 1.3, r: 0.95, fill: '#ffffff'});
    switch (L.eyes) {
      case 'round': return el('circle', {cx: x, cy: EY, r: 3.6, fill: c}) + el('circle', {cx: x, cy: EY, r: 1.8, fill: INK}) + spark;
      case 'almond': return path(P`M${x - 4.2},${EY + 0.3} Q${x},${EY - 3.9} ${x + 4.2},${EY - 0.5} Q${x},${EY + 3.2} ${x - 4.2},${EY + 0.3} Z`, c) + el('circle', {cx: x, cy: EY, r: 1.5, fill: INK}) + spark;
      case 'sleepy': return el('ellipse', {cx: x, cy: EY + 0.6, rx: 3, ry: 2.6, fill: c}) + el('circle', {cx: x, cy: EY + 0.8, r: 1.3, fill: INK})
        + path(P`M${x - 3.6},${EY + 0.4} Q${x},${EY - 4} ${x + 3.6},${EY + 0.4} Z`, skin) + line(P`M${x - 3.6},${EY + 0.4} Q${x},${EY - 1.2} ${x + 3.6},${EY + 0.4}`, lid, 1.1);
      default: return el('ellipse', {cx: x, cy: EY, rx: 3.1, ry: 4, fill: c}) + el('ellipse', {cx: x, cy: EY + 0.2, rx: 1.6, ry: 2.1, fill: INK}) + spark;
    }
  }).join('');
}
function brows(L, hc) {
  const c = L.hair === 'bald' ? shade(L.skin, 0.55) : shade(hc, 0.85);
  return [-1, 1].map(s => {
    const x = CX + s * EXo, a = x - s * 4, b = x + s * 4;
    switch (L.brows) {
      case 'straight': return line(P`M${a},${BY} L${b},${BY - 0.4}`, c, 1.5);
      case 'arched': return line(P`M${a},${BY + 0.6} Q${x},${BY - 3.4} ${b},${BY}`, c, 1.4);
      case 'thick': return line(P`M${a},${BY + 0.3} Q${x},${BY - 1.6} ${b},${BY - 0.2}`, c, 2.6);
      default: return line(P`M${a},${BY + 0.5} Q${x},${BY - 1.8} ${b},${BY + 0.3}`, c, 1.2);
    }
  }).join('');
}
function nose(L, skin) {
  const c = shade(skin, 0.84);
  switch (L.nose) {
    case 'wedge': return line(P`M${CX + 0.5},${NY - 4.5} L${CX + 2},${NY + 0.5} L${CX - 1.2},${NY + 0.8}`, c, 1.2);
    case 'round': return el('ellipse', {cx: CX, cy: NY, rx: 3, ry: 2.2, fill: c});
    default: return el('ellipse', {cx: CX, cy: NY, rx: 1.8, ry: 1.3, fill: c});
  }
}
function mouth(L) {
  switch (L.mouth) {
    case 'grin': return path(P`M${CX - 6},${MY - 1} Q${CX},${MY + 7} ${CX + 6},${MY - 1} Z`, MOUTH_IN) + path(P`M${CX - 5.2},${MY - 0.6} L${CX + 5.2},${MY - 0.6} Q${CX + 4.4},${MY + 1.2} ${CX},${MY + 1.3} Q${CX - 4.4},${MY + 1.2} ${CX - 5.2},${MY - 0.6} Z`, TEETH);
    case 'neutral': return line(P`M${CX - 4},${MY + 0.5} L${CX + 4},${MY + 0.5}`, LIP, 1.5);
    case 'smirk': return line(P`M${CX - 4.5},${MY + 0.8} Q${CX + 1},${MY + 2.6} ${CX + 5},${MY - 1.2}`, LIP, 1.5);
    default: return line(P`M${CX - 5},${MY - 0.4} Q${CX},${MY + 4.4} ${CX + 5},${MY - 0.4}`, LIP, 1.6);
  }
}
function cheeks(L, skin) {
  let s = '';
  if (L.blush) s += [-1, 1].map(k => el('ellipse', {cx: CX + k * 14, cy: 56, rx: 4, ry: 2.4, fill: BLUSH, opacity: 0.28})).join('');
  if (L.freckles) { const c = shade(skin, 0.7); for (const k of [-1, 1]) for (const [dx, dy] of [[-2.5, -0.5], [0, 1], [2.2, -0.8], [0.6, -2.2]]) s += el('circle', {cx: CX + k * 13 + dx, cy: 54.5 + dy, r: 0.6, fill: c}); }
  return s;
}
function beard(L, hc) {
  switch (L.beard) {
    case 'stubble': return path(P`M${CX - 22},54 Q${CX - 18},${CY + RY + 1} ${CX},${CY + RY + 0.5} Q${CX + 18},${CY + RY + 1} ${CX + 22},54 Q${CX + 15},65 ${CX},65 Q${CX - 15},65 ${CX - 22},54 Z`, hc, {opacity: 0.3});
    case 'mustache': return path(P`M${CX - 7},${MY - 2} Q${CX},${MY - 6.5} ${CX + 7},${MY - 2} Q${CX + 4},${MY - 0.6} ${CX},${MY - 2.4} Q${CX - 4},${MY - 0.6} ${CX - 7},${MY - 2} Z`, hc);
    case 'goatee': return path(P`M${CX - 6.5},${MY - 2} Q${CX},${MY - 6} ${CX + 6.5},${MY - 2} Q${CX + 4},${MY - 0.8} ${CX},${MY - 2.4} Q${CX - 4},${MY - 0.8} ${CX - 6.5},${MY - 2} Z`, hc)
      + path(P`M${CX - 5},${MY + 3.5} Q${CX},${MY + 13} ${CX + 5},${MY + 3.5} Q${CX},${MY + 5.5} ${CX - 5},${MY + 3.5} Z`, hc);
    case 'full': return path(P`M${CX - RX + 0.5},46 Q${CX - RX},${CY + RY + 4} ${CX},${CY + RY + 5} Q${CX + RX},${CY + RY + 4} ${CX + RX - 0.5},46 Q${CX + 20},58 ${CX + 9},${MY - 2.5} Q${CX},${MY - 6} ${CX - 9},${MY - 2.5} Q${CX - 20},58 ${CX - RX + 0.5},46 Z`, hc)
      + path(P`M${CX - 6.5},${MY - 0.5} Q${CX},${MY + 6.5} ${CX + 6.5},${MY - 0.5} Q${CX},${MY + 1.8} ${CX - 6.5},${MY - 0.5} Z`, shade(L.skin, 0.92));
    default: return '';
  }
}
function glasses(L) {
  const frame = INK;
  switch (L.glasses) {
    case 'round': return [-1, 1].map(s => el('circle', {cx: CX + s * EXo, cy: EY, r: 5.6, fill: '#ffffff', 'fill-opacity': 0.12, stroke: frame, 'stroke-width': 1.3})).join('') + line(P`M${CX - 3.9},${EY - 0.5} Q${CX},${EY - 2} ${CX + 3.9},${EY - 0.5}`, frame, 1.2);
    case 'square': return [-1, 1].map(s => el('rect', {x: CX + s * EXo - 5.8, y: EY - 4.4, width: 11.6, height: 8.8, rx: 1.6, fill: '#ffffff', 'fill-opacity': 0.12, stroke: frame, 'stroke-width': 1.3})).join('') + line(P`M${CX - 3.7},${EY - 1} L${CX + 3.7},${EY - 1}`, frame, 1.2);
    case 'shades': return [-1, 1].map(s => path(P`M${CX + s * 3.4},${EY - 4} L${CX + s * 15.5},${EY - 4} Q${CX + s * 15.5},${EY + 4.5} ${CX + s * 9.4},${EY + 4.5} Q${CX + s * 3.4},${EY + 4.5} ${CX + s * 3.4},${EY - 4} Z`, '#1c1f26', {stroke: frame, 'stroke-width': 1})).join('') + line(P`M${CX - 3.4},${EY - 3} L${CX + 3.4},${EY - 3}`, frame, 1.4);
    default: return '';
  }
}

// Hair over the head. covered: a hat sits on top, so only what shows below its band is drawn.
function hairFront(L, hc, covered) {
  const top = CY - RY - 1.5, light = mixc(hc, '#ffffff', 0.12);
  const cap = (fringe, outer = 2) => path(P`M${CX - RX - 1},52 C${CX - RX - outer},${top + 8} ${CX - 14},${top - outer} ${CX},${top - outer} C${CX + 14},${top - outer} ${CX + RX + outer},${top + 8} ${CX + RX + 1},52 ${fringe} Z`, hc);
  if (L.hair === 'bald') return '';
  if (covered) {
    // Under a hat: the sides, and a fringe for the styles that have one.
    if (L.hair === 'buzz' || L.hair === 'mohawk') return '';
    return path(P`M${CX - RX - 0.5},50 Q${CX - RX - 2},40 ${CX - RX - 1},33 L${CX - RX + 7},33 Q${CX - RX + 3},38 ${CX - RX + 2.5},45 Z`, hc) + path(P`M${CX + RX + 0.5},50 Q${CX + RX + 2},40 ${CX + RX + 1},33 L${CX + RX - 7},33 Q${CX + RX - 3},38 ${CX + RX - 2.5},45 Z`, hc);
  }
  switch (L.hair) {
    case 'buzz': return cap(P`L${CX + RX - 1},44 C${CX + 16},31 ${CX - 16},31 ${CX - RX + 1},44`, 0.6).replace('/>', ' opacity="0.9"/>');
    case 'sidepart': return cap(P`L${CX + RX - 0.5},42 C${CX + 18},30 ${CX - 2},28 ${CX - 8},33 C${CX - 14},37 ${CX - 20},38 ${CX - RX + 0.5},46`) + line(P`M${CX - 8},${top + 1} Q${CX - 6},${top + 5} ${CX - 8},33`, shade(hc, 0.75), 1);
    case 'curly': return cap(P`L${CX + RX - 1},42 C${CX + 16},33 ${CX - 16},33 ${CX - RX + 1},42`) + bumps(CX, 33, 21, 9, 4, hc) + bumps(CX, 33, 21, 9, 1.4, light);
    case 'afro': return cap(P`L${CX + RX - 1},40 C${CX + 16},31 ${CX - 16},31 ${CX - RX + 1},40`, 5) + bumps(CX, 30, 23, 9, 4.4, hc);
    case 'long': case 'bob': return cap(P`L${CX + RX - 1},44 C${CX + 18},34 ${CX + 6},30 ${CX},31 C${CX - 6},30 ${CX - 18},34 ${CX - RX + 1},44`);
    case 'ponytail': case 'bun': return cap(P`L${CX + RX - 1},42 C${CX + 16},30 ${CX - 16},30 ${CX - RX + 1},42`, 1);
    case 'braids': return cap(P`L${CX + RX - 1},44 C${CX + 14},31 ${CX + 2},31 ${CX},33 C${CX - 2},31 ${CX - 14},31 ${CX - RX + 1},44`, 1);
    case 'mohawk': return cap(P`L${CX + RX - 1},44 C${CX + 16},33 ${CX - 16},33 ${CX - RX + 1},44`, 0.4).replace('/>', ' opacity="0.45"/>')
      + path(P`M${CX - 5},38 C${CX - 7},24 ${CX - 4},10 ${CX},8 C${CX + 4},10 ${CX + 7},24 ${CX + 5},38 Z`, hc);
    default: return cap(P`L${CX + RX - 1},44 C${CX + 18},32 ${CX + 6},30 ${CX - 2},33 C${CX - 10},31 ${CX - 18},34 ${CX - RX + 1},44`);
  }
}
function hat(L) {
  const c = L.hatColor, deep = shade(c, 0.78), top = CY - RY - 3;
  switch (L.hat) {
    case 'cap': return path(P`M${CX - RX - 1.5},36 C${CX - RX - 1.5},${top - 6} ${CX + RX + 1.5},${top - 6} ${CX + RX + 1.5},36 Z`, c) + el('circle', {cx: CX, cy: top + 1.5, r: 1.6, fill: deep})
      + path(P`M${CX - RX - 2},35 Q${CX},39 ${CX + RX + 2},35 L${CX + RX + 3},37.5 Q${CX},44.5 ${CX - RX - 3},37.5 Z`, deep);
    case 'beanie': return path(P`M${CX - RX - 1.5},34 C${CX - RX - 1.5},${top - 9} ${CX + RX + 1.5},${top - 9} ${CX + RX + 1.5},34 Z`, c)
      + el('rect', {x: CX - RX - 2.5, y: 29.5, width: (RX + 2.5) * 2, height: 7.5, rx: 3, fill: deep})
      + [-14, -7, 0, 7, 14].map(x => line(P`M${CX + x},31 L${CX + x},35.5`, shade(c, 0.66), 1)).join('');
    case 'bucket': return path(P`M${CX - RX},35 C${CX - RX},${top - 7} ${CX + RX},${top - 7} ${CX + RX},35 Z`, c)
      + path(P`M${CX - RX - 9},41 Q${CX},29 ${CX + RX + 9},41 Q${CX + RX + 6},43 ${CX + RX + 2},41 Q${CX},35.5 ${CX - RX - 2},41 Q${CX - RX - 6},43 ${CX - RX - 9},41 Z`, deep);
    case 'captain': return path(P`M${CX - RX},34 L${CX - RX - 4},22 Q${CX},${top - 7} ${CX + RX + 4},22 L${CX + RX},34 Z`, c)
      + el('rect', {x: CX - RX, y: 29, width: RX * 2, height: 6, fill: INK}) + path(P`M${CX - RX + 2},35 Q${CX},40.5 ${CX + RX - 2},35 Z`, INK)
      + el('circle', {cx: CX, cy: 25.5, r: 2.6, fill: GOLD});
    case 'headphones': return line(P`M${CX - RX - 1},48 C${CX - RX - 2},${top - 3} ${CX + RX + 2},${top - 3} ${CX + RX + 1},48`, c, 3.6)
      + el('rect', {x: CX - RX - 5.5, y: 42, width: 8, height: 14, rx: 3.5, fill: deep}) + el('rect', {x: CX + RX - 2.5, y: 42, width: 8, height: 14, rx: 3.5, fill: deep});
    default: return '';
  }
}

// The SVG for a look (lookFromSpec's output).
function portraitSvg(L) {
  const skin = L.skin, hc = L.hairColor, hatOn = L.hat !== 'none' && L.hat !== 'headphones';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 3 92 92">'
    + background(L) + hairBack(L, hc) + torso(L, skin) + head(L, skin)
    + cheeks(L, skin) + eyes(L, skin) + brows(L, hc) + nose(L, skin) + beard(L, hc) + mouth(L) + glasses(L)
    + hairFront(L, hc, hatOn) + hat(L)
    + '</svg>';
}

export const portraitKey = spec => `p${PORTRAIT_VERSION}-${avatarHash(spec)}`;
const cache = new Map();
// size: the picture's width and height in CSS pixels (the drawing scales; it is the same picture at any size).
export function renderAvatarPortrait(spec, {size = 0, as = 'url', seed = ''} = {}) {
  const s = readAvatar(spec, seed), key = portraitKey(s);
  let svg = cache.get(key);
  if (svg === undefined) {
    svg = portraitSvg(lookFromSpec(s, seed));
    cache.set(key, svg);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
  } else { cache.delete(key); cache.set(key, svg); }
  const out = size > 0 ? svg.replace('<svg ', `<svg width="${Math.round(size)}" height="${Math.round(size)}" `) : svg;
  return as === 'svg' ? out : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(out);
}
export const portraitCacheSize = () => cache.size;
