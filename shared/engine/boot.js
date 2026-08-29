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
 * Loopback only.
 *
 * The chat panel can rewrite the code of a running game, so it is a
 * development tool. Gating on the origin means a deployed page never ships
 * the editing surface at all — there is nothing to disable or authenticate.
 */
function isLocal() {
  const { hostname, protocol } = location;
  if (protocol === 'file:') return true;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * @param {object} options
 * @param {string} options.entry       game entry module, e.g. './src/main.js'
 * @param {string} [options.canvas]    id of the canvas element
 * @param {string[]} [options.sources] modules the chat panel may rewrite;
 *   defaults to the entry alone
 * @param {object} [options.renderer]  options forwarded to createRenderer
 */
export async function boot({ entry, canvas = 'gl', sources, ...rendererOptions }) {
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

  if (isLocal()) {
    // Imported lazily so the panel and its store are never fetched by a
    // deployed page, not merely left unmounted.
    const [{ mountChat }] = await Promise.all([import('#engine/chat.js')]);
    const gameId = new URL(entryUrl).pathname.split('/')[2] ?? 'game';
    mountChat({
      game: window.__game,
      gameId,
      sources: (sources ?? [entry]).map((p) => new URL(p, document.baseURI).pathname),
    });
  }

  return window.__game;
}
