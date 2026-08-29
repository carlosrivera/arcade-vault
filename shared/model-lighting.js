// model-lighting.js — switchable lighting rigs for model viewers.
//
// Facet definition on a hard-surface model is as much a lighting question as a geometry
// one: a soft key with a broad fill and a rim, tone-mapped with ACES, compresses adjacent
// facet values until the form reads as smooth. The same mesh under a hard raking key looks
// like a different model. So rather than argue about it, the viewer carries several rigs
// and cycles between them — if a shape reads under `grazing` but not under `soft`, the
// problem is the light; if it reads under neither, the problem is the geometry.
//
// Press L to cycle, or pass ?light=<id>.

import * as THREE from 'three';

const d = (color, intensity, pos, shadow = false) => {
  const l = new THREE.DirectionalLight(color, intensity);
  l.position.set(...pos).multiplyScalar(3);
  if (shadow) {
    l.castShadow = true;
    l.shadow.mapSize.set(2048, 2048);
    l.shadow.bias = -0.0004;
    Object.assign(l.shadow.camera, { left: -0.9, right: 0.9, top: 0.9, bottom: -0.9, near: 0.1, far: 8 });
    l.shadow.camera.updateProjectionMatrix();
  }
  return l;
};

/**
 * Each rig returns its lights plus the renderer state it wants. Exposure and tone mapping
 * are part of a rig, not global: a hard rig needs a lower exposure or the lit faces clip
 * and you lose the very separation the rig exists to create.
 */
export const RIGS = [
  {
    id: 'soft', label: 'SOFT STUDIO',
    note: 'Broad key, sky fill, back rim. Flattering, and the most likely to hide facets.',
    exposure: 1.0, toneMapping: THREE.ACESFilmicToneMapping,
    build: () => [
      d(0xffffff, 2.4, [0.6, 0.85, 0.7], true),
      d(0xafc6e0, 0.75, [-0.8, 0.2, 0.4]),
      d(0x9fd8ff, 1.1, [-0.3, 0.4, -1.0]),
      new THREE.AmbientLight(0xc8d6e8, 0.28),
    ],
  },
  {
    id: 'hard', label: 'HARD KEY',
    note: 'One sharp key, almost no fill. Maximum value separation between adjacent facets.',
    exposure: 0.85, toneMapping: THREE.ACESFilmicToneMapping,
    build: () => [
      d(0xfff4e6, 4.2, [0.75, 0.95, 0.55], true),
      new THREE.AmbientLight(0x2a3644, 0.10),
    ],
  },
  {
    id: 'grazing', label: 'GRAZING',
    note: 'Light raking across the surface at a shallow angle - the standard way to read '
        + 'whether a form is actually faceted or merely shaded to look like it.',
    exposure: 0.9, toneMapping: THREE.ACESFilmicToneMapping,
    build: () => [
      d(0xffffff, 3.6, [1.0, 0.14, 0.22], true),
      d(0x8fb8e0, 0.45, [-0.9, 0.1, -0.3]),
      new THREE.AmbientLight(0x233043, 0.12),
    ],
  },
  {
    id: 'topdown', label: 'TOP-DOWN',
    note: 'Overhead key. Separates deck panels from flanks, which a three-quarter key merges.',
    exposure: 0.95, toneMapping: THREE.ACESFilmicToneMapping,
    build: () => [
      d(0xffffff, 3.4, [0.08, 1.0, 0.12], true),
      new THREE.AmbientLight(0x2b3a4c, 0.16),
    ],
  },
  {
    id: 'flat', label: 'FLAT ALBEDO',
    note: 'Ambient only, no tone mapping. Shows the base colours with no shading at all, so '
        + 'anything still visible here is material, not light.',
    exposure: 1.0, toneMapping: THREE.NoToneMapping,
    build: () => [new THREE.AmbientLight(0xffffff, 1.0)],
  },
  {
    id: 'normals', label: 'FACET NORMALS',
    note: 'Every face shaded by its own normal direction. The definitive read on faceting: '
        + 'flat colour patches mean flat facets, smooth gradients mean a smooth surface.',
    exposure: 1.0, toneMapping: THREE.NoToneMapping,
    override: new THREE.MeshNormalMaterial({ flatShading: true }),
    build: () => [new THREE.AmbientLight(0xffffff, 1.0)],
  },
];

export function attachLighting(viewer, { initial = 'soft', custom = null, customExposure = 1.0 } = {}) {
  const { scene, renderer, model } = viewer;
  const rigs = custom
    // A model's own authored rig, if it has one, becomes the first entry so the spec's
    // lighting stays inspectable alongside the diagnostic rigs.
    ? [{ id: 'authored', label: 'AUTHORED', note: "The model's own rig from its spec.",
         exposure: customExposure, toneMapping: THREE.ACESFilmicToneMapping,
         build: () => custom }, ...RIGS]
    : RIGS;

  const groups = rigs.map((r) => {
    const g = new THREE.Group();
    g.name = `__rig-${r.id}`;
    for (const l of r.build()) g.add(l);
    g.visible = false;
    scene.add(g);
    return g;
  });

  const saved = new Map();
  let index = Math.max(0, rigs.findIndex((r) => r.id === initial));

  function apply(i) {
    index = (i + rigs.length) % rigs.length;
    const rig = rigs[index];
    groups.forEach((g, k) => { g.visible = k === index; });
    renderer.toneMapping = rig.toneMapping;
    renderer.toneMappingExposure = rig.exposure;

    // Material override, used by the normals rig. Originals are stashed on first use so
    // cycling back restores exactly what the model authored.
    model.traverse((o) => {
      if (!o.isMesh) return;
      if (!saved.has(o)) saved.set(o, o.material);
      o.material = rig.override ?? saved.get(o);
    });
    viewer.lightingMode = rig;
    document.getElementById('light-mode')?.replaceChildren(
      Object.assign(document.createElement('b'), { textContent: rig.label }),
      Object.assign(document.createElement('span'), { textContent: ` — ${rig.note}` }),
    );
  }

  addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'l') return;
    apply(index + (e.shiftKey ? -1 : 1));
  });

  const q = new URLSearchParams(location.search).get('light');
  apply(q ? Math.max(0, rigs.findIndex((r) => r.id === q)) : index);
  viewer.lighting = { rigs, apply: (id) => apply(rigs.findIndex((r) => r.id === id)), next: () => apply(index + 1) };
  return viewer.lighting;
}
