// Presence in the 3D office: Available, Focus, Do not disturb and Away, drawn on avatars,
// name tags and door signs. The server (lib/office-status.mjs) keeps it in memory and
// broadcasts it on the office event stream. This browser also stores the person's own
// choice in localStorage so a reload does not reset it.
//
// Activity pings (a coding agent waiting on its person) ask status.isQuiet(userId) first.
// userId is the office member key. While that is true, status.notePing(userId, ping) holds
// the ping on a badge instead of announcing it; status.takeHeld(userId) returns the held
// pings once they leave Do not disturb. The office calls this itself for waiting agents.
import * as THREE from './vendor/three/three.module.min.js';
import {initials} from './devops-core.js';
import {cleanPresenceStatus, doorPolicy, isQuietStatus, nextPresence, presenceMeta, PRESENCE_STATUSES, roomLocal} from './office-status-core.js';
import {DOOR_W, ROOM_D, ROOM_W} from './office-layout.js';

const STORE = 'flow.office.status';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

const byKey = new Map();
const held = new Map();

function listHeld(userId) {
  return held.get(userId) || [];
}

// The hook activity code calls. Quiet means Do not disturb: pings and notifications
// stay on the badge until they switch back.
export const status = {
  isQuiet(userId) {
    return isQuietStatus(byKey.get(userId)?.status);
  },
  notePing(userId, ping) {
    if (!this.isQuiet(userId)) return {held: false, count: listHeld(userId).length};
    const list = listHeld(userId);
    const id = ping && ping.id != null ? String(ping.id) : '';
    if (id && list.some(p => p.id === id)) return {held: true, count: list.length};
    list.push({id, title: String(ping?.title || ping?.text || 'Waiting').slice(0, 120), at: Date.now()});
    held.set(userId, list);
    return {held: true, count: list.length};
  },
  takeHeld(userId) {
    const list = listHeld(userId);
    held.delete(userId);
    return list;
  },
};

function loadChoice() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    return cleanPresenceStatus(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveChoice(choice) {
  try { localStorage.setItem(STORE, JSON.stringify({status: choice.status, text: choice.text || ''})); } catch { /* private mode */ }
}

function safeImage(image) {
  return typeof image === 'string' && /^(https:|blob:|data:image\/)/.test(image) ? image : '';
}

export function nameTagHtml({name, image, self, bg, fg, presence, key}) {
  const meta = presenceMeta(presence?.status);
  const photo = safeImage(image);
  const badge = photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  const note = presence?.text ? `<small>${esc(presence.text)}</small>` : '';
  const who = key ? ` data-office-person="${esc(key)}"` : '';
  return `<span class="of-name${self ? ' me' : ''}"${who} data-status="${esc(meta.id)}" style="--bg:${bg};--fg:${fg};--st:${meta.color}"><i class="of-avatar">${esc(initials(name))}${badge}</i><b>${esc(name)}</b><em class="of-st" title="${esc(meta.label)}">${meta.glyph}</em>${note}</span>`;
}

export function roomTagHtml({name, me, fg, online, seen, presence, key, extra}) {
  const show = online ? presenceMeta(presence?.status) : null;
  const bits = [];
  if (!online) bits.push(`offline${seen ? ` · last seen ${seen}` : ''}`);
  else if (presence?.text) bits.push(presence.text);
  else if (show && show.id !== 'available') bits.push(show.label);
  if (extra) bits.push(extra);
  const note = bits.length ? ` · ${bits.join(' · ')}` : '';
  const mark = show ? `<em class="of-st" title="${esc(show.label)}">${show.glyph}</em>` : '';
  const color = show ? show.color : fg;
  const who = key ? ` data-office-person="${esc(key)}"` : '';
  return `<span class="of-room"${who} data-status="${show ? esc(show.id) : 'offline'}" style="--c:${fg};--st:${color}">${mark}<b>${esc(name)}</b>${me ? ' · your room' : ''}<small>${esc(note)}</small></span>`;
}

function toast(root, text, {bad = false, html = '', actions = [], ms = 8000} = {}) {
  const stack = root.querySelector('.of-toasts');
  if (!stack) return null;
  const el = document.createElement('div');
  el.className = 'of-toast' + (bad ? ' bad' : '');
  el.setAttribute('role', 'status');
  if (html) el.innerHTML = html;
  else el.textContent = text;
  stack.append(el);
  const timer = setTimeout(() => el.remove(), ms);
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'of-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => { clearTimeout(timer); el.remove(); action.run(); });
      row.append(button);
    }
    el.append(row);
  }
  return el;
}

let audioCtx;
function soundOn() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;
  try { audioCtx = audioCtx || new AC(); audioCtx.resume?.(); } catch { return null; }
  return audioCtx;
}
function tone(freq, at, dur, gain) {
  const ac = soundOn();
  if (!ac) return;
  const osc = ac.createOscillator(), amp = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  amp.gain.setValueAtTime(gain, ac.currentTime + at);
  amp.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + at + dur);
  osc.connect(amp);
  amp.connect(ac.destination);
  osc.start(ac.currentTime + at);
  osc.stop(ac.currentTime + at + dur + 0.02);
}
const playKnock = () => { tone(180, 0, 0.08, 0.18); tone(140, 0.14, 0.1, 0.14); };
const playChime = () => { tone(880, 0, 0.12, 0.05); tone(1320, 0.1, 0.16, 0.035); };

// One open office. office is the office.js state object; officeBox builds a collider.
export function attachOfficeStatus(office, {officeBox, refreshColliders} = {}) {
  const root = office.root;
  root.insertAdjacentHTML('beforeend', '<div class="of-toasts" aria-live="polite"></div>');
  const top = root.querySelector('.of-top');
  const hud = document.createElement('div');
  hud.className = 'of-presence';
  hud.innerHTML = `<button type="button" class="of-presence-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="Status: Available"><i></i><span>Available</span><b class="of-held" hidden></b><b class="of-knocks" hidden></b></button>
    <ul class="of-presence-menu" role="listbox" hidden>${PRESENCE_STATUSES.map(id => {
      const meta = presenceMeta(id);
      return `<li role="none"><button type="button" role="option" data-presence-status="${id}"><i style="background:${meta.color}"></i>${esc(meta.label)}</button></li>`;
    }).join('')}</ul>
    <input class="of-presence-text" maxlength="60" placeholder="Add a note" aria-label="Status note" autocomplete="off">`;
  top.querySelector('.of-keys')?.before(hud);
  const button = hud.querySelector('.of-presence-btn');
  const menu = hud.querySelector('.of-presence-menu');
  const note = hud.querySelector('.of-presence-text');
  const heldEl = hud.querySelector('.of-held');
  const knockEl = hud.querySelector('.of-knocks');
  const knockBtn = document.createElement('button');
  knockBtn.type = 'button';
  knockBtn.className = 'of-knock';
  knockBtn.hidden = true;
  knockBtn.innerHTML = 'Knock <kbd>E</kbd>';
  root.append(knockBtn);

  let choice = {status: 'available', text: ''};
  let auto = false;
  let lastInput = Date.now();
  let publishedAt = 0;
  let textTimer = 0;
  let seeded = false;
  const seenWaiting = new Set();
  const seenKnocks = new Set();
  const admits = new Map();
  let knockState = {count: 0, label: ''};
  let knockRoom = '';
  let doorRoot = null;
  let hinges = [];
  let boxSig = '';
  let wasInside = new Set();
  const api = (path, body) => fetch(`/api/office/${encodeURIComponent(office.env)}/${path}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(Error(data.error || 'Something went wrong'), {code: data.code, status: r.status});
    return data;
  });

  function mine() {
    return byKey.get(office.meKey) || choice;
  }
  function paintHeld(count) {
    heldEl.hidden = count < 1;
    heldEl.textContent = count > 99 ? '99+' : String(count);
    button.classList.toggle('quiet', status.isQuiet(office.meKey));
  }
  function syncHud() {
    const cur = mine();
    const meta = presenceMeta(cur.status);
    button.querySelector('i').style.background = meta.color;
    button.querySelector('span').textContent = meta.label;
    button.setAttribute('aria-label', `Status: ${meta.label}`);
    button.setAttribute('aria-expanded', String(!menu.hidden));
    for (const opt of menu.querySelectorAll('[data-presence-status]')) opt.setAttribute('aria-selected', String(opt.dataset.presenceStatus === cur.status));
    if (document.activeElement !== note) note.value = choice.text || '';
    paintHeld(listHeld(office.meKey).length);
    paintKnockBadge();
  }
  function paintKnockBadge(data) {
    if (data) knockState = {count: data.count || 0, label: data.label || knockLabelOf(data.count || 0)};
    const show = knockState.count > 0 && status.isQuiet(office.meKey);
    knockEl.hidden = !show;
    knockEl.textContent = knockState.count > 99 ? '99+' : String(knockState.count);
    knockEl.title = knockState.label;
  }
  function knockLabelOf(n) { return `${n} ${n === 1 ? 'knock' : 'knocks'}`; }
  function paintPerson(avatar) {
    if (!avatar?.tag) return;
    const presence = byKey.get(avatar.key) || {status: 'available', text: ''};
    const [bg, fg] = avatar.colors || ['#ccc', '#333'];
    avatar.tag.el.innerHTML = nameTagHtml({name: avatar.name, image: avatar.image, self: avatar.self, bg, fg, presence, key: avatar.key});
    let ring = avatar.obj.userData.statusRing;
    if (!ring) {
      ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 6, 18), new THREE.MeshBasicMaterial({color: presenceMeta(presence.status).color}));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.07;
      ring.userData.own = true;
      avatar.obj.add(ring);
      avatar.obj.userData.statusRing = ring;
    }
    ring.material.color.set(presenceMeta(presence.status).color);
  }
  function paintRoom(room, online) {
    if (!room?.tag) return;
    const presence = byKey.get(room.member.key) || {status: 'available', text: ''};
    const seen = room.seen || '';
    room.tag.el.innerHTML = roomTagHtml({name: room.member.name, me: room.member.me, fg: room.fg || '#888', online, seen, presence, key: room.member.key, extra: room.note || ''});
  }
  function paintAll() {
    if (!office.people) return;
    for (const avatar of office.people.values()) paintPerson(avatar);
    for (const room of office.rooms?.values?.() || []) {
      const online = office.people.has(room.member.key) || room.member.me;
      paintRoom(room, online);
    }
  }
  function publish(next, {automatic = false, auto: stayAuto = null} = {}) {
    const clean = cleanPresenceStatus({status: next.status, text: next.text ?? choice.text});
    const prev = mine().status;
    if (automatic) {
      // An automatic Away must not replace the status they picked. A manual Away
      // stays the saved choice, so leaving the automatic state has to be told apart.
      auto = stayAuto != null ? stayAuto : clean.status === 'away';
      choice = {status: choice.status, text: clean.text};
      saveChoice(choice);
    } else { auto = false; choice = clean; saveChoice(choice); }
    const shown = {status: clean.status, text: choice.text};
    if (office.meKey) byKey.set(office.meKey, shown);
    publishedAt = Date.now();
    syncHud();
    paintAll();
    const left = prev === 'dnd' && shown.status !== 'dnd';
    const heldHere = left ? status.takeHeld(office.meKey) : [];
    if (left) paintHeld(0);
    const say = n => { if (n === 1) toast(root, '1 agent was waiting'); else if (n) toast(root, `${n} agents were waiting`); };
    api('status', shown).then(d => { if (left) say(Math.max(heldHere.length, d.released || 0)); }).catch(e => { if (left) say(heldHere.length); toast(root, e.message, {bad: true}); });
  }
  function closeMenu() {
    if (menu.hidden) return false;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    return true;
  }
  function onPointer() { lastInput = Date.now(); }
  function onVis() { lastInput = Date.now(); }
  addEventListener('pointerdown', onPointer, true);
  addEventListener('keydown', onPointer, true);
  addEventListener('wheel', onPointer, true);
  document.addEventListener('visibilitychange', onVis);
  button.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
  });
  menu.addEventListener('click', e => {
    const id = e.target.closest('[data-presence-status]')?.dataset.presenceStatus;
    if (!id) return;
    closeMenu();
    publish({status: id, text: note.value});
  });
  note.addEventListener('input', () => {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => publish(auto ? {status: 'away', text: note.value} : {status: mine().status, text: note.value}, {automatic: auto}), 400);
  });
  note.addEventListener('keydown', e => e.stopPropagation());
  root.addEventListener('click', e => { if (!hud.contains(e.target)) closeMenu(); });

  function worldApi() {
    return office.worldApi || office.theme || globalThis.flowOfficeWorld || null;
  }
  function anchorFor(room) {
    const given = worldApi()?.doorAnchor?.(room);
    if (given && Number.isFinite(given.x) && Number.isFinite(given.z)) {
      return {
        x: given.x, z: given.z,
        yaw: Number.isFinite(given.yaw) ? given.yaw : room.facing || 0,
        width: Number.isFinite(given.width) && given.width > 0.4 ? given.width : DOOR_W,
        y: Number.isFinite(given.y) ? given.y : 0,
      };
    }
    const entrance = room.entrance || room.door || room.center;
    return {x: entrance.x, z: entrance.z, yaw: room.facing || 0, width: DOOR_W, y: entrance.y || 0};
  }
  function policyFor(room) {
    const key = room.member?.key;
    if (!key || key === office.meKey) return {open: true, enter: false, knock: false, sound: false};
    const online = !!office.people?.has(key);
    const presence = byKey.get(key)?.status || 'available';
    return doorPolicy({online, presence, admitted: (admits.get(key) || 0) > Date.now()});
  }
  function contains(room, x, z, y = 0) {
    if (!room?.center) return false;
    // A cabin on another deck shares no floor with you. Two metres is more than a jump.
    if (Math.abs(y - (room.center.y || 0)) > 2) return false;
    const l = roomLocal(room.center.x, room.center.z, room.facing || 0, x, z);
    return Math.abs(l.x) < ROOM_W / 2 - 0.35 && Math.abs(l.z) < ROOM_D / 2 - 0.35;
  }
  function disposeDoors() {
    doorRoot?.traverse(o => { if (!o.userData.own) return; o.geometry?.dispose(); o.material?.dispose(); });
    doorRoot?.removeFromParent();
    doorRoot = null;
    hinges = [];
  }
  function syncDoors() {
    disposeDoors();
    if (!office.world || !office.rooms) return;
    doorRoot = new THREE.Group();
    office.world.add(doorRoot);
    for (const room of office.rooms.values()) {
      const anchor = anchorFor(room);
      const pivot = new THREE.Group();
      // Hinge on the local −x jamb. rotation.y > 0 swings the slab toward local −z, into the room.
      pivot.position.set(anchor.x, anchor.y, anchor.z);
      pivot.rotation.y = anchor.yaw;
      const swing = new THREE.Group();
      swing.position.x = -anchor.width / 2;
      const slabMat = new THREE.MeshLambertMaterial({color: '#d7c4a3', flatShading: true});
      const slab = new THREE.Mesh(new THREE.BoxGeometry(anchor.width, 2.4, 0.08), slabMat);
      slab.position.set(anchor.width / 2, 1.2, 0);
      slab.userData.own = true;
      const knobMat = new THREE.MeshLambertMaterial({color: '#8a6a3b', flatShading: true});
      const knob = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.12), knobMat);
      knob.position.set(anchor.width - 0.22, 1.05, 0.08);
      knob.userData.own = true;
      swing.add(slab, knob);
      pivot.add(swing);
      swing.rotation.y = policyFor(room).open ? Math.PI / 2 : 0;
      doorRoot.add(pivot);
      hinges.push({room, anchor, swing});
    }
    boxSig = '';
  }
  function doorBoxes() {
    if (!officeBox) return [];
    const out = [];
    for (const door of hinges) {
      if (policyFor(door.room).open) continue;
      const a = door.anchor;
      // Taller than a jump (feet reach about 1.4 above the deck). Same x, z and yaw as the
      // closed slab. Collision boxes start at the ground, so a door on a raised deck is as
      // tall as that deck plus the slab, the same way the room walls are.
      out.push(officeBox(a.x, a.z, a.yaw, a.width, 0.08, 2.4 + (a.y || 0)));
    }
    return out;
  }
  function refreshBoxes() {
    const sig = hinges.map(d => policyFor(d.room).open ? '' : d.room.member.key).join('|');
    if (sig === boxSig) return;
    boxSig = sig;
    refreshColliders?.();
  }
  function swingDoors() {
    for (const door of hinges) {
      const target = policyFor(door.room).open ? Math.PI / 2 : 0;
      door.swing.rotation.y += (target - door.swing.rotation.y) * 0.18;
    }
  }
  function showPrompt(room) {
    knockRoom = room?.member?.key || '';
    knockBtn.hidden = !knockRoom;
  }
  function doKnock() {
    if (!knockRoom) return;
    api('knock', {room: knockRoom}).catch(e => toast(root, e.status === 429 ? 'Wait a moment before knocking again' : e.message, {bad: true}));
  }
  knockBtn.addEventListener('click', doKnock);
  function showKnock(item) {
    if (!item?.from || status.isQuiet(office.meKey)) return;
    const id = item.from + '|' + (item.at || '');
    if (seenKnocks.has(id)) return;
    seenKnocks.add(id);
    const name = item.name || 'Someone';
    toast(root, `${name} is at the door`, {
      ms: 20000,
      actions: [
        {label: 'Let in', run: () => api('admit', {from: item.from, admit: true}).catch(e => toast(root, e.message, {bad: true}))},
        {label: 'Not now', run: () => api('admit', {from: item.from, admit: false}).catch(e => toast(root, e.message, {bad: true}))},
      ],
    });
  }
  function applyAdmissions(rows) {
    admits.clear();
    for (const row of rows || []) if (row?.room && row.until > Date.now()) admits.set(row.room, row.until);
    boxSig = '';
  }

  return {
    destroy() {
      clearTimeout(textTimer);
      removeEventListener('pointerdown', onPointer, true);
      removeEventListener('keydown', onPointer, true);
      removeEventListener('wheel', onPointer, true);
      document.removeEventListener('visibilitychange', onVis);
      hud.remove();
      knockBtn.remove();
      disposeDoors();
      root.querySelector('.of-toasts')?.remove();
      byKey.clear();
      held.clear();
    },
    closeOverlays() { return closeMenu(); },
    toast(text,bad) { return toast(root,text,{bad}); },
    // EventSource listener registrar from office.js connect().
    bind(on) {
      on('status', data => {
        if (!data?.key || !PRESENCE_STATUSES.includes(data.status)) return;
        const text = typeof data.text === 'string' ? data.text : '';
        byKey.set(data.key, {status: data.status, text});
        // Our own echo arrives at once. A later event is another tab, and replaces the saved choice.
        if (data.key === office.meKey && !auto && Date.now() - publishedAt > 800) {
          choice = {status: data.status, text};
          saveChoice(choice);
        }
        syncHud();
        paintAll();
        boxSig = '';
      });
      on('knock', data => {
        playKnock();
        showKnock(data);
      });
      on('knockBadge', data => paintKnockBadge(data));
      on('knocks', data => {
        paintKnockBadge({count: 0, label: ''});
        for (const item of data?.items || []) showKnock(item);
      });
      on('knockAnswer', data => {
        if (!data) return;
        if (data.admit) {
          if (data.room) admits.set(data.room, data.until || Date.now() + 120000);
          boxSig = '';
          toast(root, `${data.name || 'They'} let you in`);
        } else {
          const name = data.name || 'They';
          toast(root, data.mode === 'dnd' ? `${name} does not want to be disturbed` : `${name} is focusing`);
        }
      });
      on('entered', data => {
        playChime();
        toast(root, `${data?.name || 'Someone'} came in`);
      });
    },
    onSnapshot(d) {
      for (const row of d.statuses || []) {
        if (row?.key && PRESENCE_STATUSES.includes(row.status)) byKey.set(row.key, {status: row.status, text: row.text || ''});
      }
      applyAdmissions(d.admissions);
      const saved = loadChoice();
      const serverMine = byKey.get(office.meKey);
      choice = saved || serverMine || {status: 'available', text: ''};
      auto = false;
      if (office.meKey) byKey.set(office.meKey, {status: choice.status, text: choice.text});
      syncHud();
      paintAll();
      paintKnockBadge(d.knocks);
      if (d.knocks?.items) for (const item of d.knocks.items) showKnock(item);
      // This browser's saved choice wins over whatever the server still has.
      if (saved) api('status', choice).catch(e => toast(root, e.message, {bad: true}));
    },
    nameTag(opts) { return nameTagHtml(opts); },
    paintPerson,
    paintRoom,
    tickIdle() {
      if (!office.meKey) return;
      const cur = mine().status;
      const next = nextPresence({choice: choice.status, current: cur, auto, hidden: document.hidden, idleMs: Date.now() - lastInput});
      if (!next.changed) return;
      publish({status: next.status, text: choice.text}, {automatic: true, auto: next.auto});
    },
    observeWaiting(member, agents) {
      if (member !== office.meKey) return;
      const list = agents || [];
      if (!seeded) {
        seeded = true;
        for (const a of list) if (a.status === 'waiting' && a.id) seenWaiting.add(a.id);
        return;
      }
      for (const a of list) {
        if (!a?.id) continue;
        if (a.status !== 'waiting') { seenWaiting.delete(a.id); continue; }
        if (seenWaiting.has(a.id)) continue;
        seenWaiting.add(a.id);
        const res = status.notePing(office.meKey, {id: a.id, title: a.title || 'Agent'});
        if (res.held) paintHeld(res.count);
      }
    },
    // A themed world may answer doorAnchor(room) with a world {x, z, yaw, width, y}.
    worldApi,
    doorBoxes,
    syncDoors,
    beforeMove() {
      const now = Date.now();
      for (const [key, until] of admits) if (until <= now) admits.delete(key);
      refreshBoxes();
      swingDoors();
    },
    afterMove(player) {
      if (!player || !office.rooms) return;
      const nowIn = new Set();
      let prompt = null;
      let best = 2.2;
      for (const room of office.rooms.values()) {
        const feet = player.y || 0;
        if (contains(room, player.x, player.z, feet)) nowIn.add(room.member.key);
        const door = hinges.find(h => h.room === room);
        if (!door || policyFor(room).open || contains(room, player.x, player.z, feet)) continue;
        if (Math.abs(feet - (door.anchor.y || 0)) > 2) continue;
        const dist = Math.hypot(player.x - door.anchor.x, player.z - door.anchor.z);
        if (dist < best) { best = dist; prompt = room; }
      }
      for (const key of nowIn) if (!wasInside.has(key)) {
        const room = office.rooms.get(key);
        if (room && policyFor(room).enter) api('enter', {room: key}).catch(() => {});
      }
      wasInside = nowIn;
      showPrompt(prompt);
    },
    // E knocks only while the prompt is up, so it still talks to agents everywhere else.
    onKey(e) {
      if (knockBtn.hidden || e.repeat || e.key?.toLowerCase() !== 'e') return false;
      e.preventDefault();
      doKnock();
      return true;
    },
  };
}
