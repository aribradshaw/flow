// Presence status for the 3D office: validation, the automatic Away rule, and the SSE broadcast.
// Knocking is covered in the same file once the door is wired. In memory only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {officeHub, officeState} from '../lib/office.mjs';
import {AWAY_IDLE_MS, allowKnock, cleanPresenceStatus, doorPolicy, isQuietStatus, knockLabel, nextPresence} from '../public/office-status-core.js';

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
