// The people in the 3D office (public/office-avatar.js), built headlessly: every part stays inside the
// triangle budget, the mesh is sound, and the animation hook other modules call keeps working.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAvatar, animateAvatar, avatarStats, avatarLodDistance, setAvatarLodDistance, paceAvatars, disposeAvatars, TRI_BUDGET, LOD_TRI_BUDGET, LOD_DISTANCE} from '../public/office-avatar.js';
import {makeHuman, animateHuman, lookFor, hashOf} from '../public/office-figures.js';
import {LOOK_OPTIONS, defaultLook, randomLook} from '../public/office-look-core.js';

const meshes = figure => { const out = []; figure.traverse(o => { if (o.isSkinnedMesh) out.push(o); }); return out; };

test('the budget: at most 2,500 triangles up close and 600 far away, whatever is worn', () => {
  assert.equal(TRI_BUDGET, 2500); assert.equal(LOD_TRI_BUDGET, 600); assert.equal(LOD_DISTANCE, 15);
  let worst = 0, worstFar = 0, total = 0, n = 0;
  const check = (look, why) => {
    const s = avatarStats(look);
    assert.ok(s.tris <= TRI_BUDGET, `${why}: ${s.tris} triangles`);
    assert.ok(s.lodTris <= LOD_TRI_BUDGET, `${why}: ${s.lodTris} triangles far away`);
    assert.ok(s.lodTris < s.tris / 2.5, `${why}: the far mesh is much lighter (${s.lodTris} of ${s.tris})`);
    worst = Math.max(worst, s.tris); worstFar = Math.max(worstFar, s.lodTris); total += s.tris; n++;
    return s;
  };
  // Every option of every part, on a few different people.
  const heaviest = {}, heaviestFar = {};
  for (const key of ['ann', 'bo', 'cy']) for (const [f, ids] of Object.entries(LOOK_OPTIONS)) {
    let most = -1, mostFar = -1;
    for (const id of ids) {
      const s = check({...defaultLook(key), [f]: id}, `${key} ${f}=${id}`);
      if (s.tris > most) { most = s.tris; heaviest[f] = id; }
      if (s.lodTris > mostFar) { mostFar = s.lodTris; heaviestFar[f] = id; }
    }
  }
  // The heaviest option of every part at once, and every hair under every hat with the heaviest rest.
  check({...defaultLook('ann'), ...heaviest, freckles: true, blush: true}, 'the heaviest of everything');
  check({...defaultLook('ann'), ...heaviestFar, freckles: true, blush: true}, 'the heaviest of everything far away');
  for (const hair of LOOK_OPTIONS.hair) for (const hat of LOOK_OPTIONS.hat) for (const top of LOOK_OPTIONS.top)
    check({...defaultLook('bo'), ...heaviest, freckles: true, hair, hat, top}, `${hair} + ${hat} + ${top}`);
  // People as they come: defaults and random looks.
  let rnd = 7; const rng = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 150; i++) { check(defaultLook('member-' + i), 'default ' + i); check(randomLook(rng), 'random ' + i); }
  assert.ok(worst > 1500, 'the budget is used: people are not blocks');
  assert.ok(total / n < 2300, `the average person is well inside it (${Math.round(total / n)})`);
});

test('one person is one skinned mesh per level of detail, on one shared material and one skeleton', () => {
  const a = createAvatar(defaultLook('ann')), b = createAvatar(defaultLook('bo')), dim = createAvatar(defaultLook('cy'), {dim: true});
  const ma = meshes(a), mb = meshes(b);
  assert.equal(ma.length, 2, 'full and far');
  assert.equal(ma[0].skeleton, ma[1].skeleton);
  assert.equal(ma[0].material, mb[0].material, 'everyone shares one material: one shader, no state changes');
  assert.notEqual(meshes(dim)[0].material, ma[0].material);
  assert.ok(meshes(dim)[0].material.transparent);
  assert.ok(ma[0].material.vertexColors);
  // Only one of the two is ever drawn.
  let lod = null; a.traverse(o => { if (o.isLOD) lod = o; });
  assert.deepEqual(lod.levels.map(l => l.distance), [0, LOD_DISTANCE]);
  a.userData.forceLod(1); assert.deepEqual(ma.map(m => m.visible), [false, true]);
  a.userData.forceLod(0); assert.deepEqual(ma.map(m => m.visible), [true, false]);
  const s = a.userData.stats();
  assert.equal(s.tris, ma[0].geometry.index.count / 3); assert.equal(s.lodTris, ma[1].geometry.index.count / 3);
  assert.ok(s.bones <= 24);
  for (const f of [a, b, dim]) f.userData.dispose();
});

test('on a slow device the full mesh is drawn less far, and comes back when frames are quick again', () => {
  disposeAvatars();
  const a = createAvatar(defaultLook('ann')), fixed = createAvatar(defaultLook('bo'), {lodDistance: 15});
  const far = f => { let lod = null; f.traverse(o => { if (o.isLOD) lod = o; }); return lod.levels[1].distance; };
  assert.equal(avatarLodDistance(), LOD_DISTANCE); assert.equal(far(a), 15);
  for (let i = 0; i < 80; i++) paceAvatars(1 / 60);
  assert.equal(far(a), 15, 'a quick device keeps full detail');
  paceAvatars(3); paceAvatars(NaN); paceAvatars(-1);
  assert.equal(far(a), 15, 'a stall or a hidden tab is not a slow device');
  for (let i = 0; i < 110; i++) paceAvatars(1 / 25);
  assert.equal(far(a), 9, 'about two seconds of long frames');
  for (let i = 0; i < 400; i++) paceAvatars(1 / 25);
  assert.equal(far(a), 4, 'and nearer still if that was not enough');
  for (let i = 0; i < 2000; i++) paceAvatars(1 / 25);
  assert.equal(far(a), 4, 'never below a few metres: whoever you stand next to stays detailed');
  assert.equal(far(fixed), 15, 'a figure with its own distance (the editor) is left alone');
  const late = createAvatar(defaultLook('cy')); assert.equal(far(late), 4, 'someone who arrives now starts there');
  for (let i = 0; i < 3000; i++) paceAvatars(1 / 60);
  assert.equal(far(a), 15); assert.equal(far(late), 15);
  for (const f of [a, fixed, late]) f.userData.dispose();
  setAvatarLodDistance(99); assert.equal(avatarLodDistance(), LOD_DISTANCE);
  disposeAvatars();
});

test('every mesh is sound: finite positions, unit normals, weights that sum to one, indices in range', () => {
  let rnd = 3; const rng = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const looks = [defaultLook('ann'), ...Array.from({length: 25}, () => randomLook(rng))];
  for (const [f, ids] of Object.entries(LOOK_OPTIONS)) for (const id of ids) looks.push({...defaultLook('bo'), [f]: id});
  for (const look of looks) {
    const fig = createAvatar(look);
    for (const m of meshes(fig)) {
      const g = m.geometry, pos = g.attributes.position, nor = g.attributes.normal, col = g.attributes.color, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, n = pos.count;
      assert.ok(n > 100 && n < 65536);
      for (const a of [nor, col, si, sw]) assert.equal(a.count, n);
      let minY = Infinity, maxY = -Infinity, maxR = 0;
      for (let i = 0; i < n; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'a finite position');
        minY = Math.min(minY, y); maxY = Math.max(maxY, y); maxR = Math.max(maxR, Math.hypot(x, z));
        const l = Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i));
        assert.ok(Math.abs(l - 1) < 1e-3, `a unit normal (${l}) in ${JSON.stringify(look)}`);
        for (const c of [col.getX(i), col.getY(i), col.getZ(i)]) assert.ok(c >= 0 && c <= 1);
        assert.ok(Math.abs(sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i) - 1) < 1e-5, 'weights sum to one');
        assert.ok(si.getX(i) < m.skeleton.bones.length && si.getY(i) < m.skeleton.bones.length);
      }
      // Feet on the floor, about 1.75 tall before the height option, and inside the sphere it is culled by.
      assert.ok(minY > -0.01 && minY < 0.03, 'feet at the floor: ' + minY);
      assert.ok(maxY > 1.6 && maxY < 2.25, 'head height: ' + maxY);
      assert.ok(maxR < 0.6, 'nothing sticks out sideways: ' + maxR);
      const idx = g.index;
      for (let i = 0; i < idx.count; i++) assert.ok(idx.getX(i) < n);
      assert.ok(g.boundingSphere.radius >= 1.3);
    }
    fig.userData.dispose();
  }
});

test('the same look always builds the same person', () => {
  const sig = look => { const f = createAvatar(look), g = meshes(f)[0].geometry, s = hashOf(Array.from(g.attributes.position.array.slice(0, 3000), v => v.toFixed(5)).join()) + ':' + g.index.count; f.userData.dispose(); return s; };
  assert.equal(sig(defaultLook('ann')), sig(defaultLook('ann')));
  assert.notEqual(sig(defaultLook('ann')), sig({...defaultLook('ann'), build: defaultLook('ann').build === 'soft' ? 'slim' : 'soft'}));
  // Junk never reaches the builder: it is cleaned to the default first.
  assert.equal(sig({hair: 'nope', skin: 'red'}), sig(defaultLook('')));
});

test('the update API other modules drive: speed, grounded, jumping and emote, plus the first rig\'s pivots', () => {
  const fig = makeHuman(lookFor('ann'), {shadow: false}), rig = fig.userData.rig;
  assert.equal(typeof fig.userData.update, 'function');
  for (const part of ['body', 'torso', 'head', 'armL', 'armR', 'legL', 'legR']) assert.ok(rig[part]?.isObject3D, 'rig.' + part);
  const pose = () => JSON.stringify(['legL', 'legR', 'armL', 'armR', 'foreL', 'foreR', 'shinL', 'shinR', 'spine', 'head'].map(n => rig.b[n].rotation.toArray().slice(0, 3).map(v => +v.toFixed(3))));
  const settle = st => { for (let i = 0; i < 40; i++) fig.userData.update(10 + i / 30, st); return pose(); };
  const idle = settle({}), walk = settle({speed: 5.2, cycle: 1.2}), run = settle({speed: 8.5, cycle: 1.2}), air = settle({grounded: false, jumping: true});
  assert.equal(new Set([idle, walk, run, air]).size, 4, 'idle, walk, run and jump are four different poses');
  assert.notEqual(settle({speed: 5.2, cycle: 1.2}), settle({speed: 5.2, cycle: 2.7}), 'the stride follows the cycle it is given');
  assert.notEqual(settle({moving: true}), idle, 'moving:true is a walk');
  // Arms swing against the legs.
  fig.userData.update(20, {speed: 5.2, cycle: Math.PI / 2});
  for (let i = 0; i < 30; i++) fig.userData.update(20 + i / 30, {speed: 5.2, cycle: Math.PI / 2});
  assert.ok(rig.b.legL.rotation.x * rig.b.armL.rotation.x < 0 && rig.b.legL.rotation.x * rig.b.legR.rotation.x < 0);
  // Emotes change the pose and the face, then end by themselves.
  const real = performance.now; let now = 1000; performance.now = () => now;
  try {
    for (const kind of ['wave', 'thumbs', 'clap', 'heart']) {
      const emote = {kind, at: now};
      now += 800; const during = settle({emote});
      assert.notEqual(during, idle, kind + ' moves the arms');
      if (kind === 'clap' || kind === 'heart') assert.ok(rig.b.joy.scale.x > 0.9 && rig.b.eyeL.scale.x < 0.1, kind + ' smiles with its eyes');
      if (kind === 'thumbs') assert.ok(rig.b.eyeR.scale.y < 0.2 && rig.b.eyeL.scale.y > 0.8, 'a wink');
      now += 2000; settle({emote});
      assert.ok(rig.b.joy.scale.x < 0.1 && rig.b.eyeL.scale.x > 0.9, kind + ' ends');
    }
  } finally { performance.now = real; }
  // Eyes blink on their own within a few seconds.
  let shut = false;
  for (let i = 0; i < 60 * 12 && !shut; i++) { fig.userData.update(100 + i / 60, {}); shut = rig.b.eyeL.scale.y < 0.3; }
  assert.ok(shut, 'a blink');
  // The older entry point is the same function, and odd input is survivable.
  assert.equal(animateHuman, animateAvatar);
  animateHuman(null, 0, {}); animateHuman(rig, 200); fig.userData.update(201, {speed: NaN, emote: {kind: 'dance', at: 0}});
  for (const n of Object.keys(rig.b)) for (const v of [...rig.b[n].position.toArray(), ...rig.b[n].scale.toArray()]) assert.ok(Number.isFinite(v), n + ' stays finite');
  // A new look rebuilds in place and keeps the same rig object for whoever holds it.
  const before = fig.userData.stats().tris;
  fig.userData.setLook({...lookFor('ann'), hair: 'bald', hat: 'none', beard: 'none'});
  assert.equal(fig.userData.rig, rig); assert.ok(fig.userData.stats().tris < before || lookFor('ann').hair === 'bald');
  assert.equal(meshes(fig).length, 2, 'the old meshes are gone');
  fig.userData.update(300, {speed: 5.2});
  fig.userData.dispose();
});
