// feel.js — the small timing tricks that make an impact land.
//
// A hit that merely subtracts health reads as a spreadsheet. Three cheap
// effects do most of the work of making it read as a hit:
//
//   hitstop  — freeze everything for a few dozen milliseconds on contact.
//              The pause is what the player reads as force; without it a
//              collision is just two objects continuing at new velocities.
//   shake    — displace the camera briefly, decaying.
//   slow-mo  — stretch time for a moment on something big.
//
// All three are time manipulation, so they live together and act on the one
// value every system already respects: dt. A game asks for an effect and keeps
// integrating as usual.

import { damp } from '#engine/math.js';

/**
 * @param {object} [options]
 * @param {number} [options.maxFreeze=0.25] ceiling on a single hitstop, seconds.
 *   A bug that requests a huge freeze should cost a visible stutter, not a
 *   hung game.
 */
export function createFeel({ maxFreeze = 0.25 } = {}) {
  let freeze = 0; // seconds of simulation still frozen
  let shake = 0; // current amplitude, world units
  let shakeDecay = 6; // per-second decay rate
  let scale = 1; // current time scale
  let scaleTarget = 1;
  let scaleRecover = 2.5; // how fast time returns to normal

  const offset = { x: 0, y: 0, z: 0 };

  return {
    /**
     * Freeze the simulation briefly. Call on impact, before applying damage.
     *
     * Typical values: 0.03 for a bullet, 0.08 for a missile, 0.15 for a crash.
     * Past ~0.2 it stops reading as impact and starts reading as a hitch.
     */
    hitstop(seconds = 0.06) {
      freeze = Math.min(maxFreeze, Math.max(freeze, seconds));
    },

    /**
     * Shake the camera.
     *
     * @param {number} amplitude world units of displacement at peak
     * @param {number} [decay] per-second falloff; lower lingers longer
     */
    shake(amplitude = 0.4, decay = 6) {
      shake = Math.max(shake, amplitude);
      shakeDecay = decay;
    },

    /**
     * Stretch time. `scale` below 1 is slow motion; it eases back to normal.
     * Unlike hitstop this still advances the world, so animations keep playing.
     */
    timeScale(target = 0.35, recover = 2.5) {
      scaleTarget = target;
      scaleRecover = recover;
      scale = target;
    },

    /**
     * Convert a real frame delta into the delta the game should integrate.
     * Call once per frame, before updating anything.
     *
     * Returns 0 while frozen — every system that already respects dt stops
     * without knowing hitstop exists.
     */
    step(dt) {
      if (freeze > 0) {
        freeze -= dt;
        // Shake keeps decaying during a freeze, so a hit reads as a jolt that
        // is already settling when motion resumes rather than starting after.
        shake = Math.max(0, shake - shakeDecay * dt);
        this._updateOffset();
        return 0;
      }
      shake = Math.max(0, shake - shakeDecay * dt);
      this._updateOffset();
      if (scale !== scaleTarget || scale !== 1) {
        scale = damp(scale, 1, scaleRecover, dt);
        if (Math.abs(1 - scale) < 0.01) scale = 1;
      }
      return dt * scale;
    },

    /** @private */
    _updateOffset() {
      if (shake <= 0) {
        offset.x = offset.y = offset.z = 0;
        return;
      }
      // Fresh random per axis each frame: smoothed noise reads as a wobble,
      // where a hit should read as a jolt.
      offset.x = (Math.random() * 2 - 1) * shake;
      offset.y = (Math.random() * 2 - 1) * shake;
      offset.z = (Math.random() * 2 - 1) * shake * 0.4;
    },

    /**
     * Current camera displacement. Add to the camera position AFTER the
     * camera has been positioned for the frame, so the shake is not smoothed
     * away by whatever follow logic the game uses.
     */
    get offset() {
      return offset;
    },

    /** True while the simulation is frozen — handy for skipping input. */
    get frozen() {
      return freeze > 0;
    },

    /** Cancel everything. Call from dispose(), or when returning to a menu. */
    reset() {
      freeze = 0;
      shake = 0;
      scale = 1;
      scaleTarget = 1;
      offset.x = offset.y = offset.z = 0;
    },
  };
}
