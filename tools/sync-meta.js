// sync-meta.js — write each game page's <head> metadata from games.json.
//
// Every game page carries ~22 head tags plus a JSON-LD block. They are
// structurally identical across games and differ only in their values, so
// maintaining them by hand means the same description lives in several files
// and drifts in most of them. games.json is the single source of truth: each
// game's `seo` block holds its tags, any head scripts, and its JSON-LD, and
// this writes them between the meta:start / meta:end markers.
//
// The tags stay static in the served HTML rather than being injected at
// runtime, because crawlers and link unfurlers read the markup, not the DOM
// after scripts run.
//
// Usage: node tools/sync-meta.js [--check]
//   --check  report stale pages and exit non-zero without writing (for CI)

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const START = '<!-- meta:start -->';
const END = '<!-- meta:end -->';

/** Render one game's head block: tags, then scripts, then JSON-LD. */
function renderMeta(game) {
  const seo = game.seo;
  if (!seo) return null;
  const parts = [...(seo.tags ?? []), ...(seo.scripts ?? [])];
  if (seo.jsonLd) {
    parts.push(
      `<script type="application/ld+json">\n${JSON.stringify(seo.jsonLd, null, 2)}\n</script>`,
    );
  }
  return parts.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const games = JSON.parse(fs.readFileSync(path.join(ROOT, 'games.json'), 'utf8'));

  let stale = 0;
  let written = 0;
  const problems = [];

  for (const game of games) {
    const file = path.join(ROOT, game.path);
    if (!fs.existsSync(file)) {
      problems.push(`${game.path}: file missing`);
      continue;
    }
    const html = fs.readFileSync(file, 'utf8');
    const from = html.indexOf(START);
    const to = html.indexOf(END);
    if (from === -1 || to === -1) {
      // A page without markers cannot be kept in sync, which is the whole
      // point of this tool — so it is an error, not something to shrug past.
      problems.push(`${game.path}: missing ${START} / ${END} markers`);
      continue;
    }
    const block = renderMeta(game);
    if (block === null) {
      problems.push(`${game.path}: no "seo" block in games.json for "${game.id}"`);
      continue;
    }

    const next = `${html.slice(0, from + START.length)}\n${block}\n${html.slice(to)}`;
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

  if (problems.length) {
    console.error('\nProblems:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  if (check && stale) {
    console.error(`\n${stale} page(s) out of sync — run: node tools/sync-meta.js`);
    process.exit(1);
  }
  console.log(`\n${written} written, ${games.length} game(s) in games.json`);
}

main();
