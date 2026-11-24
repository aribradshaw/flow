// Presence status for the 3D office: validation, the automatic Away rule, and the SSE broadcast.
// Knocking is covered in the same file once the door is wired. In memory only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {officeHub, officeState} from '../lib/office.mjs';
import {ADMIT_MS, AWAY_IDLE_MS, allowKnock, cleanPresenceStatus, doorPolicy, isQuietStatus, knockLabel, nextPresence, roomLocal} from '../public/office-status-core.js';

test('status text is one line of at most 60 characters, and the status is one of the four', () => {
  assert.deepEqual(cleanPresenceStatus({status: ' Focus ', text: '  on   a call \n'}), {status: 'focus', text: 'on a call'});
  assert.deepEqual(cleanPresenceStatus({status: 'away'}), {status: 'away', text: ''});
  assert.equal(cleanPresenceStatus({status: 'available', text: 'x'.repeat(60)}).text.length, 60);
  assert.throws(() => cleanPresenceStatus({status: 'busy'}), {status: 400, code: 'invalid_input'});
  assert.throws(() => cleanPresenceStatus(null), {status: 400, code: 'invalid_input'});
  assert.throws(() => cleanPresenceStatus({status: 'dnd', text: 'x'.repeat(61)}), {status: 400, code: 'invalid_input'});
  assert.throws(() => cleanPresenceStatus({status: 'dnd', text: 4}), {status: 400, code: 'invalid_input'});
  assert.equal(isQuietStatus('dnd'), true);
  assert.equal(isQuietStatus('focus'), false);
});

test('automatic Away waits 10 minutes of no input with the tab hidden, and clears on return', () => {
  assert.equal(AWAY_IDLE_MS, 10 * 60 * 1000);
  const idle = AWAY_IDLE_MS;
  assert.deepEqual(nextPresence({choice: 'focus', current: 'focus', hidden: true, idleMs: idle - 1}), {status: 'focus', auto: false, changed: false});
  assert.deepEqual(nextPresence({choice: 'focus', current: 'focus', hidden: true, idleMs: idle}), {status: 'away', auto: true, changed: true});
  assert.deepEqual(nextPresence({choice: 'focus', current: 'away', auto: true, hidden: true, idleMs: idle + 5}), {status: 'away', auto: true, changed: false}, 'stays away while the tab is still hidden');
  assert.deepEqual(nextPresence({choice: 'focus', current: 'away', auto: true, hidden: false, idleMs: idle}), {status: 'focus', auto: false, changed: true}, 'a visible tab clears it');
  assert.deepEqual(nextPresence({choice: 'focus', current: 'away', auto: true, hidden: true, idleMs: 0}), {status: 'focus', auto: false, changed: true}, 'any input clears it');
  assert.deepEqual(nextPresence({choice: 'available', current: 'available', hidden: false, idleMs: idle * 2}), {status: 'available', auto: false, changed: false}, 'a visible tab never goes away on its own');
  assert.deepEqual(nextPresence({choice: 'away', current: 'away', hidden: false, idleMs: 0}), {status: 'away', auto: false, changed: false}, 'an Away they picked stays');
  assert.deepEqual(nextPresence({choice: 'away', current: 'away', auto: true, hidden: false, idleMs: 0}), {status: 'away', auto: false, changed: true});
  assert.equal(nextPresence({choice: 'focus', current: 'focus', hidden: true, idleMs: 1000, awayAfterMs: 1000}).status, 'away');
});

test('room local follows the office yaw, and a +90 degree hinge swing points into the room', () => {
  assert.deepEqual(roomLocal(10, 20, 0, 10, 24.5), {x: 0, z: 4.5});
  const side = roomLocal(0, 0, Math.PI / 2, 4.5, 0);
  assert.ok(Math.abs(side.x) < 1e-9 && Math.abs(side.z - 4.5) < 1e-9, 'local +z at yaw +90 is world +x');
  // The same yaw matrix as officeBox / Three.js rotation.y. A point on the door's +x edge.
  const yaw = Math.PI / 2, c = Math.cos(yaw), s = Math.sin(yaw), x = 1.5, z = 0;
  const swung = {x: x * c + z * s, z: -x * s + z * c};
  assert.ok(Math.abs(swung.x) < 1e-9 && swung.z < 0, 'swing +90 sends the slab toward local −z');
});

test('a knock is allowed once per 10 seconds for a pair', () => {
  assert.equal(allowKnock(null, 1000), true);
  assert.equal(allowKnock(1000, 10999), false);
  assert.equal(allowKnock(1000, 11000), true);
  assert.equal(knockLabel(1), '1 knock');
  assert.equal(knockLabel(2), '2 knocks');
  assert.deepEqual(doorPolicy({online: false, presence: 'focus'}), {open: true, enter: false, knock: false, sound: false});
  assert.equal(doorPolicy({online: true, presence: 'available'}).enter, true);
  assert.equal(doorPolicy({online: true, presence: 'focus'}).knock, true);
  assert.equal(doorPolicy({online: true, presence: 'dnd'}).sound, false);
  assert.equal(doorPolicy({online: true, presence: 'focus', admitted: true}).open, true);
});

function sse(url) {
  const events = [];
  let buf = '';
  let res;
  const ready = new Promise((ok, no) => {
    const req = http.get(url, r => {
      res = r;
      r.setEncoding('utf8');
      r.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type) events.push({type, data: JSON.parse(data)});
        }
      });
      ok(r);
    });
    req.on('error', no);
  });
  const next = async (type, ms = 2000) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      const i = events.findIndex(e => e.type === type);
      if (i >= 0) return events.splice(i, 1)[0].data;
      await new Promise(r => setTimeout(r, 10));
    }
    throw Error('no ' + type + ' event');
  };
  return {ready, events, next, close: () => res?.destroy()};
}

test('status is validated, stored per person, and broadcast only inside the offices they have open', async () => {
  let time = 0;
  const users = {
    ann: {email: 'ann@example.test', name: 'Ann'},
    bo: {email: 'bo@example.test', name: 'Bo'},
    cy: {email: 'cy@example.test', name: 'Cy'},
  };
  const ctx = {
    id: 'env1', name: 'Studio', ownerEmail: users.ann.email,
    members: Object.values(users).map(u => ({email: u.email, name: u.name})),
    projects: [], agents: [],
  };
  const access = {ok: true, all: true, projectIds: new Set()};
  const hub = officeHub({state: officeState({now: () => time}), context: {env: async () => ctx}, now: () => time, heartbeatMs: 60e3});
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const who = u.searchParams.get('as');
    const env = u.searchParams.get('env') || 'env1';
    if (u.pathname === '/events') { await hub.connect(env, users[who], access, req, res); return; }
    res.writeHead(404);
    res.end();
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = (who, env = 'env1') => `http://127.0.0.1:${server.address().port}/events?as=${who}&env=${env}`;
  try {
    const ann = sse(url('ann'));
    const bo = sse(url('bo'));
    const cy = sse(url('cy', 'env2'));
    await Promise.all([ann.ready, bo.ready, cy.ready]);
    const sa = await ann.next('snapshot');
    const sb = await bo.next('snapshot');
    await cy.next('snapshot');
    const annKey = sa.me.key;
    assert.equal(sa.statuses.find(s => s.key === annKey).status, 'available');
    assert.ok(!JSON.stringify(sa.statuses).includes('@'), 'statuses carry no email');
    // Bo joining tells the office he is available. That is not Ann's change.
    assert.equal((await ann.next('status')).key, sb.me.key);

    assert.throws(() => hub.setStatus('env1', users.ann, {status: 'asleep'}), {status: 400, code: 'invalid_input'});
    assert.throws(() => hub.setStatus('env1', users.ann, {status: 'focus', text: 'x'.repeat(61)}), {status: 400, code: 'invalid_input'});
    assert.throws(() => hub.setStatus('env1', {email: 'zed@example.test'}, {status: 'away'}), {status: 409, code: 'not_connected'});

    const set = hub.setStatus('env1', users.ann, {status: 'focus', text: '  on \n a call  '});
    assert.equal(set.text, 'on a call');
    assert.deepEqual(await bo.next('status'), {key: annKey, status: 'focus', text: 'on a call'});
    assert.deepEqual(await ann.next('status'), {key: annKey, status: 'focus', text: 'on a call'}, 'her other tab hears it too');
    await new Promise(r => setTimeout(r, 30));
    assert.ok(!cy.events.some(e => e.type === 'status'), 'another office does not hear it');

    hub.setStatus('env1', users.ann, {status: 'dnd', text: ''});
    assert.equal((await bo.next('status')).status, 'dnd');
    assert.equal(hub.isQuiet(users.ann.email), true);
    assert.equal(hub.isQuiet(annKey), true);
    assert.equal(hub.isQuiet(users.bo.email), false);
    assert.equal(hub.isQuiet('mnot-a-person'), false);

    ann.close();
    const again = sse(url('ann'));
    await again.ready;
    const snap = await again.next('snapshot');
    assert.deepEqual(snap.statuses.find(s => s.key === annKey), {key: annKey, status: 'dnd', text: ''}, 'status survives leaving and coming back');
    again.close();
    bo.close();
    cy.close();
  } finally {
    hub.close();
    server.close();
  }
});

test('knocks and answers stay inside that office, one per 10 seconds for a pair', async () => {
  let time = 0;
  const users = {
    ann: {email: 'ann@example.test', name: 'Ann'},
    bo: {email: 'bo@example.test', name: 'Bo'},
    dee: {email: 'dee@example.test', name: 'Dee'},
    cy: {email: 'cy@example.test', name: 'Cy'},
    zed: {email: 'zed@example.test', name: 'Zed'},
  };
  const members = ['ann', 'bo', 'dee', 'cy'].map(id => ({email: users[id].email, name: users[id].name}));
  const ctx = {id: 'env1', name: 'Studio', ownerEmail: users.ann.email, members, projects: [], agents: []};
  const access = {ok: true, all: true, projectIds: new Set()};
  const hub = officeHub({state: officeState({now: () => time}), context: {env: async () => ctx}, now: () => time, heartbeatMs: 60e3});
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const who = u.searchParams.get('as');
    const env = u.searchParams.get('env') || 'env1';
    if (u.pathname === '/events') { await hub.connect(env, users[who], access, req, res); return; }
    res.writeHead(404);
    res.end();
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = (who, env = 'env1') => `http://127.0.0.1:${server.address().port}/events?as=${who}&env=${env}`;
  const quiet = async streams => {
    await new Promise(r => setTimeout(r, 30));
    for (const s of streams) assert.ok(!s.events.some(e => e.type === 'knock' || e.type === 'knockAnswer' || e.type === 'entered' || e.type === 'knocks'));
  };
  try {
    const ann = sse(url('ann'));
    await ann.ready;
    const sa = await ann.next('snapshot');
    const bo = sse(url('bo'));
    await bo.ready;
    const sb = await bo.next('snapshot');
    await ann.next('status');
    const dee = sse(url('dee'));
    await dee.ready;
    const sd = await dee.next('snapshot');
    await ann.next('status');
    await bo.next('status');
    const cy = sse(url('cy', 'env2'));
    await cy.ready;
    await cy.next('snapshot');
    const zed = sse(url('zed'));
    await zed.ready;
    await zed.next('snapshot');
    const annKey = sa.me.key, boKey = sb.me.key, deeKey = sd.me.key;

    await assert.rejects(hub.knock('env1', users.bo, {room: annKey}), {status: 409, code: 'open'});
    hub.setStatus('env1', users.ann, {status: 'focus', text: ''});
    await ann.next('status');
    await bo.next('status');
    await dee.next('status');
    // An open door did not use up the pair's knock.
    assert.deepEqual(await hub.knock('env1', users.bo, {room: annKey}), {ok: true});
    const knock = await ann.next('knock');
    assert.deepEqual(knock, {from: boKey, name: 'Bo', room: annKey, at: new Date(0).toISOString()});
    await quiet([bo, dee, cy, zed]);
    await assert.rejects(hub.knock('env1', users.bo, {room: annKey}), {status: 429, code: 'rate_limited'});
    time = 10000;
    assert.deepEqual(await hub.knock('env1', users.bo, {room: annKey}), {ok: true});
    assert.equal((await ann.next('knock')).from, boKey);
    await assert.rejects(hub.knock('env1', users.bo, {room: 'mnot-a-room'}), {status: 404, code: 'no_room'});
    await assert.rejects(hub.knock('env1', users.bo, {room: boKey}), {status: 400, code: 'own_room'});
    await assert.rejects(hub.knock('env1', users.zed, {room: annKey}), {status: 403, code: 'not_a_member'});
    assert.ok(!JSON.stringify(knock).includes('@'));

    ctx.members = members.filter(m => m.email !== users.bo.email);
    await assert.rejects(hub.admit('env1', users.ann, {from: boKey, admit: true}), {status: 403, code: 'not_a_member'});
    ctx.members = members;
    const turned = await hub.admit('env1', users.ann, {from: boKey, admit: false});
    assert.deepEqual(turned, {ok: true, admit: false, name: 'Ann', mode: 'focus'});
    assert.deepEqual(await bo.next('knockAnswer'), {admit: false, name: 'Ann', mode: 'focus'});
    assert.deepEqual(await ann.next('knockBadge'), {count: 0, label: '0 knocks'});
    await quiet([dee, cy, zed]);

    time = 20000;
    await hub.knock('env1', users.bo, {room: annKey});
    await ann.next('knock');
    const letIn = await hub.admit('env1', users.ann, {from: boKey, admit: true});
    assert.equal(letIn.until, time + ADMIT_MS);
    assert.equal(ADMIT_MS, 120000);
    assert.deepEqual(await bo.next('knockAnswer'), {admit: true, room: annKey, name: 'Ann', until: time + ADMIT_MS});
    assert.deepEqual(await ann.next('knockBadge'), {count: 0, label: '0 knocks'});
    await quiet([dee, cy]);
    await assert.rejects(hub.admit('env1', users.ann, {from: boKey, admit: true}), {status: 404, code: 'no_knock'});

    bo.close();
    const back = sse(url('bo'));
    await back.ready;
    const again = await back.next('snapshot');
    assert.deepEqual(again.admissions, [{room: annKey, until: time + ADMIT_MS}]);
    assert.ok(!JSON.stringify(again.admissions).includes('@'));

    assert.deepEqual(await hub.enter('env1', users.dee, {room: annKey}), {ok: true, notified: false}, 'focus does not announce a walk-in');
    hub.setStatus('env1', users.ann, {status: 'available', text: ''});
    assert.deepEqual(await hub.enter('env1', users.dee, {room: annKey}), {ok: true, notified: true});
    assert.deepEqual(await ann.next('entered'), {from: deeKey, name: 'Dee'});
    assert.deepEqual(await hub.enter('env1', users.dee, {room: annKey}), {ok: true, notified: false});
    await quiet([dee, cy, zed, back]);

    hub.setStatus('env1', users.ann, {status: 'dnd', text: ''});
    time = 20000 + ADMIT_MS;
    await hub.knock('env1', users.bo, {room: annKey});
    await hub.knock('env1', users.dee, {room: annKey});
    assert.deepEqual(await ann.next('knockBadge'), {count: 1, label: '1 knock'});
    assert.deepEqual(await ann.next('knockBadge'), {count: 2, label: '2 knocks'});
    await quiet([back, dee, cy]);
    const left = hub.setStatus('env1', users.ann, {status: 'available', text: ''});
    assert.equal(left.released, 0);
    const queued = await ann.next('knocks');
    assert.equal(queued.label, '2 knocks');
    assert.deepEqual(queued.items.map(k => k.name).sort(), ['Bo', 'Dee']);
    assert.ok(!JSON.stringify(queued).includes('@'));
    await quiet([back, dee, cy]);

    hub.setStatus('env1', users.ann, {status: 'focus', text: ''});
    ann.close();
    assert.equal((await back.next('leave')).key, annKey);
    await assert.rejects(hub.knock('env1', users.bo, {room: annKey}), {status: 409, code: 'offline'});
    back.close();
    dee.close();
    cy.close();
    zed.close();
  } finally {
    hub.close();
    server.close();
  }
});
