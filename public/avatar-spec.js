// The portable avatar spec, version 1 (docs/concepts/13-avatars.md): one avatar per account, used across
// Flow and meant for other apps too. Plain data and pure functions: no DOM, no Three.js, no network, so the
// browser and the server (lib/avatars.mjs) check it with the same code.
//
//   {v:1, skin, body:{build, height},
//    face:{eyes, eyeColor, brows, nose, mouth, facialHair, glasses, freckles, blush},
//    hair:{style, color}, hat:{style, color}, top:{style, color, pattern, accent},
//    bottoms:{style, color}, shoes:{style, color}}
//
// Option ids are stable strings (AVATAR_OPTIONS). Colours are #rrggbb. freckles and blush are booleans.
// Fields this version does not know are kept as they are, at the top level and inside each group, so an app
// that knows a later field can round-trip through one that does not. A whole spec is at most AVATAR_MAX_BYTES
// of JSON. Version 1 only ever gains optional fields; a change that is not additive is a new v.
//
// The 3D office draws the flat "look" in office-look-core.js. lookFromSpec / specFromLook convert, and
// readAvatar migrates anything stored before this spec (an office look of any version, or no look at all:
// the deterministic default for a stable seed, the person's opaque office member key).
import {LOOK_OPTIONS, LOOK_VERSION, cleanLook, defaultLook, hashOf} from './office-look-core.js';

export const AVATAR_VERSION = 1;
export const AVATAR_MAX_BYTES = 2048;

// [path, office look field, kind]. kind: 'option' (an id from AVATAR_OPTIONS), 'color' or 'flag'.
export const AVATAR_FIELDS = [
  ['skin', 'skin', 'color'],
  ['body.build', 'build', 'option'], ['body.height', 'height', 'option'],
  ['face.eyes', 'eyes', 'option'], ['face.eyeColor', 'eyeColor', 'color'], ['face.brows', 'brows', 'option'], ['face.nose', 'nose', 'option'],
  ['face.mouth', 'mouth', 'option'], ['face.facialHair', 'beard', 'option'], ['face.glasses', 'glasses', 'option'],
  ['face.freckles', 'freckles', 'flag'], ['face.blush', 'blush', 'flag'],
  ['hair.style', 'hair', 'option'], ['hair.color', 'hairColor', 'color'],
  ['hat.style', 'hat', 'option'], ['hat.color', 'hatColor', 'color'],
  ['top.style', 'top', 'option'], ['top.color', 'topColor', 'color'], ['top.pattern', 'pattern', 'option'], ['top.accent', 'accent', 'color'],
  ['bottoms.style', 'bottoms', 'option'], ['bottoms.color', 'bottomsColor', 'color'],
  ['shoes.style', 'shoes', 'option'], ['shoes.color', 'shoesColor', 'color'],
];
export const AVATAR_GROUPS = ['body', 'face', 'hair', 'hat', 'top', 'bottoms', 'shoes'];
// {path: [ids]}: the office look's allow-lists under the spec's names. Ids are only ever added.
export const AVATAR_OPTIONS = Object.freeze(Object.fromEntries(AVATAR_FIELDS.filter(f => f[2] === 'option').map(([path, field]) => [path, Object.freeze([...LOOK_OPTIONS[field]])])));

const COLOR = /^#[0-9a-f]{6}$/i;
// Names an unknown field may have: no prototype tricks, nothing odd.
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const BANNED = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}); };
const split = path => path.split('.');
const getPath = (o, path) => split(path).reduce((x, k) => (isObj(x) ? x[k] : undefined), o);
function setPath(o, path, v) {
  const parts = split(path); let x = o;
  for (const k of parts.slice(0, -1)) x = isObj(x[k]) ? x[k] : (x[k] = {});
  x[parts.at(-1)] = v;
}
const KNOWN = new Set(AVATAR_FIELDS.map(f => f[0]));

// An unknown value, copied as plain JSON (depth-limited). -> the copy, or undefined to drop it (lenient) /
// a 400 (strict).
function plain(v, strict, where, depth = 0) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : bad(strict, where, 'must be a finite number');
  if (depth >= 4) return bad(strict, where, 'is nested too deeply');
  if (Array.isArray(v)) { const out = []; for (const x of v) { const c = plain(x, strict, where, depth + 1); if (c !== undefined) out.push(c); } return out; }
  if (isObj(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (!NAME.test(k) || BANNED.has(k)) { bad(strict, where + '.' + k, 'is not an allowed field name'); continue; }
      const c = plain(x, strict, where + '.' + k, depth + 1); if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return bad(strict, where, 'is not JSON');
}
function bad(strict, where, why) { if (strict) fail(400, 'invalid_avatar', `${where} ${why}`); return undefined; }

// One known field. -> the clean value, or undefined (missing or invalid when lenient).
function cleanField([path, field, kind], v, strict) {
  if (v === undefined || v === null) return strict ? bad(true, path, 'is required') : undefined;
  if (kind === 'color') return typeof v === 'string' && COLOR.test(v.trim()) ? v.trim().toLowerCase() : bad(strict, path, 'must be a colour like #3d6fb6');
  if (kind === 'flag') return typeof v === 'boolean' ? v : bad(strict, path, 'must be true or false');
  const id = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return LOOK_OPTIONS[field].includes(id) ? id : bad(strict, path, `must be one of ${LOOK_OPTIONS[field].join(', ')}`);
}

// Copies every field this version does not know from src into out (top level and inside the groups).
function keepUnknown(src, out, strict) {
  if (!isObj(src)) return out;
  for (const [k, v] of Object.entries(src)) {
    if (k === 'v') continue;
    if (AVATAR_GROUPS.includes(k)) {
      if (!isObj(v)) { if (v !== undefined) bad(strict, k, 'must be an object'); continue; }
      for (const [kk, vv] of Object.entries(v)) {
        if (KNOWN.has(k + '.' + kk)) continue;
        if (!NAME.test(kk) || BANNED.has(kk)) { bad(strict, k + '.' + kk, 'is not an allowed field name'); continue; }
        const c = plain(vv, strict, k + '.' + kk); if (c !== undefined) (out[k] ||= {})[kk] = c;
      }
      continue;
    }
    if (KNOWN.has(k)) continue;
    if (!NAME.test(k) || BANNED.has(k)) { bad(strict, k, 'is not an allowed field name'); continue; }
    const c = plain(v, strict, k); if (c !== undefined) out[k] = c;
  }
  return out;
}
// Known fields in the documented order, then whatever else there is.
function ordered(spec) {
  const out = {v: AVATAR_VERSION, skin: spec.skin};
  for (const g of AVATAR_GROUPS) out[g] = spec[g];
  for (const [k, v] of Object.entries(spec)) if (!(k in out)) out[k] = v;
  return out;
}
export const avatarBytes = spec => new TextEncoder().encode(JSON.stringify(spec)).length;

// Is this a spec (groups as objects), rather than a flat office look or nothing?
export const isAvatarSpec = v => isObj(v) && (isObj(v.face) || isObj(v.hair) || isObj(v.top));

// A save: input -> a complete, clean spec, or a 400 (invalid_avatar) / 413 (avatar_too_large).
// Every known field is required and checked; unknown fields are kept.
export function validateAvatar(input) {
  if (!isObj(input)) fail(400, 'invalid_avatar', 'avatar must be an object');
  if (input.v !== AVATAR_VERSION) fail(400, 'invalid_avatar', `v must be ${AVATAR_VERSION}`);
  const out = {v: AVATAR_VERSION};
  for (const g of AVATAR_GROUPS) if (!isObj(input[g])) fail(400, 'invalid_avatar', `${g} must be an object`);
  for (const f of AVATAR_FIELDS) setPath(out, f[0], cleanField(f, getPath(input, f[0]), true));
  const spec = ordered(keepUnknown(input, out, true));
  if (avatarBytes(spec) > AVATAR_MAX_BYTES) fail(413, 'avatar_too_large', `An avatar is at most ${AVATAR_MAX_BYTES} bytes of JSON`);
  return spec;
}

// The office look (office-look-core.js) a spec draws as. seed fills anything missing or invalid.
export function lookFromSpec(spec, seed = '') {
  const flat = {v: LOOK_VERSION};
  for (const [path, field] of AVATAR_FIELDS) { const v = getPath(spec, path); if (v !== undefined) flat[field] = v; }
  return cleanLook(flat, {key: seed});
}
// A spec from an office look. base: the spec it was edited from, whose unknown fields are kept.
export function specFromLook(look, {seed = '', base = null} = {}) {
  const L = cleanLook(look, {key: seed}), out = {v: AVATAR_VERSION};
  for (const [path, field] of AVATAR_FIELDS) setPath(out, path, L[field]);
  return ordered(keepUnknown(isAvatarSpec(base) ? base : null, out, false));
}
// The avatar of someone who has not made one: the same for a seed every time (the office's default look).
export const defaultAvatar = seed => specFromLook(defaultLook(String(seed ?? '')), {seed});

// Reading what is stored (never refuses): a spec (invalid known fields fall back to the seed's default,
// unknown ones are kept), an office look of any version (migrated), or nothing (the default for the seed).
export function readAvatar(input, seed = '') {
  if (!isObj(input)) return defaultAvatar(seed);
  if (!isAvatarSpec(input)) return specFromLook(input, {seed});
  const base = defaultAvatar(seed), out = {v: AVATAR_VERSION};
  for (const f of AVATAR_FIELDS) setPath(out, f[0], cleanField(f, getPath(input, f[0]), false) ?? getPath(base, f[0]));
  let spec = ordered(keepUnknown(input, out, false));
  // Stored data over the cap (it never should be): the unknown fields go first.
  if (avatarBytes(spec) > AVATAR_MAX_BYTES) spec = ordered(out);
  return spec;
}

// Canonical JSON: keys sorted at every level, so equal specs give equal strings.
export function canonicalAvatar(spec) {
  const sort = v => Array.isArray(v) ? v.map(sort) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(spec));
}
export const sameAvatar = (a, b) => canonicalAvatar(a) === canonicalAvatar(b);
// A short stable id for a spec (cache keys): two FNV-1a passes over its canonical JSON.
export function avatarHash(spec) {
  const s = canonicalAvatar(spec);
  return hashOf(s).toString(36).padStart(7, '0') + hashOf('\u0001' + s).toString(36).padStart(7, '0');
}
