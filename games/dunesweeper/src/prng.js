/**
 * DUNESWEEPER - Seeded Pseudo-Random Number Generator
 * Deterministic generation for repeatable expeditions and daily seeds
 */

export class PRNG {
  constructor(seed = 'expedition_001') {
    this.seedStr = String(seed);
    this.state = PRNG.hashString(this.seedStr);
  }

  /**
   * 32-bit integer hash of a string
   */
  static hashString(str) {
    let hash = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      hash = Math.imul(hash ^ str.charCodeAt(i), 3432918353);
      hash = (hash << 13) | (hash >>> 19);
    }
    return hash >>> 0 || 1;
  }

  /**
   * Mulberry32 algorithm: returns float in [0, 1)
   */
  next() {
    this.state += 0x6d2b79f5;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Random float between min (inclusive) and max (exclusive)
   */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /**
   * Random integer between min (inclusive) and max (inclusive)
   */
  rangeInt(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /**
   * Pick random item from an array
   */
  choice(array) {
    if (!array || array.length === 0) return null;
    return array[Math.floor(this.next() * array.length)];
  }

  /**
   * Returns true with given probability [0..1]
   */
  chance(probability) {
    return this.next() < probability;
  }

  /**
   * In-place Fisher-Yates shuffle
   */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * Fork a sub-generator with a combined seed tag
   */
  fork(tag = '') {
    return new PRNG(`${this.seedStr}_${tag}_${this.state}`);
  }
}
