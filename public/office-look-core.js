// What a person looks like in the 3D office (docs/concepts/12-office.md): the look schema, its allowed
// options, validation, and the default look for someone who has not chosen one. Pure checks shared by the
// browser (office-avatar.js draws a look, office-look-editor.js edits one) and the server
// (lib/office-look.mjs stores one per person): no DOM, no Three.js, no network.
//
// A look is a flat object: an option id per part and a colour per material.
//   {v:2, build, height, skin, eyes, eyeColor, brows, nose, mouth, beard, glasses, freckles, blush,
//    hair, hairColor, hat, hatColor, top, topColor, pattern, accent, bottoms, bottomsColor, shoes, shoesColor}
// Option ids come from LOOK_OPTIONS (anything else is refused, or replaced by the default when lenient).
// Colours are #rrggbb, any hue, with lightness clamped so a face or an outfit never turns pure black or white.
// Adding a field later is compatible: cleanLook fills what is missing from the person's default look.

export const LOOK_VERSION = 2;

export const LOOK_OPTIONS = {
  build: ['slim', 'regular', 'broad', 'soft'],
  height: ['short', 'medium', 'tall'],
  eyes: ['oval', 'round', 'almond', 'sleepy'],
  brows: ['soft', 'straight', 'arched', 'thick'],
  nose: ['button', 'wedge', 'round'],
  mouth: ['smile', 'grin', 'neutral', 'smirk'],
  beard: ['none', 'stubble', 'mustache', 'goatee', 'full'],
  glasses: ['none', 'round', 'square', 'shades'],
  hair: ['short', 'buzz', 'sidepart', 'curly', 'afro', 'long', 'bob', 'ponytail', 'bun', 'braids', 'mohawk', 'bald'],
  hat: ['none', 'cap', 'beanie', 'bucket', 'captain', 'headphones'],
  top: ['tee', 'hoodie', 'buttonup', 'blazer', 'sweater', 'tank'],
  pattern: ['none', 'stripes', 'block', 'band', 'badge'],
  bottoms: ['jeans', 'chinos', 'shorts', 'skirt', 'joggers'],
  shoes: ['sneakers', 'boots', 'loafers', 'sandals'],
};
export const LOOK_TOGGLES = ['freckles', 'blush'];
export const LOOK_COLORS = ['skin', 'eyeColor', 'hairColor', 'hatColor', 'topColor', 'accent', 'bottomsColor', 'shoesColor'];
export const LOOK_FIELDS = ['build', 'height', 'skin', 'eyes', 'eyeColor', 'brows', 'nose', 'mouth', 'beard', 'glasses', 'freckles', 'blush',
  'hair', 'hairColor', 'hat', 'hatColor', 'top', 'topColor', 'pattern', 'accent', 'bottoms', 'bottomsColor', 'shoes', 'shoesColor'];

// Names for the editor.
export const LOOK_LABELS = {
  build: 'Build', height: 'Height', skin: 'Skin tone', eyes: 'Eyes', eyeColor: 'Eye colour', brows: 'Eyebrows', nose: 'Nose', mouth: 'Mouth',
  beard: 'Facial hair', glasses: 'Glasses', freckles: 'Freckles', blush: 'Blush', hair: 'Hair', hairColor: 'Hair colour', hat: 'Hat',
  hatColor: 'Hat colour', top: 'Top', topColor: 'Top colour', pattern: 'Pattern', accent: 'Accent colour', bottoms: 'Bottoms',
  bottomsColor: 'Bottoms colour', shoes: 'Shoes', shoesColor: 'Shoe colour',
  slim: 'Slim', regular: 'Regular', broad: 'Broad', soft: 'Soft', short: 'Short', medium: 'Medium', tall: 'Tall',
  oval: 'Oval', round: 'Round', almond: 'Almond', sleepy: 'Sleepy', straight: 'Straight', arched: 'Arched', thick: 'Thick',
  button: 'Button', wedge: 'Wedge', smile: 'Smile', grin: 'Grin', neutral: 'Neutral', smirk: 'Smirk',
  none: 'None', stubble: 'Stubble', mustache: 'Mustache', goatee: 'Goatee', full: 'Full beard', square: 'Square', shades: 'Shades',
  buzz: 'Buzz', sidepart: 'Side part', curly: 'Curly', afro: 'Afro', long: 'Long', bob: 'Bob', ponytail: 'Ponytail', bun: 'Bun',
  braids: 'Braids', mohawk: 'Mohawk', bald: 'Bald', cap: 'Cap', beanie: 'Beanie', bucket: 'Bucket hat', captain: 'Captain’s hat',
  headphones: 'Headphones', tee: 'T-shirt', hoodie: 'Hoodie', buttonup: 'Button-up', blazer: 'Blazer', sweater: 'Sweater', tank: 'Tank top',
  stripes: 'Stripes', block: 'Colour block', band: 'Chest band', badge: 'Badge', jeans: 'Jeans', chinos: 'Chinos', shorts: 'Shorts',
  skirt: 'Skirt', joggers: 'Joggers', sneakers: 'Sneakers', boots: 'Boots', loafers: 'Loafers', sandals: 'Sandals',
};
// The hair style is "short" and so is the height: the height's own names.
export const lookLabel = (field, id) => field === 'hair' && id === 'short' ? 'Short' : LOOK_LABELS[id] || id;

// Swatches. Any other colour is allowed too (the editor's custom colour).
export const SKIN_TONES = ['#fde7d6', '#f9d9c0', '#f3c9a5', '#eab88c', '#dea678', '#cf9365', '#be8253', '#a86c42', '#8d5836', '#73452a', '#5a3521', '#422619'];
export const HAIR_COLORS = ['#1b1512', '#33221a', '#4e3323', '#70472a', '#976231', '#bb8742', '#dcba6c', '#efdda4', '#a5432b', '#d2632f', '#8e8e8c', '#e8e7e2', '#3f6fd1', '#d95f9c', '#6b4bb3', '#2f9a8a'];
export const EYE_COLORS = ['#2b1c13', '#5b3b23', '#7b5c2f', '#3f6c4b', '#3d6f9f', '#6f8aa1', '#1c1c20'];
export const CLOTH_COLORS = ['#f3f0e9', '#c9cdd2', '#6c737f', '#2c3039', '#20294a', '#3d6fb6', '#6aa8d9', '#2f8f8a', '#4f9a62', '#8fae4a', '#e2b53f', '#e07b39', '#c8553d', '#d87881', '#8a5fb8', '#7a5136', '#d9c3a0'];
export const BOTTOM_COLORS = ['#34507c', '#4a6d9e', '#27324a', '#2c3039', '#5b6068', '#c9b48c', '#8a7550', '#5f6b46', '#7a5136', '#f0ece2', '#1f1f24', '#8f4d55'];
export const SHOE_COLORS = ['#f4f2ec', '#2a2a2e', '#7a4f33', '#b08a5c', '#c8553d', '#3d6fb6', '#4f9a62', '#e2b53f', '#d87881', '#6c737f'];
export const LOOK_SWATCHES = {skin: SKIN_TONES, eyeColor: EYE_COLORS, hairColor: HAIR_COLORS, hatColor: CLOTH_COLORS, topColor: CLOTH_COLORS,
  accent: CLOTH_COLORS, bottomsColor: BOTTOM_COLORS, shoesColor: SHOE_COLORS};

const fail = (status, code, message) => { throw Object.assign(new Error(message), {status, code}); };

// A stable number from an opaque id (the server's member key, or an AgentFlow agent id).
export function hashOf(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

// ---------- colours ----------
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
export function parseHex(v) {
  const m = typeof v === 'string' ? HEX.exec(v.trim()) : null;
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
const toHex = rgb => '#' + rgb.map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function fromHsl([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h / 60 % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
// Lightness limits per colour: skin keeps a face readable (eyes and mouth are darker than any skin, the
// highlight lighter), cloth and hair stop short of pure black and pure white so shading still shows.
export const COLOR_LIMITS = {skin: [0.16, 0.93], eyeColor: [0.05, 0.6], hairColor: [0.06, 0.92], hatColor: [0.08, 0.95], topColor: [0.08, 0.95],
  accent: [0.08, 0.95], bottomsColor: [0.08, 0.95], shoesColor: [0.08, 0.95]};
// -> '#rrggbb' with its lightness inside the field's limits, or null when it is not a hex colour.
export function clampColor(field, value) {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const [lo, hi] = COLOR_LIMITS[field] || [0, 1], hsl = toHsl(rgb);
  if (hsl[2] >= lo && hsl[2] <= hi) return toHex(rgb);
  return toHex(fromHsl([hsl[0], hsl[1], Math.max(lo, Math.min(hi, hsl[2]))]));
}

// ---------- the default look ----------
// Deterministic per key: the same person (or AgentFlow person) always gets the same look until they choose one.
const pickOf = (key, field, list) => list[hashOf(key + '\n' + field) % list.length];
// Weighted: [[id, weight], ...].
function weighted(key, field, table) {
  const total = table.reduce((n, [, w]) => n + w, 0);
  let at = hashOf(key + '\n' + field) % total;
  for (const [id, w] of table) { if (at < w) return id; at -= w; }
  return table[0][0];
}
const DEFAULT_SHOES = [['sneakers', '#f4f2ec'], ['sneakers', '#2a2a2e'], ['sneakers', '#c8553d'], ['boots', '#7a4f33'], ['boots', '#2a2a2e'], ['loafers', '#7a4f33'], ['loafers', '#2a2a2e'], ['sneakers', '#3d6fb6']];
export function defaultLook(key) {
  key = String(key ?? '');
  const top = weighted(key, 'top', [['tee', 5], ['hoodie', 4], ['buttonup', 4], ['sweater', 4], ['blazer', 3], ['tank', 1]]);
  const bottoms = weighted(key, 'bottoms', [['jeans', 6], ['chinos', 5], ['joggers', 2], ['shorts', 2], ['skirt', 2]]);
  const [shoes, shoesColor] = pickOf(key, 'shoes', DEFAULT_SHOES);
  const hairColor = pickOf(key, 'hairColor', HAIR_COLORS.slice(0, 12));
  const topColor = pickOf(key, 'topColor', CLOTH_COLORS);
  // An accent that differs from the top, so a pattern always shows.
  const accents = CLOTH_COLORS.filter(c => c !== topColor);
  return {
    v: LOOK_VERSION,
    build: weighted(key, 'build', [['regular', 4], ['slim', 2], ['broad', 2], ['soft', 2]]),
    height: weighted(key, 'height', [['medium', 3], ['short', 1], ['tall', 1]]),
    skin: pickOf(key, 'skin', SKIN_TONES),
    eyes: weighted(key, 'eyes', [['oval', 4], ['round', 3], ['almond', 3], ['sleepy', 1]]),
    eyeColor: pickOf(key, 'eyeColor', EYE_COLORS),
    brows: pickOf(key, 'brows', LOOK_OPTIONS.brows),
    nose: pickOf(key, 'nose', LOOK_OPTIONS.nose),
    mouth: weighted(key, 'mouth', [['smile', 5], ['grin', 2], ['neutral', 2], ['smirk', 1]]),
    beard: weighted(key, 'beard', [['none', 14], ['stubble', 2], ['mustache', 1], ['goatee', 1], ['full', 2]]),
    glasses: weighted(key, 'glasses', [['none', 14], ['round', 3], ['square', 2], ['shades', 1]]),
    freckles: hashOf(key + '\nfreckles') % 6 === 0,
    blush: hashOf(key + '\nblush') % 3 === 0,
    hair: weighted(key, 'hair', [['short', 4], ['sidepart', 4], ['curly', 3], ['long', 3], ['bob', 3], ['ponytail', 2], ['bun', 2], ['afro', 2], ['buzz', 2], ['braids', 2], ['mohawk', 1], ['bald', 1]]),
    hairColor,
    hat: weighted(key, 'hat', [['none', 22], ['cap', 2], ['beanie', 1], ['bucket', 1], ['headphones', 1]]),
    hatColor: pickOf(key, 'hatColor', CLOTH_COLORS),
    top, topColor,
    pattern: weighted(key, 'pattern', [['none', 6], ['stripes', 2], ['block', 1], ['band', 1], ['badge', 2]]),
    accent: pickOf(key, 'accent', accents),
    bottoms,
    bottomsColor: pickOf(key, 'bottomsColor', BOTTOM_COLORS),
    shoes, shoesColor,
  };
}

// ---------- validation ----------
// input -> a complete, valid look. Unknown fields are dropped. key: whose look it is, for the fields the
// input leaves out. strict (what the server uses for a save): an option id outside the allow-list, a colour
// that is not hex or a toggle that is not a boolean is refused with a 400; otherwise each such field falls
// back to the person's default. Colours are always clamped (clampColor), never refused for being too dark
// or too light. An older look (no v, or v 1) is migrated first.
export function cleanLook(input, {key = '', strict = false} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (strict) fail(400, 'invalid_input', 'look must be an object');
    return defaultLook(key);
  }
  const src = Number(input.v) >= LOOK_VERSION ? input : migrateLook(input), base = defaultLook(key), out = {v: LOOK_VERSION};
  if (strict && Number(input.v) > LOOK_VERSION) fail(400, 'invalid_input', `look version ${LOOK_VERSION} is the newest this server knows`);
  for (const f of LOOK_FIELDS) {
    const v = src[f];
    if (v === undefined || v === null) { out[f] = base[f]; continue; }
    if (LOOK_OPTIONS[f]) {
      const id = typeof v === 'string' ? v.trim().toLowerCase() : '';
      if (LOOK_OPTIONS[f].includes(id)) out[f] = id;
      else if (strict) fail(400, 'invalid_input', `${f} must be one of ${LOOK_OPTIONS[f].join(', ')}`);
      else out[f] = base[f];
    } else if (LOOK_TOGGLES.includes(f)) {
      if (typeof v === 'boolean') out[f] = v;
      else if (strict) fail(400, 'invalid_input', `${f} must be true or false`);
      else out[f] = base[f];
    } else {
      const c = clampColor(f, v);
      if (c) out[f] = c;
      else if (strict) fail(400, 'invalid_input', `${f} must be a colour like #3d6fb6`);
      else out[f] = base[f];
    }
  }
  return out;
}

// Older looks, to today's fields (whatever is missing is filled from the default by cleanLook):
//   v1 (the first figures): {skin, hair, shirt, pants, style}: four colours and a hair style 0-3.
//   the first wardrobe (office-decor-core.js cleanLook): {skin, hair, hairStyle, topStyle, top, bottoms, accessory}:
//   palette colours, a hair style 0-3, tee / hoodie / shirt, and none / cap / headphones / glasses. Also read
//   loosely: skin, hair, top and bottoms as either a colour or an option id.
const OLD_STYLE = ['short', 'long', 'sidepart', 'buzz'];
const ACCESSORY = {glasses: {glasses: 'round'}, sunglasses: {glasses: 'shades'}, shades: {glasses: 'shades'}, cap: {hat: 'cap'}, hat: {hat: 'cap'},
  beanie: {hat: 'beanie'}, bucket: {hat: 'bucket'}, captain: {hat: 'captain'}, headphones: {hat: 'headphones'}, headset: {hat: 'headphones'}};
const TOP_ALIAS = {tshirt: 'tee', 't-shirt': 'tee', shirt: 'buttonup', 'button-up': 'buttonup', jacket: 'blazer', suit: 'blazer', jumper: 'sweater', vest: 'tank'};
const BOTTOM_ALIAS = {pants: 'chinos', trousers: 'chinos', slacks: 'chinos', denim: 'jeans', sweatpants: 'joggers', dress: 'skirt'};
export function migrateLook(old) {
  if (!old || typeof old !== 'object' || Array.isArray(old)) return {};
  const out = {}, isHex = v => !!parseHex(v), id = v => typeof v === 'string' ? v.trim().toLowerCase() : '';
  // Either a colour or an option id, under one old name.
  const either = (v, colorField, optionField, alias = {}) => {
    if (isHex(v)) out[colorField] = v;
    else if (id(v)) out[optionField] = alias[id(v)] || id(v);
  };
  if (isHex(old.skin)) out.skin = old.skin;
  either(old.hair, 'hairColor', 'hair');
  if (isHex(old.hairColor)) out.hairColor = old.hairColor;
  for (const style of [old.hairStyle, old.style]) {
    if (out.hair) break;
    if (Number.isInteger(style) && OLD_STYLE[style]) out.hair = OLD_STYLE[style];
    else if (id(style)) out.hair = id(style);
  }
  if (id(old.topStyle)) out.top = TOP_ALIAS[id(old.topStyle)] || id(old.topStyle);
  either(old.top, 'topColor', 'top', TOP_ALIAS);
  either(old.shirt, 'topColor', 'top', TOP_ALIAS);
  if (isHex(old.topColor)) out.topColor = old.topColor;
  either(old.bottoms, 'bottomsColor', 'bottoms', BOTTOM_ALIAS);
  either(old.pants, 'bottomsColor', 'bottoms', BOTTOM_ALIAS);
  if (isHex(old.bottomsColor)) out.bottomsColor = old.bottomsColor;
  Object.assign(out, ACCESSORY[id(old.accessory)]);
  // Fields that already carry today's names pass through; cleanLook checks them.
  for (const f of LOOK_FIELDS) if (out[f] === undefined && old[f] !== undefined && !(f === 'hair' && isHex(old[f])) && !(f === 'top' && isHex(old[f])) && !(f === 'bottoms' && isHex(old[f]))) out[f] = old[f];
  return out;
}

export const sameLook = (a, b) => LOOK_FIELDS.every(f => a?.[f] === b?.[f]);

// A random look for the editor's Randomize. rng: () -> [0, 1).
export function randomLook(rng = Math.random) {
  const pick = list => list[Math.floor(rng() * list.length) % list.length];
  const often = (list, first, p) => rng() < p ? first : pick(list.filter(x => x !== first));
  const topColor = pick(CLOTH_COLORS);
  return {
    v: LOOK_VERSION, build: pick(LOOK_OPTIONS.build), height: pick(LOOK_OPTIONS.height), skin: pick(SKIN_TONES),
    eyes: pick(LOOK_OPTIONS.eyes), eyeColor: pick(EYE_COLORS), brows: pick(LOOK_OPTIONS.brows), nose: pick(LOOK_OPTIONS.nose), mouth: pick(LOOK_OPTIONS.mouth),
    beard: often(LOOK_OPTIONS.beard, 'none', 0.65), glasses: often(LOOK_OPTIONS.glasses, 'none', 0.65), freckles: rng() < 0.2, blush: rng() < 0.35,
    hair: pick(LOOK_OPTIONS.hair), hairColor: pick(HAIR_COLORS), hat: often(LOOK_OPTIONS.hat, 'none', 0.6), hatColor: pick(CLOTH_COLORS),
    top: pick(LOOK_OPTIONS.top), topColor, pattern: often(LOOK_OPTIONS.pattern, 'none', 0.45), accent: pick(CLOTH_COLORS.filter(c => c !== topColor)),
    bottoms: pick(LOOK_OPTIONS.bottoms), bottomsColor: pick(BOTTOM_COLORS), shoes: pick(LOOK_OPTIONS.shoes), shoesColor: pick(SHOE_COLORS),
  };
}
