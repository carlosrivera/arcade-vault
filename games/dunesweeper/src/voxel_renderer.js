/**
 * DUNESWEEPER - Voxel Renderer & Diorama Presentation
 * 100% Voxel Diorama with Raised Terraces, Sunken Chambers, and Portal Gateway
 */

import * as THREE from 'three';
import { PRNG } from '#engine/rng.js';
import { CONFIG } from './config.js';
import { CELL_STATE } from './game_state.js';
import {
  buildVoxelMesh,
  createAltarSkullChamber,
  createAmethystChamber,
  createBoneDecor,
  createCactus,
  createChestChamber,
  createDryShrub,
  createFlag,
  createGoldenIdolChamber,
  createGrandPortalGateway,
  createPitLiner,
  createRock,
  createScorpionPit,
  createSpiderChamber,
  createTombStairsDoor,
  createTorch,
  createVoxelDigit,
  getBlockMaterial,
  getGrainTexture,
} from './voxel_primitives.js';

export class VoxelRenderer {
  constructor(container, gameState) {
    this.container = container;
    this.gameState = gameState;
    this.prng = new PRNG(gameState.seed);

    this.scene = null;
    this.camera = null;
    this.renderer = null;

    this.dioramaGroup = null;
    this.gridGroup = null;
    this.cellViews = new Map(); // key `${x},${y}` -> CellView
    this.animatedObjects = [];

    // Hover & Compass visuals
    this.hoverMesh = null;
    this.compassHighlightGroup = null;

    // Per-cell dune relief (extra plateau layers) for hover/flag placement
    this.reliefByCell = new Map();

    // Flickering point lights (torches, tomb exit glow)
    this.flickerLights = [];

    // Camera control state matching reference 58° tilt, board-aligned start
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camDistance = CONFIG.CAMERA.distance;
    this.camAngle = 0; // axis-aligned starting view; drag or Q/E to orbit
    this.camPitch = CONFIG.CAMERA.pitch; // 58 degree pitch
    this.targetDistance = this.camDistance;
    this.targetAngle = this.camAngle;

    this.isDragging = false;
    this.prevMouse = { x: 0, y: 0 };
    this.hoveredCell = null;
    this.dragDistance = 0; // suppresses dig-click after an orbit drag

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    this.initScene();
    this.buildDioramaEnvironment();
    this.buildGrid();
    this.bindEvents();
  }

  initScene() {
    this.scene = new THREE.Scene();
    // Warm sunny desert atmosphere
    this.scene.background = new THREE.Color(0xd8aa6c);
    this.scene.fog = new THREE.FogExp2(0xd8aa6c, 0.026);

    const aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 100);
    this.updateCameraTransform();

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.container,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;

    // Low ambient base — shadows carry the scene and the torch/shrine point
    // lights become the real light sources
    const ambientLight = new THREE.AmbientLight(0xffe3bd, 0.18);
    this.scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xfff1da, 0xa87b4a, 0.3);
    this.scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xfff3e0, 1.6);
    sunLight.position.set(22, 24, 10);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 70;
    sunLight.shadow.camera.left = -16;
    sunLight.shadow.camera.right = 16;
    sunLight.shadow.camera.top = 16;
    sunLight.shadow.camera.bottom = -16;
    sunLight.shadow.bias = -0.0004;
    this.scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0xfde68a, 0.1);
    fillLight.position.set(-15, 18, -12);
    this.scene.add(fillLight);

    this.dioramaGroup = new THREE.Group();
    this.scene.add(this.dioramaGroup);

    this.gridGroup = new THREE.Group();
    this.dioramaGroup.add(this.gridGroup);

    // Hover box indicator
    const hoverGeo = new THREE.BoxGeometry(CONFIG.CELL_SIZE * 0.98, 0.1, CONFIG.CELL_SIZE * 0.98);
    const hoverMat = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      wireframe: true,
      transparent: true,
      opacity: 0.9,
    });
    this.hoverMesh = new THREE.Mesh(hoverGeo, hoverMat);
    this.hoverMesh.visible = false;
    this.dioramaGroup.add(this.hoverMesh);

    this.compassHighlightGroup = new THREE.Group();
    this.dioramaGroup.add(this.compassHighlightGroup);
  }

  updateCameraTransform() {
    const x =
      this.camTarget.x + Math.sin(this.camAngle) * Math.cos(this.camPitch) * this.camDistance;
    const y = this.camTarget.y + Math.sin(this.camPitch) * this.camDistance;
    const z =
      this.camTarget.z + Math.cos(this.camAngle) * Math.cos(this.camPitch) * this.camDistance;
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.camTarget);
  }

  gridToWorld(gx, gy) {
    const halfW = (this.gameState.width * CONFIG.CELL_SIZE) / 2;
    const halfH = (this.gameState.height * CONFIG.CELL_SIZE) / 2;
    const x = (gx + 0.5) * CONFIG.CELL_SIZE - halfW;
    const z = (gy + 0.5) * CONFIG.CELL_SIZE - halfH;
    return { x, z };
  }

  /**
   * Build the natural desert ground, perimeter vegetation, and Grand Temple Portal Gateway
   */
  buildDioramaEnvironment() {
    const vSize = CONFIG.VOXEL_SIZE;
    const w = this.gameState.width;
    const h = this.gameState.height;
    const boardW = w * CONFIG.CELL_SIZE;
    const boardH = h * CONFIG.CELL_SIZE;
    const margin = 3.6;

    const totalW = boardW + margin * 2;
    const totalH = boardH + margin * 2;

    // 1. Natural Desert Ground Base Plane — tiled sand grain texture
    const groundGeo = new THREE.PlaneGeometry(totalW * 4, totalH * 4, 32, 32);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xd2a35f,
      roughness: 0.95,
      metalness: 0.02,
      flatShading: true,
      map: getGrainTexture().clone(),
    });
    groundMat.map.needsUpdate = true;
    // One texture tile per board cell so ground texels stay blocky-huge
    groundMat.map.repeat.set(totalW * 1.05, totalH * 1.05);
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.y = -0.05;
    groundMesh.receiveShadow = true;
    this.dioramaGroup.add(groundMesh);

    // 2. Grand Temple Portal Gateway mounted IN the south wall gap — the
    //    expedition entrance, bridged to the flagstone causeway
    const portalVox = createGrandPortalGateway();
    const portalMesh = buildVoxelMesh(portalVox, vSize, getBlockMaterial());
    portalMesh.position.set(0, 0, boardH / 2 + 0.55);
    portalMesh.scale.setScalar(1.4);
    this.dioramaGroup.add(portalMesh);

    // 2b. Enclosing ruin wall ringing the board — half-cell masonry courses
    //     laid in brick bond, with a gateway gap on the south rim
    const wallRng = new PRNG(`${this.gameState.seed}_wall`);
    const wallStones = [];
    const STONE = CONFIG.CELL_VOXELS / 2; // stone footprint in authored voxels
    const VOX_W = w * CONFIG.CELL_VOXELS; // board span in authored voxels
    const VOX_H = h * CONFIG.CELL_VOXELS;
    const EDGE_C = STONE / 2 + 0.14; // stone-centre distance outside the board edge
    const portalGapMinVox = (Math.floor(w / 2) - 2) * CONFIG.CELL_VOXELS;
    const portalGapMaxVox = (Math.ceil(w / 2) + 1) * CONFIG.CELL_VOXELS;

    const pushWallStone = (xc, zc, ly, scale) => {
      const col = CONFIG.PALETTES.wall[wallRng.rangeInt(0, 3)];
      wallStones.push({
        x: xc - VOX_W / 2 + (ly % 2 === 1 ? STONE * 0.22 : 0), // brick-bond stagger
        y: ly * STONE + STONE * 0.5,
        z: zc - VOX_H / 2,
        color: col,
        scale,
      });
    };

    const stackWallSection = (xc, zc, maxStack) => {
      if (wallRng.chance(0.08)) return; // collapsed section of ruin
      const stack = wallRng.rangeInt(1, maxStack);
      for (let ly = 0; ly < stack; ly++) pushWallStone(xc, zc, ly, STONE * 0.94);
      if (wallRng.chance(0.12)) {
        // creeping moss capstone
        pushWallStone(xc, zc, stack, STONE * 0.66);
        wallStones[wallStones.length - 1].color = CONFIG.PALETTES.portal.moss;
      }
    };

    for (let xt = 0; xt < VOX_W; xt += STONE) {
      const mid = xt + STONE / 2;
      stackWallSection(mid, -EDGE_C, 3); // north rim
      if (mid < portalGapMinVox || mid > portalGapMaxVox) {
        stackWallSection(mid, VOX_H + EDGE_C, 3); // south rim, minus gateway
      }
    }
    for (let zt = 0; zt < VOX_H; zt += STONE) {
      const mid = zt + STONE / 2;
      stackWallSection(-EDGE_C, mid, 3); // west rim
      stackWallSection(VOX_W + EDGE_C, mid, 3); // east rim
    }
    // Corner keeps rise taller than the curtain walls
    for (const [cxk, czk] of [
      [-EDGE_C, -EDGE_C],
      [VOX_W + EDGE_C, -EDGE_C],
      [-EDGE_C, VOX_H + EDGE_C],
      [VOX_W + EDGE_C, VOX_H + EDGE_C],
    ]) {
      const stack = wallRng.rangeInt(4, 6);
      for (let ly = 0; ly < stack; ly++) pushWallStone(cxk, czk, ly, STONE);
    }
    const wallMesh = buildVoxelMesh(wallStones, vSize, getBlockMaterial());
    this.dioramaGroup.add(wallMesh);

    // 2c. Entry causeway: flagstone path bridging the wall gap to the portal
    const pathRng = new PRNG(`${this.gameState.seed}_path`);
    const pathStones = [];
    const PATH_W = CONFIG.CELL_VOXELS * 2.6; // corridor width in voxels
    for (let zt = VOX_H; zt <= VOX_H + 20; zt += 4) {
      for (let xt = -PATH_W / 2; xt < PATH_W / 2; xt += 4) {
        if (pathRng.chance(0.12)) continue; // worn gaps
        pathStones.push({
          x: VOX_W / 2 + xt + pathRng.range(-0.3, 0.3),
          y: 0.22,
          z: zt - 2,
          color: CONFIG.PALETTES.floor[pathRng.rangeInt(0, 2)],
          scale: 4 * pathRng.range(0.82, 0.98),
        });
      }
      // Low guiding kerbs
      pathStones.push({
        x: VOX_W / 2 - PATH_W / 2 - 1.5,
        y: 0.55,
        z: zt - 2,
        color: CONFIG.PALETTES.wall[2],
        scale: 3.2,
      });
      pathStones.push({
        x: VOX_W / 2 + PATH_W / 2 + 1.5,
        y: 0.55,
        z: zt - 2,
        color: CONFIG.PALETTES.wall[2],
        scale: 3.2,
      });
    }
    const pathMesh = buildVoxelMesh(pathStones, vSize, getBlockMaterial());
    this.dioramaGroup.add(pathMesh);

    // 2d. Torch placement with real flickering point lights — the diorama's
    //     light sources: portal pair, causeway pair, four corner braziers.
    //     Positions are authored voxel coords → world = coord * vSize.
    const addTorch = (worldX, worldY, worldZ, scale = 1.35, opts = {}) => {
      const torchMesh = buildVoxelMesh(
        createTorch({ height: opts.height ?? 5 }),
        vSize,
        getBlockMaterial(),
      );
      torchMesh.position.set(worldX, worldY, worldZ);
      torchMesh.scale.setScalar(scale);
      torchMesh.rotation.y = opts.rotation ?? 0;
      this.dioramaGroup.add(torchMesh);

      const flameWorldY = (1.2 + (opts.height ?? 5) * 0.55 + 0.45) * vSize * scale;
      const light = new THREE.PointLight(0xffa64d, 0, 7, 2);
      light.position.set(worldX, worldY + flameWorldY, worldZ);
      light.userData.base = opts.intensity ?? 3.4;
      light.userData.phase = Math.random() * Math.PI * 2;
      this.scene.add(light);
      this.flickerLights.push(light);
    };

    // Portal plinth lights (match createGrandPortalGateway authoring)
    for (const sx of [-3.4, 3.4]) {
      const l = new THREE.PointLight(0xffa64d, 0, 7.5, 2);
      l.position.set(sx * vSize * 1.4, 2.7 * vSize * 1.4, boardH / 2 + 0.55);
      l.userData.base = 4.4;
      l.userData.phase = Math.random() * Math.PI * 2;
      this.scene.add(l);
      this.flickerLights.push(l);
    }

    // Causeway gate torches just inside the wall gap
    addTorch((-PATH_W / 2) * vSize, 0, (VOX_H + 0.8) * vSize, 1.5, { intensity: 4.0 });
    addTorch((PATH_W / 2) * vSize, 0, (VOX_H + 0.8) * vSize, 1.5, { intensity: 4.0 });

    // Four brazier torches hugging the wall corners (outside the ring).
    // Diorama is origin-centred: corners sit at ±(boardHalf + offset).
    const CORNER_OFF = EDGE_C * vSize + 0.85;
    const halfW = boardW / 2;
    const halfH = boardH / 2;
    for (const [cx2, cz2] of [
      [-halfW - CORNER_OFF, -halfH - CORNER_OFF],
      [halfW + CORNER_OFF, -halfH - CORNER_OFF],
      [-halfW - CORNER_OFF, halfH + CORNER_OFF],
      [halfW + CORNER_OFF, halfH + CORNER_OFF],
    ]) {
      addTorch(cx2, 0, cz2, 1.6, { height: 6, intensity: 3.8 });
    }

    // 3. Perimeter Scenery: Cacti, Rocks, Dry bushes matching reference
    const rng = new PRNG(`${this.gameState.seed}_env`);
    const cactusCount = 14;

    for (let i = 0; i < cactusCount; i++) {
      const side = rng.rangeInt(0, 3);
      let px = 0;
      let pz = 0;
      const offset = rng.range(3.5, 6.5);

      if (side === 0) {
        px = rng.range(-totalW / 2, totalW / 2);
        pz = -boardH / 2 - offset;
      } else if (side === 1) {
        px = rng.range(-totalW / 2, totalW / 2);
        pz = boardH / 2 + offset + 0.8;
      } else if (side === 2) {
        px = -boardW / 2 - offset;
        pz = rng.range(-totalH / 2, totalH / 2);
      } else {
        px = boardW / 2 + offset;
        pz = rng.range(-totalH / 2, totalH / 2);
      }

      if (rng.chance(0.65)) {
        const cactVox = createCactus({
          seed: `cact_${i}`,
          height: rng.rangeInt(4, 7),
          arms: rng.rangeInt(1, 3),
        });
        const cactMesh = buildVoxelMesh(cactVox, vSize, getBlockMaterial());
        cactMesh.position.set(px, 0, pz);
        cactMesh.rotation.y = rng.range(0, Math.PI * 2);
        this.dioramaGroup.add(cactMesh);
      } else {
        const rockVox = createRock({
          seed: `rock_${i}`,
          radius: rng.range(1.2, 2.2),
        });
        const rockMesh = buildVoxelMesh(rockVox, vSize, getBlockMaterial());
        rockMesh.position.set(px, 0, pz);
        this.dioramaGroup.add(rockMesh);
      }

      // Add dry shrub nearby
      if (rng.chance(0.4)) {
        const shrubVox = createDryShrub({ seed: `shrub_${i}` });
        const shrubMesh = buildVoxelMesh(shrubVox, vSize, getBlockMaterial());
        shrubMesh.position.set(px + rng.range(-0.8, 0.8), 0, pz + rng.range(-0.8, 0.8));
        this.dioramaGroup.add(shrubMesh);
      }
    }

    // 4. Far field: dune ridges, mountains, pyramids and boulders ring the
    //    diorama so the desert reads as endless instead of a square plinth.
    //    Everything is chunky big-cube voxels fading into the fog.
    const farRng = new PRNG(`${this.gameState.seed}_far`);
    const farVox = [];
    const FAR_STEP = 2.4; // big cubes: authored size = world size / vSize
    const pushFarCube = (wx, wy, wz, size, color) => {
      farVox.push({ x: wx / vSize, y: wy / vSize, z: wz / vSize, color, scale: size / vSize });
    };

    const duneCols = CONFIG.PALETTES.desert;
    const wallCols = CONFIG.PALETTES.wall;
    const rockCols = [0x8a6a42, 0x9c7a4c, 0x7a5c36, wallCols[2]];

    // Rolling dune field over a wide square annulus, driven by layered sines
    const R0 = Math.max(totalW, totalH) * 0.78;
    const R1 = R0 + 14;
    for (let gx = -R1; gx <= R1; gx += FAR_STEP) {
      for (let gz = -R1; gz <= R1; gz += FAR_STEP) {
        const cheb = Math.max(Math.abs(gx), Math.abs(gz));
        if (cheb < R0) continue;
        // Keep the causeway corridor to the south gate clear
        if (gz > R0 * 0.35 && Math.abs(gx) < 4.5) continue;
        if (farRng.chance(0.3)) continue; // sparse, organic gaps

        const duneH =
          (Math.sin(gx * 0.16 + gz * 0.07) * 0.5 + 0.5) * 1.6 +
          (Math.sin(gx * 0.05 - gz * 0.12 + 2.2) * 0.5 + 0.5) * 2.4;
        const stack = Math.max(1, Math.round(duneH + farRng.range(0, 0.8)));
        const col = duneCols[farRng.rangeInt(0, 3)];
        const size = FAR_STEP * farRng.range(0.9, 1.15);
        for (let ly = 0; ly < stack; ly++) {
          pushFarCube(
            gx + farRng.range(-0.4, 0.4),
            ly * FAR_STEP * 0.92 + size * 0.5,
            gz + farRng.range(-0.4, 0.4),
            size,
            ly === stack - 1 ? duneCols[2] : col,
          );
        }
      }
    }

    // Distant mountains: stacked shrinking cube slabs at the horizon
    const mountainAngles = [0.4, 1.9, 3.6, 5.2];
    mountainAngles.forEach((ang, mi) => {
      const dist = R1 * farRng.range(1.1, 1.32);
      const mx = Math.cos(ang) * dist;
      const mz = Math.sin(ang) * dist;
      const layers = farRng.rangeInt(6, 10);
      let slabSize = 6.5 + farRng.range(0, 3);
      for (let ly = 0; ly < layers; ly++) {
        const t = ly / layers;
        const size = Math.max(1.6, slabSize * (1 - t) + 1.6);
        const y = ly * 1.5 + size * 0.5;
        const col = ly > layers - 3 ? wallCols[3] : rockCols[mi % rockCols.length];
        pushFarCube(mx + farRng.range(-0.6, 0.6), y, mz + farRng.range(-0.6, 0.6), size, col);
        // Twin shoulder peaks on the big ones
        if (ly < layers * 0.5 && farRng.chance(0.5)) {
          const off = size * 0.55;
          pushFarCube(
            mx + farRng.choice([-off, off]),
            y - 1.5,
            mz + farRng.range(-off, off),
            size * 0.8,
            rockCols[(mi + 1) % rockCols.length],
          );
        }
        slabSize *= 0.86;
      }
    });

    // Two pyramids: stepped sandstone monuments on the diagonals.
    // One slab per course — big instanced cubes make the steps for free.
    const pyramidAngles = [2.55, 5.85];
    pyramidAngles.forEach((ang, pi) => {
      const dist = R0 + farRng.range(8, 13);
      const px0 = Math.cos(ang) * dist;
      const pz0 = Math.sin(ang) * dist;
      const courses = pi === 0 ? 8 : 6;
      const baseSize = pi === 0 ? 9 : 6;
      for (let ly = 0; ly < courses; ly++) {
        const size = Math.max(1.5, baseSize * (1 - ly / courses));
        const y = ly * 1.3 + size * 0.35;
        const col = ly % 2 === 0 ? 0xd8ab66 : 0xca9a52;
        pushFarCube(px0, y, pz0, size, col);
      }
      // Glowing capstone
      pushFarCube(px0, courses * 1.3 + 1, pz0, 1.1, CONFIG.PALETTES.portal.glow);
    });

    // Big boulders scattered in the mid-field
    for (let b = 0; b < 14; b++) {
      const ang = farRng.range(0, Math.PI * 2);
      const dist = R0 * farRng.range(0.86, 1.15);
      const bx = Math.cos(ang) * dist;
      const bz = Math.sin(ang) * dist;
      if (bz > R0 * 0.3 && Math.abs(bx) < 5) continue; // causeway clear
      const chunks = farRng.rangeInt(2, 4);
      for (let c = 0; c < chunks; c++) {
        pushFarCube(
          bx + farRng.range(-1.6, 1.6),
          farRng.range(0.4, 1.6),
          bz + farRng.range(-1.6, 1.6),
          farRng.range(1.1, 2.3),
          rockCols[farRng.rangeInt(0, 3)],
        );
      }
    }

    const farMesh = buildVoxelMesh(farVox, vSize, getBlockMaterial());
    farMesh.castShadow = false;
    farMesh.receiveShadow = false;
    this.dioramaGroup.add(farMesh);
  }

  /**
   * Build the 2D grid cells as Raised Terraces & Sunken Chambers
   */
  buildGrid() {
    this.cellViews.clear();
    this.reliefByCell.clear();
    const vSize = CONFIG.VOXEL_SIZE;
    const vPerCell = CONFIG.CELL_VOXELS;

    for (let y = 0; y < this.gameState.height; y++) {
      for (let x = 0; x < this.gameState.width; x++) {
        const cell = this.gameState.grid[y][x];
        const worldPos = this.gridToWorld(x, y);

        const cellGroup = new THREE.Group();
        cellGroup.position.set(worldPos.x, 0, worldPos.z);
        cellGroup.userData = { gridX: x, gridY: y };

        // 1. Excavated stone pathway: cobbled flagstones with per-stone tint
        //    jitter, worn cracks (missing stones over a dirt bed) and gravel
        const floorVoxels = [];
        const floorCols = CONFIG.PALETTES.floor;
        const floorGroove = floorCols[3];
        const halfC = (vPerCell - 1) / 2;
        const floorRng = new PRNG(`floor_${x}_${y}_${this.gameState.seed}`);
        const floorTint = new THREE.Color();
        const dirtCol = 0x5c4522;

        // Dirt bed sits under the whole footprint so cracks show earth
        for (let fx = 0; fx < vPerCell; fx++) {
          for (let fz = 0; fz < vPerCell; fz++) {
            if (fx === 0 || fx === vPerCell - 1 || fz === 0 || fz === vPerCell - 1) continue;
            floorVoxels.push({
              x: fx - halfC,
              y: -0.55,
              z: fz - halfC,
              color: dirtCol,
              scale: floorRng.range(0.85, 1),
            });
          }
        }

        // A couple of worn-away flagstones reveal the dirt bed
        const crackCount = floorRng.rangeInt(0, 2);
        const cracked = new Set();
        for (let i = 0; i < crackCount; i++) {
          const cxr = floorRng.rangeInt(1, vPerCell - 2);
          const czr = floorRng.rangeInt(1, vPerCell - 2);
          cracked.add(`${cxr},${czr}`);
          // cracks sometimes fork into a neighbour
          if (floorRng.chance(0.6)) {
            const nx = Math.min(vPerCell - 2, Math.max(1, cxr + floorRng.choice([-1, 1])));
            cracked.add(`${nx},${czr + floorRng.choice([-1, 0, 1])}`);
          }
        }

        for (let fx = 0; fx < vPerCell; fx++) {
          for (let fz = 0; fz < vPerCell; fz++) {
            const isBorder = fx === 0 || fx === vPerCell - 1 || fz === 0 || fz === vPerCell - 1;
            if (!isBorder && cracked.has(`${fx},${fz}`)) continue; // hole in path

            let col = isBorder ? floorGroove : floorCols[(cell.variation + fx * 3 + fz) % 3];
            // Per-stone weathering so slabs read individually laid
            floorTint.setHex(col);
            floorTint.multiplyScalar(isBorder ? 0.92 : floorRng.range(0.85, 1.12));
            col = floorTint.getHex();

            floorVoxels.push({
              x: fx - halfC,
              y: 0,
              z: fz - halfC,
              color: col,
              scale: isBorder ? 0.98 : floorRng.range(0.9, 0.98),
            });
          }
        }

        // Gravel sprinkled between slabs
        for (let g = 0; g < 3; g++) {
          floorVoxels.push({
            x: floorRng.range(-halfC, halfC),
            y: 0.3,
            z: floorRng.range(-halfC, halfC),
            color: floorRng.chance(0.5) ? dirtCol : floorCols[2],
            scale: floorRng.range(0.28, 0.42),
          });
        }
        const floorMesh = buildVoxelMesh(floorVoxels, vSize);
        cellGroup.add(floorMesh);

        // 2. Raised Sandstone Plateau (Undiscovered layers): golden crown face,
        //    darker sediment strata beneath, dark rim edge, per-cell relief so
        //    the untouched board reads as rolling dunes instead of a flat slab
        const terraceVoxels = [];
        const terraceCols = CONFIG.PALETTES.terrace;
        const jitterColor = new THREE.Color();
        const cellJitter = new PRNG(`top_${x}_${y}_${this.gameState.seed}`);

        // Dune relief: most cells at base height, some build up 1-2 extra
        // layers; ~10% of cells expose a buried stone ruin tip on top
        const reliefRoll = cellJitter.range(0, 1);
        const bonusLayers = reliefRoll > 0.9 ? 2 : reliefRoll > 0.62 ? 1 : 0;
        const hasRuinTip = cellJitter.chance(0.08);
        this.reliefByCell.set(`${x},${y}`, bonusLayers);

        for (let sx = 0; sx < vPerCell; sx++) {
          for (let sz = 0; sz < vPerCell; sz++) {
            const isTopEdge = sx === 0 || sx === vPerCell - 1 || sz === 0 || sz === vPerCell - 1;

            for (let sy = 1; sy <= CONFIG.SAND_LAYERS + bonusLayers; sy++) {
              // Crown layer picks a per-cell golden tone; lower layers are
              // darker strata so the block sides read as packed sediment
              let tCol =
                sy === CONFIG.SAND_LAYERS + bonusLayers
                  ? terraceCols[cell.variation % 2]
                  : sy % 2 === 0
                    ? terraceCols[1]
                    : terraceCols[2];

              if (isTopEdge && sy === CONFIG.SAND_LAYERS + bonusLayers) {
                tCol = terraceCols[4]; // dark rim outlines each plateau cell
              }

              // Very subtle brightness speckle on the crown — kept tight so
              // per-cube seams never read as a waffle grid up close
              if (sy >= CONFIG.SAND_LAYERS + bonusLayers - 1) {
                jitterColor.setHex(tCol);
                jitterColor.multiplyScalar(0.965 + cellJitter.range(0, 0.065));
                tCol = jitterColor.getHex();
              }

              terraceVoxels.push({
                x: sx - halfC,
                y: sy,
                z: sz - halfC,
                color: tCol,
                scale: sy === CONFIG.SAND_LAYERS + bonusLayers ? 1 : 0.98,
              });
            }
          }
        }

        // Buried ruin tip poking out of the sand crown, or smaller props:
        // pebbles, a dry sprout, an old bone — keeps plates from feeling empty
        const capY = CONFIG.SAND_LAYERS + bonusLayers;
        if (hasRuinTip) {
          const stoneCol = CONFIG.PALETTES.portal.stone;
          terraceVoxels.push({
            x: 0,
            y: capY + 0.75,
            z: 0,
            color: stoneCol,
            scale: vPerCell * 0.52,
          });
          terraceVoxels.push({
            x: halfC * 0.4,
            y: capY + 0.45,
            z: -halfC * 0.35,
            color: stoneCol,
            scale: vPerCell * 0.3,
          });
        } else {
          const propRoll = cellJitter.range(0, 1);
          if (propRoll > 0.9) {
            // Pebble cluster
            const pebbleCol = 0x8f8676;
            for (let p = 0; p < 3; p++) {
              terraceVoxels.push({
                x: cellJitter.range(-2, 2),
                y: capY + 0.55,
                z: cellJitter.range(-2, 2),
                color: p === 0 ? 0xa39a88 : pebbleCol,
                scale: cellJitter.range(0.7, 1.25),
              });
            }
          } else if (propRoll > 0.82) {
            // Dry sprout
            terraceVoxels.push({
              x: cellJitter.range(-1.5, 1.5),
              y: capY + 0.5,
              z: cellJitter.range(-1.5, 1.5),
              color: CONFIG.PALETTES.wall[2],
              scale: 0.8,
            });
            terraceVoxels.push({
              x: cellJitter.range(-1.5, 1.5),
              y: capY + 0.95,
              z: cellJitter.range(-1.5, 1.5),
              color: CONFIG.PALETTES.vegetation.cactusHighlight,
              scale: 0.65,
            });
          } else if (propRoll > 0.76) {
            // Old bone surfacing
            terraceVoxels.push({
              x: cellJitter.range(-1.8, 1.8),
              y: capY + 0.55,
              z: cellJitter.range(-1.8, 1.8),
              color: CONFIG.PALETTES.hazards.skullBone,
              scale: 1.15,
            });
          }
        }
        const terraceMesh = buildVoxelMesh(terraceVoxels, vSize);
        terraceMesh.name = 'terraceCover';
        cellGroup.add(terraceMesh);

        // 3. Survey Flag placeholder
        const flagVox = createFlag();
        const flagMesh = buildVoxelMesh(flagVox, vSize);
        flagMesh.name = 'flagMesh';
        flagMesh.position.set(0, (CONFIG.SAND_LAYERS + bonusLayers) * vSize, 0);
        flagMesh.visible = false;
        cellGroup.add(flagMesh);

        // 4. Excavated Content Holder (Number, Sunken Relic, or Sunken Trap Pit)
        const contentGroup = new THREE.Group();
        contentGroup.name = 'contentGroup';
        contentGroup.visible = false;
        cellGroup.add(contentGroup);

        this.gridGroup.add(cellGroup);

        this.cellViews.set(`${x},${y}`, {
          cell,
          group: cellGroup,
          floorMesh,
          terraceMesh,
          flagMesh,
          contentGroup,
          contentBuilt: false,
        });
      }
    }
  }

  /**
   * Lazily populate content (large numerals or sunken chamber rooms)
   */
  ensureContentBuilt(x, y) {
    const view = this.cellViews.get(`${x},${y}`);
    if (!view || view.contentBuilt) return;

    const cell = view.cell;
    const vSize = CONFIG.VOXEL_SIZE;

    // ZERO. Tomb Exit: sandstone archway with stairs descending into darkness
    if (cell.isExit) {
      // Hide flat floor so the stairwell reads as a real descent
      view.floorMesh.visible = false;

      const doorMesh = buildVoxelMesh(createTombStairsDoor(), vSize);
      view.contentGroup.add(doorMesh);

      const glowLight = new THREE.PointLight(0xffc766, 0, 6.5, 2);
      glowLight.position.set(0, 1.15 * (CONFIG.SAND_LAYERS + 2) * 0.6, 0);
      glowLight.userData.base = 4.8;
      glowLight.userData.phase = Math.random() * Math.PI * 2;
      this.scene.add(glowLight);
      this.flickerLights.push(glowLight);

      const wp = this.gridToWorld(x, y);
      glowLight.position.set(wp.x, 0.9, wp.z);
    }
    // A. Sunken Relic Chambers
    else if (cell.relicType) {
      // Hide flat floor to reveal deep sunken room
      view.floorMesh.visible = false;

      let relicChamberVox = [];
      if (cell.relicType === 'idol') {
        relicChamberVox = createGoldenIdolChamber({ _seed: `idol_${x}_${y}` });
      } else if (cell.relicType === 'amethyst') {
        relicChamberVox = createAmethystChamber({ _seed: `amethyst_${x}_${y}` });
      } else {
        relicChamberVox = createChestChamber({ _seed: `chest_${x}_${y}` });
      }
      // Sink the whole chamber further down for visible pit depth
      relicChamberVox = relicChamberVox.map((v) => ({ ...v, y: v.y - 1.9 }));
      // Dark earthen shaft rim so the pit reads as deep from any angle
      relicChamberVox.push(...createPitLiner());

      const chamberMesh = buildVoxelMesh(relicChamberVox, vSize);
      view.contentGroup.add(chamberMesh);

      // Shrine glow: the relic is a reward — light it like one
      const glowLight = new THREE.PointLight(0xffc766, 0, 6, 2);
      const wpGlow = this.gridToWorld(x, y);
      glowLight.position.set(wpGlow.x, 0.7, wpGlow.z);
      glowLight.userData.base = 4.0;
      glowLight.userData.phase = Math.random() * Math.PI * 2;
      this.scene.add(glowLight);
      this.flickerLights.push(glowLight);
    }
    // B. Sunken Trap / Hazard Pits
    else if (cell.isTrap) {
      view.floorMesh.visible = false;

      let trapPitVox = [];
      if (cell.hazardType === 'spider') {
        trapPitVox = createSpiderChamber({ _seed: `spider_${x}_${y}` });
      } else if (cell.hazardType === 'altar') {
        trapPitVox = createAltarSkullChamber({ _seed: `altar_${x}_${y}` });
      } else {
        trapPitVox = createScorpionPit({ _seed: `scorp_${x}_${y}` });
      }
      // Small details: bones & pottery shards scattered in most pits
      if (!cell.relicType && Math.abs((x * 7 + y * 13) % 10) < 6) {
        trapPitVox.push(...createBoneDecor({ seed: `bones_${x}_${y}` }));
      }
      // Sink the pit modestly — hazard stays near the lip so the shaft and
      // its contents are visible from the play camera
      trapPitVox = trapPitVox.map((v) => ({ ...v, y: v.y - 0.9 }));
      // Dark earthen shaft rim so the pit reads as deep from any angle
      trapPitVox.push(...createPitLiner());

      const trapMesh = buildVoxelMesh(trapPitVox, vSize);
      view.contentGroup.add(trapMesh);
    }
    // C. 3D Voxel Number standing on the limestone tile
    else if (cell.neighborTraps > 0) {
      const digitVox = createVoxelDigit(cell.neighborTraps);
      const digitMesh = buildVoxelMesh(digitVox, vSize);
      digitMesh.position.set(0, 0.04, 0);
      view.contentGroup.add(digitMesh);
    }

    view.contentBuilt = true;
  }

  revealCellView(x, y) {
    const view = this.cellViews.get(`${x},${y}`);
    if (!view) return;

    this.ensureContentBuilt(x, y);

    if (view.terraceMesh) view.terraceMesh.visible = false;
    if (view.flagMesh) view.flagMesh.visible = false;
    if (view.contentGroup) view.contentGroup.visible = true;
  }

  setFlagView(x, y, isFlagged) {
    const view = this.cellViews.get(`${x},${y}`);
    if (!view?.flagMesh) return;

    view.flagMesh.visible = isFlagged;
    if (isFlagged) {
      view.flagMesh.scale.set(0.1, 0.1, 0.1);
      let scale = 0.1;
      const anim = () => {
        scale += 0.2;
        if (scale >= 1) {
          view.flagMesh.scale.set(1, 1, 1);
        } else {
          view.flagMesh.scale.set(scale, scale, scale);
          requestAnimationFrame(anim);
        }
      };
      anim();
    }
  }

  showCompassArea(cells, count) {
    while (this.compassHighlightGroup.children.length > 0) {
      this.compassHighlightGroup.remove(this.compassHighlightGroup.children[0]);
    }

    const vSize = CONFIG.VOXEL_SIZE;
    const highlightBoxes = [];

    for (const c of cells) {
      const wp = this.gridToWorld(c.x, c.y);
      const boxGeo = new THREE.BoxGeometry(CONFIG.CELL_SIZE * 0.94, 0.2, CONFIG.CELL_SIZE * 0.94);
      const boxMat = new THREE.MeshBasicMaterial({
        color: count > 0 ? 0xffa500 : 0x22c55e,
        wireframe: true,
        transparent: true,
        opacity: 0.9,
      });
      const boxMesh = new THREE.Mesh(boxGeo, boxMat);
      boxMesh.position.set(wp.x, CONFIG.SAND_LAYERS * vSize + 0.1, wp.z);
      this.compassHighlightGroup.add(boxMesh);
      highlightBoxes.push(boxMesh);
    }

    setTimeout(() => {
      let opacity = 0.9;
      const fade = () => {
        opacity -= 0.05;
        if (opacity <= 0) {
          while (this.compassHighlightGroup.children.length > 0) {
            this.compassHighlightGroup.remove(this.compassHighlightGroup.children[0]);
          }
        } else {
          for (const b of highlightBoxes) {
            b.material.opacity = opacity;
          }
          requestAnimationFrame(fade);
        }
      };
      fade();
    }, 2000);
  }

  bindEvents() {
    window.addEventListener('resize', () => this.onResize());

    this.container.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.container.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mouseup', () => this.onMouseUp());
    this.container.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  onResize() {
    if (!this.renderer || !this.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  onMouseMove(e) {
    const rect = this.container.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    if (this.isDragging) {
      const deltaX = e.clientX - this.prevMouse.x;
      const deltaY = e.clientY - this.prevMouse.y;
      this.prevMouse = { x: e.clientX, y: e.clientY };
      this.dragDistance += Math.abs(deltaX) + Math.abs(deltaY);

      // Any-button drag orbits the diorama
      this.targetAngle -= deltaX * 0.006;
      const minPitch = 48 * (Math.PI / 180);
      const maxPitch = 74 * (Math.PI / 180);
      this.camPitch = Math.max(minPitch, Math.min(maxPitch, this.camPitch + deltaY * 0.004));
    }

    this.updateHover();
  }

  onMouseDown(e) {
    this.isDragging = true;
    this.prevMouse = { x: e.clientX, y: e.clientY };
    this.dragDistance = 0;
  }

  onMouseUp() {
    this.isDragging = false;
  }

  /**
   * True when the last mouse press turned into an orbit drag, so the click
   * should not also excavate a cell. Resets on each press.
   */
  wasDragGesture() {
    return this.dragDistance > 12;
  }

  /** Smoothly rotate the board by a step (keyboard / HUD affordance). */
  orbit(deltaAngle) {
    this.targetAngle += deltaAngle;
  }

  onWheel(e) {
    e.preventDefault();
    const zoomDelta = e.deltaY * 0.012;
    this.targetDistance = Math.max(
      CONFIG.CAMERA.minDistance,
      Math.min(CONFIG.CAMERA.maxDistance, this.targetDistance + zoomDelta),
    );
  }

  updateHover() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.gridGroup.children, true);

    if (intersects.length > 0) {
      let obj = intersects[0].object;
      while (obj.parent && obj.parent !== this.gridGroup) {
        obj = obj.parent;
      }

      if (obj?.userData?.gridX !== undefined) {
        const { gridX, gridY } = obj.userData;
        this.hoveredCell = { x: gridX, y: gridY };

        const wp = this.gridToWorld(gridX, gridY);
        const cell = this.gameState.getCell(gridX, gridY);
        const relief = this.reliefByCell.get(`${gridX},${gridY}`) || 0;
        const yOffset =
          cell?.state === CELL_STATE.COVERED
            ? (CONFIG.SAND_LAYERS + relief + 0.2) * CONFIG.VOXEL_SIZE
            : 0.2 * CONFIG.VOXEL_SIZE;

        this.hoverMesh.position.set(wp.x, yOffset, wp.z);
        this.hoverMesh.visible = true;
        return;
      }
    }

    this.hoveredCell = null;
    this.hoverMesh.visible = false;
  }

  getGridCoordinatesUnderPointer(clientX, clientY) {
    // The press turned into an orbit drag — don't treat it as a dig
    if (this.wasDragGesture()) return null;

    const rect = this.container.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const intersects = this.raycaster.intersectObjects(this.gridGroup.children, true);

    if (intersects.length > 0) {
      let obj = intersects[0].object;
      while (obj.parent && obj.parent !== this.gridGroup) {
        obj = obj.parent;
      }
      if (obj?.userData?.gridX !== undefined) {
        return { x: obj.userData.gridX, y: obj.userData.gridY };
      }
    }
    return null;
  }

  render(_time) {
    this.camDistance += (this.targetDistance - this.camDistance) * 0.12;
    this.camAngle += (this.targetAngle - this.camAngle) * 0.12;
    this.updateCameraTransform();

    // Torch flame flicker — layered sines so each light breathes on its own
    for (const light of this.flickerLights) {
      const { base, phase } = light.userData;
      const wobble =
        0.72 +
        0.2 * (0.5 + 0.5 * Math.sin(_time * 11 + phase)) +
        0.1 * (0.5 + 0.5 * Math.sin(_time * 29 + phase * 3));
      light.intensity = base * wobble;
    }

    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    if (this.renderer) {
      this.renderer.dispose();
    }
  }
}
