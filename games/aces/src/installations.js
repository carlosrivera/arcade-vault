// installations.js — things on the ground worth flying to.
//
// The terrain was 400km of scenery: beautiful, and irrelevant to play. Ground
// installations give it a job. Because heightAt() is a pure function of
// position, sites can be placed deterministically from the same seed as the
// landscape — no storage, no spawn bookkeeping, and the same world every
// session.
//
// Sites are built lazily as the player approaches and released when they fall
// behind, mirroring how Terrain streams its chunks.

import * as THREE from 'three';
import { mulberry32 } from '#engine/rng.js';
import { terrainHeightAt } from './terrain.js';

const SITE_SEED = 0x5a17e;
const GRID = 26000; // metres between candidate sites
const BUILD_RADIUS = 90000; // build within this range of the player
const DROP_RADIUS = 120000; // release beyond this
const MIN_ALTITUDE = 30; // skip candidates that land in the sea

const SHARED = {
  base: new THREE.MeshStandardMaterial({ color: 0x6b7059, roughness: 0.9, metalness: 0.05 }),
  tower: new THREE.MeshStandardMaterial({ color: 0x8a8f78, roughness: 0.85 }),
  dish: new THREE.MeshStandardMaterial({ color: 0xb9c0a8, roughness: 0.6, metalness: 0.2 }),
  dead: new THREE.MeshStandardMaterial({ color: 0x2a2a28, roughness: 1 }),
};

/** One radar/SAM site: a pad, a mast and a dish, sized to read from the air. */
function buildSite(x, z, groundY, rand) {
  const group = new THREE.Group();
  group.position.set(x, groundY, z);
  group.rotation.y = rand() * Math.PI * 2;

  const pad = new THREE.Mesh(new THREE.CylinderGeometry(380, 430, 60, 12), SHARED.base);
  pad.position.y = 30;
  group.add(pad);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(34, 48, 520, 8), SHARED.tower);
  mast.position.y = 290;
  group.add(mast);

  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(180, 14, 10, 0, Math.PI * 2, 0, 1.1),
    SHARED.dish,
  );
  dish.position.y = 570;
  dish.rotation.x = -0.5;
  group.add(dish);

  // Outbuildings, so a site reads as a place rather than a prop.
  for (let i = 0; i < 3; i++) {
    const shed = new THREE.Mesh(new THREE.BoxGeometry(230, 110, 160), SHARED.base);
    const a = rand() * Math.PI * 2;
    shed.position.set(Math.cos(a) * 680, 55, Math.sin(a) * 680);
    shed.rotation.y = rand() * Math.PI;
    group.add(shed);
  }
  return { group, dish, mast };
}

export class Installations {
  /**
   * @param {THREE.Scene} scene
   * @param {(position: THREE.Vector3, scale: number) => void} onDestroyed
   *   called so the game can spawn its own explosion and score the kill
   */
  constructor(scene, onDestroyed) {
    this.scene = scene;
    this.onDestroyed = onDestroyed;
    this.sites = new Map(); // "gx,gz" -> site
    this.destroyed = new Set(); // keys, so a wreck stays wrecked when restreamed
  }

  /** Build nearby sites, release distant ones. Cheap enough to call per frame. */
  update(playerPos) {
    const gx0 = Math.round(playerPos.x / GRID);
    const gz0 = Math.round(playerPos.z / GRID);
    const span = Math.ceil(BUILD_RADIUS / GRID);

    for (let gz = gz0 - span; gz <= gz0 + span; gz++) {
      for (let gx = gx0 - span; gx <= gx0 + span; gx++) {
        const key = `${gx},${gz}`;
        if (this.sites.has(key)) continue;

        // One generator per cell, seeded by the cell itself: whether a site
        // exists here, and what it looks like, is the same every session and
        // independent of the order cells are visited.
        const rand = mulberry32(SITE_SEED ^ (gx * 73856093) ^ (gz * 19349663));
        if (rand() > 0.45) continue; // not every cell has one

        const x = gx * GRID + (rand() - 0.5) * GRID * 0.6;
        const z = gz * GRID + (rand() - 0.5) * GRID * 0.6;
        const groundY = terrainHeightAt(x, z);
        if (groundY < MIN_ALTITUDE) continue; // in the water

        if (Math.hypot(x - playerPos.x, z - playerPos.z) > BUILD_RADIUS) continue;

        const built = buildSite(x, z, groundY, rand);
        if (this.destroyed.has(key)) this._wreck(built);
        this.scene.add(built.group);
        this.sites.set(key, {
          ...built,
          key,
          pos: new THREE.Vector3(x, groundY + 300, z),
          hp: this.destroyed.has(key) ? 0 : 100,
          alive: !this.destroyed.has(key),
        });
      }
    }

    for (const [key, site] of this.sites) {
      if (Math.hypot(site.pos.x - playerPos.x, site.pos.z - playerPos.z) < DROP_RADIUS) continue;
      this.scene.remove(site.group);
      this.sites.delete(key);
    }
  }

  /** @private turn a site into a burnt-out version of itself */
  _wreck(site) {
    site.dish.visible = false;
    site.mast.material = SHARED.dead;
    site.mast.rotation.z = 0.6; // toppled
    site.mast.position.y = 160;
  }

  /**
   * Apply damage to any site within `radius` of a point.
   * @returns {boolean} true if something was hit
   */
  damageAt(point, damage, radius = 620) {
    let hit = false;
    for (const site of this.sites.values()) {
      if (!site.alive) continue;
      const dx = site.pos.x - point.x;
      const dz = site.pos.z - point.z;
      const dy = site.pos.y - point.y;
      if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      hit = true;
      site.hp -= damage;
      if (site.hp <= 0) {
        site.alive = false;
        this.destroyed.add(site.key);
        this._wreck(site);
        this.onDestroyed?.(site.pos, 2.4);
      }
    }
    return hit;
  }

  /** Nearest live site, for HUD cueing. */
  nearest(from, maxRange = Number.POSITIVE_INFINITY) {
    let best = null;
    let bestDist = maxRange;
    for (const site of this.sites.values()) {
      if (!site.alive) continue;
      const d = Math.hypot(site.pos.x - from.x, site.pos.z - from.z);
      if (d < bestDist) {
        bestDist = d;
        best = site;
      }
    }
    return best ? { site: best, distance: bestDist } : null;
  }

  dispose() {
    for (const site of this.sites.values()) this.scene.remove(site.group);
    this.sites.clear();
  }
}
