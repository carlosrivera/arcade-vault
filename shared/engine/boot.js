// boot.js — the one script a game page loads.
//
// Creates the host, mounts the game, and exposes it as window.__game so a
// chat panel (or the console) can hot-swap code without a refresh:
//
//   await __game.reload()                       // re-read from disk
//   await __game.reload({ overrides: { ... } }) // run edits held in memory
//
// The host and its WebGL context belong to this module and survive every
// swap; only the game's own modules are rebuilt.

import { createHost } from '#engine/host.js';

/**
 * @param {object} options
 * @param {string} options.entry       game entry module, e.g. './src/main.js'
 * @param {string} [options.canvas]    id of the canvas element
 * @param {object} [options.renderer]  options forwarded to createRenderer
 */
export async function boot({ entry, canvas = 'gl', ...rendererOptions }) {
  const el = document.getElementById(canvas);
  if (!el) throw new Error(`boot: no canvas #${canvas}`);

  const host = createHost({ canvas: el, ...rendererOptions });
  const entryUrl = new URL(entry, document.baseURI).href;
  await host.mount(entryUrl);

  window.__game = {
    host,
    entry: entryUrl,
    /** Swap in current source (or `overrides`) with the world carried over. */
    reload: (options) => host.reload(options),
  };
  return window.__game;
}
