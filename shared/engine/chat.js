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
@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');

/* Matches the eject button's cabinet language: pixel font for chrome, 3px
   black borders, hard unblurred offset shadows, and a bevel from inset
   highlight/shadow pairs. Body text stays terminal-monospace — Press Start 2P
   is a display face and unreadable at paragraph length. */
.vault-chat {
  position: fixed; top: 16px; right: 16px; z-index: 10000;
  font-family: 'Press Start 2P', monospace, sans-serif;
  user-select: none; -webkit-user-select: none;
}

.vault-chat__fab {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  background: #0f1224; color: #8da2d8;
  padding: 8px 12px; font: inherit; font-size: 9px; letter-spacing: 1px;
  border: 3px solid #000;
  box-shadow: inset 2px 2px 0 #384270, inset -2px -2px 0 #060812, 4px 4px 0 #000;
  transition: all .12s ease-out;
}
.vault-chat__fab .ico { font-size: 13px; color: #ffcc00; transition: transform .15s ease; }
.vault-chat__fab:hover {
  background: #1c2242; color: #6cf0a0;
  transform: translate(-1px,-1px);
  box-shadow: inset 2px 2px 0 #4f5d9c, inset -2px -2px 0 #060812, 6px 6px 0 #000;
}
.vault-chat__fab:hover .ico { color: #6cf0a0; transform: translateY(-2px); }
.vault-chat__fab:active {
  transform: translate(2px,2px);
  box-shadow: inset 2px 2px 0 #060812, inset -2px -2px 0 #384270, 2px 2px 0 #000;
}

.vault-chat__panel {
  display: none; flex-direction: column;
  width: min(420px, calc(100vw - 32px)); height: min(540px, calc(100vh - 64px));
  background: #0f1224; border: 3px solid #000;
  box-shadow: inset 2px 2px 0 #384270, inset -2px -2px 0 #060812, 6px 6px 0 #000;
}
.vault-chat--open .vault-chat__panel { display: flex; }
.vault-chat--open .vault-chat__fab { display: none; }

.vault-chat__bar {
  display: flex; align-items: center; gap: 6px;
  padding: 9px 8px; background: #1c2242; border-bottom: 3px solid #000;
}
.vault-chat__bar strong { flex: 1; font-size: 9px; letter-spacing: 1px; color: #ffcc00; }
.vault-chat__bar button {
  background: #0f1224; color: #8da2d8; border: 2px solid #000;
  box-shadow: inset 1px 1px 0 #384270, inset -1px -1px 0 #060812, 2px 2px 0 #000;
  padding: 5px 7px; font: inherit; font-size: 7px; letter-spacing: 1px; cursor: pointer;
}
.vault-chat__bar button:hover { color: #6cf0a0; background: #232a4e; }
.vault-chat__bar button:active {
  transform: translate(1px,1px);
  box-shadow: inset 1px 1px 0 #060812, inset -1px -1px 0 #384270, 1px 1px 0 #000;
}

/* Scanline wash over the log, like a CRT readout. */
.vault-chat__log {
  flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 9px;
  font-family: 'Courier New', ui-monospace, monospace; font-size: 12px; line-height: 1.5;
  color: #8da2d8; background:
    repeating-linear-gradient(180deg, rgba(0,0,0,0) 0 2px, rgba(0,0,0,.22) 2px 4px), #0a0d1c;
}
.vault-chat__log::-webkit-scrollbar { width: 8px; }
.vault-chat__log::-webkit-scrollbar-thumb { background: #384270; border: 2px solid #000; }

.vault-chat__msg { white-space: pre-wrap; word-break: break-word; }
.vault-chat__msg--user { color: #6cf0a0; }
.vault-chat__msg--user::before { content: '> '; color: #ffcc00; }
.vault-chat__msg--err { color: #ff3344; }
.vault-chat__msg--err::before { content: '!! '; }
.vault-chat__msg--note {
  color: #ffcc00; font-family: 'Press Start 2P', monospace; font-size: 7px;
  letter-spacing: 1px; line-height: 1.8;
}

.vault-chat__form { display: flex; gap: 6px; padding: 8px; border-top: 3px solid #000; background: #1c2242; }
.vault-chat__form textarea {
  flex: 1; resize: none; height: 50px; padding: 6px;
  background: #0a0d1c; color: #6cf0a0; border: 2px solid #000;
  box-shadow: inset 1px 1px 0 #060812;
  font-family: 'Courier New', ui-monospace, monospace; font-size: 12px;
}
.vault-chat__form textarea::placeholder { color: #4a5580; }
.vault-chat__form textarea:focus { outline: none; border-color: #384270; }
.vault-chat__form button {
  background: #ffcc00; color: #0f1224; border: 3px solid #000;
  box-shadow: inset 2px 2px 0 #ffe680, inset -2px -2px 0 #a07f00, 3px 3px 0 #000;
  padding: 0 12px; font: inherit; font-size: 8px; letter-spacing: 1px; cursor: pointer;
}
.vault-chat__form button:hover:not(:disabled) { background: #ffd633; }
.vault-chat__form button:active:not(:disabled) {
  transform: translate(2px,2px);
  box-shadow: inset 2px 2px 0 #a07f00, inset -2px -2px 0 #ffe680, 1px 1px 0 #000;
}
.vault-chat__form button:disabled { background: #3a3a48; color: #6a6a78; box-shadow: none; cursor: default; }

@media (max-width: 600px) {
  .vault-chat { top: 10px; right: 10px; }
  .vault-chat__fab .label { display: none; }
}
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
    <button class="vault-chat__fab" type="button" title="Edit this cartridge">
      <span class="ico">✎</span><span class="label">EDIT</span>
    </button>
    <div class="vault-chat__panel">
      <div class="vault-chat__bar">
        <strong>${gameId.toUpperCase()}</strong>
        <button data-act="export">EXPORT</button>
        <button data-act="revert">REVERT</button>
        <button data-act="close">X</button>
      </div>
      <div class="vault-chat__log"></div>
      <form class="vault-chat__form">
        <textarea placeholder="describe a change..." required></textarea>
        <button type="submit">SEND</button>
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
