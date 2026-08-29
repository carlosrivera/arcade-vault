// storage.js — where edits live before they are code.
//
// Edits made from the chat panel are held in the browser, not written to disk:
// the page applies them as hot-reload overrides, so a session can be explored,
// undone and abandoned without touching the repository. When something is
// worth keeping, export() produces files to commit.
//
// IndexedDB rather than localStorage because module sources run to tens of
// kilobytes and localStorage is a synchronous ~5MB budget shared with
// everything else on the origin. Small preferences still belong there.

const DB_NAME = 'arcade-vault';
const DB_VERSION = 1;
const STORE = 'edits';

let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Keyed by module path: one current source per file, with history left
        // to git once exported.
        const store = db.createObjectStore(STORE, { keyPath: 'path' });
        store.createIndex('game', 'game', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx(mode, run) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const result = run(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(result?.result ?? result);
        transaction.onerror = () => reject(transaction.error);
      }),
  );
}

/** Save (or replace) the working source for one module. */
export function saveEdit({ path, source, game, note = '' }) {
  return tx('readwrite', (store) =>
    store.put({ path, source, game, note, updatedAt: new Date().toISOString() }),
  );
}

/** Every stored edit, newest first. */
export async function listEdits(game = null) {
  const all = await tx('readonly', (store) => store.getAll());
  const rows = game ? all.filter((e) => e.game === game) : all;
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Stored edits shaped for the hot-reload loader: { path: source }.
 * Pass straight to `__game.reload({ overrides })`.
 */
export async function overridesFor(game) {
  const rows = await listEdits(game);
  return Object.fromEntries(rows.map((e) => [e.path, e.source]));
}

/** Discard one edit, so the next reload falls back to the file on disk. */
export function revertEdit(path) {
  return tx('readwrite', (store) => store.delete(path));
}

/** Discard every edit for a game, or all games when none is given. */
export async function revertAll(game = null) {
  const rows = await listEdits(game);
  for (const row of rows) await revertEdit(row.path);
  return rows.length;
}

/**
 * Package edits for the repository.
 *
 * Returns { files, script } — `files` maps repo-relative paths to their new
 * contents, and `script` is a shell heredoc that writes them, so an edit made
 * in the browser can be committed without hand-copying anything.
 */
export async function exportEdits(game = null) {
  const rows = await listEdits(game);
  const files = Object.fromEntries(rows.map((e) => [e.path.replace(/^\//, ''), e.source]));
  const script = rows
    .map((e) => {
      const rel = e.path.replace(/^\//, '');
      return `cat > ${rel} <<'VAULT_EOF'\n${e.source}\nVAULT_EOF`;
    })
    .join('\n\n');
  return { files, script, count: rows.length };
}
