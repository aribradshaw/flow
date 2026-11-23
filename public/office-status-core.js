// Presence status for the 3D office. Pure checks shared by the browser (public/office-status.js)
// and the server (lib/office-status.mjs): no DOM, no network.
//
// Available, Focus, Do not disturb, Away. Away can also be chosen for you after
// AWAY_IDLE_MS with no input while the tab is hidden, and that automatic Away
// clears when the tab is visible again or anything is pressed.

export const PRESENCE_STATUSES = ['available', 'focus', 'dnd', 'away'];
export const STATUS_TEXT_MAX = 60;
export const AWAY_IDLE_MS = 10 * 60 * 1000;
export const KNOCK_INTERVAL_MS = 10 * 1000;
export const ADMIT_MS = 2 * 60 * 1000;

export const PRESENCE_META = {
  available: {id: 'available', label: 'Available', color: '#2f9e57', glyph: '●'},
  focus: {id: 'focus', label: 'Focus', color: '#d08900', glyph: '◐'},
  dnd: {id: 'dnd', label: 'Do not disturb', color: '#d4534a', glyph: '⊘'},
  away: {id: 'away', label: 'Away', color: '#8b9490', glyph: '◌'},
};

const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}); };

export function presenceMeta(id) {
  return PRESENCE_META[id] || PRESENCE_META.available;
}

// {status, text?} -> {status, text}. Text is optional, one line, at most 60 characters.
export function cleanPresenceStatus(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'invalid_input', 'status is required');
  const status = String(input.status || '').trim().toLowerCase();
  if (!PRESENCE_STATUSES.includes(status)) fail(400, 'invalid_input', 'status must be one of ' + PRESENCE_STATUSES.join(', '));
  if (input.text != null && typeof input.text !== 'string') fail(400, 'invalid_input', 'status text must be a string');
  const text = typeof input.text === 'string' ? input.text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (text.length > STATUS_TEXT_MAX) fail(400, 'invalid_input', `status text must be ${STATUS_TEXT_MAX} characters or fewer`);
  return {status, text};
}

// True when a knock from this person to that one is allowed. One knock per gap per pair.
export function allowKnock(lastAt, now, gap = KNOCK_INTERVAL_MS) {
  return lastAt == null || now - lastAt >= gap;
}

export function knockLabel(count) {
  const n = Math.max(0, Number(count) || 0);
  return `${n} ${n === 1 ? 'knock' : 'knocks'}`;
}

// What the door does for one visitor. Offline rooms are open. Focus and Do not disturb
// stay shut until this visitor is let in. Available and Away let them walk in.
export function doorPolicy({online = false, presence = 'available', admitted = false} = {}) {
  if (!online || admitted) return {open: true, enter: false, knock: false, sound: false};
  if (presence === 'focus') return {open: false, enter: false, knock: true, sound: true};
  if (presence === 'dnd') return {open: false, enter: false, knock: true, sound: false};
  return {open: true, enter: true, knock: false, sound: false};
}

export function isQuietStatus(presence) {
  return presence === 'dnd';
}

// choice: the status they picked (kept in localStorage). current: what the office shows now.
// auto: current Away was set by this rule, not picked. hidden: the tab is in the background.
// idleMs: time since the last key, pointer or wheel. Coming back clears an automatic Away.
export function nextPresence({choice = 'available', current = 'available', auto = false, hidden = false, idleMs = 0, awayAfterMs = AWAY_IDLE_MS} = {}) {
  const saved = PRESENCE_STATUSES.includes(choice) ? choice : 'available';
  const nowStatus = PRESENCE_STATUSES.includes(current) ? current : saved;
  if (auto) {
    if (!hidden || idleMs < awayAfterMs) return {status: saved, auto: false, changed: true};
    return {status: 'away', auto: true, changed: nowStatus !== 'away'};
  }
  if (hidden && idleMs >= awayAfterMs && nowStatus !== 'away') return {status: 'away', auto: true, changed: true};
  return {status: nowStatus, auto: false, changed: false};
}
