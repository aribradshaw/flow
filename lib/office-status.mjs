// Presence status for one Flow process (docs/concepts/12-office.md). In memory, like the rest of
// the office: a restart clears it. The browser also keeps the person's own choice in localStorage.
//
// createPresenceBook({now}) is the server side of public/office-status.js. officeHub broadcasts
// what the book decides and is the only place that knows who is connected.
import {cleanPresenceStatus, isQuietStatus} from '../public/office-status-core.js';

const lc = s => String(s || '').trim().toLowerCase();

export function createPresenceBook({now = () => Date.now()} = {}) {
  const statuses = new Map();
  const statusOf = email => statuses.get(lc(email)) || {status: 'available', text: ''};
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
  };
}
