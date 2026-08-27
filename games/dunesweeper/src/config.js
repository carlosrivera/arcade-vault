/**
 * DUNESWEEPER - Configuration & Biome Palettes
 * 100% Procedural Voxel Archaeological Excavation
 */

export const CONFIG = {
  VOXEL_SIZE: 0.12, // Size of an individual micro-voxel cube
  CELL_VOXELS: 8, // Each cell grid is 8x8 micro-voxels
  CELL_SIZE: 0.12 * 8, // 0.96 world units per board cell
  SAND_LAYERS: 4, // Raised plateau height of undiscovered cells
  CHAMBER_DEPTH: 3, // Depth for sunken chambers

  EXPEDITION_NAMES: [
    'KHEPRI RUINS',
    'TEMPLE OF ANUBIS',
    'SANCTUARY OF HORUS',
    'TOMB OF OSIRIS',
    'PYRAMID OF RA',
  ],

  DIFFICULTIES: {
    scout: {
      id: 'scout',
      name: 'SCOUT (8x8)',
      width: 8,
      height: 8,
      traps: 9,
      relics: 2,
      lives: 3,
      shields: 1,
      brushes: 3,
      compasses: 2,
      maps: 1,
    },
    explorer: {
      id: 'explorer',
      name: 'EXPLORER (10x10)',
      width: 10,
      height: 10,
      traps: 16,
      relics: 3,
      lives: 3,
      shields: 1,
      brushes: 3,
      compasses: 3,
      maps: 2,
    },
    archaeologist: {
      id: 'archaeologist',
      name: 'ARCHAEOLOGIST (14x14)',
      width: 14,
      height: 14,
      traps: 32,
      relics: 4,
      lives: 3,
      shields: 2,
      brushes: 4,
      compasses: 4,
      maps: 3,
    },
  },

  PALETTES: {
    // Warm golden sandstone terraces: {0,1} crown tones, {1,2} body strata,
    // 3 spare highlight, 4 dark rim used on block edges
    terrace: [
      0xdca95c, // sunlit golden sandstone (crown A)
      0xd09a42, // warm sandstone (crown B / strata)
      0xbf8b3a, // deep sediment strata
      0xe9c48c, // spare highlight crest
      0x9f7331, // shaded rim / groove
    ],
    // Masonry courses for the enclosing ruin wall
    wall: [0xd6ab66, 0xca9a52, 0xb98d49, 0xdfba7e],
    // Excavated limestone floor
    floor: [
      0xd4c2a5, // bright carved floor tile
      0xc8b596, // weathered slab
      0xbeab8a, // stone center
      0x8b7759, // tile border groove
    ],
    // Natural desert sand perimeter
    desert: [0xdeb578, 0xd5a666, 0xe5be82, 0xc89652],
    // Scattered sand burst cubes (used by excavation FX)
    sand: [0xe9c48c, 0xdbb06a, 0xd5a761, 0xce9e59],
    // Vibrant number colors matching reference
    numbers: {
      1: 0x2563eb, // High-contrast Sapphire Blue
      2: 0x16a34a, // Forest Green
      3: 0xdc2626, // Terracotta Red
      4: 0x9333ea, // Royal Purple
      5: 0xd97706, // Amber Ochre
      6: 0x0891b2, // Cyan Teal
      7: 0x334155, // Slate Obsidian
      8: 0xffffff, // Quartz White
    },
    relics: {
      goldIdol: 0xf5b700,
      goldIdolHighlight: 0xffe066,
      amethyst: 0x9333ea,
      amethystGlow: 0xc084fc,
      ruby: 0xef4444,
      chestWood: 0x78350f,
      chestGold: 0xfbbf24,
    },
    hazards: {
      spiderBody: 0x1e293b,
      spiderEyes: 0xef4444,
      web: 0xe2e8f0,
      skullBone: 0xf1f5f9,
      altarStone: 0x475569,
      scorpionShell: 0x3d2012,
      scorpionSting: 0xdc2626,
    },
    portal: {
      stone: 0x6b6252, // weathered sand-grey stone (warm, not slate blue)
      moss: 0x65a30d,
      glow: 0x84cc16,
      stairs: 0x4a4438,
      torchWood: 0x78350f,
      torchFlame: 0xf97316,
    },
    vegetation: {
      cactusMain: 0x33511f,
      cactusShade: 0x27401a,
      cactusHighlight: 0x47682c,
      dryShrub: 0x9c4a12,
    },
    flag: {
      pole: 0x5c3d2e,
      cloth: 0xdc2626,
      clothHighlight: 0xf87171,
    },
  },

  CAMERA: {
    pitch: 58 * (Math.PI / 180), // 58 degrees isometric tilt
    distance: 12.5,
    minDistance: 6,
    maxDistance: 24,
    panLimit: 4,
  },
};
