// One avatar per account (lib/avatars.mjs, docs/concepts/13-avatars.md): the file store across restarts, the
// portrait choice, and the migration of looks saved before accounts had avatars (the newest wins, once).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {avatarStore, latestLook} from '../lib/avatars.mjs';
import {officeStorage} from '../lib/office-storage.mjs';
import {defaultAvatar, lookFromSpec, specFromLook} from '../public/avatar-spec.js';
import {defaultLook} from '../public/office-look-core.js';

const seedOf = email => 'm' + email.split('@')[0].padEnd(12, 'x').slice(0, 12);
const temp = () => mkdtempSync(join(tmpdir(), 'ff-avatars-'));

test('the file store keeps an avatar and the portrait choice per email, across a restart', async () => {
  const dir = temp();
  try {
    let s = avatarStore({dir, seedOf});
    let v = await s.get('Ann@Example.test');
    assert.deepEqual([v.email, v.custom, v.usePortrait, v.avatar], ['ann@example.test', false, false, defaultAvatar(seedOf('ann@example.test'))]);
    const mine = {...defaultAvatar('x'), hat: {style: 'cap', color: '#3d6fb6'}, future: 1};
    v = await s.save('ann@example.test', mine);
    assert.deepEqual([v.custom, v.avatar.hat.style, v.avatar.future], [true, 'cap', 1]);
    await assert.rejects(s.save('ann@example.test', {...mine, skin: 'beige'}), {status: 400});
    await assert.rejects(s.save('ann@example.test', {...mine, notes: 'x'.repeat(3000)}), {status: 413});
    await s.setUsePortrait('ann@example.test', true);
    s = avatarStore({dir, seedOf});
    v = await s.get('ann@example.test');
    assert.deepEqual([v.custom, v.usePortrait, v.avatar.future], [true, true, 1]);
    // Saving the default is having none; the toggle stays.
    v = await s.save('ann@example.test', defaultAvatar(seedOf('ann@example.test')));
    assert.deepEqual([v.custom, v.usePortrait], [false, true]);
    v = await s.save('ann@example.test', null);
    assert.deepEqual([v.custom, v.usePortrait], [false, true]);
    const many = await s.many(['ann@example.test', 'BO@example.test', '']);
    assert.deepEqual([...many.keys()], ['ann@example.test', 'bo@example.test']);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('latestLook: the most recently saved look wins', () => {
  assert.equal(latestLook([]), null);
  assert.equal(latestLook([{data: {a: 1}, updated: 3}, {data: {b: 1}, updated: 9}, {data: {c: 1}, updated: 5}]).data.b, 1);
  assert.equal(latestLook([{data: {a: 1}, updated: 0}, {data: null, updated: 99}]).data.a, 1, 'rows without a look do not count');
  assert.equal(latestLook([{data: {a: 1}, updated: 4}, {data: {b: 1}, updated: 4}]).data.a, 1, 'ties keep the first');
});

test('per-office looks migrate into the account once: the newest wins, and a reset is not undone', async () => {
  const dir = temp();
  try {
    const email = 'cy@example.test', key = seedOf(email);
    // Before accounts had avatars: a look per person, and one kept with a room's decor in another office.
    mkdirSync(dir, {recursive: true});
    const older = {...defaultLook(key), hair: 'bun'}, newer = {...defaultLook(key), hair: 'braids', hat: 'bucket'};
    writeFileSync(join(dir, '_office-state.json'), JSON.stringify({looks: [{member: key, data: older, updated: 1000}],
      decor: [{env: 'env-b', member: key, data: {theme: null, props: [], look: newer, lookUpdated: 2000}}, {env: 'env-c', member: 'mother', data: {look: older, lookUpdated: 9999}}]}));
    const office = await officeStorage({dir, secret: 's'});
    let asked = 0;
    const legacy = async e => { asked++; return office.legacyLooks(seedOf(e)); };
    let s = avatarStore({dir, seedOf, legacy});
    let v = await s.get(email);
    assert.equal(v.custom, true);
    assert.deepEqual(lookFromSpec(v.avatar, key), lookFromSpec(specFromLook(newer, {seed: key}), key), 'the most recently saved look');
    await s.get(email); assert.equal(asked, 1, 'read from the old store once');
    // A fresh process reads the account row, not the old looks.
    s = avatarStore({dir, seedOf, legacy}); await s.get(email); assert.equal(asked, 1);
    // Going back to the default does not bring the old look back.
    await s.save(email, null);
    s = avatarStore({dir, seedOf, legacy});
    assert.equal((await s.get(email)).custom, false); assert.equal(asked, 1);
    // The other way round: the per-person look is newer than the decor one.
    const dir2 = temp();
    try {
      writeFileSync(join(dir2, '_office-state.json'), JSON.stringify({looks: [{member: key, data: newer, updated: 5000}], decor: [{env: 'e', member: key, data: {look: older, lookUpdated: 10}}]}));
      const o2 = await officeStorage({dir: dir2, secret: 's'});
      const s2 = avatarStore({dir: dir2, seedOf, legacy: e => o2.legacyLooks(seedOf(e))});
      assert.equal((await s2.get(email)).avatar.hair.style, 'braids');
      // Nothing to migrate: the default, and no row is needed.
      assert.equal((await s2.get('nobody@example.test')).custom, false);
    } finally { rmSync(dir2, {recursive: true, force: true}); }
    // A legacy look that is just the default is no avatar.
    const dir3 = temp();
    try {
      const s3 = avatarStore({dir: dir3, seedOf, legacy: async () => [{data: defaultLook(key), updated: 1}]});
      assert.equal((await s3.get(email)).custom, false);
    } finally { rmSync(dir3, {recursive: true, force: true}); }
    // A failing old store is not fatal.
    const s4 = avatarStore({dir: null, seedOf, legacy: async () => { throw Error('down'); }});
    assert.equal((await s4.get(email)).custom, false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
