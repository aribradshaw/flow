// The look editor for the 3D office (docs/concepts/12-office.md): a full-screen dialog with a turntable
// preview of you and, per tab, every option as a small picture and every colour as a swatch.
//
//   const editor=openLookEditor({key, name, look, host, save(look|null) -> Promise, toast, onClose})
//   editor.close()
//
// key: whose look it is (their default look is derived from it). save(null) goes back to that default.
// The preview is its own small WebGL canvas. Option pictures are drawn with the same renderer, a few per
// frame, and kept until the look they were drawn from changes. Nothing is saved until Save.
import * as THREE from './vendor/three/three.module.min.js';
import {icon} from './icons.js';
import {createAvatar} from './office-avatar.js';
import {LOOK_OPTIONS, LOOK_LABELS, LOOK_SWATCHES, lookLabel, cleanLook, clampColor, defaultLook, randomLook, sameLook} from './office-look-core.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
// Tabs: which fields each shows, and where the preview looks while it is open ([target height, distance]).
const TABS = [
  {id: 'body', label: 'Body', fields: ['skin', 'build', 'height'], view: [0.92, 4.3]},
  {id: 'face', label: 'Face', fields: ['eyes', 'eyeColor', 'brows', 'nose', 'mouth', 'beard', 'glasses', 'freckles', 'blush'], view: [1.5, 2.1]},
  {id: 'hair', label: 'Hair', fields: ['hair', 'hairColor'], view: [1.52, 2.5]},
  {id: 'hat', label: 'Hat', fields: ['hat', 'hatColor'], view: [1.56, 2.5]},
  {id: 'top', label: 'Top', fields: ['top', 'topColor', 'pattern', 'accent'], view: [1.12, 2.5]},
  {id: 'bottoms', label: 'Bottoms', fields: ['bottoms', 'bottomsColor'], view: [0.55, 2.8]},
  {id: 'shoes', label: 'Shoes', fields: ['shoes', 'shoesColor'], view: [0.28, 2.2]},
];
// How an option's picture is framed: [target height, distance, yaw].
const THUMB_VIEW = {build: [0.92, 4.1, 0.35], height: [0.92, 4.4, 0.35], eyes: [1.52, 0.95, 0], brows: [1.54, 0.95, 0], nose: [1.5, 1.0, 0.55], mouth: [1.47, 0.95, 0],
  beard: [1.47, 1.3, 0.35], glasses: [1.52, 1.25, 0.35], hair: [1.56, 1.75, 0.5], hat: [1.6, 1.75, 0.5], top: [1.1, 2.3, 0.35], pattern: [1.1, 2.1, 0.2], bottoms: [0.52, 2.6, 0.35], shoes: [0.12, 1.25, 0.7]};
const THUMB = 144;

export function openLookEditor({key, name = 'You', look, host = document.body, save, toast = () => {}, onClose = () => {}}) {
  const base = defaultLook(key);
  let current = cleanLook(look, {key}), tab = TABS[0], mode = 'idle', saving = false, closed = false;
  const start = current, history = [];
  const debug = navigator.webdriver || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || (() => { try { return localStorage.getItem('flow.debug') === '1'; } catch { return false; } })();

  const dialog = document.createElement('dialog');
  dialog.className = 'of-look';
  dialog.setAttribute('aria-label', 'Edit your look');
  dialog.innerHTML = `<form method="dialog" class="of-look-box" novalidate>
    <header class="of-look-top">
      <strong>${icon('shirt', 16)}Edit your look</strong><span class="sp"></span>
      <button type="button" class="txt" data-look="random">${icon('dice', 13)}Randomize</button>
      <button type="button" class="txt" data-look="undo" disabled>${icon('undo', 13)}Undo</button>
      <button type="button" class="txt" data-look="reset">Reset to default</button>
      <button type="button" class="txt" data-look="cancel">Cancel</button>
      <button type="button" class="txt primary" data-look="save">${icon('check', 13)}Save</button>
    </header>
    <div class="of-look-main">
      <div class="of-look-stage">
        <canvas class="of-look-canvas" aria-label="A preview of ${esc(name)}. Drag to turn, scroll to zoom." tabindex="0"></canvas>
        <div class="of-look-moves" role="group" aria-label="Preview">
          ${[['idle', 'Stand'], ['walk', 'Walk'], ['run', 'Run'], ['wave', '👋'], ['thumbs', '👍'], ['clap', '👏'], ['heart', '❤️']].map(([id, label]) => `<button type="button" data-move="${id}" aria-pressed="${id === 'idle'}"${label.length < 3 ? ` aria-label="${id}"` : ''}>${label}</button>`).join('')}
        </div>
        <p class="of-look-hint">Drag to turn · scroll or pinch to zoom</p>
        <output class="of-look-debug"${debug ? '' : ' hidden'}></output>
      </div>
      <div class="of-look-side">
        <div class="of-look-tabs" role="tablist" aria-label="Parts">${TABS.map((t, i) => `<button type="button" role="tab" id="of-look-tab-${t.id}" data-tab="${t.id}" aria-selected="${!i}" tabindex="${i ? -1 : 0}">${t.label}</button>`).join('')}</div>
        <div class="of-look-panel" role="tabpanel"></div>
      </div>
    </div>
  </form>`;
  host.append(dialog);
  const $ = sel => dialog.querySelector(sel), canvas = $('.of-look-canvas'), panel = $('.of-look-panel'), stageEl = $('.of-look-stage');

  // ---------- the preview ----------
  let renderer = null, raf = 0;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(32, 1, 0.05, 60), thumbCamera = new THREE.PerspectiveCamera(30, 1, 0.05, 60);
  scene.add(new THREE.HemisphereLight('#ffffff', '#b9c4bf', 2.2));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6); sun.position.set(4, 9, 7); scene.add(sun);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1.15, 40), new THREE.MeshLambertMaterial({color: '#dfe8e3'})); floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), new THREE.MeshBasicMaterial({color: '#000', transparent: true, opacity: 0.13, depthWrite: false})); blob.rotation.x = -Math.PI / 2; blob.position.y = 0.012; scene.add(blob);
  const figure = createAvatar(current), model = createAvatar(current);
  figure.userData.forceLod(0); model.userData.forceLod(0); model.visible = false;
  scene.add(figure, model);
  const view = {yaw: 0.35, pitch: 0.08, dist: tab.view[1], y: tab.view[0], toDist: tab.view[1], toY: tab.view[0], spin: 0};
  const clock = new THREE.Clock();
  let emoteAt = 0, cycle = 0;
  try {
    renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: 'low-power'});
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  } catch { stageEl.insertAdjacentHTML('afterbegin', '<p class="of-look-fail">3D graphics are unavailable in this browser.</p>'); }
  const fit = () => {
    if (!renderer) return;
    const w = Math.max(1, stageEl.clientWidth), h = Math.max(1, stageEl.clientHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  const resize = new ResizeObserver(fit); resize.observe(stageEl);
  const stateFor = (t, dt) => {
    if (mode === 'walk' || mode === 'run') { const speed = mode === 'run' ? 8.5 : 5.2; cycle += dt * speed * (mode === 'run' ? 1.98 : 2.35); return {speed, cycle}; }
    return mode === 'idle' ? {} : {emote: {kind: mode, at: emoteAt}};
  };
  // Option pictures: drawn at their own size before the frame's preview, so the canvas never shows them.
  const thumbs = new Map();
  let queue = [];
  function drawThumbs() {
    if (!renderer || !queue.length) return;
    const size = renderer.getSize(new THREE.Vector2()), ratio = renderer.getPixelRatio();
    renderer.setPixelRatio(1); renderer.setSize(THUMB, THUMB, false);
    figure.visible = false; floor.visible = false; blob.visible = false; model.visible = true;
    for (let n = 0; n < 6 && queue.length; n++) {
      const job = queue.shift();
      if (!job.el.isConnected || job.el.dataset.sig !== job.sig) continue;
      model.userData.setLook(job.look); model.userData.forceLod(0); model.userData.update(0, {snap: true});
      const [y, d, yaw] = THUMB_VIEW[job.field] || [0.92, 4, 0.3], s = model.userData.rig.scale || 1;
      thumbCamera.position.set(Math.sin(yaw) * d, y * s + d * 0.06, Math.cos(yaw) * d); thumbCamera.lookAt(0, y * s, 0);
      renderer.render(scene, thumbCamera);
      const ctx = job.el.getContext('2d'); ctx.clearRect(0, 0, THUMB, THUMB); ctx.drawImage(renderer.domElement, 0, 0, THUMB, THUMB);
      createImageBitmap(job.el).then(bmp => { thumbs.set(job.sig, bmp); if (thumbs.size > 400) thumbs.delete(thumbs.keys().next().value); }).catch(() => {});
    }
    figure.visible = true; floor.visible = true; blob.visible = true; model.visible = false;
    renderer.setPixelRatio(ratio); renderer.setSize(size.x, size.y, false);
  }
  function frame() {
    if (closed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
    if (mode !== 'idle' && mode !== 'walk' && mode !== 'run' && performance.now() - emoteAt > 1700) setMode('idle');
    const k = 1 - Math.exp(-dt * 6);
    view.dist += (view.toDist - view.dist) * k; view.y += (view.toY - view.y) * k;
    figure.userData.update(t, stateFor(t, dt));
    if (!renderer) return;
    drawThumbs();
    const s = figure.userData.rig.scale || 1, cy = view.y * s, cp = Math.cos(view.pitch);
    camera.position.set(Math.sin(view.yaw) * cp * view.dist, cy + Math.sin(view.pitch) * view.dist, Math.cos(view.yaw) * cp * view.dist);
    camera.lookAt(0, cy, 0);
    renderer.render(scene, camera);
  }
  // Drag turns, wheel and pinch zoom; zooming in moves the view up to the face.
  const FACE_Y = 1.5;
  const zoomTo = d => {
    view.toDist = Math.max(0.9, Math.min(5.5, d));
    const f = Math.max(0, Math.min(1, (view.toDist - 1.3) / Math.max(0.1, tab.view[1] - 1.3)));
    view.toY = tab.id === 'body' || tab.id === 'top' ? FACE_Y + (tab.view[0] - FACE_Y) * f : tab.view[0];
  };
  const pointers = new Map(); let pinch = 0;
  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); pinch = 0; });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId); if (!p) return;
    if (pointers.size === 1) { view.yaw -= (e.clientX - p[0]) * 0.011; view.pitch = Math.max(-0.25, Math.min(0.7, view.pitch + (e.clientY - p[1]) * 0.006)); }
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) zoomTo(view.toDist * pinch / Math.max(1, d)); pinch = d; }
  });
  const up = e => { pointers.delete(e.pointerId); pinch = 0; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoomTo(view.toDist * Math.exp(e.deltaY * 0.0014)); }, {passive: false});
  canvas.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { view.yaw += e.key === 'ArrowLeft' ? -0.25 : 0.25; e.preventDefault(); }
    if (e.key === '+' || e.key === '=' || e.key === '-') { zoomTo(view.toDist * (e.key === '-' ? 1.2 : 1 / 1.2)); e.preventDefault(); }
  });

  // ---------- the options ----------
  const isToggle = f => f === 'freckles' || f === 'blush', isColor = f => !!LOOK_SWATCHES[f];
  // A field that does nothing right now says why, instead of looking broken.
  const idleNote = f => f === 'hatColor' && current.hat === 'none' ? 'Pick a hat first' : f === 'accent' && current.pattern === 'none' && current.top !== 'blazer' && !['ponytail', 'bun', 'braids'].includes(current.hair) ? 'Used by patterns, blazers and hair ties' : f === 'hairColor' && current.hair === 'bald' && current.beard === 'none' ? 'Used by eyebrows' : '';
  function renderPanel() {
    panel.setAttribute('aria-labelledby', 'of-look-tab-' + tab.id);
    panel.innerHTML = tab.fields.map(f => {
      if (isToggle(f)) return `<label class="of-look-toggle"><input type="checkbox" data-field="${f}"${current[f] ? ' checked' : ''}> ${LOOK_LABELS[f]}</label>`;
      const note = idleNote(f);
      if (isColor(f)) {
        const list = LOOK_SWATCHES[f], custom = !list.includes(current[f]);
        return `<fieldset class="of-look-group"><legend>${LOOK_LABELS[f]}${note ? `<small>${note}</small>` : ''}</legend><div class="of-look-swatches">${list.map(c => `<button type="button" class="of-look-swatch" data-field="${f}" data-value="${c}" aria-pressed="${current[f] === c}" aria-label="${LOOK_LABELS[f]} ${c}" style="--c:${c}"></button>`).join('')}
          <label class="of-look-custom${custom ? ' on' : ''}" style="--c:${current[f]}" data-tip="Any colour"><input type="color" data-field="${f}" value="${current[f]}" aria-label="${LOOK_LABELS[f]}: any colour"><span aria-hidden="true">+</span></label></div></fieldset>`;
      }
      return `<fieldset class="of-look-group"><legend>${LOOK_LABELS[f]}</legend><div class="of-look-options">${LOOK_OPTIONS[f].map(id => `<button type="button" class="of-look-option" data-field="${f}" data-value="${id}" aria-pressed="${current[f] === id}"><canvas width="${THUMB}" height="${THUMB}" aria-hidden="true"></canvas><span>${esc(lookLabel(f, id))}</span></button>`).join('')}</div></fieldset>`;
    }).join('');
    paintThumbs();
  }
  // Each picture shows the current look with that one option changed.
  function paintThumbs() {
    queue = queue.filter(job => job.el.isConnected && job.el.dataset.sig === job.sig);
    for (const el of panel.querySelectorAll('.of-look-option')) {
      const f = el.dataset.field, id = el.dataset.value, cv = el.querySelector('canvas');
      let l = {...current, [f]: id};
      // A hat hides hair choices, and glasses hide eyes: show the part itself.
      if (f === 'hair') l.hat = 'none';
      if (f === 'eyes' || f === 'brows') l.glasses = 'none';
      const sig = f + '|' + JSON.stringify(l);
      if (cv.dataset.sig === sig) continue;
      cv.dataset.sig = sig;
      const kept = thumbs.get(sig);
      if (kept) { const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, THUMB, THUMB); ctx.drawImage(kept, 0, 0); } else queue.push({el: cv, sig, look: l, field: f});
    }
  }
  function refresh({rebuild = true} = {}) {
    if (rebuild) figure.userData.setLook(current);
    figure.userData.forceLod(0);
    for (const el of panel.querySelectorAll('[data-field][data-value]')) el.setAttribute('aria-pressed', String(current[el.dataset.field] === el.dataset.value));
    for (const el of panel.querySelectorAll('input[type=checkbox][data-field]')) el.checked = !!current[el.dataset.field];
    for (const el of panel.querySelectorAll('input[type=color][data-field]')) { const f = el.dataset.field; if (document.activeElement !== el) el.value = current[f]; el.parentElement.style.setProperty('--c', current[f]); el.parentElement.classList.toggle('on', !LOOK_SWATCHES[f].includes(current[f])); }
    $('[data-look=undo]').disabled = !history.length;
    $('[data-look=save]').disabled = saving || sameLook(current, start);
    disarm();
    const st = figure.userData.stats();
    $('.of-look-debug').textContent = `${st.tris} triangles · ${st.lodTris} far · 1 draw call · ${st.bones} bones`;
    paintThumbs();
  }
  // step: false while a colour is being dragged, so one drag is one Undo.
  function change(next, {step = true} = {}) {
    const clean = cleanLook(next, {key});
    if (sameLook(clean, current)) return;
    if (step) { history.push(current); if (history.length > 60) history.shift(); }
    const notes = tab.fields.map(idleNote).join();
    current = clean;
    if (tab.fields.map(idleNote).join() !== notes) renderPanel();
    refresh();
  }
  function setTab(id, focus = false) {
    tab = TABS.find(t => t.id === id) || TABS[0];
    for (const b of dialog.querySelectorAll('[role=tab]')) { const on = b.dataset.tab === tab.id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); }
    view.toY = tab.view[0]; view.toDist = tab.view[1];
    renderPanel(); refresh({rebuild: false});
  }
  function setMode(next) {
    mode = next; emoteAt = performance.now();
    for (const b of dialog.querySelectorAll('[data-move]')) b.setAttribute('aria-pressed', String(b.dataset.move === mode));
  }
  let dragging = null; // a colour input mid-drag: [field, the look before it]
  panel.addEventListener('click', e => {
    const b = e.target.closest('button[data-field]'); if (!b) return;
    change({...current, [b.dataset.field]: b.dataset.value});
  });
  panel.addEventListener('input', e => {
    const el = e.target.closest('input[data-field]'); if (!el) return;
    if (el.type === 'checkbox') { change({...current, [el.dataset.field]: el.checked}); return; }
    const c = clampColor(el.dataset.field, el.value); if (!c) return;
    if (dragging?.[0] !== el.dataset.field) { dragging = [el.dataset.field, current]; history.push(current); }
    change({...current, [el.dataset.field]: c}, {step: false});
  });
  panel.addEventListener('change', e => { if (e.target.matches?.('input[type=color]')) dragging = null; });
  // closest() would walk on up past the dialog into the app's own markup: only what is inside counts.
  const inside = (e, sel) => { const el = e.target.closest?.(sel); return el && dialog.contains(el) ? el : null; };
  dialog.addEventListener('click', e => {
    const t = inside(e, '[data-tab]'); if (t) { setTab(t.dataset.tab); return; }
    const m = inside(e, '[data-move]'); if (m) { setMode(m.dataset.move); return; }
    const a = inside(e, '[data-look]')?.dataset.look; if (!a) return;
    if (a === 'random') change(randomLook());
    else if (a === 'undo') { if (history.length) { current = history.pop(); renderPanel(); refresh(); } }
    else if (a === 'reset') change(base);
    else if (a === 'cancel') leave();
    else if (a === 'save') commit();
  });
  dialog.addEventListener('keydown', e => {
    e.stopPropagation(); // the office underneath does not see the editor's keys
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.matches?.('input[type=text]')) { e.preventDefault(); $('[data-look=undo]').click(); return; }
    const t = inside(e, '[role=tab]');
    if (t && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const i = TABS.indexOf(tab), n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowLeft' ? -1 : 1) + TABS.length) % TABS.length;
      setTab(TABS[n].id, true);
    }
  });
  dialog.addEventListener('keyup', e => e.stopPropagation());
  dialog.addEventListener('cancel', e => { e.preventDefault(); leave(); });
  dialog.addEventListener('close', () => close());
  // The office closes it without asking (it is going away itself).

  // Leaving with unsaved changes takes a second press: Cancel turns into Discard changes for a few seconds.
  let armed = 0;
  const cancelBtn = $('[data-look=cancel]');
  function disarm() { clearTimeout(armed); armed = 0; cancelBtn.textContent = 'Cancel'; cancelBtn.classList.remove('warn'); }
  function leave() {
    if (saving) return;
    if (sameLook(current, start) || armed) { close(); return; }
    cancelBtn.textContent = 'Discard changes'; cancelBtn.classList.add('warn'); cancelBtn.focus();
    armed = setTimeout(disarm, 4000);
  }
  async function commit() {
    if (saving) return;
    if (sameLook(current, start)) { close(); return; }
    saving = true; const btn = $('[data-look=save]'); btn.disabled = true;
    try { await save(sameLook(current, base) ? null : current); close(); }
    catch (e) { saving = false; btn.disabled = false; toast(e?.message || 'Your look could not be saved', true); }
  }
  function close() {
    if (closed) return; closed = true;
    clearTimeout(armed); cancelAnimationFrame(raf); resize.disconnect();
    figure.userData.dispose(); model.userData.dispose(); floor.geometry.dispose(); floor.material.dispose(); blob.geometry.dispose(); blob.material.dispose();
    for (const bmp of thumbs.values()) bmp.close?.();
    thumbs.clear(); renderer?.dispose(); renderer?.forceContextLoss?.();
    if (dialog.open) dialog.close();
    dialog.remove();
    onClose();
  }

  dialog.showModal();
  fit(); setTab(tab.id); frame();
  $('[role=tab][aria-selected=true]').focus();
  return {dialog, close, look: () => current, stats: () => figure.userData.stats(), busy: () => queue.length};
}
