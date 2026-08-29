// chat.js — edit the running game by talking to it.
//
// A floating panel that sends the conversation, plus the current source of the
// game's modules, to the local backend; the reply comes back as complete
// replacement modules, which are applied as hot-reload overrides. The world
// changes without the page reloading, and nothing touches disk until you
// export.
//
// Development-only by construction: boot.js mounts this on loopback origins
// only, so a deployed page never ships the editing surface.

import { exportEdits, overridesFor, revertAll, saveEdit } from '#engine/storage.js';

const BACKEND = 'http://127.0.0.1:8787';
// Fenced block tagged with the file it changes:
//   ```js path=/games/x/src/y.js            -> whole-module replacement
//   ```js path=/games/x/src/y.js mode=patch -> SEARCH/REPLACE pairs
const FILE_BLOCK = /```(?:js|javascript)\s+path=(\S+)([^\n]*)\n([\s\S]*?)```/g;
const PATCH_PAIR = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;

const CSS = `
.vault-chat { position: fixed; right: 16px; bottom: 16px; z-index: 99999;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e8ecf4; }
.vault-chat__fab { width: 48px; height: 48px; border-radius: 50%; border: 0; cursor: pointer;
  background: #7fd6ff; color: #06070a; font-size: 20px; font-weight: 700;
  box-shadow: 0 6px 24px rgba(0,0,0,.45); }
.vault-chat__panel { display: none; flex-direction: column; width: min(440px, calc(100vw - 32px));
  height: min(560px, calc(100vh - 96px)); background: #0e1117ee; backdrop-filter: blur(8px);
  border: 1px solid #2a3140; border-radius: 10px; overflow: hidden;
  box-shadow: 0 12px 48px rgba(0,0,0,.55); }
.vault-chat--open .vault-chat__panel { display: flex; }
.vault-chat--open .vault-chat__fab { display: none; }
.vault-chat__bar { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  background: #151a23; border-bottom: 1px solid #2a3140; }
.vault-chat__bar strong { font-size: 11px; letter-spacing: .12em; color: #7fd6ff; flex: 1; }
.vault-chat__bar button { background: #232b38; color: #cfd8e6; border: 1px solid #333d4d;
  border-radius: 4px; padding: 3px 8px; font: inherit; font-size: 11px; cursor: pointer; }
.vault-chat__bar button:hover { background: #2c3646; }
.vault-chat__log { flex: 1; overflow-y: auto; padding: 10px; display: flex;
  flex-direction: column; gap: 10px; }
.vault-chat__msg { white-space: pre-wrap; word-break: break-word; }
.vault-chat__msg--user { color: #9dff2f; }
.vault-chat__msg--err { color: #ff6b6b; }
.vault-chat__msg--note { color: #8b97a8; font-size: 11px; }
.vault-chat__form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #2a3140; }
.vault-chat__form textarea { flex: 1; resize: none; height: 52px; background: #151a23;
  color: inherit; border: 1px solid #333d4d; border-radius: 4px; padding: 6px; font: inherit; }
.vault-chat__form button { background: #7fd6ff; color: #06070a; border: 0; border-radius: 4px;
  padding: 0 14px; font: inherit; font-weight: 700; cursor: pointer; }
.vault-chat__form button:disabled { opacity: .5; cursor: default; }
`;

/**
 * Apply SEARCH/REPLACE pairs to a source string.
 *
 * @throws if a search string is absent or ambiguous — a patch that silently
 *   matched nothing would leave the game running stale code while the reply
 *   claimed success.
 */
export function applyPatch(source, patchBody) {
  let out = source;
  let applied = 0;
  for (const [, search, replace] of patchBody.matchAll(PATCH_PAIR)) {
    const count = out.split(search).length - 1;
    if (count === 0) throw new Error(`patch target not found: ${search.slice(0, 60)}…`);
    if (count > 1)
      throw new Error(`patch target matched ${count}× (must be unique): ${search.slice(0, 60)}…`);
    out = out.replace(search, replace);
    applied++;
  }
  if (!applied) throw new Error('patch block contained no SEARCH/REPLACE pairs');
  return out;
}

/**
 * Pull `path=` tagged blocks out of a reply and resolve them to full sources.
 *
 * @param {string} text  the model's reply
 * @param {Record<string,string>} current  path -> source, for patch blocks
 */
export function parseFileBlocks(text, current = {}) {
  const files = {};
  const errors = [];
  for (const [, path, flags, body] of text.matchAll(FILE_BLOCK)) {
    if (/\bmode=patch\b/.test(flags)) {
      const base = files[path] ?? current[path];
      if (base === undefined) {
        errors.push(`${path}: patch block but no current source to apply it to`);
        continue;
      }
      try {
        files[path] = applyPatch(base, body);
      } catch (error) {
        errors.push(`${path}: ${error.message}`);
      }
    } else {
      files[path] = body.trimEnd();
    }
  }
  return { files, errors };
}

/**
 * Mount the panel.
 *
 * @param {object} options
 * @param {{reload: Function, entry: string}} options.game  window.__game
 * @param {string} options.gameId
 * @param {string[]} options.sources module paths the model may rewrite
 */
export function mountChat({ game, gameId, sources = [] }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const root = document.createElement('div');
  root.className = 'vault-chat';
  root.innerHTML = `
    <button class="vault-chat__fab" type="button" title="Edit this game">✎</button>
    <div class="vault-chat__panel">
      <div class="vault-chat__bar">
        <strong>EDIT · ${gameId}</strong>
        <button data-act="export">export</button>
        <button data-act="revert">revert</button>
        <button data-act="close">✕</button>
      </div>
      <div class="vault-chat__log"></div>
      <form class="vault-chat__form">
        <textarea placeholder="Describe a change — e.g. make the camera lower and wider" required></textarea>
        <button type="submit">Send</button>
      </form>
    </div>`;
  document.body.append(root);

  const log = root.querySelector('.vault-chat__log');
  const form = root.querySelector('.vault-chat__form');
  const input = form.querySelector('textarea');
  const send = form.querySelector('button');
  const history = [];

  const say = (text, kind = '') => {
    const el = document.createElement('div');
    el.className = `vault-chat__msg${kind ? ` vault-chat__msg--${kind}` : ''}`;
    el.textContent = text;
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };

  root.querySelector('.vault-chat__fab').onclick = () => {
    root.classList.add('vault-chat--open');
    input.focus();
  };
  root.querySelector('[data-act="close"]').onclick = () =>
    root.classList.remove('vault-chat--open');

  root.querySelector('[data-act="revert"]').onclick = async () => {
    const n = await revertAll(gameId);
    // Reload with no overrides: the game falls back to what is on disk.
    await game.reload();
    say(`reverted ${n} edit(s) — running from disk`, 'note');
  };

  root.querySelector('[data-act="export"]').onclick = async () => {
    const { script, count } = await exportEdits(gameId);
    if (!count) return say('nothing to export', 'note');
    await navigator.clipboard?.writeText(script).catch(() => {});
    say(`${count} file(s) copied to clipboard — paste into a shell at the repo root`, 'note');
  };

  /** Read the current source of each module the model is allowed to rewrite. */
  async function currentSources() {
    const stored = await overridesFor(gameId);
    const files = {};
    for (const path of sources) {
      files[path] = stored[path] ?? (await fetch(path).then((r) => (r.ok ? r.text() : '')));
    }
    return files;
  }

  form.onsubmit = async (event) => {
    event.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = '';
    send.disabled = true;
    say(prompt, 'user');
    history.push({ role: 'user', content: prompt });

    const out = say('');
    try {
      // Kept so patch blocks apply against exactly what the model was shown.
      const sent = await currentSources();
      const response = await fetch(`${BACKEND}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, files: sent }),
      });
      if (!response.ok) throw new Error(`backend ${response.status}: ${await response.text()}`);

      // Stream so the reply appears as it is written rather than all at once.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
        out.textContent = full;
        log.scrollTop = log.scrollHeight;
      }
      history.push({ role: 'assistant', content: full });

      const { files, errors } = parseFileBlocks(full, sent);
      for (const problem of errors) say(problem, 'err');
      const paths = Object.keys(files);
      if (!paths.length) return say('no file blocks applied', 'note');

      for (const [path, source] of Object.entries(files)) {
        await saveEdit({ path, source, game: gameId });
      }
      // Every stored edit is replayed, not just this turn's, so successive
      // changes compose instead of the newest one reverting the rest.
      await game.reload({ overrides: await overridesFor(gameId) });
      say(`applied ${paths.length} file(s): ${paths.join(', ')}`, 'note');
    } catch (error) {
      say(String(error.message ?? error), 'err');
    } finally {
      send.disabled = false;
    }
  };

  return { root, say };
}
