# Avatars

Your avatar is the character you build in the [3D office](#3d-office): one per account, the same in every office you are in, shared environments included. It is stored as a small, versioned JSON spec that any app can read, so the same character can appear elsewhere later.

- **Make it.** In the office, press **L**, select the shirt button, click yourself, or use the mirror in your room. **Save** saves it to your account, not to the office you are in: every office you are in shows the change at once.
- **Until you make one,** you get a default avatar picked for you. It stays the same every visit and in every office, because it comes from a stable, opaque seed for your account (the same one the office uses for your member key), never from your email or name.
- **Who sees it.** People who share an office with you see your avatar there, as before. Nobody else can change it.

## The avatar spec (version 1)

```json
{"v":1,"skin":"#a86c42",
 "body":{"build":"regular","height":"medium"},
 "face":{"eyes":"oval","eyeColor":"#5b3b23","brows":"soft","nose":"button","mouth":"smile",
         "facialHair":"none","glasses":"none","freckles":false,"blush":true},
 "hair":{"style":"sidepart","color":"#33221a"},
 "hat":{"style":"none","color":"#8a5fb8"},
 "top":{"style":"buttonup","color":"#c8553d","pattern":"none","accent":"#f3f0e9"},
 "bottoms":{"style":"chinos","color":"#c9b48c"},
 "shoes":{"style":"loafers","color":"#2a2a2e"}}
```

A spec is about 500 bytes and at most 2 KB. Every field shown is required. Colours are `#rrggbb`. `freckles` and `blush` are `true` or `false`. Every other field is an option id from this list; ids are stable, and new ones are only ever added:

| Field | Option ids |
| --- | --- |
| `body.build` | `slim`, `regular`, `broad`, `soft` |
| `body.height` | `short`, `medium`, `tall` |
| `face.eyes` | `oval`, `round`, `almond`, `sleepy` |
| `face.brows` | `soft`, `straight`, `arched`, `thick` |
| `face.nose` | `button`, `wedge`, `round` |
| `face.mouth` | `smile`, `grin`, `neutral`, `smirk` |
| `face.facialHair` | `none`, `stubble`, `mustache`, `goatee`, `full` |
| `face.glasses` | `none`, `round`, `square`, `shades` |
| `hair.style` | `short`, `buzz`, `sidepart`, `curly`, `afro`, `long`, `bob`, `ponytail`, `bun`, `braids`, `mohawk`, `bald` |
| `hat.style` | `none`, `cap`, `beanie`, `bucket`, `captain`, `headphones` |
| `top.style` | `tee`, `hoodie`, `buttonup`, `blazer`, `sweater`, `tank` |
| `top.pattern` | `none`, `stripes`, `block`, `band`, `badge` |
| `bottoms.style` | `jeans`, `chinos`, `shorts`, `skirt`, `joggers` |
| `shoes.style` | `sneakers`, `boots`, `loafers`, `sandals` |

**Fields this version does not know are kept.** An app that adds a field (at the top level, or inside a group such as `face`) can save it, and Flow keeps it when you edit your avatar here, so the spec round-trips through apps that don't know it. Such fields need plain names (a letter, then letters, digits, `_` or `-`) and plain JSON values. Version 1 only ever gains optional fields; a change that is not additive would be a new `v`.

**Drawing it.** The 3D office draws colours with a minimum and maximum lightness, so a face never turns pure black or white; the spec keeps the colour you chose. An unknown option id or a bad colour is refused when you save. A stored spec that is no longer valid (it never should be) draws your default for that field.

**One module.** `public/avatar-spec.js` has no dependencies and runs in the browser and in Node: validation (`validateAvatar`), reading anything stored before (`readAvatar`), the default for a seed (`defaultAvatar`), and the conversions to and from the office's look (`lookFromSpec`, `specFromLook`). `public/avatar.js` draws a spec: `renderAvatar3D(THREE, spec, {lod})` builds the office's animated person, and `renderAvatarPortrait(spec, {size})` draws a head-and-shoulders picture. The portrait is SVG drawn from the same spec and the same derived look as the 3D person, not an offscreen WebGL render: it needs no Three.js or WebGL, so the rest of Flow never loads them, and the server can draw the very same picture. Portraits are a few KB, sharp at any size, and cached by `portraitKey(spec)`: the portrait renderer's version plus a hash of the spec's canonical JSON, so equal specs share one picture across sessions and machines.

## Storage and the API

Each account has one row: the spec (or none, for the default), and whether to use the avatar instead of the photo. It is stored by sign-in email in Postgres (`flygon_flow_avatars`) or under `BACKUP_DIR` (`_avatars.json`).

| Route | What it does |
| --- | --- |
| `GET /api/me/avatar` | Your avatar: `{key, avatar, custom, usePortrait, updated, source}`. `avatar` is always a full spec (your default when `custom` is `false`). `key` is your office member key. |
| `PUT /api/me/avatar` | `{avatar}` saves a spec (`null` goes back to the default); `{usePortrait}` sets the photo choice. Either or both. Refused with 400 for an invalid spec and 413 over 2 KB. |
| `GET /api/avatar/<key>?env=<id>` | Someone's avatar: `{key, avatar, custom}`. `<key>` is their office member key or their OneProfileID id, never an email. Only for people you already see in that environment: its owner, its members and its share recipients, when you can open its office. Anyone else is a 404. |

These routes are for the signed-in Flow page only (they work in local mode too): API keys and the owner token are refused. Saves are rate limited. The office's own save (`POST /api/office/<env>/look`) also saves to your account.

**Looks saved before accounts had avatars** move to your account the first time it is read: the most recently saved of them wins (the office's per-person look, or one kept with a room). After that the account row is what counts, so going back to the default does not bring an old look back.

## OneProfileID later

Flow does not send avatars to OneProfileID today. The design keeps a clean seam for when it does:

- **Where it would live.** OneProfileID would store the same spec, unchanged, as a profile attribute next to the account photo (for example `avatar`), with the time it was saved. Apps that know the spec read it with the same module, `avatar-spec.js`; apps that don't can show the portrait OneProfileID draws with `avatar.js`.
- **The seam.** Each stored avatar has a `source` (`local` today). An `avatarSource` is either `local` (Flow's own table) or `opid` (the profile attribute). `GET` and `PUT /api/me/avatar` keep their shape either way.
- **Sync.** With `opid`, Flow reads the attribute when you sign in and when its window regains focus, and writes it when you save (Flow to OneProfileID on save, OneProfileID to Flow on read). Flow keeps its row as a cache, so the office still works when OneProfileID is unreachable.
- **Conflicts.** The last saved wins: each side keeps the time of its last save, and the newer spec replaces the older one whole. Fields one side doesn't know are kept by the rules above, so nothing is lost by passing through an older app.
- **Privacy.** The spec holds no personal data beyond what you chose to look like. Who may see it follows the same rules as the photo: in Flow, only people who already see you; in OneProfileID, its own rules for profile photos.
