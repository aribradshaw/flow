// Presence status for one Flow process (docs/concepts/12-office.md). In memory, like the rest of
// the office: a restart clears it. The browser also keeps the person's own choice in localStorage.
//
// createPresenceBook({now}) is the server side of public/office-status.js. officeHub broadcasts
// what the book decides and is the only place that knows who is connected.
import {ADMIT_MS, allowKnock, cleanPresenceStatus, isQuietStatus, knockLabel} from '../public/office-status-core.js';

const lc = s => String(s || '').trim().toLowerCase();
const pairKey = (envId, ownerEmail, visitorEmail) => `${envId}\n${lc(ownerEmail)}\n${lc(visitorEmail)}`;
const queueKey = (envId, ownerEmail) => `${envId}\n${lc(ownerEmail)}`;

export function createPresenceBook({now = () => Date.now()} = {}) {
  const statuses = new Map();
  // Knocks wait on the room's owner until they let the person in or turn them away.
  // One queued knock per visitor. Times are the hub clock, so a frozen clock still rate-limits.
  const knocks = new Map();
  const lastKnock = new Map();
  const admits = new Map();
  const lastEnter = new Map();
  const statusOf = email => statuses.get(lc(email)) || {status: 'available', text: ''};
  const queueOf = (envId, ownerEmail) => knocks.get(queueKey(envId, ownerEmail)) || [];
  return {
    view(email) {
      const s = statusOf(email);
      return {status: s.status, text: s.text};
    },
    // True while this person is in Do not disturb. userId is an email here; the hub also
    // accepts the office member key (see officeHub.isQuiet).
    isQuiet(email) {
      return isQuietStatus(statusOf(email).status);
    },
    set(email, input) {
      const clean = cleanPresenceStatus(input);
      const prev = statusOf(email).status;
      statuses.set(lc(email), clean);
      return {clean, leftDnd: prev === 'dnd' && clean.status !== 'dnd'};
    },
    // One entry per member so a reconnecting office can paint rings before anyone walks.
    forSnapshot(members) {
      return (members || []).map(m => ({key: m.key, ...this.view(m.email)}));
    },
    // One knock per 10 seconds for this visitor at this door. Replaces their earlier knock.
    // The pair is the two people; fromKey is only the opaque id the browser already has.
    queueKnock({envId, ownerEmail, fromEmail, fromKey, name, at}) {
      const pair = pairKey(envId, ownerEmail, fromEmail);
      if (!allowKnock(lastKnock.get(pair), at)) {
        const err = new Error('Slow down a little');
        err.status = 429;
        err.code = 'rate_limited';
        throw err;
      }
      lastKnock.set(pair, at);
      const list = queueOf(envId, ownerEmail).filter(k => k.from !== fromKey);
      list.push({from: fromKey, name, at: new Date(at).toISOString()});
      knocks.set(queueKey(envId, ownerEmail), list);
      return {count: list.length, label: knockLabel(list.length), at: list.at(-1).at};
    },
    hasKnock(envId, ownerEmail, fromKey) {
      return queueOf(envId, ownerEmail).some(k => k.from === fromKey);
    },
    takeKnock(envId, ownerEmail, fromKey) {
      const list = queueOf(envId, ownerEmail);
      const item = list.find(k => k.from === fromKey);
      if (!item) return null;
      const rest = list.filter(k => k.from !== fromKey);
      knocks.set(queueKey(envId, ownerEmail), rest);
      return {item, count: rest.length, label: knockLabel(rest.length)};
    },
    pendingKnocks(envId, ownerEmail) {
      const list = queueOf(envId, ownerEmail);
      return {count: list.length, label: knockLabel(list.length), items: list.map(({from, name, at}) => ({from, name, at}))};
    },
    // Let this visitor through this door until now + 2 minutes.
    admit(envId, ownerEmail, visitorEmail, at) {
      const until = at + ADMIT_MS;
      admits.set(pairKey(envId, ownerEmail, visitorEmail), until);
      return until;
    },
    admittedUntil(envId, ownerEmail, visitorEmail, at) {
      const until = admits.get(pairKey(envId, ownerEmail, visitorEmail)) || 0;
      return until > at ? until : 0;
    },
    // Doors this visitor may still walk through. Members are {key, email}; nothing but keys is returned.
    admissionsFor(envId, email, members, at) {
      const out = [];
      for (const m of members || []) {
        const until = admits.get(pairKey(envId, m.email, email)) || 0;
        if (until > at) out.push({room: m.key, until});
      }
      return out;
    },
    // True the first time this visitor should announce themselves in this 10 second window.
    noteEnter(envId, ownerEmail, visitorEmail, at) {
      const pair = 'enter\n' + pairKey(envId, ownerEmail, visitorEmail);
      if (!allowKnock(lastEnter.get(pair), at)) return false;
      lastEnter.set(pair, at);
      return true;
    },
  };
}
