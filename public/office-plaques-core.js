// Pure helpers for room door plaques in the 3D office. No DOM, no Three.js: the browser
// module (office-plaques.js) draws these lines onto a canvas texture on a wall-mounted plate.

import {presenceMeta} from './office-status-core.js';

// What the plaque shows for one room. online false dims the plate and leads with "offline".
// presence: {status, text?}; extra: agent count / desk note from office.js.
export function plaqueCopy({name, me = false, online = true, seen = '', presence = null, extra = ''} = {}) {
  const show = online ? presenceMeta(presence?.status) : null;
  const title = String(name || 'Room').trim() || 'Room';
  const subtitle = me ? 'Your room' : '';
  const lines = [];
  if (!online) lines.push(seen ? `Offline · last seen ${seen}` : 'Offline');
  else if (presence?.text) lines.push(presence.text);
  else if (show && show.id !== 'available') lines.push(show.label);
  if (extra) lines.push(String(extra));
  return {
    title,
    subtitle,
    lines: lines.slice(0, 3),
    online: !!online,
    status: show || {id: 'offline', label: 'Offline', color: '#8b9490', glyph: '◌'},
  };
}
