// loader.js — load a module graph from source, so a running page can swap code.
//
// The browser caches ES modules by URL permanently: once './main.js' is
// imported, that exact URL can never yield different code again. Appending a
// query token sidesteps it, but only for the file you name -- its own imports
// still resolve to the cached originals, so a game would reload its entry
// against nine stale siblings.
//
// So this walks the graph itself: fetch each module, rewrite its *relative*
// specifiers to point at Blob URLs of the modules it depends on, and import
// the entry. Every module in the graph is therefore new.
//
// Bare specifiers ('three', 'three/addons/', '#engine/') are deliberately left
// alone. They resolve through the page's import map, so the engine and three
// stay shared and cached -- only game code is rebuilt.
//
// Because sources are supplied as text, they need not exist on disk. Passing
// `overrides` runs code straight from memory, which is how an assistant's edit
// can take effect without a file write or a build.

const SPECIFIER = /(\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g;

const isRelative = (s) => s.startsWith('./') || s.startsWith('../') || s.startsWith('/');

/**
 * Build a module graph and return the entry's Blob URL, ready to import().
 *
 * @param {string} entryUrl absolute or page-relative URL of the entry module
 * @param {object} [options]
 * @param {Record<string,string>} [options.overrides] url -> source, to run code
 *   that is not on disk (or not yet saved)
 * @returns {Promise<{url: string, urls: string[], modules: string[]}>}
 *   `urls` are Blob URLs to revoke once the import settles.
 */
export async function buildModuleGraph(entryUrl, { overrides = {} } = {}) {
  const built = new Map(); // resolved url -> blob url
  const inProgress = new Set();
  const urls = [];
  const modules = [];

  async function build(url) {
    const resolved = new URL(url, location.href).href;
    if (built.has(resolved)) return built.get(resolved);
    if (inProgress.has(resolved)) {
      // Rewriting to Blob URLs requires each dependency's URL before its
      // dependent is built, which a cycle makes impossible. Report it rather
      // than deadlock or silently drop an edge.
      throw new Error(`Import cycle through ${resolved} — cannot hot-load a cyclic graph`);
    }
    inProgress.add(resolved);

    const key = new URL(resolved).pathname;
    let source = overrides[resolved] ?? overrides[key];
    if (source === undefined) {
      const res = await fetch(resolved, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status} loading ${resolved}`);
      source = await res.text();
    }

    // Depth-first: a dependency's Blob URL must exist before it can be
    // substituted into the dependent's source.
    const deps = new Map();
    for (const [, , , spec] of source.matchAll(SPECIFIER)) {
      if (!isRelative(spec) || deps.has(spec)) continue;
      deps.set(spec, await build(new URL(spec, resolved).href));
    }

    const rewritten = source.replace(SPECIFIER, (match, kw, quote, spec) =>
      deps.has(spec) ? `${kw}${quote}${deps.get(spec)}${quote}` : match,
    );

    const blobUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
    built.set(resolved, blobUrl);
    inProgress.delete(resolved);
    urls.push(blobUrl);
    modules.push(resolved);
    return blobUrl;
  }

  const url = await build(entryUrl);
  return { url, urls, modules };
}

/**
 * Import a fresh copy of a module graph.
 *
 * Blob URLs are revoked once the import settles: the graph is already
 * instantiated by then, and leaving them alive would retain every source
 * string of every reload.
 */
export async function importFresh(entryUrl, options) {
  const { url, urls, modules } = await buildModuleGraph(entryUrl, options);
  try {
    const module = await import(/* @vite-ignore */ url);
    return { module, modules };
  } finally {
    for (const u of urls) URL.revokeObjectURL(u);
  }
}
