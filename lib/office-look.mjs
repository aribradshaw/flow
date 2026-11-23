// What each person looks like in the 3D office (docs/concepts/12-office.md): the server side of
// public/office-look-core.js. A look belongs to a person, not to one office: it is stored under their office
// member key (lib/office-storage.mjs looks / look) and shown in every office they are in. Nobody else can
// change it. Someone who has not chosen a look has none stored: every browser draws the same default for
// their key (defaultLook).
//
// createLookBook({storage}) keeps what it has read in memory. officeHub broadcasts what the book decides.
import {cleanLook, defaultLook, sameLook} from '../public/office-look-core.js';

export function createLookBook({storage} = {}) {
  const looks = new Map(), known = new Set();
  return {
    // Reads the stored looks of these member keys once each.
    async load(keys) {
      const missing = [...new Set(keys)].filter(k => !known.has(k));
      if (!missing.length) return;
      const rows = await storage?.looks?.(missing) || [];
      for (const k of missing) known.add(k);
      for (const {member, data} of rows) {
        // Stored looks are re-checked leniently on the way out, so an older schema still draws.
        if (data && !looks.has(member)) looks.set(member, cleanLook(data, {key: member}));
      }
      if (known.size > 50000) { known.clear(); looks.clear(); }
    },
    get: key => looks.get(key) || null,
    // {key: look} for the members who chose one.
    forSnapshot(keys) {
      const out = {};
      for (const k of keys) if (looks.has(k)) out[k] = looks.get(k);
      return out;
    },
    // input: a look, or null to go back to the default. -> {look: the saved look or null, write}
    set(key, input) {
      let look = input === null || input === undefined ? null : cleanLook(input, {key, strict: true});
      // Saving exactly the default look is the same as having none.
      if (look && sameLook(look, defaultLook(key))) look = null;
      known.add(key);
      if (look) looks.set(key, look); else looks.delete(key);
      return {look, write: storage?.look ? Promise.resolve().then(() => storage.look(key, look)) : undefined};
    },
  };
}
