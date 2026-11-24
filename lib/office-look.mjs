// What each person looks like in the 3D office (docs/concepts/12-office.md, 13-avatars.md): the office side of
// the account avatar (lib/avatars.mjs). A look belongs to a person's account, not to one office: every office
// they are in draws the same one, and nobody else can change it. The office draws the flat look of
// public/office-look-core.js; the account keeps the portable spec (public/avatar-spec.js), converted here.
// Someone who has not made an avatar has none stored: every browser draws the same default for their key.
//
// createLookBook({avatars}) keeps what it has read in memory, by office member key. officeHub broadcasts what
// the book decides. members are {key, email}.
import {cleanLook} from '../public/office-look-core.js';
import {lookFromSpec, specFromLook} from '../public/avatar-spec.js';

export function createLookBook({avatars}) {
  const looks = new Map(), specs = new Map(), known = new Set();
  // view: an avatars.get() result. -> the look the office draws, or null for the default.
  function remember(key, view) {
    known.add(key);
    if (view?.custom) { specs.set(key, view.avatar); looks.set(key, lookFromSpec(view.avatar, key)); }
    else { specs.delete(key); looks.delete(key); }
    return looks.get(key) || null;
  }
  return {
    // Reads the avatars of these members once each.
    async load(members) {
      const missing = [...new Map(members.filter(m => !known.has(m.key)).map(m => [m.key, m])).values()];
      if (!missing.length) return;
      const rows = await avatars.many(missing.map(m => m.email));
      for (const m of missing) remember(m.key, rows.get(String(m.email).trim().toLowerCase()));
      if (known.size > 50000) { known.clear(); looks.clear(); specs.clear(); }
    },
    get: key => looks.get(key) || null,
    // {key: look} for the members who made one.
    forSnapshot(keys) {
      const out = {};
      for (const k of keys) if (looks.has(k)) out[k] = looks.get(k);
      return out;
    },
    remember,
    // input: an office look, or null to go back to the default. Checked strictly, then saved to the account as
    // a spec that keeps whatever the stored one carries beyond this version. -> {look: the saved look or null}
    async set(member, input) {
      // Saving exactly the default is having none (lib/avatars.mjs), unless the stored spec carries more.
      const look = input === null || input === undefined ? null : cleanLook(input, {key: member.key, strict: true});
      const base = specs.get(member.key) || (look ? (await avatars.get(member.email)).avatar : null);
      const view = await avatars.save(member.email, look ? specFromLook(look, {seed: member.key, base}) : null);
      return {look: remember(member.key, view), view};
    },
  };
}
