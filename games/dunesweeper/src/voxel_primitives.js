/**
 * DUNESWEEPER - Procedural Voxel Primitives & Asset Generators
 * 100% Procedural compositions of micro-voxel cubes matching the archaeological diorama
 */

import { PRNG } from '#engine/rng.js';
import {
  BOX_GEOMETRY,
  buildVoxelMesh,
  getBlockMaterial,
  getGrainTexture,
  VOXEL_MATERIAL,
} from '#engine/voxel.js';
import { CONFIG } from './config.js';

// Re-exported so the prop builders below and their callers keep one import.
export { BOX_GEOMETRY, buildVoxelMesh, getBlockMaterial, getGrainTexture, VOXEL_MATERIAL };

/**
 * 3D Micro-Voxel Digits matching the reference colors
 */
const DIGIT_PATTERNS = {
  1: [' # ', '## ', ' # ', ' # ', '###'],
  2: ['###', '  #', '###', '#  ', '###'],
  3: ['###', '  #', '###', '  #', '###'],
  4: ['# #', '# #', '###', '  #', '  #'],
  5: ['###', '#  ', '###', '  #', '###'],
  6: ['###', '#  ', '###', '# #', '###'],
  7: ['###', '  #', ' # ', ' # ', ' # '],
  8: ['###', '# #', '###', '# #', '###'],
};

export function createVoxelDigit(num, customColor = null) {
  const pattern = DIGIT_PATTERNS[num];
  if (!pattern) return [];

  const color = customColor !== null ? customColor : CONFIG.PALETTES.numbers[num] || 0xffffff;
  const voxels = [];

  const rows = pattern.length;
  const cols = pattern[0].length;
  const offsetX = -(cols - 1) / 2;
  const offsetZ = -(rows - 1) / 2;

  // Bold 3D Raised Voxel Number
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (pattern[r][c] === '#') {
        const vx = (c + offsetX) * 1.1;
        const vz = (r + offsetZ) * 1.1;

        // Base layer
        voxels.push({
          x: vx,
          y: 0.6,
          z: vz,
          color,
          scale: 1.08,
        });
        // Top extruded layer
        voxels.push({
          x: vx,
          y: 1.2,
          z: vz,
          color,
          scale: 1.08,
        });
      }
    }
  }

  return voxels;
}

/**
 * Grand Temple Portal Gateway at the diorama front entrance
 */
export function createGrandPortalGateway() {
  const voxels = [];
  const stone = CONFIG.PALETTES.portal.stone;
  const moss = CONFIG.PALETTES.portal.moss;
  const glow = CONFIG.PALETTES.portal.glow;
  const stairs = CONFIG.PALETTES.portal.stairs;
  const torchW = CONFIG.PALETTES.portal.torchWood;
  const torchF = CONFIG.PALETTES.portal.torchFlame;

  // Front stepped stone stairs
  const steps = 4;
  for (let s = 0; s < steps; s++) {
    const sz = s * 0.8 + 1.2;
    const sy = -s * 0.4 - 0.2;
    for (let sx = -2.2; sx <= 2.2; sx += 0.8) {
      voxels.push({
        x: sx,
        y: sy,
        z: sz,
        color: stairs,
        scale: 1.1,
      });
    }
  }

  // Stone Archway Pillars (Left & Right)
  for (let y = 0; y <= 6; y++) {
    const isMoss = y >= 4;
    const col = isMoss && y % 2 === 0 ? moss : stone;
    // Left pillar
    voxels.push({ x: -2.4, y: y * 0.6 + 0.2, z: 0, color: col, scale: 1.3 });
    voxels.push({ x: -1.6, y: y * 0.6 + 0.2, z: 0, color: col, scale: 1.2 });
    // Right pillar
    voxels.push({ x: 2.4, y: y * 0.6 + 0.2, z: 0, color: col, scale: 1.3 });
    voxels.push({ x: 1.6, y: y * 0.6 + 0.2, z: 0, color: col, scale: 1.2 });
  }

  // Archway Header & Keystone
  for (let x = -2.4; x <= 2.4; x += 0.8) {
    voxels.push({ x, y: 4.2, z: 0, color: stone, scale: 1.3 });
    voxels.push({ x, y: 4.8, z: 0, color: moss, scale: 1.2 });
  }

  // Glowing Emerald Portal Center Doorway
  for (let py = 0.5; py <= 3.2; py += 0.6) {
    for (let px = -0.8; px <= 0.8; px += 0.6) {
      voxels.push({
        x: px,
        y: py,
        z: -0.2,
        color: glow,
        scale: 1.0,
      });
    }
  }

  // Left & Right Torch Pedestals with lit flames
  const torchPlinths = [
    { x: -3.4, z: 0.6 },
    { x: 3.4, z: 0.6 },
  ];

  for (const pl of torchPlinths) {
    voxels.push({ x: pl.x, y: 0.3, z: pl.z, color: stone, scale: 1.4 });
    voxels.push({ x: pl.x, y: 1.0, z: pl.z, color: stone, scale: 1.2 });
    voxels.push({ x: pl.x, y: 1.6, z: pl.z, color: torchW, scale: 0.8 });
    // Glowing orange/yellow flame
    voxels.push({ x: pl.x, y: 2.2, z: pl.z, color: torchF, scale: 0.9 });
    voxels.push({ x: pl.x, y: 2.6, z: pl.z, color: 0xfde047, scale: 0.6 });
  }

  return voxels;
}

/**
 * Masonry pit shaft: full brick courses lining the walls down to the chamber
 * floor, with missing bricks showing darkness, rubble on the bottom and moss
 * strands draped over the lip — so dug cells read as deep built shafts.
 */
export function createPitLiner() {
  const voxels = [];
  const rng = new PRNG(`shaft_${_linerSeed++}`);
  const brickCols = [0x6b4e26, 0x5c4220, 0x7a5a30, 0x4a3618];
  const halfC = (CONFIG.CELL_VOXELS - 1) / 2;

  // Raised brick lip around the shaft mouth, sitting at crown height so the
  // dark opening reads clearly from any camera angle
  const lipY = CONFIG.SAND_LAYERS * 0.9 + 0.55;
  const lipR = halfC + 0.8;
  for (let side = 0; side < 4; side++) {
    for (let a = -lipR; a <= lipR; a += 0.85) {
      if (rng.chance(0.1)) continue;
      let x;
      let z;
      if (side === 0) {
        x = a;
        z = -lipR;
      } else if (side === 1) {
        x = lipR;
        z = a;
      } else if (side === 2) {
        x = a;
        z = lipR;
      } else {
        x = -lipR;
        z = a;
      }
      voxels.push({
        x,
        y: lipY,
        z,
        color: brickCols[(side + ((a * 10) | 0)) % brickCols.length],
        scale: rng.range(0.85, 1),
      });
    }
  }

  // Darkness plug deep in the shaft — looking in reads as a black hole
  voxels.push({ x: 0, y: -4.6, z: 0, color: 0x171008, scale: 7.5 });

  for (let d = 0; d < 5; d++) {
    const y = -(d * 0.9);
    // Courses step slightly inward for a funnelled silhouette
    const r = halfC + 0.85 - d * 0.12;
    for (let side = 0; side < 4; side++) {
      for (let a = -r; a <= r; a += 0.85) {
        if (rng.chance(0.14)) continue; // missing / crumbled brick
        let x;
        let z;
        if (side === 0) {
          x = a;
          z = -r;
        } else if (side === 1) {
          x = r;
          z = a;
        } else if (side === 2) {
          x = a;
          z = r;
        } else {
          x = -r;
          z = a;
        }
        voxels.push({
          x,
          y,
          z,
          color: brickCols[(d + side + ((a * 10) | 0)) % brickCols.length],
          scale: rng.range(0.82, 0.98),
        });
      }
    }
  }

  // Moss strands draped over the lip
  if (rng.chance(0.55)) {
    for (let v = 0; v < rng.rangeInt(1, 3); v++) {
      const vx = rng.choice([-halfC, halfC]);
      const vz = rng.range(-halfC, halfC);
      voxels.push({ x: vx, y: -0.25, z: vz, color: CONFIG.PALETTES.portal.moss, scale: 0.75 });
      if (rng.chance(0.7)) {
        voxels.push({ x: vx, y: -1.05, z: vz, color: 0x4d7c0f, scale: 0.55 });
      }
    }
  }

  // Rubble heap at the bottom
  for (let rb = 0; rb < rng.rangeInt(3, 6); rb++) {
    voxels.push({
      x: rng.choice([-2.2, -1.4, 1.4, 2.2]) + rng.range(-0.3, 0.3),
      y: -2.15 + rng.range(-0.1, 0.25),
      z: rng.range(-2.4, 2.4),
      color: rng.chance(0.5) ? brickCols[1] : 0x5c4522,
      scale: rng.range(0.35, 0.65),
    });
  }

  return voxels;
}
let _linerSeed = 0;

/**
 * Sunken Chamber: Golden Idol Relic Room
 */
export function createGoldenIdolChamber({ _seed = 'idol' } = {}) {
  const voxels = [];
  const gold = CONFIG.PALETTES.relics.goldIdol;
  const goldH = CONFIG.PALETTES.relics.goldIdolHighlight;
  const stone = CONFIG.PALETTES.portal.stone;
  const floor = CONFIG.PALETTES.floor[0];

  // Sunken floor & walls
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      voxels.push({ x, y: -2.4, z, color: floor, scale: 1.0 });
    }
  }

  // Central Stone Pedestal
  voxels.push({ x: 0, y: -1.6, z: 0, color: stone, scale: 1.6 });
  voxels.push({ x: 0, y: -1.0, z: 0, color: stone, scale: 1.3 });

  // Golden Voxel Idol on top of pedestal
  voxels.push({ x: 0, y: -0.3, z: 0, color: gold, scale: 1.4 });
  voxels.push({ x: 0, y: 0.4, z: 0, color: goldH, scale: 1.2 }); // Idol head
  voxels.push({ x: -0.6, y: 0.1, z: 0, color: gold, scale: 0.7 }); // Idol ears
  voxels.push({ x: 0.6, y: 0.1, z: 0, color: gold, scale: 0.7 });

  // Flanking mini stone pillar
  voxels.push({ x: 1.8, y: -1.4, z: 0, color: stone, scale: 0.9 });
  voxels.push({ x: 1.8, y: -0.7, z: 0, color: stone, scale: 0.8 });

  return voxels;
}

/**
 * Sunken Chamber: Purple Amethyst Relic Room
 */
export function createAmethystChamber({ _seed = 'amethyst' } = {}) {
  const voxels = [];
  const purp = CONFIG.PALETTES.relics.amethyst;
  const purpG = CONFIG.PALETTES.relics.amethystGlow;
  const wood = CONFIG.PALETTES.relics.chestWood;
  const floor = CONFIG.PALETTES.floor[0];

  // Sunken room base
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      voxels.push({ x, y: -2.4, z, color: floor, scale: 1.0 });
    }
  }

  // Wooden altar stand
  voxels.push({ x: 0, y: -1.6, z: 0, color: wood, scale: 1.4 });
  voxels.push({ x: 0, y: -1.0, z: 0, color: wood, scale: 1.1 });

  // Sprouting Amethyst Crystal cluster
  voxels.push({ x: 0, y: -0.3, z: 0, color: purp, scale: 1.3 });
  voxels.push({ x: 0.4, y: 0.3, z: 0.2, color: purpG, scale: 0.8 });
  voxels.push({ x: -0.4, y: 0.2, z: -0.2, color: purpG, scale: 0.7 });

  return voxels;
}

/**
 * Sunken Chamber: Treasure Chest Room
 */
export function createChestChamber({ _seed = 'chest' } = {}) {
  const voxels = [];
  const wood = CONFIG.PALETTES.relics.chestWood;
  const gold = CONFIG.PALETTES.relics.chestGold;
  const floor = CONFIG.PALETTES.floor[0];

  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      voxels.push({ x, y: -2.4, z, color: floor, scale: 1.0 });
    }
  }

  // Chest Base
  voxels.push({ x: 0, y: -1.5, z: 0, color: wood, scale: 1.6 });
  // Gold Trim & Latch
  voxels.push({ x: 0, y: -1.5, z: 0.7, color: gold, scale: 0.5 });
  // Chest Curved Lid
  voxels.push({ x: 0, y: -0.8, z: 0, color: wood, scale: 1.4 });
  voxels.push({ x: 0, y: -0.8, z: 0, color: gold, scale: 0.7 });

  return voxels;
}

/**
 * Sunken Chamber: Cobweb & Spider Hazard Pit
 */
export function createSpiderChamber({ _seed = 'spider' } = {}) {
  const voxels = [];
  const sBody = CONFIG.PALETTES.hazards.spiderBody;
  const sEyes = CONFIG.PALETTES.hazards.spiderEyes;
  const web = CONFIG.PALETTES.hazards.web;
  const floor = 0x584630; // dark earthen pit floor

  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      voxels.push({ x, y: -2.4, z, color: floor, scale: 1.0 });
    }
  }

  // White Cobweb grid in corner
  for (let x = -2; x <= 0; x++) {
    for (let z = -2; z <= 0; z++) {
      if (Math.abs(x) === Math.abs(z) || x === -1 || z === -1) {
        voxels.push({ x, y: -2.1, z, color: web, scale: 0.5 });
      }
    }
  }

  // Menacing Black Spider in center
  voxels.push({ x: 0.5, y: -1.8, z: 0.5, color: sBody, scale: 1.4 });
  // Red spider eyes
  voxels.push({ x: 0.3, y: -1.6, z: 1.1, color: sEyes, scale: 0.4 });
  voxels.push({ x: 0.7, y: -1.6, z: 1.1, color: sEyes, scale: 0.4 });
  // Legs
  for (let leg = -1; leg <= 1; leg += 0.8) {
    voxels.push({ x: -0.4, y: -2.0, z: 0.5 + leg, color: sBody, scale: 0.4 });
    voxels.push({ x: 1.4, y: -2.0, z: 0.5 + leg, color: sBody, scale: 0.4 });
  }

  return voxels;
}

/**
 * Sunken Chamber: Ancient Altar with Skull Hazard
 */
export function createAltarSkullChamber({ _seed = 'skull' } = {}) {
  const voxels = [];
  const altar = CONFIG.PALETTES.hazards.altarStone;
  const bone = CONFIG.PALETTES.hazards.skullBone;
  const floor = 0x584630; // dark earthen pit floor

  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      voxels.push({ x, y: -2.4, z, color: floor, scale: 1.0 });
    }
  }

  // Stone Altar Slab
  voxels.push({ x: 0, y: -1.6, z: 0, color: altar, scale: 1.6 });

  // White Voxel Skull
  voxels.push({ x: 0, y: -0.9, z: 0, color: bone, scale: 1.2 });
  // Dark eye sockets
  voxels.push({ x: -0.3, y: -0.8, z: 0.5, color: 0x1e293b, scale: 0.4 });
  voxels.push({ x: 0.3, y: -0.8, z: 0.5, color: 0x1e293b, scale: 0.4 });

  // Ruined column stump beside altar
  voxels.push({ x: -1.8, y: -1.4, z: -1.2, color: altar, scale: 0.9 });
  voxels.push({ x: -1.8, y: -0.6, z: -1.2, color: altar, scale: 0.8 });

  return voxels;
}

/**
 * Sunken Pit: Scorpion Hazard
 */
export function createScorpionPit({ _seed = 'scorpion' } = {}) {
  const voxels = [];
  const shell = CONFIG.PALETTES.hazards.scorpionShell;
  const sting = CONFIG.PALETTES.hazards.scorpionSting;
  const floor = 0x584630; // dark earthen pit floor

  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      voxels.push({ x, y: -2.4, z, color: floor, scale: 1.0 });
    }
  }

  // Scorpion Body
  voxels.push({ x: 0, y: -1.8, z: 0, color: shell, scale: 1.2 });
  voxels.push({ x: -0.7, y: -1.8, z: -0.6, color: shell, scale: 0.7 }); // claws
  voxels.push({ x: 0.7, y: -1.8, z: -0.6, color: shell, scale: 0.7 });
  // Stinger tail
  voxels.push({ x: 0, y: -1.1, z: 0.8, color: shell, scale: 0.8 });
  voxels.push({ x: 0, y: -0.6, z: 0.3, color: sting, scale: 0.9 });

  return voxels;
}

/**
 * Procedural Survey Stake with Red Flag
 */
export function createFlag() {
  const voxels = [];
  const pole = CONFIG.PALETTES.flag.pole;
  const cloth = CONFIG.PALETTES.flag.cloth;
  const clothH = CONFIG.PALETTES.flag.clothHighlight;

  // Wooden stake
  for (let y = 0; y < 6; y++) {
    voxels.push({ x: 0, y: y * 0.4 + 0.2, z: 0, color: pole, scale: 0.5 });
  }

  // Red pennant flag
  voxels.push({ x: 0.4, y: 2.2, z: 0, color: cloth, scale: 0.7 });
  voxels.push({ x: 0.9, y: 2.2, z: 0, color: cloth, scale: 0.7 });
  voxels.push({ x: 1.4, y: 2.2, z: 0, color: clothH, scale: 0.6 });
  voxels.push({ x: 0.4, y: 1.7, z: 0, color: cloth, scale: 0.7 });
  voxels.push({ x: 0.9, y: 1.7, z: 0, color: cloth, scale: 0.7 });

  return voxels;
}

/**
 * Procedural Multi-Arm Saguaro Cactus matching the reference.
 * Chunky mass: trunk is a solid 2x2 column of overlapping voxels so props
 * feel built from the same cube grain as the terrain.
 */
export function createCactus({ seed = 'cactus', height = 5, arms = 2 }) {
  const rng = new PRNG(seed);
  const voxels = [];
  const mainCol = CONFIG.PALETTES.vegetation.cactusMain;
  const shadeCol = CONFIG.PALETTES.vegetation.cactusShade;
  const highCol = CONFIG.PALETTES.vegetation.cactusHighlight;

  // Trunk: 2x2 fat column
  for (let y = 0; y < height; y++) {
    const col = y === height - 1 ? highCol : y % 2 === 0 ? mainCol : shadeCol;
    for (const dx of [-0.35, 0.35]) {
      for (const dz of [-0.35, 0.35]) {
        voxels.push({ x: dx, y: y * 0.75 + 0.38, z: dz, color: col, scale: 1.25 });
      }
    }
    // Rounded cap
    if (y === height - 1) {
      voxels.push({ x: 0, y: y * 0.75 + 1.05, z: 0, color: mainCol, scale: 1.1 });
    }
  }

  // Arms: horizontal elbow then a rising mini-column
  const armDirs = [
    { dx: 1, dz: 0 },
    { dx: -1, dz: 0 },
    { dx: 0, dz: 1 },
    { dx: 0, dz: -1 },
  ];
  rng.shuffle(armDirs);

  const armCount = Math.min(arms, 3);
  for (let i = 0; i < armCount; i++) {
    const dir = armDirs[i];
    const armY = 2 + i;
    if (armY >= height - 1) continue;

    // Elbow segment reaching out from the trunk
    voxels.push({
      x: dir.dx * 1.15,
      y: armY * 0.75 + 0.5,
      z: dir.dz * 1.15,
      color: mainCol,
      scale: 1.15,
    });

    // Vertical rise with rounded top
    const riseSteps = 2;
    for (let s = 1; s <= riseSteps; s++) {
      const col = s === riseSteps ? highCol : mainCol;
      voxels.push({
        x: dir.dx * 1.15,
        y: armY * 0.75 + 0.5 + s * 0.75,
        z: dir.dz * 1.15,
        color: col,
        scale: s === riseSteps ? 0.95 : 1.1,
      });
    }
  }

  return voxels;
}

/**
 * Procedural Desert Rock
 */
export function createRock({ seed = 'rock', radius = 1.6 }) {
  const rng = new PRNG(seed);
  const voxels = [];
  const colors = [0xc79953, 0xb98845, 0xd6a862];

  for (let x = -radius; x <= radius; x += 0.8) {
    for (let y = 0; y <= radius * 0.75; y += 0.8) {
      for (let z = -radius; z <= radius; z += 0.8) {
        if (Math.hypot(x, y * 1.6, z) <= radius && rng.chance(0.9)) {
          voxels.push({
            x,
            y: y + 0.25,
            z,
            color: rng.choice(colors),
            scale: 1.05,
          });
        }
      }
    }
  }
  return voxels;
}

/**
 * Procedural Desert Shrub
 */
export function createDryShrub({ seed = 'shrub' }) {
  const rng = new PRNG(seed);
  const voxels = [];
  const dryCol = CONFIG.PALETTES.vegetation.dryShrub;

  for (let i = 0; i < 5; i++) {
    voxels.push({
      x: rng.range(-0.6, 0.6),
      y: rng.range(0.2, 0.9),
      z: rng.range(-0.6, 0.6),
      color: dryCol,
      scale: rng.range(0.4, 0.7),
    });
  }
  return voxels;
}

/**
 * Standing torch: stone plinth, wooden shaft, layered flame.
 * Used to carry real point lights across the diorama (see renderer).
 */
export function createTorch({ height = 5 } = {}) {
  const voxels = [];
  const stone = CONFIG.PALETTES.portal.stone;
  const wood = CONFIG.PALETTES.portal.torchWood;
  const flame = CONFIG.PALETTES.portal.torchFlame;

  // Plinth
  voxels.push({ x: 0, y: 0.2, z: 0, color: stone, scale: 1.35 });
  voxels.push({ x: 0, y: 0.75, z: 0, color: stone, scale: 1.05 });

  // Shaft
  for (let i = 0; i < height; i++) {
    voxels.push({
      x: 0,
      y: 1.2 + i * 0.55,
      z: 0,
      color: i === height - 1 ? '#4a2f14' : wood,
      scale: 0.55,
    });
  }

  // Flame stack
  const topY = 1.2 + height * 0.55;
  voxels.push({ x: 0, y: topY, z: 0, color: flame, scale: 0.85 });
  voxels.push({ x: 0, y: topY + 0.45, z: 0, color: 0xfde047, scale: 0.62 });
  voxels.push({ x: 0, y: topY + 0.8, z: 0, color: 0xfff7cc, scale: 0.38 });

  return voxels;
}

/**
 * Tomb Exit Door: sandstone archway over a stairway descending into
 * darkness. Authored at cell scale (8 voxels wide), sits in the exit cell.
 */
export function createTombStairsDoor() {
  const voxels = [];
  const stone = 0x6b6252;
  const stoneDark = 0x4a4438;
  const gold = 0xd9a83c;
  const glowGreen = 0x84cc16;

  // Descending stairs into the earth
  for (let s = 0; s < 5; s++) {
    const depth = -s * 1.1 - 0.8;
    for (let sx = -2; sx <= 2; sx += 0.9) {
      voxels.push({
        x: sx,
        y: depth + 0.55,
        z: 1.4 - s * 0.85,
        color: s % 2 === 0 ? stoneDark : '#332e22',
        scale: 0.95,
      });
    }
  }

  // Arch columns
  for (let ly = 0; ly <= 4; ly++) {
    for (const px of [-3, 3]) {
      voxels.push({
        x: px,
        y: ly * 0.85 + 0.42,
        z: 1.9,
        color: ly % 2 === 0 ? stone : stoneDark,
        scale: 1.0,
      });
      voxels.push({
        x: px * 0.72,
        y: ly * 0.85 + 0.42,
        z: 1.9,
        color: stoneDark,
        scale: 0.92,
      });
    }
  }

  // Lintel with a gold keystone emblem
  for (let lx = -3; lx <= 3; lx += 0.85) {
    voxels.push({ x: lx, y: 3.9, z: 1.9, color: stone, scale: 0.98 });
  }
  voxels.push({ x: 0, y: 4.5, z: 1.9, color: glowGreen, scale: 0.7 });
  voxels.push({ x: -1.6, y: 3.35, z: 2.0, color: gold, scale: 0.45 });
  voxels.push({ x: 1.6, y: 3.35, z: 2.0, color: gold, scale: 0.45 });

  // Torch stubs flanking the doorway (visual only; real light added by renderer)
  voxels.push({ x: -2.6, y: 2.6, z: 2.2, color: 0xf97316, scale: 0.6 });
  voxels.push({ x: 2.6, y: 2.6, z: 2.2, color: 0xf97316, scale: 0.6 });

  return voxels;
}

/**
 * Bone & pottery scatter dropped inside hazard pits as small details.
 */
export function createBoneDecor({ seed = 'bones' } = {}) {
  const rng = new PRNG(seed);
  const bone = CONFIG.PALETTES.hazards.skullBone;
  const potShard = 0xa86a32;
  const voxels = [];

  // A couple of long bones
  const boneCount = rng.rangeInt(2, 4);
  for (let i = 0; i < boneCount; i++) {
    const bx = rng.range(-2.4, 2.4);
    const bz = rng.range(-2.4, 2.4);
    voxels.push({ x: bx, y: -2.15, z: bz, color: bone, scale: 0.55 });
    if (rng.chance(0.7)) {
      voxels.push({
        x: bx + rng.choice([-0.55, 0.55]),
        y: -2.18,
        z: bz + rng.range(-0.15, 0.15),
        color: WHT_BONE_TIP,
        scale: 0.4,
      });
    }
  }

  // Broken pottery shards
  const shardCount = rng.rangeInt(1, 3);
  for (let i = 0; i < shardCount; i++) {
    voxels.push({
      x: rng.range(-2.6, 2.6),
      y: -2.2,
      z: rng.range(-2.6, 2.6),
      color: rng.chance(0.5) ? potShard : 0x8a5324,
      scale: rng.range(0.35, 0.55),
    });
  }

  return voxels;
}

const WHT_BONE_TIP = '#d4cabb';
