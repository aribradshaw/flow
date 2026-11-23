// The portable avatar spec v1 (docs/concepts/13-avatars.md): validation, unknown fields kept, migration from
// office looks and from no look at all, deterministic defaults, and the renderer module (portrait cache key,
// deterministic SVG, the 3D builder from a spec).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AVATAR_VERSION, AVATAR_MAX_BYTES, AVATAR_FIELDS, AVATAR_GROUPS, AVATAR_OPTIONS, validateAvatar, readAvatar, defaultAvatar, lookFromSpec, specFromLook,
  canonicalAvatar, sameAvatar, avatarHash, avatarBytes, isAvatarSpec} from '../public/avatar-spec.js';
import {LOOK_OPTIONS, LOOK_FIELDS, cleanLook, defaultLook} from '../public/office-look-core.js';
import {renderAvatarPortrait, portraitKey, PORTRAIT_VERSION, renderAvatar3D} from '../public/avatar.js';

const errs = (fn, status, code) => assert.throws(fn, e => e.status === status && (!code || e.code === code));

test('v1 covers every office look field once, with its allow-list', () => {
  assert.equal(AVATAR_VERSION, 1);
  assert.deepEqual(AVATAR_FIELDS.map(f => f[1]).sort(), [...LOOK_FIELDS].sort());
  for (const [path, field, kind] of AVATAR_FIELDS) {
    if (kind === 'option') assert.deepEqual(AVATAR_OPTIONS[path], LOOK_OPTIONS[field], path);
    assert.ok(path === 'skin' || AVATAR_GROUPS.includes(path.split('.')[0]), path);
  }
  // The names the spec promises.
  assert.deepEqual(Object.keys(defaultAvatar('m1')), ['v', 'skin', ...AVATAR_GROUPS]);
  assert.deepEqual(Object.keys(defaultAvatar('m1').face), ['eyes', 'eyeColor', 'brows', 'nose', 'mouth', 'facialHair', 'glasses', 'freckles', 'blush']);
  assert.deepEqual(AVATAR_OPTIONS['face.facialHair'], ['none', 'stubble', 'mustache', 'goatee', 'full']);
});

test('the default is deterministic per seed, valid, small, and the office default look', () => {
  for (const seed of ['mAbc', 'mXyz123', '', 'a1']) {
    const a = defaultAvatar(seed);
    assert.deepEqual(a, defaultAvatar(seed));
    assert.deepEqual(validateAvatar(a), a);
    assert.deepEqual(lookFromSpec(a, seed), defaultLook(seed), 'draws exactly the old default look');
    assert.deepEqual(readAvatar(null, seed), a); assert.deepEqual(readAvatar(undefined, seed), a);
    assert.ok(avatarBytes(a) < 700, `${avatarBytes(a)} bytes`);
  }
  const seen = new Set(Array.from({length: 40}, (_, i) => canonicalAvatar(defaultAvatar('m' + i))));
  assert.ok(seen.size > 35, 'people differ');
});

test('validation: complete, strict ids and #rrggbb colours, groups as objects', () => {
  const ok = defaultAvatar('m1');
  assert.deepEqual(validateAvatar({...ok, skin: ' #A86C42 '}).skin, '#a86c42', 'colours are trimmed and lower-cased');
  assert.equal(validateAvatar({...ok, hair: {style: 'AFRO', color: ok.hair.color}}).hair.style, 'afro');
  for (const skin of ['peach', '#abc', '#12345', '#1234567', '#gggggg', 12, null, '']) errs(() => validateAvatar({...ok, skin}), 400, 'invalid_avatar');
  for (const [g, k, v] of [['hat', 'style', 'crown'], ['face', 'eyes', 'laser'], ['top', 'pattern', 'plaid'], ['shoes', 'style', ''], ['face', 'freckles', 'yes'], ['face', 'blush', 1]])
    errs(() => validateAvatar({...ok, [g]: {...ok[g], [k]: v}}), 400, 'invalid_avatar');
  errs(() => validateAvatar({...ok, face: {...ok.face, mouth: undefined}}), 400, 'invalid_avatar');
  errs(() => validateAvatar({...ok, hair: 'afro'}), 400);
  errs(() => validateAvatar({...ok, v: 2}), 400); errs(() => validateAvatar({...ok, v: undefined}), 400);
  for (const x of [null, [], 'spec', 3]) errs(() => validateAvatar(x), 400);
  errs(() => validateAvatar(JSON.parse(`{"v":1,"skin":"#a86c42","__proto__":{"x":1},${JSON.stringify(ok).slice(1).replace(/"v":1,"skin":"#a86c42",/, '')}`)), 400);
  errs(() => validateAvatar({...ok, 'bad key': 1}), 400);
  errs(() => validateAvatar({...ok, deep: {a: {b: {c: {d: {e: 1}}}}}}), 400);
  errs(() => validateAvatar({...ok, n: Infinity}), 400);
  // The size cap.
  errs(() => validateAvatar({...ok, notes: 'x'.repeat(AVATAR_MAX_BYTES)}), 413, 'avatar_too_large');
  assert.ok(validateAvatar({...ok, notes: 'x'.repeat(1000)}));
});

test('unknown fields survive validation, reading, the office look and back', () => {
  const ok = defaultAvatar('m1');
  const extra = {...ok, aura: {color: '#ffaa00', on: true}, tags: ['a', 1, null], face: {...ok.face, wink: 'left'}, shoes: {...ok.shoes, laces: 'red'}};
  const v = validateAvatar(extra);
  assert.deepEqual([v.aura, v.tags, v.face.wink, v.shoes.laces], [{color: '#ffaa00', on: true}, ['a', 1, null], 'left', 'red']);
  assert.deepEqual(readAvatar(v, 'm1'), v);
  // Through the office editor: the look has no idea about them; the base spec keeps them.
  const look = {...lookFromSpec(v, 'm1'), hair: 'bun'};
  const back = specFromLook(look, {seed: 'm1', base: v});
  assert.deepEqual([back.aura, back.face.wink, back.shoes.laces, back.hair.style], [v.aura, 'left', 'red', 'bun']);
  assert.deepEqual(JSON.parse(JSON.stringify(back)), back, 'plain JSON');
  // Reading stored data never refuses: a bad known field falls back to the default, a bad unknown one is dropped.
  const r = readAvatar({...v, skin: 'nope', hat: {style: 'crown', color: '#fff'}, 'odd key': 1}, 'm1');
  assert.deepEqual([r.skin, r.hat, r.aura, 'odd key' in r], [ok.skin, ok.hat, v.aura, false]);
});

test('migration: office looks of every version become a spec that draws the same', () => {
  const v2 = {...defaultLook('m9'), hair: 'mohawk', hat: 'headphones', beard: 'goatee', topColor: '#2f8f8a'};
  const spec = readAvatar(v2, 'm9');
  assert.ok(isAvatarSpec(spec) && !isAvatarSpec(v2));
  assert.deepEqual(lookFromSpec(spec, 'm9'), cleanLook(v2, {key: 'm9'}));
  assert.deepEqual([spec.hair.style, spec.hat.style, spec.face.facialHair, spec.top.color], ['mohawk', 'headphones', 'goatee', '#2f8f8a']);
  // The first figures, and the first wardrobe panel.
  const v1 = readAvatar({skin: '#c08259', hair: '#1c1c1c', shirt: '#3d6fb6', pants: '#2d3a4a', style: 3}, 'm9');
  assert.deepEqual([v1.hair.style, v1.hair.color, v1.top.color, v1.bottoms.color], ['buzz', '#1c1c1c', '#3d6fb6', '#2d3a4a']);
  const w = readAvatar({skin: '#94603f', hair: '#b9874b', hairStyle: 1, topStyle: 'hoodie', top: '#d87881', bottoms: '#283044', accessory: 'glasses'}, 'm9');
  assert.deepEqual([w.hair.style, w.top.style, w.face.glasses], ['long', 'hoodie', 'round']);
  for (const s of [spec, v1, w]) assert.deepEqual(validateAvatar(s), s);
});

test('the portrait cache key is stable: key order, sessions and machines; any change gives a new one', () => {
  const a = defaultAvatar('mStable');
  const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse().map(([k, v]) => [k, v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse()) : v]))));
  assert.equal(canonicalAvatar(shuffled), canonicalAvatar(a)); assert.ok(sameAvatar(shuffled, a));
  assert.equal(portraitKey(shuffled), portraitKey(a));
  assert.match(portraitKey(a), new RegExp(`^p${PORTRAIT_VERSION}-[0-9a-z]{14}$`));
  // Pinned: the hash is part of the format (caches outlive a process).
  assert.equal(avatarHash({v: 1, skin: '#a86c42'}), avatarHash({skin: '#a86c42', v: 1}));
  assert.equal(avatarHash({v: 1, skin: '#a86c42'}), '1i7sloi1lt39x3');
  const keys = new Set([a, {...a, skin: '#a86c43'}, {...a, hat: {...a.hat, style: 'cap'}}, {...a, extra: 1}].map(portraitKey));
  assert.equal(keys.size, 4);
});

test('the portrait: the same SVG for the same spec, sized on request, safe as an image URL', () => {
  const a = {...defaultAvatar('m3'), hair: {style: 'afro', color: '#3f6fd1'}, hat: {style: 'beanie', color: '#c8553d'}, face: {...defaultAvatar('m3').face, glasses: 'shades', facialHair: 'full'}};
  const svg = renderAvatarPortrait(a, {as: 'svg'});
  assert.equal(svg, renderAvatarPortrait(JSON.parse(JSON.stringify(a)), {as: 'svg'}));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d ]+">/);
  assert.ok(!/NaN|undefined|null|<script|on\w+=/i.test(svg));
  assert.ok(svg.length < 8000, `${svg.length} bytes`);
  assert.ok(svg.includes('#3f6fd1') && svg.includes('#c8553d'), 'drawn in the spec colours');
  assert.match(renderAvatarPortrait(a, {as: 'svg', size: 32}), /^<svg width="32" height="32" /);
  const url = renderAvatarPortrait(a);
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.equal(decodeURIComponent(url.slice(url.indexOf(',') + 1)), svg);
  // Every option draws.
  for (const [path, ids] of Object.entries(AVATAR_OPTIONS)) for (const id of ids) {
    const [g, k] = path.split('.'), s = structuredClone(a); s[g][k] = id;
    assert.ok(!/NaN|undefined/.test(renderAvatarPortrait(s, {as: 'svg'})), path + ' ' + id);
  }
  // Anything else draws the seed's default.
  assert.equal(renderAvatarPortrait(null, {as: 'svg', seed: 'm3'}), renderAvatarPortrait(defaultAvatar('m3'), {as: 'svg'}));
});

test('renderAvatar3D builds the office person from a spec', async () => {
  const THREE = await import('../public/vendor/three/three.module.min.js');
  await import('../public/office-avatar.js');
  const spec = {...defaultAvatar('m4'), hair: {style: 'bun', color: '#d2632f'}};
  const person = renderAvatar3D(THREE, spec);
  assert.equal(person.userData.look().hair, 'bun');
  assert.ok(person.userData.stats().tris > 500);
  const light = renderAvatar3D(THREE, spec, {lod: 'light'});
  assert.ok(light.userData.stats().lodTris > 0);
  person.userData.dispose(); light.userData.dispose();
  assert.throws(() => renderAvatar3D({}, spec), /registered/);
});
