import * as THREE from 'three';
import { disposeMaterial } from '#engine/assets.js';

// Closed-loop anti-grav circuit built from a Catmull-Rom spline.
// Everything on the track is addressed by arc-length distance `s` in
// [0, length). frameAt(s) returns an interpolated reference frame
// { pos, tan, right, up, bank } that ships, pads and props are placed against.

const N = 900; // arc-length samples around the loop
const HALF_W = 15; // half road width
export const ROAD_HALF_W = HALF_W;
export const WALL_LAT = HALF_W - 2.6; // max |lateral| a ship can hold
export const WEAPON_PAD_FRACTIONS = [0.16, 0.24, 0.4, 0.58, 0.72, 0.9];
const BANK_GAIN = 46;
const MAX_BANK = 0.55;

function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function roadTextures() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');

  // Base deep asphalt / carbon composite
  g.fillStyle = '#080a14';
  g.fillRect(0, 0, 512, 512);

  // Carbon fiber diagonal cross-hatch weave
  for (let y = 0; y < 512; y += 4) {
    for (let x = 0; x < 512; x += 4) {
      const isAlt = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      g.fillStyle = isAlt ? 'rgba(26, 32, 54, 0.45)' : 'rgba(10, 12, 22, 0.45)';
      g.fillRect(x, y, 4, 4);
    }
  }

  // Asphalt micro-grain specks
  for (let i = 0; i < 2200; i++) {
    const v = (28 + Math.random() * 52) | 0;
    g.fillStyle = `rgba(${v},${v + 10},${v + 35},${0.08 + Math.random() * 0.16})`;
    g.fillRect((Math.random() * 512) | 0, (Math.random() * 512) | 0, 2, 2);
  }

  // Recessed Tron side circuit tracks (left & right racing guide lines)
  g.strokeStyle = 'rgba(53, 240, 255, 0.65)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(70, 0);
  g.lineTo(70, 512);
  g.moveTo(78, 0);
  g.lineTo(78, 512);
  g.moveTo(434, 0);
  g.lineTo(434, 512);
  g.moveTo(442, 0);
  g.lineTo(442, 512);
  g.stroke();

  // Glowing center pulse dashes
  g.fillStyle = 'rgba(53, 240, 255, 0.9)';
  for (let y = 0; y < 512; y += 128) {
    g.fillRect(252, y + 10, 8, 70);
  }

  // Lateral expansion seams with subtle neon joints
  g.fillStyle = 'rgba(255, 47, 214, 0.4)';
  g.fillRect(0, 506, 512, 4);

  // Emissive Map (Only high-intensity glowing parts)
  const e = document.createElement('canvas');
  e.width = e.height = 512;
  const ge = e.getContext('2d');
  ge.fillStyle = '#000000';
  ge.fillRect(0, 0, 512, 512);

  // Center dashes in emissive
  ge.fillStyle = '#35f0ff';
  for (let y = 0; y < 512; y += 128) {
    ge.fillRect(252, y + 10, 8, 70);
  }

  // Side circuit lines
  ge.strokeStyle = '#35f0ff';
  ge.lineWidth = 2.5;
  ge.beginPath();
  ge.moveTo(70, 0);
  ge.lineTo(70, 512);
  ge.moveTo(78, 0);
  ge.lineTo(78, 512);
  ge.moveTo(434, 0);
  ge.lineTo(434, 512);
  ge.moveTo(442, 0);
  ge.lineTo(442, 512);
  ge.stroke();

  // Lateral glowing seam
  ge.fillStyle = '#ff2fd6';
  ge.fillRect(0, 506, 512, 4);

  const map = new THREE.CanvasTexture(c);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;

  const emissiveMap = new THREE.CanvasTexture(e);
  emissiveMap.wrapS = THREE.ClampToEdgeWrapping;
  emissiveMap.wrapT = THREE.RepeatWrapping;

  // Procedural normal map: carbon-weave micro relief + panel seams + specks.
  // Painted directly in tangent space (128 = flat).
  const n = document.createElement('canvas');
  n.width = n.height = 512;
  const gn = n.getContext('2d');
  gn.fillStyle = 'rgb(128, 128, 255)';
  gn.fillRect(0, 0, 512, 512);
  // carbon weave: alternating tile bevels
  for (let y = 0; y < 512; y += 4) {
    for (let x = 0; x < 512; x += 4) {
      const isAlt = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      gn.fillStyle = isAlt ? 'rgb(138, 118, 255)' : 'rgb(118, 138, 255)';
      gn.fillRect(x, y, 4, 4);
    }
  }
  // micro grain
  for (let i = 0; i < 2600; i++) {
    const b = 118 + ((Math.random() * 20) | 0);
    gn.fillStyle = `rgb(${b},${b},255)`;
    gn.fillRect((Math.random() * 512) | 0, (Math.random() * 512) | 0, 2, 2);
  }
  // recessed guide grooves
  gn.fillStyle = 'rgb(90, 110, 255)';
  gn.fillRect(68, 0, 12, 512);
  gn.fillRect(432, 0, 12, 512);
  // raised seam joints
  gn.fillStyle = 'rgb(170, 150, 255)';
  gn.fillRect(0, 504, 512, 8);
  const normalMap = new THREE.CanvasTexture(n);
  normalMap.wrapS = THREE.ClampToEdgeWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;

  // Roughness map: base satin asphalt with darker damp streaks that catch
  // the environment reflections on acceleration lines.
  const r = document.createElement('canvas');
  r.width = r.height = 512;
  const gr = r.getContext('2d');
  gr.fillStyle = 'rgb(210, 210, 210)';
  gr.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 90; i++) {
    const x = (Math.random() * 512) | 0;
    const w = 12 + ((Math.random() * 40) | 0);
    gr.fillStyle = `rgba(120, 120, 120, ${0.15 + Math.random() * 0.3})`;
    gr.fillRect(x, 0, w, 512);
  }
  for (let i = 0; i < 1400; i++) {
    const v = 170 + ((Math.random() * 70) | 0);
    gr.fillStyle = `rgb(${v},${v},${v})`;
    gr.fillRect((Math.random() * 512) | 0, (Math.random() * 512) | 0, 3, 3);
  }
  const roughnessMap = new THREE.CanvasTexture(r);
  roughnessMap.wrapS = THREE.ClampToEdgeWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;

  return { map, emissiveMap, normalMap, roughnessMap };
}

function chevronTexture(colorA, colorB) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,10,18,0.92)';
  g.fillRect(0, 0, 128, 128);
  g.shadowColor = colorA;
  g.shadowBlur = 10;
  // chevrons point toward canvas top = plane +Y = track tangent (forward)
  for (let i = 0; i < 3; i++) {
    g.strokeStyle = i === 1 ? colorB : colorA;
    g.lineWidth = 13;
    g.beginPath();
    const x = 24 + i * 40;
    g.moveTo(x - 15, 112);
    g.lineTo(x + 3, 16);
    g.lineTo(x + 21, 112);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowSpotTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  return t;
}

function startLineTextures() {
  const w = 1024,
    h = 256;

  // Base diffuse map
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');

  // Emissive map (for bloom)
  const e = document.createElement('canvas');
  e.width = w;
  e.height = h;
  const ge = e.getContext('2d');

  g.fillStyle = '#0a0d18';
  g.fillRect(0, 0, w, h);

  ge.fillStyle = '#000000';
  ge.fillRect(0, 0, w, h);

  // Checkered pattern helper
  const numCols = 32;
  const colW = w / numCols;

  // Top checkered band (y: 18 to 82)
  for (let col = 0; col < numCols; col++) {
    for (let row = 0; row < 2; row++) {
      const isWhite = (col + row) % 2 === 0;
      const x = col * colW;
      const y = 18 + row * 32;
      if (isWhite) {
        g.fillStyle = '#ffffff';
        g.fillRect(x, y, colW, 32);
        ge.fillStyle = '#e8f8ff';
        ge.fillRect(x, y, colW, 32);
      } else {
        g.fillStyle = '#101428';
        g.fillRect(x, y, colW, 32);
      }
    }
  }

  // Bottom checkered band (y: 174 to 238)
  for (let col = 0; col < numCols; col++) {
    for (let row = 0; row < 2; row++) {
      const isWhite = (col + row) % 2 === 1;
      const x = col * colW;
      const y = 174 + row * 32;
      if (isWhite) {
        g.fillStyle = '#ffffff';
        g.fillRect(x, y, colW, 32);
        ge.fillStyle = '#e8f8ff';
        ge.fillRect(x, y, colW, 32);
      } else {
        g.fillStyle = '#101428';
        g.fillRect(x, y, colW, 32);
      }
    }
  }

  // Neon glowing outer border strips (y: 4 to 14 and 242 to 252)
  g.fillStyle = '#35f0ff';
  g.fillRect(0, 4, w, 10);
  g.fillRect(0, 242, w, 10);
  ge.fillStyle = '#35f0ff';
  ge.fillRect(0, 4, w, 10);
  ge.fillRect(0, 242, w, 10);

  // Neon gold/magenta inner accent dividing lines (y: 86 to 92 and 164 to 170)
  g.fillStyle = '#ff2fd6';
  g.fillRect(0, 86, w, 6);
  g.fillRect(0, 164, w, 6);
  ge.fillStyle = '#ff2fd6';
  ge.fillRect(0, 86, w, 6);
  ge.fillRect(0, 164, w, 6);

  // Center tech strip (y: 92 to 164)
  g.fillStyle = '#060913';
  g.fillRect(0, 92, w, 72);

  // Repeated START / FINISH with chevrons across the track floor width
  const label = '▶▶▶  START  /  FINISH  ▶▶▶';
  g.font = '900 36px "Trebuchet MS", "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  ge.font = '900 36px "Trebuchet MS", "Arial Black", sans-serif';
  ge.textAlign = 'center';
  ge.textBaseline = 'middle';

  const repeats = 3;
  for (let i = 0; i < repeats; i++) {
    const cx = (w / repeats) * (i + 0.5);
    const cy = 128;

    // Center text shadow & glow
    g.fillStyle = '#59e6ff';
    g.fillText(label, cx, cy);

    ge.fillStyle = '#78f0ff';
    ge.fillText(label, cx, cy);
  }

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const emissiveMap = new THREE.CanvasTexture(e);
  emissiveMap.colorSpace = THREE.SRGBColorSpace;

  return { map, emissiveMap };
}

function gridSlotTexture(slotNum) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');

  g.clearRect(0, 0, 256, 256);

  const isPlayer = slotNum === 1;
  const mainCol = isPlayer ? '#35f0ff' : '#ffcf5e';
  const subCol = isPlayer ? '#ffffff' : '#ffd270';

  // Corner brackets
  g.strokeStyle = mainCol;
  g.lineWidth = 10;
  g.shadowColor = mainCol;
  g.shadowBlur = 12;

  const m = 18;
  const bLen = 54;

  // Top-Left
  g.beginPath();
  g.moveTo(m, m + bLen);
  g.lineTo(m, m);
  g.lineTo(m + bLen, m);
  g.stroke();

  // Top-Right
  g.beginPath();
  g.moveTo(256 - m - bLen, m);
  g.lineTo(256 - m, m);
  g.lineTo(256 - m, m + bLen);
  g.stroke();

  // Bottom-Left
  g.beginPath();
  g.moveTo(m, 256 - m - bLen);
  g.lineTo(m, 256 - m);
  g.lineTo(m + bLen, 256 - m);
  g.stroke();

  // Bottom-Right
  g.beginPath();
  g.moveTo(256 - m - bLen, 256 - m);
  g.lineTo(256 - m, 256 - m);
  g.lineTo(256 - m, 256 - m - bLen);
  g.stroke();

  // Under-bar line
  g.strokeStyle = 'rgba(255,255,255,0.45)';
  g.lineWidth = 4;
  g.shadowBlur = 0;
  g.beginPath();
  g.moveTo(m + 12, 256 - m - 20);
  g.lineTo(256 - m - 12, 256 - m - 20);
  g.stroke();

  // Grid number
  g.fillStyle = subCol;
  g.shadowColor = mainCol;
  g.shadowBlur = 16;
  g.font = 'bold 112px "Trebuchet MS", "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(slotNum), 128, 120);

  // Position label
  g.fillStyle = mainCol;
  g.shadowBlur = 6;
  g.font = 'bold 20px "Trebuchet MS", sans-serif';
  g.fillText(isPlayer ? 'POLE 1' : `GRID ${slotNum}`, 128, 192);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const TRACK_CONFIGS = [
  {
    id: 'velocity',
    name: 'VELOCITY DOME',
    difficulty: 'BEGINNER',
    difficultyColor: '#35f0ff',
    grade: [0.94, 1.0, 1.08], // cool dome
    desc: 'Wide straights, gentle sweeps & one massive high-speed banked turn. Low hazards.',
    generatePoints: () => {
      const pts = [];
      const straightHalf = 620;

      // Long Main Straightaway (Z = -340)
      for (let x = -straightHalf; x <= straightHalf; x += 180) {
        pts.push(new THREE.Vector3(x, 0, -340));
      }

      // Gentle transition into the giant high-speed sweeper
      pts.push(new THREE.Vector3(straightHalf + 240, 4, -250));
      pts.push(new THREE.Vector3(straightHalf + 460, 8, -90));
      pts.push(new THREE.Vector3(straightHalf + 560, 12, 120));
      pts.push(new THREE.Vector3(straightHalf + 500, 15, 340));
      pts.push(new THREE.Vector3(straightHalf + 320, 14, 520));
      pts.push(new THREE.Vector3(straightHalf + 70, 10, 640));

      // Back Straightaway (Z = 650, going back right to left)
      for (let x = straightHalf - 140; x >= -straightHalf + 140; x -= 180) {
        pts.push(new THREE.Vector3(x, 6, 650));
      }

      // The ONE BIG SWEEPING CURVE (massive 180° radius banked panoramic turn)
      pts.push(new THREE.Vector3(-straightHalf - 120, 4, 620));
      pts.push(new THREE.Vector3(-straightHalf - 360, 2, 500));
      pts.push(new THREE.Vector3(-straightHalf - 560, 0, 300));
      pts.push(new THREE.Vector3(-straightHalf - 640, -2, 60));
      pts.push(new THREE.Vector3(-straightHalf - 580, -2, -170));
      pts.push(new THREE.Vector3(-straightHalf - 380, -1, -290));
      pts.push(new THREE.Vector3(-straightHalf - 160, 0, -338));

      return pts;
    },
    obstacleCount: 5,
    padDefs: [
      { f: 0.05, lat: -4 },
      { f: 0.08, lat: 4 },
      { f: 0.22, lat: 0 },
      { f: 0.42, lat: -4 },
      { f: 0.45, lat: 4 },
      { f: 0.65, lat: 0 },
      { f: 0.82, lat: -3 },
      { f: 0.85, lat: 3 },
    ],
    weaponFractions: [0.15, 0.35, 0.55, 0.75, 0.9],
    bankGain: 40,
    maxBank: 0.46,
  },
  {
    id: 'neon',
    name: 'NEON CIRCUIT',
    difficulty: 'INTERMEDIATE',
    difficultyColor: '#ffcf5e',
    grade: [1.06, 0.93, 1.07], // hot magenta city
    desc: 'The classic anti-grav raceway with rolling undulations and balanced turns.',
    generatePoints: () => {
      const pts = [];
      const NP = 28;
      for (let i = 0; i < NP; i++) {
        const t = (i / NP) * Math.PI * 2;
        const r = 560 + 150 * Math.sin(3 * t) + 55 * Math.sin(7 * t + 1.3);
        const y = 34 * Math.sin(2 * t) + 20 * Math.sin(5 * t + 0.7) + 10 * Math.cos(4 * t);
        pts.push(new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r));
      }
      return pts;
    },
    obstacleCount: 16,
    padDefs: [
      { f: 0.07, lat: -5 },
      { f: 0.1, lat: 5 },
      { f: 0.28, lat: 0 },
      { f: 0.47, lat: -6 },
      { f: 0.5, lat: 6 },
      { f: 0.66, lat: 3 },
      { f: 0.83, lat: -3 },
      { f: 0.86, lat: 4 },
    ],
    weaponFractions: [0.16, 0.24, 0.4, 0.58, 0.72, 0.9],
    bankGain: 46,
    maxBank: 0.55,
  },
  {
    id: 'canyon',
    name: 'QUANTUM CANYON',
    difficulty: 'EXPERT',
    difficultyColor: '#ff2fd6',
    grade: [1.1, 0.97, 0.84], // warm canyon dusk
    desc: 'High-altitude rollercoaster with steep diving drops, tight chicanes and hazards.',
    generatePoints: () => {
      const pts = [];
      const NP = 32;
      for (let i = 0; i < NP; i++) {
        const t = (i / NP) * Math.PI * 2;
        const r = 600 + 200 * Math.sin(4 * t) + 75 * Math.sin(9 * t + 0.5) - 50 * Math.cos(2 * t);
        const y = 55 * Math.sin(3 * t) + 38 * Math.cos(5 * t + 1.1) + 20 * Math.sin(2 * t);
        pts.push(new THREE.Vector3(Math.cos(t) * r, y, Math.sin(t) * r));
      }
      return pts;
    },
    obstacleCount: 22,
    padDefs: [
      { f: 0.06, lat: -5 },
      { f: 0.09, lat: 5 },
      { f: 0.21, lat: 0 },
      { f: 0.38, lat: -4 },
      { f: 0.41, lat: 4 },
      { f: 0.54, lat: -3 },
      { f: 0.57, lat: 3 },
      { f: 0.74, lat: 0 },
      { f: 0.88, lat: -4 },
      { f: 0.91, lat: 4 },
    ],
    weaponFractions: [0.14, 0.28, 0.44, 0.62, 0.78, 0.92],
    bankGain: 54,
    maxBank: 0.62,
  },
];

export class Track {
  constructor(scene, trackIdx = 0) {
    this.scene = scene;
    this.trackIdx = trackIdx;
    this.config = TRACK_CONFIGS[trackIdx] || TRACK_CONFIGS[0];
    this.weaponFractions = this.config.weaponFractions;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.pads = [];
    this._tmp = {
      pos: new THREE.Vector3(),
      tan: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      bank: 0,
    };
    this._buildCurve();
    this._buildRoad();
    this._buildStartLine();
    this._buildPads();
    this._buildObstacles();
    this._buildGates();
    this._buildPosts();
    this._buildLightTowers();
    this._buildFlowDashes();
    this.rings = []; // transient boost shockwaves
    this._buildHoloBillboards();
  }

  dispose() {
    if (!this.group) return;
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      // disposeMaterial, not material.dispose(): the latter leaves every map
      // attached to it resident. This track bakes eleven CanvasTextures, and
      // detaching the group from the scene first puts them out of reach of any
      // later scene-walking sweep.
      for (const m of mats) disposeMaterial(m);
    });
  }

  _buildHoloBillboards() {
    const count = 9;
    const holoDefs = [
      { text: 'GRAVPULSE 2097', sub: '// AG-SYSTEMS CHAMPIONSHIP //', col: '#35f0ff' },
      { text: 'QUANTUM OVERDRIVE', sub: '// TERMINAL HYPER-VELOCITY //', col: '#ff2fd6' },
      { text: 'PULSE SHIELD MATRIX', sub: '// MAXIMUM DEFLECTION POWER //', col: '#ffb02e' },
      { text: 'ZERO-G CIRCUIT', sub: '// APEX CORNERING VECTOR //', col: '#44ee77' },
      { text: 'FEISAR-X DRIVE', sub: '// PROTOTYPE AG-PROPULSION //', col: '#35f0ff' },
    ];

    for (let i = 0; i < count; i++) {
      const frac = (i + 0.5) / count;
      const s = frac * this.length;
      const fr = this.frameAt(s);
      const def = holoDefs[i % holoDefs.length];
      const side = i % 2 === 0 ? 1 : -1;
      const isOverhead = i % 3 === 0;

      // High-Res Hologram Canvas Texture
      const hc = document.createElement('canvas');
      hc.width = 1024;
      hc.height = 320;
      const hg = hc.getContext('2d');
      hg.fillStyle = 'rgba(2, 6, 20, 0.88)';
      hg.fillRect(0, 0, 1024, 320);

      // Cyber Hologram Border & Grid lines
      hg.strokeStyle = def.col;
      hg.lineWidth = 8;
      hg.strokeRect(10, 10, 1004, 300);

      // Scanline grid effect
      hg.strokeStyle = 'rgba(255,255,255,0.06)';
      hg.lineWidth = 2;
      for (let y = 20; y < 300; y += 16) {
        hg.beginPath();
        hg.moveTo(14, y);
        hg.lineTo(1010, y);
        hg.stroke();
      }

      // Corner Tech Accents
      hg.fillStyle = def.col;
      hg.fillRect(10, 10, 48, 48);
      hg.fillRect(966, 10, 48, 48);
      hg.fillRect(10, 262, 48, 48);
      hg.fillRect(966, 262, 48, 48);

      // Hazard Stripes
      hg.fillStyle = def.col;
      for (let x = 70; x < 950; x += 60) {
        hg.beginPath();
        hg.moveTo(x, 14);
        hg.lineTo(x + 24, 14);
        hg.lineTo(x + 12, 34);
        hg.lineTo(x - 12, 34);
        hg.fill();
      }

      // Massive Glowing Title
      hg.font = '900 68px "Trebuchet MS", "Arial Black", monospace';
      hg.fillStyle = '#ffffff';
      hg.textAlign = 'center';
      hg.shadowColor = def.col;
      hg.shadowBlur = 18;
      hg.fillText(def.text, 512, 165);
      hg.shadowBlur = 0;

      // Subtitle
      hg.font = '700 30px monospace';
      hg.fillStyle = def.col;
      hg.fillText(def.sub, 512, 235);

      const holoTex = new THREE.CanvasTexture(hc);
      holoTex.colorSpace = THREE.SRGBColorSpace;

      if (isOverhead) {
        // Colossal Overhead Arch Banner
        const boardGeo = new THREE.PlaneGeometry(36, 11);
        const boardMat = new THREE.MeshBasicMaterial({
          map: holoTex,
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        });

        const board = new THREE.Mesh(boardGeo, boardMat);
        board.position.copy(fr.pos).addScaledVector(fr.up, 13.5);
        board.quaternion.setFromAxisAngle(fr.up, fr.bank);
        board.lookAt(fr.pos.clone().addScaledVector(fr.tan, -10).addScaledVector(fr.up, 13.5));
        this.group.add(board);

        // Arch pillars on both sides
        for (const pSide of [-1, 1]) {
          const archGeo = new THREE.CylinderGeometry(0.45, 0.65, 18, 6);
          const archMat = new THREE.MeshStandardMaterial({
            color: '#12162a',
            metalness: 0.85,
            roughness: 0.25,
          });
          const pillar = new THREE.Mesh(archGeo, archMat);
          pillar.position
            .copy(fr.pos)
            .addScaledVector(fr.right, pSide * (HALF_W + 3))
            .addScaledVector(fr.up, 7);
          this.group.add(pillar);
        }
      } else {
        // Massive Trackside Jumbotron
        const boardGeo = new THREE.PlaneGeometry(28, 9.2);
        const boardMat = new THREE.MeshBasicMaterial({
          map: holoTex,
          transparent: true,
          opacity: 0.92,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        });

        const board = new THREE.Mesh(boardGeo, boardMat);
        board.position
          .copy(fr.pos)
          .addScaledVector(fr.right, side * (HALF_W + 12))
          .addScaledVector(fr.up, 11);

        board.quaternion.setFromAxisAngle(fr.up, fr.bank);
        board.lookAt(fr.pos.clone().addScaledVector(fr.up, 11));
        this.group.add(board);

        // Structural Mounting Pylon
        const pylonGeo = new THREE.CylinderGeometry(0.4, 0.6, 16, 6);
        const pylonMat = new THREE.MeshStandardMaterial({
          color: '#12162a',
          metalness: 0.85,
          roughness: 0.25,
        });
        const pylon = new THREE.Mesh(pylonGeo, pylonMat);
        pylon.position
          .copy(fr.pos)
          .addScaledVector(fr.right, side * (HALF_W + 12))
          .addScaledVector(fr.up, 5);
        this.group.add(pylon);
      }
    }
  }

  // red hazard pylons scattered on the racing line — dodge or bleed speed
  _buildObstacles() {
    const count = this.config.obstacleCount || 16;
    const geo = new THREE.ConeGeometry(1.05, 2.6, 4);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.9, 0.22, 0.16), // HDR red -> blooms hard
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.obstMat = mat;
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.frustumCulled = false;
    inst.castShadow = true; // grounded hazard shadow helps read the dodge
    this.obstacles = [];
    this.obstFlash = 0;

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const xV = new THREE.Vector3();
    const fr = {
      pos: new THREE.Vector3(),
      tan: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      bank: 0,
    };
    let placed = 0,
      guard = 0;
    while (placed < count && guard++ < 600) {
      const s = Math.random() * this.length;
      if (s < 80 || s > this.length - 80) continue; // keep the grid + line clear
      const gap = (a, b) => {
        const d = Math.abs(a - b);
        return Math.min(d, this.length - d);
      };
      if (this.pads.some((p) => gap(p.s, s) < 45)) continue; // never on a pad
      if (this.weaponFractions.some((f) => gap(f * this.length, s) < 40)) continue; // nor on weapon pads
      if (this.obstacles.some((o) => gap(o.s, s) < 90)) continue; // breathing room
      const lat = (Math.random() * 2 - 1) * (WALL_LAT - 2.5);
      this.frameAt(s, fr);
      xV.copy(fr.up).cross(fr.tan).normalize();
      m4.makeBasis(xV, fr.up, fr.tan);
      q.setFromRotationMatrix(m4);
      m4.compose(
        new THREE.Vector3().copy(fr.pos).addScaledVector(fr.right, lat).addScaledVector(fr.up, 1.3),
        q,
        one,
      );
      inst.setMatrixAt(placed, m4);
      this.obstacles.push({ s, lat });
      placed++;
    }
    this.group.add(inst);
  }

  // alternating cyan/magenta marker posts along both road edges
  _buildPosts() {
    const step = 8;
    const count = Math.ceil(this.n / step) * 2;
    const geo = new THREE.CylinderGeometry(0.09, 0.14, 2.6, 6);
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const yAxis = new THREE.Vector3(0, 1, 0);
    const fr = {
      pos: new THREE.Vector3(),
      tan: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      bank: 0,
    };
    let k = 0;
    for (let i = 0; i < this.n; i += step) {
      this.frameAt((i / this.n) * this.length, fr);
      for (const side of [-1, 1]) {
        q.setFromUnitVectors(yAxis, fr.up);
        m.compose(
          new THREE.Vector3()
            .copy(fr.pos)
            .addScaledVector(fr.right, side * (HALF_W + 1.1))
            .addScaledVector(fr.up, 1.3),
          q,
          one,
        );
        inst.setMatrixAt(k, m);
        inst.setColorAt(k, new THREE.Color(side < 0 ? '#35f0ff' : '#ff2fd6'));
        k++;
      }
    }
    this.group.add(inst);
  }

  _buildCurve() {
    const pts = this.config.generatePoints();
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    this.length = this.curve.getLength();
    this.ds = this.length / N;

    const P = this.curve.getSpacedPoints(N); // N+1 points, last == first
    P.pop();
    const n = P.length;

    // tangents (central differences), reference right/up frames
    const tan = [],
      right = [],
      up = [];
    const Y = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const a = P[(i - 1 + n) % n],
        b = P[(i + 1) % n];
      const tv = new THREE.Vector3().subVectors(b, a).normalize();
      const rv = new THREE.Vector3().crossVectors(tv, Y).normalize(); // ship's right
      const uv = new THREE.Vector3().crossVectors(rv, tv).normalize();
      tan.push(tv);
      right.push(rv);
      up.push(uv);
    }

    // signed curvature from heading deltas -> bank angle
    const kappa = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const h0 = Math.atan2(tan[i].x, tan[i].z);
      const h1 = Math.atan2(tan[(i + 1) % n].x, tan[(i + 1) % n].z);
      kappa[i] = wrapPi(h1 - h0) / this.ds;
    }
    // smooth twice with a box window so banking rolls in gradually
    let ks = kappa;
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(n);
      const W = 14;
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = -W; k <= W; k++) acc += ks[(i + k + n) % n];
        out[i] = acc / (2 * W + 1);
      }
      ks = out;
    }
    const bankGain = this.config.bankGain || BANK_GAIN;
    const maxBank = this.config.maxBank || MAX_BANK;
    const bank = new Float32Array(n);
    for (let i = 0; i < n; i++)
      bank[i] = THREE.MathUtils.clamp(ks[i] * bankGain, -maxBank, maxBank);

    // banked final frames
    const q = new THREE.Quaternion();
    this.pos = P;
    this.tan = tan;
    this.right = [];
    this.up = [];
    this.kappaV = ks; // smoothed signed curvature (rad per unit length)
    this.bankV = bank;
    for (let i = 0; i < n; i++) {
      q.setFromAxisAngle(tan[i], bank[i]);
      this.right.push(right[i].clone().applyQuaternion(q));
      this.up.push(up[i].clone().applyQuaternion(q));
    }

    this.n = n;
  }

  frameAt(s, out = this._tmp) {
    const L = this.length;
    const u = ((s % L) + L) / this.ds;
    const i0 = Math.floor(u) % this.n;
    const i1 = (i0 + 1) % this.n;
    const f = u - Math.floor(u);
    out.pos.lerpVectors(this.pos[i0], this.pos[i1], f);
    out.tan.lerpVectors(this.tan[i0], this.tan[i1], f).normalize();
    out.right.lerpVectors(this.right[i0], this.right[i1], f).normalize();
    out.up.lerpVectors(this.up[i0], this.up[i1], f).normalize();
    out.bank = this.bankV[i0] + (this.bankV[i1] - this.bankV[i0]) * f;
    return out;
  }

  // mean absolute curvature ahead of s (for AI cornering)
  curvatureAhead(s, dist = 60) {
    let acc = 0;
    const steps = Math.max(1, Math.round(dist / this.ds));
    const i = Math.floor(((s % this.length) + this.length) / this.ds) % this.n;
    for (let k = 0; k < steps; k++) {
      acc += Math.abs(this.kappaV[(((i + k) % this.n) + this.n) % this.n]);
    }
    return acc / steps;
  }

  _stripGeometry(innerLat, outerLat, liftInner, liftOuter, vScale) {
    const verts = [],
      uvs = [],
      idx = [];
    const rows = this.n;
    const tmp = new THREE.Vector3();
    for (let r = 0; r <= rows; r++) {
      const i = r % this.n;
      tmp
        .copy(this.pos[i])
        .addScaledVector(this.right[i], innerLat)
        .addScaledVector(this.up[i], liftInner);
      verts.push(tmp.x, tmp.y, tmp.z);
      uvs.push(0, r / vScale);
      tmp
        .copy(this.pos[i])
        .addScaledVector(this.right[i], outerLat)
        .addScaledVector(this.up[i], liftOuter);
      verts.push(tmp.x, tmp.y, tmp.z);
      uvs.push(1, r / vScale);
    }
    for (let r = 0; r < rows; r++) {
      const a = r * 2,
        b = a + 1,
        c = a + 2,
        d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  _buildRoad() {
    const { map, emissiveMap, normalMap, roughnessMap } = roadTextures();
    const aniso = 8; // clamped by the driver to the hardware max
    for (const t of [map, emissiveMap, normalMap, roughnessMap]) t.anisotropy = aniso;
    // main road slab
    const geo = new THREE.BufferGeometry();
    const verts = [],
      uvs = [],
      idx = [];
    const rows = this.n;
    const tmp = new THREE.Vector3();
    for (let r = 0; r <= rows; r++) {
      const i = r % this.n;
      tmp.copy(this.pos[i]).addScaledVector(this.right[i], -HALF_W);
      verts.push(tmp.x, tmp.y, tmp.z);
      uvs.push(0, r / 14);
      tmp.copy(this.pos[i]).addScaledVector(this.right[i], HALF_W);
      verts.push(tmp.x, tmp.y, tmp.z);
      uvs.push(1, r / 14);
    }
    for (let r = 0; r < rows; r++) {
      const a = r * 2,
        b = a + 1,
        c = a + 2,
        d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const roadMat = new THREE.MeshStandardMaterial({
      map,
      emissiveMap,
      normalMap,
      roughnessMap,
      normalScale: new THREE.Vector2(0.85, 0.85),
      emissive: new THREE.Color('#35f0ff'),
      emissiveIntensity: 0.95,
      roughness: 1.0,
      metalness: 0.22,
      envMapIntensity: 0.85,
      side: THREE.DoubleSide, // no see-through on elevated sections from below
    });
    const roadMesh = new THREE.Mesh(geo, roadMat);
    roadMesh.receiveShadow = true;
    this.group.add(roadMesh);

    // glowing edge strips
    const edgeMatL = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.5, 2.2, 2.8),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.group.add(
      new THREE.Mesh(this._stripGeometry(-HALF_W - 0.05, -HALF_W + 1.3, 0.06, 0.06, 2), edgeMatL),
    );
    this.group.add(
      new THREE.Mesh(
        this._stripGeometry(HALF_W - 1.3, HALF_W + 0.05, 0.06, 0.06, 2),
        edgeMatL.clone(),
      ),
    );

    // faint continuous panels behind the bar walls
    const wallMat = new THREE.MeshBasicMaterial({
      color: '#3a34c8',
      transparent: true,
      opacity: 0.07,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.group.add(new THREE.Mesh(this._stripGeometry(-HALF_W, -HALF_W, 0, 3.0, 6), wallMat));
    this.group.add(new THREE.Mesh(this._stripGeometry(HALF_W, HALF_W, 0, 3.0, 6), wallMat));

    // glowing energy-bar walls: touching them saps speed (see Ship.update)
    const barGeo = new THREE.BoxGeometry(0.14, 3.4, 0.55);
    const step = 4;
    const perSide = Math.ceil(this.n / step);
    const mkBars = (hdr) => {
      const mat = new THREE.MeshBasicMaterial({
        color: hdr,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const inst = new THREE.InstancedMesh(barGeo, mat, perSide);
      inst.frustumCulled = false;
      this.group.add(inst);
      return inst;
    };
    this.barL = mkBars(new THREE.Color(0.25, 1.5, 1.7)); // HDR cyan -> blooms
    this.barR = mkBars(new THREE.Color(1.7, 0.25, 1.45)); // HDR magenta -> blooms
    this.wallFlash = [0, 0];
    const m4 = new THREE.Matrix4();
    const qb = new THREE.Quaternion();
    const oneV = new THREE.Vector3(1, 1, 1);
    const _yV = new THREE.Vector3(0, 1, 0);
    const frB = {
      pos: new THREE.Vector3(),
      tan: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      bank: 0,
    };
    const xV = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i < this.n; i += step) {
      this.frameAt((i / this.n) * this.length, frB);
      xV.copy(frB.up).cross(frB.tan).normalize(); // proper right-handed basis
      m4.makeBasis(xV, frB.up, frB.tan);
      qb.setFromRotationMatrix(m4);
      for (const [side, inst] of [
        [-1, this.barL],
        [1, this.barR],
      ]) {
        m4.compose(
          new THREE.Vector3()
            .copy(frB.pos)
            .addScaledVector(frB.right, side * HALF_W)
            .addScaledVector(frB.up, 1.7),
          qb,
          oneV,
        );
        inst.setMatrixAt(k, m4);
      }
      k++;
    }

    // under-glow skirt along both outer walls
    const skirtMat = new THREE.MeshBasicMaterial({
      color: '#ff2fd6',
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.group.add(
      new THREE.Mesh(this._stripGeometry(-HALF_W - 0.2, -HALF_W - 0.2, -0.1, -4.5, 3), skirtMat),
    );
    this.group.add(
      new THREE.Mesh(this._stripGeometry(HALF_W + 0.2, HALF_W + 0.2, -0.1, -4.5, 3), skirtMat),
    );
  }

  _buildStartLine() {
    const { map, emissiveMap } = startLineTextures();
    const halfLen = 4.2; // spans s = -4.2 to +4.2 (centered at s=0)
    const segs = 20;
    const verts = [],
      uvs = [],
      idx = [];
    const tmpA = {
      pos: new THREE.Vector3(),
      tan: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      bank: 0,
    };
    const tmp = new THREE.Vector3();

    for (let r = 0; r <= segs; r++) {
      const sOffset = -halfLen + (r / segs) * (halfLen * 2);
      const s = (sOffset + this.length) % this.length;
      const fr = this.frameAt(s, tmpA);
      const v = r / segs;

      tmp
        .copy(fr.pos)
        .addScaledVector(fr.right, -HALF_W + 0.1)
        .addScaledVector(fr.up, 0.08);
      verts.push(tmp.x, tmp.y, tmp.z);
      uvs.push(0, v);

      tmp
        .copy(fr.pos)
        .addScaledVector(fr.right, HALF_W - 0.1)
        .addScaledVector(fr.up, 0.08);
      verts.push(tmp.x, tmp.y, tmp.z);
      uvs.push(1, v);
    }

    for (let r = 0; r < segs; r++) {
      const a = r * 2,
        b = a + 1,
        c = a + 2,
        d = a + 3;
      idx.push(a, c, b, b, c, d);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      map,
      emissiveMap,
      emissive: new THREE.Color('#55d8ff'),
      emissiveIntensity: 0.95,
      roughness: 0.4,
      metalness: 0.2,
      side: THREE.DoubleSide,
    });
    this.group.add(new THREE.Mesh(geo, mat));

    // Luminous laser line strips on floor at boundaries and exact finish line
    const laserMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.6, 2.8, 3.2), // HDR cyan bloom
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    for (const offset of [-halfLen, 0, halfLen]) {
      const sLine = (offset + this.length) % this.length;
      const laserGeo = new THREE.BufferGeometry();
      const lVerts = [],
        lUvs = [],
        lIdx = [];
      const lFr = this.frameAt(sLine, tmpA);
      const w = HALF_W - 0.1;
      const thick = 0.22;

      const p0 = new THREE.Vector3()
        .copy(lFr.pos)
        .addScaledVector(lFr.right, -w)
        .addScaledVector(lFr.tan, -thick)
        .addScaledVector(lFr.up, 0.11);
      const p1 = new THREE.Vector3()
        .copy(lFr.pos)
        .addScaledVector(lFr.right, w)
        .addScaledVector(lFr.tan, -thick)
        .addScaledVector(lFr.up, 0.11);
      const p2 = new THREE.Vector3()
        .copy(lFr.pos)
        .addScaledVector(lFr.right, -w)
        .addScaledVector(lFr.tan, thick)
        .addScaledVector(lFr.up, 0.11);
      const p3 = new THREE.Vector3()
        .copy(lFr.pos)
        .addScaledVector(lFr.right, w)
        .addScaledVector(lFr.tan, thick)
        .addScaledVector(lFr.up, 0.11);

      lVerts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
      lUvs.push(0, 0, 1, 0, 0, 1, 1, 1);
      lIdx.push(0, 2, 1, 1, 2, 3);

      laserGeo.setAttribute('position', new THREE.Float32BufferAttribute(lVerts, 3));
      laserGeo.setAttribute('uv', new THREE.Float32BufferAttribute(lUvs, 2));
      laserGeo.setIndex(lIdx);
      laserGeo.computeVertexNormals();

      this.group.add(new THREE.Mesh(laserGeo, laserMat));
    }

    // Starting grid boxes (Pole positions) marked on the floor behind start line
    const gridSlotGeom = new THREE.PlaneGeometry(5.0, 7.5);
    const L = this.length;
    for (let i = 0; i < 4; i++) {
      const sSlot = (((L - 14 - i * 8) % L) + L) % L;
      const latSlot = i % 2 === 0 ? -4.5 : 4.5;
      const slotTex = gridSlotTexture(i + 1);
      const slotMat = new THREE.MeshBasicMaterial({
        map: slotTex,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const frSlot = this.frameAt(sSlot, tmpA);
      const mtx = new THREE.Matrix4().makeBasis(frSlot.right, frSlot.tan, frSlot.up);
      const q = new THREE.Quaternion().setFromRotationMatrix(mtx);

      const slotMesh = new THREE.Mesh(gridSlotGeom, slotMat);
      slotMesh.quaternion.copy(q);
      slotMesh.position
        .copy(frSlot.pos)
        .addScaledVector(frSlot.right, latSlot)
        .addScaledVector(frSlot.up, 0.09);
      this.group.add(slotMesh);
    }
  }

  _buildPads() {
    const defs = [
      { f: 0.07, lat: -5 },
      { f: 0.1, lat: 5 },
      { f: 0.28, lat: 0 },
      { f: 0.47, lat: -6 },
      { f: 0.5, lat: 6 },
      { f: 0.66, lat: 3 },
      { f: 0.83, lat: -3 },
      { f: 0.86, lat: 4 },
    ];
    const tex = chevronTexture('#ffcf5e', '#ffffff');
    const matProto = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const geom = new THREE.PlaneGeometry(4.6, 15);
    const haloTex = glowSpotTexture();
    const haloMatProto = new THREE.MeshBasicMaterial({
      map: haloTex,
      color: '#ffb02e',
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const haloGeom = new THREE.PlaneGeometry(10, 21);
    for (const d of defs) {
      const s = d.f * this.length;
      const fr = this.frameAt(s, {
        pos: new THREE.Vector3(),
        tan: new THREE.Vector3(),
        right: new THREE.Vector3(),
        up: new THREE.Vector3(),
        bank: 0,
      });
      const mtx = new THREE.Matrix4().makeBasis(fr.right, fr.tan, fr.up);
      const q = new THREE.Quaternion().setFromRotationMatrix(mtx);

      const m = new THREE.Mesh(geom, matProto.clone());
      m.quaternion.copy(q);
      m.position.copy(fr.pos).addScaledVector(fr.right, d.lat).addScaledVector(fr.up, 0.14);
      this.group.add(m);

      const halo = new THREE.Mesh(haloGeom, haloMatProto);
      halo.quaternion.copy(q);
      halo.position.copy(fr.pos).addScaledVector(fr.right, d.lat).addScaledVector(fr.up, 0.07);
      this.group.add(halo);

      this.pads.push({ s, lat: d.lat, mesh: m, phase: Math.random() * Math.PI * 2 });
    }
  }

  _buildGates() {
    const legGeo = new THREE.BoxGeometry(1.2, 11, 1.2);
    const beamGeo = new THREE.BoxGeometry((HALF_W + 4) * 2, 1.4, 1.6);
    const lightGeo = new THREE.BoxGeometry((HALF_W + 4) * 2 - 1.2, 0.35, 0.35);
    const structMat = new THREE.MeshStandardMaterial({
      color: '#141a2a',
      roughness: 0.55,
      metalness: 0.7,
    });
    const lights = ['#35f0ff', '#ff2fd6', '#ffb02e', '#6cff7a'];
    const count = 12;

    // Build standard checkpoint gates around the track
    for (let k = 0; k < count; k++) {
      const s = (k / count) * this.length + 40;
      const fr = this.frameAt(s, {
        pos: new THREE.Vector3(),
        tan: new THREE.Vector3(),
        right: new THREE.Vector3(),
        up: new THREE.Vector3(),
        bank: 0,
      });
      const g = new THREE.Group();
      // x = up × tan keeps this basis a proper rotation
      const mtx = new THREE.Matrix4().makeBasis(
        new THREE.Vector3().crossVectors(fr.up, fr.tan),
        fr.up,
        fr.tan,
      );
      g.quaternion.setFromRotationMatrix(mtx);
      g.position.copy(fr.pos);
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, structMat);
        leg.position.set(side * (HALF_W + 2.6), 4.2, 0);
        g.add(leg);
      }
      const beam = new THREE.Mesh(beamGeo, structMat);
      beam.position.set(0, 9.6, 0);
      g.add(beam);
      const lampColor = lights[k % lights.length];
      const lightMat = new THREE.MeshBasicMaterial({ color: lampColor });
      const strip = new THREE.Mesh(lightGeo, lightMat);
      strip.position.set(0, 8.75, 0.72);
      g.add(strip);

      // Downward road illumination lamp light (kept gentle: gates are flown
      // through at point-blank range, and bloom amplifies any overdrive)
      const lampLight = new THREE.PointLight(lampColor, 0.9, 22, 1.8);
      lampLight.position.set(0, 7.2, 0);
      g.add(lampLight);

      // Light pooling on the road under the gate
      const pool = new THREE.Mesh(
        new THREE.PlaneGeometry(HALF_W * 1.7, 12),
        new THREE.MeshBasicMaterial({
          map: glowSpotTexture(),
          color: lampColor,
          transparent: true,
          opacity: 0.1,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      pool.quaternion.copy(g.quaternion);
      pool.position.copy(fr.pos).addScaledVector(fr.up, 0.05);
      this.group.add(pool);

      this.group.add(g);
    }

    // Build dedicated Start/Finish Arch over s = 0
    {
      const fr = this.frameAt(0, {
        pos: new THREE.Vector3(),
        tan: new THREE.Vector3(),
        right: new THREE.Vector3(),
        up: new THREE.Vector3(),
        bank: 0,
      });
      const g = new THREE.Group();
      const mtx = new THREE.Matrix4().makeBasis(
        new THREE.Vector3().crossVectors(fr.up, fr.tan),
        fr.up,
        fr.tan,
      );
      g.quaternion.setFromRotationMatrix(mtx);
      g.position.copy(fr.pos);

      // Lighter steel for the start arch — it frames the launch view and must
      // not read as a black slab against the city glow
      const archMat = new THREE.MeshStandardMaterial({
        color: '#33406b',
        roughness: 0.38,
        metalness: 0.55,
        envMapIntensity: 1.3,
      });

      // Robust dual pillars (+ inner neon edge so they frame the grid)
      const trimGeo = new THREE.BoxGeometry(0.18, 8.5, 0.28);
      for (const side of [-1, 1]) {
        const p1 = new THREE.Mesh(legGeo, archMat);
        p1.position.set(side * (HALF_W + 2.6), 4.6, -0.8);
        g.add(p1);
        const p2 = new THREE.Mesh(legGeo, archMat);
        p2.position.set(side * (HALF_W + 2.6), 4.6, 0.8);
        g.add(p2);
        const trim = new THREE.Mesh(
          trimGeo,
          new THREE.MeshBasicMaterial({
            color: side < 0 ? new THREE.Color(0.4, 2.4, 2.9) : new THREE.Color(2.4, 0.45, 2.2),
          }),
        );
        trim.position.set(side * (HALF_W + 1.95), 4.8, -0.8);
        g.add(trim);
      }

      // Overhead heavy gantry beam
      const sfBeam = new THREE.Mesh(new THREE.BoxGeometry((HALF_W + 4) * 2, 2.2, 2.6), archMat);
      sfBeam.position.set(0, 10.2, 0);
      g.add(sfBeam);

      // Glowing multi-strip start lights (facing incoming ships, tan -Z in local coords)
      const neonStartLight = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 0.4, 1.6) }); // HDR magenta
      const neonLightStrip1 = new THREE.Mesh(lightGeo, neonStartLight);
      neonLightStrip1.position.set(0, 9.2, -1.35);
      g.add(neonLightStrip1);

      const neonCyanLight = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.2, 2.8) }); // HDR cyan
      const neonLightStrip2 = new THREE.Mesh(lightGeo, neonCyanLight);
      neonLightStrip2.position.set(0, 11.2, -1.35);
      g.add(neonLightStrip2);

      // Downward Start/Finish flood light
      const sfLight = new THREE.PointLight('#59d8ff', 6.0, 52, 1.6);
      sfLight.position.set(0, 7.6, 1.6);
      g.add(sfLight);

      this.group.add(g);
    }
  }

  // Trackside light towers: thin poles with a hot head + billboard glow.
  // Pure scale cues — nothing beats poles whipping past for a sense of speed.
  _buildLightTowers() {
    const spacing = 140;
    const count = Math.floor(this.length / spacing);
    const poleGeo = new THREE.CylinderGeometry(0.16, 0.22, 8.5, 6);
    const headGeo = new THREE.BoxGeometry(0.7, 0.35, 1.1);
    const poleMat = new THREE.MeshStandardMaterial({
      color: '#10141f',
      roughness: 0.6,
      metalness: 0.6,
    });
    const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 1.5, 1.8) });
    const glowTex = glowSpotTexture();
    const fr = this._tmp;
    for (let i = 0; i < count; i++) {
      const s = (i / count) * this.length + spacing * 0.5;
      const side = i % 2 === 0 ? -1 : 1;
      this.frameAt(s, fr);
      const xV = new THREE.Vector3().copy(fr.up).cross(fr.tan).normalize();
      const q = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(xV, fr.up, fr.tan),
      );
      const base = new THREE.Vector3()
        .copy(fr.pos)
        .addScaledVector(fr.right, side * (HALF_W + 4.2));

      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.copy(base).addScaledVector(fr.up, 4.25);
      pole.quaternion.copy(q);
      this.group.add(pole);

      const head = new THREE.Mesh(headGeo, headMat);
      head.position.copy(base).addScaledVector(fr.up, 8.2).addScaledVector(fr.tan, 0.9);
      head.quaternion.copy(q);
      this.group.add(head);

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color: side < 0 ? '#59e8ff' : '#ff9de0',
          transparent: true,
          opacity: 0.75,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      glow.scale.setScalar(6.5);
      glow.position.copy(head.position);
      this.group.add(glow);
    }
  }

  // Narrow ribbon along the road centre with a scrolling dash texture —
  // a constant motion cue even at constant speed.
  _buildFlowDashes() {
    const geo = this._stripGeometry(-0.4, 0.4, 0.055, 0.055, 8);
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 64;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 16, 64);
    g.fillStyle = 'rgba(120, 235, 255, 0.9)';
    g.fillRect(3, 8, 10, 30);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    this.dashTex = tex;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.group.add(new THREE.Mesh(geo, mat));
  }

  // Transient shockwave ring on the road (boost pads).
  spawnRing(s, lat, colorHex = '#ffb02e') {
    const fr = this.frameAt(s, {
      pos: new THREE.Vector3(),
      tan: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      bank: 0,
    });
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.2, 28),
      new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.position.copy(fr.pos).addScaledVector(fr.right, lat).addScaledVector(fr.up, 0.16);
    this._orientFlat(mesh, fr);
    this.group.add(mesh);
    this.rings.push({ mesh, t: 0 });
  }

  _orientFlat(mesh, fr) {
    const x = new THREE.Vector3().copy(fr.right);
    const y = new THREE.Vector3().copy(fr.tan);
    const z = new THREE.Vector3().copy(fr.up);
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }

  bumpWall(side) {
    const i = side < 0 ? 0 : 1;
    this.wallFlash[i] = Math.min(1, this.wallFlash[i] + 0.45);
  }

  update(dt, racers, onPadHit, onObstacleHit) {
    const t = performance.now() / 1000;
    for (const p of this.pads) p.mesh.material.opacity = 0.75 + 0.25 * Math.sin(t * 7 + p.phase);
    // bar-wall glow decays back to idle after a scrape
    const decay = Math.exp(-dt * 3.5);
    this.wallFlash[0] *= decay;
    this.wallFlash[1] *= decay;
    this.barL.material.opacity = 0.34 + 0.55 * this.wallFlash[0];
    this.barR.material.opacity = 0.34 + 0.55 * this.wallFlash[1];
    this.obstFlash *= decay;
    this.obstMat.opacity = 0.75 + 0.25 * this.obstFlash;
    // flowing centre dashes
    this.dashTex.offset.y -= dt * 0.55;
    // boost shockwave rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.t += dt / 0.42;
      if (ring.t >= 1) {
        this.group.remove(ring.mesh);
        ring.mesh.geometry.dispose();
        ring.mesh.material.dispose();
        this.rings.splice(i, 1);
        continue;
      }
      ring.mesh.scale.setScalar(1 + ring.t * 6.5);
      ring.mesh.material.opacity = 0.85 * (1 - ring.t);
    }
    if (onPadHit && racers) {
      for (const r of racers) {
        for (const pad of this.pads) {
          let dsPad = r.s - pad.s;
          if (dsPad > this.length / 2) dsPad -= this.length;
          if (dsPad < -this.length / 2) dsPad += this.length;
          if (Math.abs(dsPad) < 6 && Math.abs(r.lat - pad.lat) < 3.2) {
            onPadHit(r);
          }
        }
        if (onObstacleHit) {
          for (const o of this.obstacles) {
            if (r.obstCd > 0) break;
            let dsO = r.s - o.s;
            if (dsO > this.length / 2) dsO -= this.length;
            if (dsO < -this.length / 2) dsO += this.length;
            if (Math.abs(dsO) < 2.6 && Math.abs(r.lat - o.lat) < 1.9) {
              onObstacleHit(r, o);
              this.obstFlash = 1;
            }
          }
        }
      }
    }
  }

  // static minimap polyline in [x,z]
  minimapPoints(step = 12) {
    const pts = [];
    for (let i = 0; i < this.n; i += step)
      pts.push({ x: this.pos[i].x, z: this.pos[i].z, s: (i / this.n) * this.length });
    return pts;
  }
}
