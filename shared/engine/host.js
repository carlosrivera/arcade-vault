// host.js — runs a game module and can swap it for a new one while the page
// stays put.
//
// The split matters: the host owns the canvas and the WebGL renderer, and a
// game owns everything built on top of them. Renderers are the reason. A
// browser keeps only a handful of WebGL contexts alive and silently drops the
// oldest when a new one is made -- creating a renderer per reload kills the
// game after a few edits. One renderer, many games.
//
// A game module is expected to export:
//
//   export function init(ctx) {
//     // ctx: { renderer, canvas, state }
//     return {
//       update(dt, elapsed) {},   // one frame
//       dispose() {},             // release everything init() acquired
//       getState() {},            // optional: carried into the next reload
//     };
//   }
//
// Nothing at module scope: a hot-swapped module is evaluated again, so any
// work done on import happens twice and cannot be undone.

import { importFresh } from '#engine/loader.js';
import { createLoop } from '#engine/loop.js';
import { createRenderer, handleResize } from '#engine/render.js';

export function createHost({ canvas, renderer: existingRenderer, ...rendererOptions } = {}) {
  // Reused for the life of the page — see the note above about contexts.
  const renderer = existingRenderer ?? createRenderer(canvas, rendererOptions);
  let instance = null;
  let entry = null;
  let loop = null;
  let carried = null;

  const stopResize = handleResize(renderer, null, {
    setSize: (w, h) => instance?.resize?.(w, h),
  });

  async function start(entryUrl, { state = null, overrides } = {}) {
    entry = entryUrl ?? entry;
    const { module } = await importFresh(entry, { overrides });
    if (typeof module.init !== 'function') {
      throw new Error(`${entry} does not export init(ctx) — see host.js for the contract`);
    }
    instance = module.init({ renderer, canvas, state });
    loop ??= createLoop((dt, elapsed) => instance?.update?.(dt, elapsed));
    return instance;
  }

  function teardown() {
    try {
      carried = instance?.getState?.() ?? carried;
    } catch {
      // A game mid-failure should still be disposable; keep the previous state.
    }
    instance?.dispose?.();
    instance = null;
  }

  return {
    renderer,

    /** Load and run a game. */
    mount: (entryUrl, options) => start(entryUrl, options),

    /**
     * Swap in the current source without a page refresh.
     *
     * State from getState() is handed to the new init(), so a seeded world can
     * come back exactly as it was rather than restarting.
     *
     * @param {object} [options]
     * @param {Record<string,string>} [options.overrides] url -> source, to run
     *   edits held in memory rather than written to disk
     */
    async reload({ overrides } = {}) {
      teardown();
      const { module } = await importFresh(entry, { overrides });
      if (typeof module.init !== 'function') {
        throw new Error(`${entry} no longer exports init(ctx)`);
      }
      instance = module.init({ renderer, canvas, state: carried });
      return instance;
    },

    /** Current game instance, or null between swaps. */
    get game() {
      return instance;
    },

    dispose() {
      loop?.stop();
      loop = null;
      teardown();
      stopResize();
      renderer.dispose();
    },
  };
}
