// model-inspect.js — click-to-select inspection and error marking for model viewers.
//
// Purpose: let a reviewer point AT a defect instead of describing it. Marks are exported as
// JSON carrying the part name, the triangle index, and the world position that was clicked,
// which is enough to locate the offending code — part names come straight from the build,
// so `feather-2-l` or `chine-strip-r` names the function that made it.
//
// Controls
//   click            select (object mode: whole named part · face mode: one triangle)
//   O / F            switch between object and face selection
//   H                hide the selection            U  undo the last hide
//   Backspace/Del    delete the selected face (face mode) or part (object mode)
//   M                mark the selection as an error, with a typed note
//   X                clear all marks
//   E                export marks as JSON (downloads, copies to clipboard, logs)
//   Esc              deselect
//
// Marks persist in localStorage per model, so a reload does not lose a review pass.

import * as THREE from 'three';

const HILITE = new THREE.MeshBasicMaterial({ color: 0x3ad6ff, wireframe: true, transparent: true, opacity: 0.9 });
const MARKED = 0xff3b6b;

export function attachInspector(viewer, { storageKey = location.pathname } = {}) {
  const { scene, camera, renderer, model } = viewer;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let mode = 'object';
  let sel = null;                 // { mesh, faceIndex }
  const hidden = [];              // undo stack
  const marks = load('marks');
  // Removals are edits, and they were session-only in the first version: hiding or deleting
  // something and then reloading - or handing the session to someone else - lost the work
  // silently. They persist and export alongside the marks now, because "I removed this" is
  // exactly as much a review finding as "this is wrong".
  const removals = load('removals');
  const overlay = new THREE.Group();
  overlay.name = '__inspect-overlay';
  scene.add(overlay);

  function load(kind) {
    try { return JSON.parse(localStorage.getItem(`${kind}:${storageKey}`) || '[]'); }
    catch { return []; }
  }
  function save() {
    localStorage.setItem(`marks:${storageKey}`, JSON.stringify(marks));
    localStorage.setItem(`removals:${storageKey}`, JSON.stringify(removals));
    redrawMarks();
    render();
  }
  function recordRemoval(action, mesh, faceIndex, point) {
    removals.push({
      action, part: mesh.name || '(unnamed)',
      face: mode === 'face' ? faceIndex : null,
      at: point ? point.toArray().map((v) => +v.toFixed(4)) : null,
    });
    save();
  }
  /** Re-apply persisted removals on load, so a reload does not undo a review pass. */
  function applyStoredRemovals() {
    let applied = 0;
    for (const r of removals) {
      if (r.action !== 'delete' && r.action !== 'hide') continue;
      const target = model.getObjectByName(r.part);
      if (!target) continue;
      if (r.action === 'hide' || r.face == null) { target.visible = false; applied++; }
      else if (target.isMesh) { removeFace(target, r.face); applied++; }
    }
    return applied;
  }

  // --- panel ---------------------------------------------------------------
  const panel = document.createElement('div');
  panel.id = 'inspect';
  document.body.appendChild(panel);
  function render() {
    const s = sel
      ? `<b>${sel.mesh.name || '(unnamed)'}</b>` +
        (mode === 'face' ? ` · face ${sel.faceIndex}` : ` · ${triCount(sel.mesh)} tris`)
      : '<span class="dim">nothing selected</span>';
    panel.innerHTML =
      `<div class="row"><span class="k">${mode.toUpperCase()} MODE</span> ${s}</div>` +
      (removals.length
        ? `<div class="rm">${removals.length} removal${removals.length > 1 ? 's' : ''} stored` +
          ' <span class="dim">— press E to export</span></div>'
        : '') +
      (marks.length
        ? `<div class="marks">${marks.map((m, i) =>
            `<div class="m"><span class="n">${i + 1}</span> ${m.part}` +
            (m.face != null ? ` <span class="dim">f${m.face}</span>` : '') +
            ` — ${escapeHtml(m.note)}</div>`).join('')}</div>`
        : '') +
      '<div class="help">click select · <b>O</b>bject/<b>F</b>ace · <b>H</b>ide · <b>U</b>ndo · ' +
      '<b>Del</b> remove · <b>M</b>ark · <b>E</b>xport · <b>X</b> clear</div>';
  }
  const escapeHtml = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const triCount = (m) => (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;

  // --- selection highlight -------------------------------------------------
  let hiliteMesh = null;
  function clearHilite() {
    if (hiliteMesh) { overlay.remove(hiliteMesh); hiliteMesh.geometry.dispose(); hiliteMesh = null; }
  }
  function showHilite() {
    clearHilite();
    if (!sel) return;
    const g = new THREE.BufferGeometry();
    if (mode === 'face') {
      g.setAttribute('position', new THREE.Float32BufferAttribute(faceVerts(sel.mesh, sel.faceIndex), 3));
    } else {
      g.copy(sel.mesh.geometry);
    }
    hiliteMesh = new THREE.Mesh(g, HILITE);
    sel.mesh.updateWorldMatrix(true, false);
    hiliteMesh.applyMatrix4(sel.mesh.matrixWorld);
    hiliteMesh.renderOrder = 999;
    overlay.add(hiliteMesh);
  }
  function faceVerts(mesh, fi) {
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.index;
    const out = [];
    for (let k = 0; k < 3; k++) {
      const i = idx ? idx.getX(fi * 3 + k) : fi * 3 + k;
      out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    return out;
  }

  // --- mark pins -----------------------------------------------------------
  const pins = new THREE.Group();
  pins.name = '__inspect-pins';
  overlay.add(pins);
  function redrawMarks() {
    for (const c of [...pins.children]) { pins.remove(c); c.geometry.dispose(); }
    const geo = new THREE.SphereGeometry(viewer.radius * 0.012, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: MARKED });
    for (const m of marks) {
      const p = new THREE.Mesh(geo.clone(), mat);
      p.position.fromArray(m.at);
      p.renderOrder = 999;
      pins.add(p);
    }
  }

  // --- interaction ---------------------------------------------------------
  renderer.domElement.addEventListener('pointerdown', (e) => {
    // Only a plain click selects; orbit drags must not.
    if (e.button !== 0 || e.shiftKey) return;
    const start = { x: e.clientX, y: e.clientY };
    const up = (ev) => {
      renderer.domElement.removeEventListener('pointerup', up);
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) return; // a drag
      pick(ev);
    };
    renderer.domElement.addEventListener('pointerup', up);
  });

  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(model, true).filter((h) => h.object.visible);
    sel = hits.length ? { mesh: hits[0].object, faceIndex: hits[0].faceIndex, point: hits[0].point.clone() } : null;
    showHilite();
    render();
  }

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'o') { mode = 'object'; showHilite(); render(); }
    else if (k === 'f') { mode = 'face'; showHilite(); render(); }
    else if (k === 'escape') { sel = null; clearHilite(); render(); }
    else if (k === 'h' && sel) {
      hidden.push({ mesh: sel.mesh, was: sel.mesh.visible });
      recordRemoval('hide', sel.mesh, sel.faceIndex, sel.point);
      sel.mesh.visible = false; sel = null; clearHilite(); render();
    }
    else if (k === 'u' && hidden.length) {
      const h = hidden.pop(); h.mesh.visible = h.was;
      // Undo pops the matching record too, so the export never claims a removal that was
      // taken back.
      for (let i = removals.length - 1; i >= 0; i--) {
        if (removals[i].action === 'hide' && removals[i].part === h.mesh.name) { removals.splice(i, 1); break; }
      }
      save();
    }
    else if ((k === 'delete' || k === 'backspace') && sel) {
      e.preventDefault();
      recordRemoval('delete', sel.mesh, sel.faceIndex, sel.point);
      if (mode === 'face') removeFace(sel.mesh, sel.faceIndex);
      else sel.mesh.parent?.remove(sel.mesh);
      sel = null; clearHilite(); render();
    }
    else if (k === 'm' && sel) {
      const note = prompt('What is wrong here?');
      if (note) {
        marks.push({
          part: sel.mesh.name || '(unnamed)',
          face: mode === 'face' ? sel.faceIndex : null,
          at: sel.point.toArray().map((v) => +v.toFixed(4)),
          note,
        });
        save();
      }
    }
    else if (k === 'x' && (marks.length || removals.length)) {
      if (confirm(`Clear ${marks.length} marks and ${removals.length} removals?`)) {
        marks.length = 0; removals.length = 0; save();
      }
    }
    else if (k === 'e') exportMarks();
  });

  /** Delete one triangle from a non-indexed buffer by rebuilding without its three vertices. */
  function removeFace(mesh, fi) {
    const geo = mesh.geometry;
    if (geo.index) { console.warn('indexed geometry: face delete not supported'); return; }
    const pos = geo.getAttribute('position');
    const keep = new Float32Array(pos.count * 3 - 9);
    let w = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.floor(i / 3) === fi) continue;
      keep[w++] = pos.getX(i); keep[w++] = pos.getY(i); keep[w++] = pos.getZ(i);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(keep, 3));
    g.computeVertexNormals();
    mesh.geometry.dispose();
    mesh.geometry = g;
  }

  function exportMarks() {
    const payload = {
      model: storageKey,
      capturedAt: new Date().toISOString(),
      camera: {
        position: camera.position.toArray().map((v) => +v.toFixed(4)),
        target: viewer.centre.toArray().map((v) => +v.toFixed(4)),
      },
      marks,
      removals,
    };
    const text = JSON.stringify(payload, null, 2);
    console.log(`[inspect] marks\n${text}`);
    navigator.clipboard?.writeText(text).catch(() => {});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = `marks-${storageKey.replace(/\W+/g, '-').replace(/^-|-$/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const reapplied = applyStoredRemovals();
  if (reapplied) console.info(`[inspect] re-applied ${reapplied} stored removal(s)`);
  redrawMarks();
  render();
  // Exposed so a headless review pass can read the same marks a human left.
  viewer.inspect = {
    marks, removals, exportMarks,
    get selection() { return sel; },
    setMode(m) { mode = m; render(); },
  };
  return viewer.inspect;
}
