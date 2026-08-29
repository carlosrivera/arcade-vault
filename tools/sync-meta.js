// sync-meta.js — regenerate each game page's <head> metadata from games.json.
//
// All 22 head tags on a game page are structurally identical across games;
// only the values differ. Keeping them by hand means the same description
// lives in five places and drifts in four of them. games.json is the source of
// truth, and this writes the derived tags into each page between the
// meta:start / meta:end markers.
//
// The tags stay *static in the HTML* rather than being injected at runtime,
// because crawlers and link unfurlers read the served markup.
//
// Usage: node tools/sync-meta.js [--check]
//   --check  exit non-zero if any page is stale, without writing (for CI)

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SITE = 'https://carlosrivera.github.io/arcade-vault';
const START = '<!-- meta:start -->';
const END = '<!-- meta:end -->';

const escape = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function renderMeta(game) {
  const url = `${SITE}/${game.path}`;
  const image = `${SITE}/assets/og-card.png`;
  const title = `${game.title} — ${game.subtitle}`;
  const tags = [
    ['meta', { name: 'description', content: game.description }],
    ['meta', { name: 'author', content: game.author }],
    ['meta', { name: 'robots', content: 'index,follow' }],
    ['meta', { name: 'theme-color', content: '#06070a' }],
    ['meta', { name: 'keywords', content: (game.tags ?? []).join(', ') }],

    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Arcade Vault' }],
    ['meta', { property: 'og:title', content: title }],
    ['meta', { property: 'og:description', content: game.description }],
    ['meta', { property: 'og:url', content: url }],
    ['meta', { property: 'og:image', content: image }],

    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: title }],
    ['meta', { name: 'twitter:description', content: game.description }],
    ['meta', { name: 'twitter:image', content: image }],

    ['link', { rel: 'canonical', href: url }],
    ['link', { rel: 'icon', href: '../../assets/icon-192.png', type: 'image/png' }],
    ['link', { rel: 'apple-touch-icon', href: '../../assets/apple-touch-icon.png' }],
    ['link', { rel: 'manifest', href: '../../site.webmanifest' }],
  ];

  const rendered = tags
    .map(([tag, attrs]) => {
      const pairs = Object.entries(attrs)
        .map(([k, v]) => `${k}="${escape(v)}"`)
        .join(' ');
      return `<${tag} ${pairs}>`;
    })
    .join('\n');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: game.title,
    description: game.description,
    url,
    genre: game.genre,
    author: { '@type': 'Organization', name: game.author },
    applicationCategory: 'Game',
    operatingSystem: 'Web Browser',
  };

  return `${rendered}\n<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n</script>`;
}

function main() {
  const check = process.argv.includes('--check');
  const games = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));

  let stale = 0;
  let written = 0;
  let skipped = 0;

  for (const game of games) {
    const file = path.join(ROOT, game.path);
    if (!fs.existsSync(file)) {
      console.warn(`  skip  ${game.path} (missing)`);
      skipped++;
      continue;
    }
    const html = fs.readFileSync(file, 'utf8');
    const from = html.indexOf(START);
    const to = html.indexOf(END);
    if (from === -1 || to === -1) {
      // Pages predating this tool have hand-written heads; adding the markers
      // is a deliberate act, not something to do behind the author's back.
      console.warn(`  skip  ${game.path} (no meta:start/meta:end markers)`);
      skipped++;
      continue;
    }

    const next = `${html.slice(0, from + START.length)}\n${renderMeta(game)}\n${html.slice(to)}`;
    if (next === html) {
      console.log(`  ok    ${game.path}`);
      continue;
    }
    stale++;
    if (check) {
      console.error(`  STALE ${game.path}`);
      continue;
    }
    fs.writeFileSync(file, next);
    written++;
    console.log(`  wrote ${game.path}`);
  }

  if (check && stale) {
    console.error(`\n${stale} page(s) out of sync with games.json — run: node tools/sync-meta.js`);
    process.exit(1);
  }
  console.log(`\n${written} written, ${skipped} skipped, ${games.length} game(s) in games.json`);
}

main();
