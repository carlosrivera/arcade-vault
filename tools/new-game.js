// new-game.js — scaffold a game that is hot-reloadable from the first commit.
//
// Every game page carries the same 22 head tags, the same import map, the
// same eject script and the same boot call. Reproducing that by hand is where
// they drift: gravpulse once resolved three by a relative path while the other
// two used the bare specifier, and nothing failed loudly.
//
// Usage: node tools/new-game.js <id> [--title "NAME"] [--genre "..."]
//
// Writes games/<id>/{index.html,src/main.js} and adds an entry to games.json.
// The generated main.js exports init(ctx) -> { update, dispose } so the game
// can be swapped in a running page; see shared/engine/host.js.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = 'https://carlosrivera.github.io/arcade-vault';

const escapeAttr = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function parseArgs(argv) {
  const [id, ...rest] = argv;
  const opts = { id };
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i]?.startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1];
  }
  return opts;
}

const INDEX_HTML = ({ title, subtitle, description }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>

<!-- Metadata is generated from games.json — run tools/sync-meta.js after editing it. -->
<!-- meta:start -->
<!-- meta:end -->

<style>
  html, body { margin: 0; height: 100%; background: #06070a; overflow: hidden; }
  canvas { display: block; width: 100%; height: 100%; }
  #menu {
    position: fixed; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 12px; z-index: 50;
    color: #e8ecf4; font-family: ui-monospace, Menlo, monospace; text-align: center;
    background: radial-gradient(ellipse at center, #101725 0%, #06070a 70%);
  }
  #menu.hidden { display: none; }
  #menu h1 { font-size: clamp(28px, 7vw, 64px); letter-spacing: 0.14em; margin: 0; }
  #menu p { opacity: 0.7; margin: 0; }
  #startBtn {
    margin-top: 18px; padding: 12px 28px; cursor: pointer;
    background: #7fd6ff; color: #06070a; border: 0; border-radius: 2px;
    font: inherit; font-weight: 700; letter-spacing: 0.18em;
  }
</style>
</head>
<body>
<canvas id="gl"></canvas>

<div id="menu">
  <h1>${title}</h1>
  <p>${subtitle}</p>
  <p>${description}</p>
  <button id="startBtn" type="button">START</button>
</div>

<script type="importmap">
{
  "imports": {
    "three": "../../shared/vendor/three.module.js",
    "three/addons/": "../../shared/vendor/jsm/",
    "#engine/": "../../shared/engine/"
  }
}
</script>
<script type="module" src="../../shared/eject.js"></script>
<script type="module">
  // Booted through the shared host so the game can be hot-swapped in place;
  // see shared/engine/boot.js.
  import { boot } from '#engine/boot.js';
  boot({ entry: './src/main.js', maxPixelRatio: 2 });
</script>
</body>
</html>
`;

const MAIN_JS = ({ title }) => `// main.js — ${title}
//
// Exports init(ctx) rather than running at module scope, so shared/engine's
// host can swap this module in a live page. Anything created on import would
// run again on every reload with no handle to tear it down.

import * as THREE from 'three';
import { damp } from '#engine/math.js';
import { Keyboard } from '#engine/input.js';
import { PRNG } from '#engine/rng.js';

/**
 * @param {object} ctx
 * @param {THREE.WebGLRenderer} ctx.renderer  owned by the host, spans reloads
 * @param {HTMLCanvasElement} ctx.canvas
 * @param {object|null} ctx.state             whatever the last getState() returned
 */
export function init({ renderer, state }) {
  // A carried seed rebuilds the same world after a hot reload.
  const seed = state?.seed ?? \`\${Date.now()}\`;
  const rng = new PRNG(seed);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06070a);
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 2, 6);

  scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x20160c, 1.1));
  const key = new THREE.DirectionalLight(0xfff2dd, 1.4);
  key.position.set(4, 8, 5);
  scene.add(key);

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ color: rng.choice([0x7fd6ff, 0xff8fd0, 0x9dff2f]) }),
  );
  scene.add(cube);

  const keys = new Keyboard();
  const menu = document.getElementById('menu');
  // Resume where the previous instance left off, so a hot reload mid-play does
  // not drop the player back to the menu.
  let running = state?.running ?? false;

  const unbind = [];
  const on = (target, type, handler) => {
    if (!target) return;
    target.addEventListener(type, handler);
    unbind.push(() => target.removeEventListener(type, handler));
  };

  on(document.getElementById('startBtn'), 'click', () => {
    running = true;
    menu.classList.add('hidden');
  });

  // The DOM outlives a hot swap, so put the menu back in sync with this
  // instance rather than trusting whatever the previous one left behind.
  menu.classList.toggle('hidden', running);

  let spin = 0;
  return {
    update(dt) {
      const target = running ? 1.2 + keys.axis('ArrowLeft', 'ArrowRight') : 0.15;
      spin = damp(spin, target, 3, dt);
      cube.rotation.y += spin * dt;
      cube.rotation.x += spin * 0.4 * dt;
      renderer.render(scene, camera);
    },

    /** Carried into the next init() so a reload resumes rather than restarts. */
    getState() {
      return { seed, running };
    },

    dispose() {
      for (const off of unbind) off();
      keys.dispose();
      // GPU memory is not garbage collected — without this every reload leaks.
      scene.traverse((obj) => {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material)
          ? obj.material
          : obj.material
            ? [obj.material]
            : [];
        for (const m of mats) {
          for (const k of Object.keys(m)) m[k]?.isTexture && m[k].dispose();
          m.dispose();
        }
      });
      scene.clear();
    },
  };
}
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.id || !/^[a-z][a-z0-9-]*$/.test(opts.id)) {
    console.error('usage: node tools/new-game.js <id> [--title "NAME"] [--genre "..."]');
    console.error('  <id> must be lowercase letters, digits and dashes.');
    process.exit(1);
  }

  const dir = path.join(ROOT, 'games', opts.id);
  if (fs.existsSync(dir)) {
    console.error(`games/${opts.id} already exists — refusing to overwrite.`);
    process.exit(1);
  }

  const entry = {
    id: opts.id,
    title: opts.title ?? opts.id.toUpperCase(),
    subtitle: opts.subtitle ?? 'A new experiment',
    genre: opts.genre ?? '3D Arcade',
    players: opts.players ?? '1P',
    llm: opts.llm ?? 'Claude',
    author: opts.author ?? 'LLM Game Vault',
    description: opts.description ?? 'A vanilla web game with zero build step.',
    thumbnail: `games/${opts.id}/assets/thumb.png`,
    path: `games/${opts.id}/index.html`,
    tags: (opts.tags ?? 'threejs,vanilla').split(','),
    style: opts.style ?? 'arcade',
  };

  // sync-meta.js renders this verbatim into the page's <head>. It lives in
  // games.json so the description exists in exactly one place; edit it here,
  // then run sync-meta.js.
  const url = `${SITE}/${entry.path}`;
  entry.seo = {
    tags: [
      `<meta name="description" content="${escapeAttr(entry.description)}">`,
      `<meta name="author" content="${escapeAttr(entry.author)}">`,
      '<meta name="robots" content="index, follow, max-image-preview:large">',
      '<meta name="theme-color" content="#06070a">',
      `<link rel="canonical" href="${url}">`,
      '<link rel="icon" href="../../assets/favicon.svg" type="image/svg+xml">',
      '<link rel="apple-touch-icon" href="../../assets/apple-touch-icon.png">',
      '<link rel="manifest" href="../../site.webmanifest">',
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="Arcade Vault">',
      '<meta property="og:locale" content="en_US">',
      `<meta property="og:title" content="${escapeAttr(entry.title)} — ${escapeAttr(entry.subtitle)}">`,
      `<meta property="og:description" content="${escapeAttr(entry.description)}">`,
      `<meta property="og:url" content="${url}">`,
      '<meta property="og:image" content="../../assets/og-card.png">',
      '<meta property="og:image:alt" content="Arcade Vault game gallery">',
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:title" content="${escapeAttr(entry.title)} — ${escapeAttr(entry.subtitle)}">`,
      `<meta name="twitter:description" content="${escapeAttr(entry.description)}">`,
      '<meta name="twitter:image" content="../../assets/og-card.png">',
    ],
    scripts: [],
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'VideoGame',
      name: entry.title,
      url,
      description: entry.description,
      image: `${SITE}/assets/og-card.png`,
      author: { '@type': 'Person', name: entry.author },
      applicationCategory: 'Game',
      operatingSystem: 'Any (Web Browser)',
      genre: entry.genre,
      playMode: 'SinglePlayer',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  };

  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML(entry));
  fs.writeFileSync(path.join(dir, 'src', 'main.js'), MAIN_JS(entry));

  const gamesPath = path.join(ROOT, 'games.json');
  const games = JSON.parse(fs.readFileSync(gamesPath, 'utf8'));
  games.push(entry);
  fs.writeFileSync(gamesPath, `${JSON.stringify(games, null, 2)}\n`);

  console.log(`created games/${opts.id}/`);
  console.log(`  index.html   shell, import map, boot`);
  console.log(`  src/main.js  init(ctx) -> { update, dispose, getState }`);
  console.log(`added "${entry.title}" to games.json`);

  // Write the <head> block immediately: leaving it as a manual follow-up means
  // the page ships with empty markers and sync-meta --check fails in CI.
  execFileSync(process.execPath, [path.join(import.meta.dirname, 'sync-meta.js')], {
    stdio: 'inherit',
  });
  console.log(`\nrun it:  http://localhost:8080/games/${opts.id}/index.html`);
}

main();
