// What a person looks like in the 3D office: the look schema's allow-lists and colour limits, migration
// from older looks, the default look per key, and saving one (in memory, on disk, and over the event stream).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {officeHub, officeState} from '../lib/office.mjs';
import {officeStorage} from '../lib/office-storage.mjs';
import {createLookBook} from '../lib/office-look.mjs';
import {cleanLook as wardrobe} from '../public/office-decor-core.js';
import {LOOK_VERSION, LOOK_OPTIONS, LOOK_FIELDS, LOOK_COLORS, LOOK_TOGGLES, LOOK_SWATCHES, LOOK_LABELS, COLOR_LIMITS, cleanLook, clampColor, defaultLook,
  migrateLook, randomLook, sameLook, lookLabel, parseHex, hashOf} from '../public/office-look-core.js';

const lightness = hex => { const [r, g, b] = parseHex(hex).map(n => n / 255); return (Math.max(r, g, b) + Math.min(r, g, b)) / 2; };

test('every field is an option, a toggle or a colour, and every option has a name', () => {
  for (const f of LOOK_FIELDS) assert.ok(LOOK_OPTIONS[f] || LOOK_TOGGLES.includes(f) || LOOK_COLORS.includes(f), f);
  assert.equal(new Set(LOOK_FIELDS).size, LOOK_FIELDS.length);
  for (const [f, ids] of Object.entries(LOOK_OPTIONS)) {
    assert.ok(LOOK_LABELS[f], 'a name for ' + f);
    assert.equal(new Set(ids).size, ids.length, f + ' has no duplicates');
    for (const id of ids) assert.ok(lookLabel(f, id) && lookLabel(f, id) !== id, `a name for ${f} ${id}`);
  }
  // What the office promises: the variety of each part.
  const count = f => LOOK_OPTIONS[f].length;
  assert.deepEqual([count('eyes'), count('brows'), count('nose'), count('mouth'), count('beard'), count('glasses')], [4, 4, 3, 4, 5, 4]);
  assert.ok(count('hair') >= 10);
  for (const h of ['short', 'buzz', 'curly', 'afro', 'long', 'ponytail', 'bun', 'braids', 'mohawk', 'bald']) assert.ok(LOOK_OPTIONS.hair.includes(h), h);
  assert.deepEqual(LOOK_OPTIONS.hat, ['none', 'cap', 'beanie', 'bucket', 'captain', 'headphones']);
  assert.deepEqual(LOOK_OPTIONS.top, ['tee', 'hoodie', 'buttonup', 'blazer', 'sweater', 'tank']);
  assert.deepEqual(LOOK_OPTIONS.bottoms, ['jeans', 'chinos', 'shorts', 'skirt', 'joggers']);
  assert.deepEqual(LOOK_OPTIONS.shoes, ['sneakers', 'boots', 'loafers', 'sandals']);
  assert.ok(LOOK_SWATCHES.skin.length >= 10, 'a wide range of skin tones');
  for (const [f, list] of Object.entries(LOOK_SWATCHES)) for (const c of list) assert.equal(clampColor(f, c), c, `${f} swatch ${c} is inside its own limits`);
});

test('option ids are allow-listed: a save refuses anything else, a read falls back to the default', () => {
  const base = defaultLook('ann');
  for (const f of Object.keys(LOOK_OPTIONS)) {
    for (const id of LOOK_OPTIONS[f]) assert.equal(cleanLook({...base, [f]: id}, {key: 'ann', strict: true})[f], id);
    for (const bad of ['nope', '', 7, {}, ['short'], '__proto__', 'constructor']) {
      assert.throws(() => cleanLook({...base, [f]: bad}, {key: 'ann', strict: true}), {status: 400, code: 'invalid_input'}, `${f}=${JSON.stringify(bad)}`);
      assert.equal(cleanLook({...base, [f]: bad}, {key: 'ann'})[f], base[f]);
    }
  }
  assert.equal(cleanLook({...base, hair: ' AFRO '}, {key: 'ann', strict: true}).hair, 'afro', 'ids are trimmed and lower-cased');
  for (const f of LOOK_TOGGLES) {
    assert.throws(() => cleanLook({...base, [f]: 'yes'}, {key: 'ann', strict: true}), {status: 400});
    assert.equal(cleanLook({...base, [f]: 'yes'}, {key: 'ann'})[f], base[f]);
    assert.equal(cleanLook({...base, [f]: !base[f]}, {key: 'ann', strict: true})[f], !base[f]);
  }
  for (const bad of [null, undefined, 'look', 4, [], [base]]) {
    assert.throws(() => cleanLook(bad, {strict: true}), {status: 400, code: 'invalid_input'});
    assert.deepEqual(cleanLook(bad, {key: 'ann'}), base);
  }
  assert.throws(() => cleanLook({...base, v: LOOK_VERSION + 1}, {strict: true}), {status: 400}, 'a newer schema than this server knows');
  // Nothing but the known fields comes out.
  const out = cleanLook({...base, admin: true, email: 'someone@example.test', __proto__: {x: 1}, script: '<b>'}, {key: 'ann', strict: true});
  assert.deepEqual(Object.keys(out).sort(), ['v', ...LOOK_FIELDS].sort());
  assert.equal(out.v, LOOK_VERSION);
});

test('colours are hex, any hue, with lightness clamped per material', () => {
  assert.equal(clampColor('topColor', '#3D6FB6'), '#3d6fb6');
  assert.equal(clampColor('topColor', 'abc'), '#aabbcc', 'three digits, with or without the hash');
  for (const bad of ['red', '#12', '#1234567', 'rgb(1,2,3)', 'javascript:1', '', null, 7, {}, '#gggggg', '#3d6fb6;x']) assert.equal(clampColor('skin', bad), null, String(bad));
  for (const f of LOOK_COLORS) {
    const [lo, hi] = COLOR_LIMITS[f];
    for (const c of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#010203', '#fefefe', '#808080']) {
      const l = lightness(clampColor(f, c));
      assert.ok(l >= lo - 0.012 && l <= hi + 0.012, `${f} ${c} -> lightness ${l.toFixed(3)} within ${lo}..${hi}`);
    }
  }
  assert.ok(lightness(clampColor('skin', '#000000')) > 0.14, 'skin never goes black: the face stays readable');
  assert.ok(lightness(clampColor('skin', '#ffffff')) < 0.95);
  // A custom skin colour keeps its hue.
  assert.equal(clampColor('skin', '#4466cc'), '#4466cc');
  const base = defaultLook('ann');
  for (const f of LOOK_COLORS) {
    assert.throws(() => cleanLook({...base, [f]: 'blue'}, {key: 'ann', strict: true}), {status: 400, code: 'invalid_input'});
    assert.equal(cleanLook({...base, [f]: 'blue'}, {key: 'ann'})[f], base[f]);
    assert.equal(cleanLook({...base, [f]: '#000'}, {key: 'ann', strict: true})[f], clampColor(f, '#000000'), 'too dark is clamped, not refused');
  }
});

test('the default look is the same for a key every time, valid, and varied across people', () => {
  assert.deepEqual(defaultLook('m4Xk2'), defaultLook('m4Xk2'));
  assert.deepEqual(JSON.parse(JSON.stringify(defaultLook('m4Xk2'))), defaultLook('m4Xk2'), 'plain JSON');
  const seen = Object.fromEntries(LOOK_FIELDS.map(f => [f, new Set()]));
  for (let i = 0; i < 400; i++) {
    const key = 'member-' + i, l = defaultLook(key);
    assert.deepEqual(cleanLook(l, {key, strict: true}), l, 'a default passes its own validation unchanged');
    assert.notEqual(l.accent, l.topColor, 'a pattern always shows');
    for (const f of LOOK_FIELDS) seen[f].add(l[f]);
  }
  for (const f of Object.keys(LOOK_OPTIONS)) assert.ok(seen[f].size >= Math.min(3, LOOK_OPTIONS[f].length), `${f} varies (${seen[f].size})`);
  assert.equal(seen.hair.size, LOOK_OPTIONS.hair.length, 'every hair style turns up');
  assert.ok(seen.skin.size >= 10 && seen.topColor.size >= 12);
  assert.equal(typeof hashOf('x'), 'number');
  assert.deepEqual(defaultLook(undefined), defaultLook(''));
  // What is left out of a saved look comes from that person's default, so a later field is compatible.
  const part = cleanLook({v: LOOK_VERSION, hair: 'mohawk'}, {key: 'm4Xk2', strict: true});
  assert.deepEqual(part, {...defaultLook('m4Xk2'), hair: 'mohawk'});
});

test('older looks migrate: the first figures, and the first wardrobe panel', () => {
  // v1: four colours and a hair style number.
  const v1 = cleanLook({skin: '#c08259', hair: '#1c1c1c', shirt: '#3d6fb6', pants: '#2d3a4a', style: 1}, {key: 'ann'});
  assert.equal(v1.v, LOOK_VERSION);
  assert.deepEqual([v1.skin, v1.hairColor, v1.topColor, v1.bottomsColor, v1.hair], ['#c08259', '#1c1c1c', '#3d6fb6', '#2d3a4a', 'long']);
  assert.deepEqual([0, 1, 2, 3].map(style => cleanLook({style}, {key: 'ann'}).hair), ['short', 'long', 'sidepart', 'buzz']);
  assert.equal(cleanLook({style: 9}, {key: 'ann'}).hair, defaultLook('ann').hair);
  // The wardrobe panel: skin, hair, top, bottoms and one accessory, as colours or as ids.
  const w = cleanLook({skin: '#f7d9c4', hair: 'curly', top: '#a8524c', bottoms: 'shorts', accessory: 'glasses'}, {key: 'bo'});
  assert.deepEqual([w.skin, w.hair, w.topColor, w.bottoms, w.glasses], ['#f7d9c4', 'curly', '#a8524c', 'shorts', 'round']);
  assert.equal(w.top, defaultLook('bo').top, 'a colour under "top" leaves the style alone');
  const w2 = cleanLook({hair: '#ddc48d', top: 'T-Shirt', bottoms: 'pants', accessory: 'Headphones'}, {key: 'bo'});
  assert.deepEqual([w2.hairColor, w2.top, w2.bottoms, w2.hat], ['#ddc48d', 'tee', 'chinos', 'headphones']);
  assert.equal(w2.hair, defaultLook('bo').hair);
  assert.deepEqual(['cap', 'beanie', 'captain', 'sunglasses', 'none', 'wings'].map(accessory => { const l = cleanLook({accessory}, {key: 'bo'}); return [l.hat, l.glasses]; }),
    [['cap', defaultLook('bo').glasses], ['beanie', defaultLook('bo').glasses], ['captain', defaultLook('bo').glasses], [defaultLook('bo').hat, 'shades'], [defaultLook('bo').hat, defaultLook('bo').glasses], [defaultLook('bo').hat, defaultLook('bo').glasses]]);
  // Exactly what office-decor-core.js cleanLook accepts: every field carries over.
  const decor = wardrobe({skin: '#f7d9c4', hair: '#2b1d14', hairStyle: 1, topStyle: 'hoodie', top: '#3d6fb6', bottoms: '#2d3a4a', accessory: 'glasses'});
  const d = cleanLook(decor, {key: 'cy', strict: true});
  assert.deepEqual([d.skin, d.hairColor, d.hair, d.top, d.topColor, d.bottomsColor, d.glasses, d.hat], ['#f7d9c4', '#2b1d14', 'long', 'hoodie', '#3d6fb6', '#2d3a4a', 'round', defaultLook('cy').hat]);
  for (const [topStyle, top] of [['tee', 'tee'], ['hoodie', 'hoodie'], ['shirt', 'buttonup']]) assert.equal(cleanLook({...decor, topStyle}, {key: 'cy', strict: true}).top, top);
  for (const [hairStyle, hair] of [[0, 'short'], [1, 'long'], [2, 'sidepart'], [3, 'buzz']]) assert.equal(cleanLook({...decor, hairStyle}, {key: 'cy', strict: true}).hair, hair);
  for (const [accessory, f, v] of [['cap', 'hat', 'cap'], ['headphones', 'hat', 'headphones'], ['glasses', 'glasses', 'round']]) assert.equal(cleanLook({...decor, accessory}, {key: 'cy', strict: true})[f], v);
  // Strict: a migrated value is still checked.
  assert.throws(() => cleanLook({hair: 'spikes'}, {key: 'bo', strict: true}), {status: 400});
  assert.deepEqual(migrateLook(null), {});
  // Today's looks pass through untouched.
  const now = defaultLook('cy');
  assert.deepEqual(cleanLook(now, {key: 'someone-else', strict: true}), now);
});

test('random looks are valid, and sameLook compares the fields', () => {
  let n = 0;
  const rng = () => (n = (n * 1103515245 + 12345) % 2147483648) / 2147483648;
  const all = new Set();
  for (let i = 0; i < 200; i++) { const l = randomLook(rng); assert.deepEqual(cleanLook(l, {strict: true, key: 'x'}), l); all.add(JSON.stringify(l)); }
  assert.ok(all.size > 190);
  const a = defaultLook('ann');
  assert.ok(sameLook(a, {...a, v: 99, extra: 1}));
  assert.ok(!sameLook(a, {...a, blush: !a.blush}));
  assert.ok(!sameLook(a, null));
});

test('the look book: a save is strict, the default is stored as nothing, and stored looks are read once', async () => {
  const rows = new Map(), calls = [];
  const storage = {looks: async keys => { calls.push(keys); return keys.filter(k => rows.has(k)).map(k => ({member: k, data: rows.get(k)})); }, look: async (k, v) => { if (v) rows.set(k, v); else rows.delete(k); }};
  // An older stored look still draws.
  rows.set('mOld', {skin: '#c08259', hair: '#1c1c1c', shirt: '#3d6fb6', pants: '#2d3a4a', style: 3});
  const book = createLookBook({storage});
  await book.load(['mOld', 'mNew']); await book.load(['mOld', 'mNew', 'mOld']);
  assert.deepEqual(calls, [['mOld', 'mNew']], 'each key is read once');
  assert.equal(book.get('mOld').hair, 'buzz'); assert.equal(book.get('mNew'), null);
  assert.deepEqual(Object.keys(book.forSnapshot(['mOld', 'mNew', 'mGone'])), ['mOld']);
  const mine = {...defaultLook('mNew'), hair: 'mohawk', hairColor: '#3f6fd1'};
  let r = book.set('mNew', mine); await r.write;
  assert.deepEqual(r.look, mine); assert.deepEqual(rows.get('mNew'), mine); assert.deepEqual(book.get('mNew'), mine);
  assert.throws(() => book.set('mNew', {...mine, hat: 'crown'}), {status: 400});
  assert.deepEqual(book.get('mNew'), mine, 'a refused save changes nothing');
  r = book.set('mNew', defaultLook('mNew')); await r.write;
  assert.equal(r.look, null, 'saving the default is having none'); assert.ok(!rows.has('mNew'));
  r = book.set('mOld', null); await r.write;
  assert.equal(book.get('mOld'), null); assert.ok(!rows.has('mOld'));
  // No storage: memory only.
  const mem = createLookBook();
  await mem.load(['a']); assert.equal(mem.set('a', mine).write, undefined); assert.deepEqual(mem.get('a'), cleanLook(mine, {key: 'a'}));
});

test('file storage keeps looks across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ff-look-'));
  try {
    let s = await officeStorage({dir, secret: 's'});
    const look = {...defaultLook('m1'), hat: 'captain'};
    await s.look('m1', look); await s.look('m2', defaultLook('zz'));
    s = await officeStorage({dir, secret: 's'});
    assert.deepEqual(await s.looks(['m1', 'm3']), [{member: 'm1', data: look}]);
    await s.look('m1', null);
    s = await officeStorage({dir, secret: 's'});
    assert.deepEqual((await s.looks(['m1', 'm2'])).map(r => r.member), ['m2']);
    // The rest of the office state is untouched by looks.
    const room = await s.room('env');
    assert.deepEqual([room.chat, room.status], [[], []]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

function sse(url) {
  const events = []; let buf = '', res;
  const ready = new Promise((ok, no) => { const req = http.get(url, r => { res = r; r.setEncoding('utf8'); r.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const type = /^event: (.+)$/m.exec(b)?.[1], data = /^data: (.+)$/m.exec(b)?.[1]; if (type) events.push({type, data: JSON.parse(data)}); } }); ok(); }); req.on('error', no); });
  const next = async (type, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end;) { const i = events.findIndex(e => e.type === type); if (i >= 0) return events.splice(i, 1)[0].data; await new Promise(r => setTimeout(r, 10)); } throw Error('no ' + type + ' event'); };
  return {ready, next, events, close: () => res?.destroy()};
}

test('a saved look reaches everyone in the office at once, and the next snapshot has it', async () => {
  const users = {ann: {email: 'ann@example.test', name: 'Ann'}, bo: {email: 'bo@example.test', name: 'Bo'}, cy: {email: 'cy@example.test', name: 'Cy'}};
  const ctxs = {
    env1: {id: 'env1', name: 'Studio', ownerEmail: users.ann.email, members: [users.ann, users.bo].map(u => ({...u})), projects: [], agents: []},
    env2: {id: 'env2', name: 'Other', ownerEmail: users.cy.email, members: [users.cy, users.ann].map(u => ({...u})), projects: [], agents: []},
    env3: {id: 'env3', name: 'Elsewhere', ownerEmail: users.cy.email, members: [{...users.cy}], projects: [], agents: []},
  };
  const access = {ok: true, all: true, projectIds: new Set()}, stored = new Map();
  const storage = {secret: 's', room: async () => ({chat: [], status: []}), status: async () => {}, say: async () => [],
    looks: async keys => keys.filter(k => stored.has(k)).map(k => ({member: k, data: stored.get(k)})), look: async (k, v) => { if (v) stored.set(k, v); else stored.delete(k); }};
  const hub = officeHub({state: officeState(), context: {env: async id => ctxs[id]}, heartbeatMs: 60e3, storage});
  const server = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); await hub.connect(u.searchParams.get('env'), users[u.searchParams.get('as')], access, req, res); });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = (who, env) => `http://127.0.0.1:${server.address().port}/events?as=${who}&env=${env}`, open = [];
  const join = async (who, env) => { const s = sse(url(who, env)); open.push(s); await s.ready; return [s, await s.next('snapshot')]; };
  try {
    const [ann, sa] = await join('ann', 'env1'), [bo] = await join('bo', 'env1'), [cy2] = await join('cy', 'env2'), [cy3] = await join('cy', 'env3');
    const annKey = sa.me.key;
    assert.deepEqual(sa.looks, {}, 'nobody has chosen a look yet');
    const mine = {...defaultLook(annKey), hair: 'afro', hat: 'captain', topColor: '#c8553d'};
    await assert.rejects(hub.setLook('env1', users.ann, {look: {...mine, hair: 'spikes'}}), {status: 400, code: 'invalid_input'});
    await assert.rejects(hub.setLook('env1', users.ann, {}), {status: 400});
    await assert.rejects(hub.setLook('env1', users.ann, null), {status: 400});
    await assert.rejects(hub.setLook('env3', users.ann, {look: mine}), {status: 409, code: 'not_connected'});
    const out = await hub.setLook('env1', users.ann, {look: {...mine, junk: 1}});
    assert.deepEqual(out, {ok: true, key: annKey, look: mine});
    assert.deepEqual(stored.get(annKey), mine);
    for (const s of [ann, bo, cy2]) assert.deepEqual(await s.next('look'), {key: annKey, look: mine}, 'every office she is a member of hears');
    await new Promise(r => setTimeout(r, 60));
    assert.ok(!cy3.events.some(e => e.type === 'look'), 'an office she is not in does not');
    assert.ok(!JSON.stringify(out).includes('@'), 'a look carries no email');
    // A later visitor sees it in the snapshot; so does a fresh server reading storage.
    const [, sb2] = await join('bo', 'env1');
    assert.deepEqual(sb2.looks, {[annKey]: mine});
    const hub2 = officeHub({state: officeState(), context: {env: async id => ctxs[id]}, heartbeatMs: 60e3, storage, secret: Buffer.from('other')});
    hub2.close();
    // Back to the default: stored as nothing, announced as null.
    assert.equal((await hub.setLook('env1', users.ann, {look: null})).look, null);
    assert.deepEqual(await bo.next('look'), {key: annKey, look: null});
    assert.ok(!stored.has(annKey));
    // Saves are rate limited per person.
    let limited = 0;
    for (let i = 0; i < 20; i++) await hub.setLook('env1', users.ann, {look: {...mine, blush: i % 2 === 0}}).catch(e => { if (e.status === 429) limited++; else throw e; });
    assert.ok(limited > 0);
  } finally { for (const s of open) s.close(); hub.close(); await new Promise(ok => server.close(ok)); }
});

// The real server in local single-user mode: POST /api/office/{env}/look is same-origin only, strict, and
// what it saves is in the next snapshot, also after a restart.
test('the server route: same-origin, strict, and a saved look survives a restart', async () => {
  const {spawn} = await import('node:child_process');
  const ROOT = new URL('..', import.meta.url).pathname, dir = mkdtempSync(join(tmpdir(), 'ff-look-srv-'));
  const start = async () => {
    const app = spawn(process.execPath, ['server.mjs'], {cwd: ROOT, env: {...process.env, FLOW_SYNC_URL: '', FLOW_SYNC_TOKEN: '', DATABASE_URL: '', PORT: '0', ORG_CHART_VERIFY: '1',
      OPID_BASE_URL: '', OPID_APP_ID: '', OPID_APP_SECRET: '', OPID_APP_ORIGIN: '', BACKUP_DIR: join(dir, 'backups'), SAVES_DIR: join(dir, 'saves'), INBOX_DIR: join(dir, 'inbox')}});
    let err = ''; app.stderr.on('data', d => err += d);
    const base = await new Promise((resolve, reject) => { let out = ''; app.stdout.on('data', c => { out += c; const url = /Flygon Flow: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1]; if (url) resolve(url); }); app.once('exit', () => reject(Error('server did not start: ' + err))); });
    return {app, base};
  };
  const post = (base, path, body, headers = {}) => fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)}).then(async r => ({status: r.status, data: await r.json().catch(() => null)}));
  let run = await start();
  try {
    let s = sse(run.base + '/api/office/default-workspace/events'); await s.ready;
    const snap = await s.next('snapshot'), key = snap.me.key;
    assert.deepEqual(snap.looks, {});
    const mine = {...defaultLook(key), hair: 'braids', hat: 'beanie', hatColor: '#c8553d'};
    assert.equal((await post(run.base, '/api/office/default-workspace/look', {look: mine}, {origin: 'https://evil.example'})).status, 403, 'other sites cannot call it');
    assert.equal((await post(run.base, '/api/office/nowhere-env/look', {look: mine})).status, 404);
    let r = await post(run.base, '/api/office/default-workspace/look', {look: {...mine, top: 'cape'}});
    assert.deepEqual([r.status, r.data.code], [400, 'invalid_input']);
    r = await post(run.base, '/api/office/default-workspace/look', {look: {...mine, skin: '#000000', extra: 'x'}});
    assert.equal(r.status, 200); assert.equal(r.data.look.skin, clampColor('skin', '#000000')); assert.ok(!('extra' in r.data.look));
    const saved = r.data.look;
    assert.deepEqual(await s.next('look'), {key, look: saved});
    s.close(); run.app.kill(); await new Promise(ok => run.app.once('exit', ok));
    // A new process reads it back from disk.
    run = await start();
    s = sse(run.base + '/api/office/default-workspace/events'); await s.ready;
    assert.deepEqual((await s.next('snapshot')).looks, {[key]: saved});
    r = await post(run.base, '/api/office/default-workspace/look', {look: null});
    assert.deepEqual([r.status, r.data.look], [200, null]);
    assert.deepEqual(await s.next('look'), {key, look: null});
    s.close();
  } finally { run.app.kill(); setTimeout(() => { try { rmSync(dir, {recursive: true, force: true}); } catch { /* still closing */ } }, 300); }
});
