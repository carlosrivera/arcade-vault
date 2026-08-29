// loop.js — the requestAnimationFrame driver.

/**
 * Run `update(dt, elapsed)` once per animation frame, with dt in seconds.
 *
 * dt is clamped to `maxDt`. Without that clamp, a tab left in the background
 * returns with a multi-second delta, and every integrator in the game takes
 * one enormous step: ships tunnel through walls, physics explodes. Capping it
 * makes a long stall look like a brief slowdown instead.
 *
 * @param {(dt: number, elapsed: number) => void} update
 * @param {object} [options]
 * @param {number} [options.maxDt=0.05] longest step to report, in seconds
 * @returns {{stop: () => void, start: () => void, paused: boolean}}
 */
export function createLoop(update, { maxDt = 0.05 } = {}) {
  let frame = null;
  let previous = 0;
  let elapsed = 0;

  const handle = {
    paused: false,
    start() {
      if (frame !== null) return;
      previous = performance.now() / 1000;
      frame = requestAnimationFrame(tick);
    },
    stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };

  function tick() {
    frame = requestAnimationFrame(tick);
    const now = performance.now() / 1000;
    let dt = Math.min(now - previous, maxDt);
    previous = now;
    if (handle.paused) dt = 0;
    elapsed += dt;
    update(dt, elapsed);
  }

  handle.start();
  return handle;
}
