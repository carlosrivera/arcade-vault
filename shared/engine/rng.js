// rng.js — seeded, deterministic pseudo-randomness.
//
// Every generator here is pure and reproducible: the same seed always yields
// the same sequence, which is what makes procedural worlds re-visitable and
// bakes (see games/aces/tools/bake_radar.js) byte-stable across runs.

/**
 * Mulberry32. Returns a function producing floats in [0, 1).
 *
 * The `| 0` on the accumulator matters: without it the state grows as a float
 * and loses integer precision once it passes 2^53, at which point the sequence
 * silently stops matching. Wrapping to int32 each step keeps it exact forever.
 */
export function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit integer hash of a string, for turning human-readable seeds into ints. */
export function hashString(str) {
  let hash = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(hash ^ str.charCodeAt(i), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return hash >>> 0 || 1;
}

/** Stateful generator over mulberry32 with the sampling helpers games want. */
export class PRNG {
  constructor(seed = 'seed') {
    this.seedStr = String(seed);
    this.state = hashString(this.seedStr);
  }

  /**
   * Float in [0, 1). Same step as mulberry32() above, written out rather than
   * delegating so `state` stays observable — fork() derives from it.
   */
  next() {
    const a = (this.state + 0x6d2b79f5) | 0;
    this.state = a;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max], both inclusive. */
  rangeInt(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /** Uniform pick, or null for an empty/missing array. */
  choice(array) {
    if (!array || array.length === 0) return null;
    return array[Math.floor(this.next() * array.length)];
  }

  /** True with the given probability in [0, 1]. */
  chance(probability) {
    return this.next() < probability;
  }

  /** In-place Fisher-Yates. */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /** Independent sub-generator, so one system's draws can't shift another's. */
  fork(tag = '') {
    return new PRNG(`${this.seedStr}_${tag}_${this.state}`);
  }
}
