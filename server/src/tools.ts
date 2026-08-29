// tools.ts — what the model can do, declared for the browser to carry out.
//
// None of these have an `execute`: the source of truth for a running game is
// the browser's override store, not the files on disk. A server-side read
// would happily return a config the live game stopped using ten edits ago. So
// the model's tool calls are streamed to the page, executed there, and their
// results fed back.

import { jsonSchema, tool } from 'ai';

export const TOOLS = {
  list_files: tool({
    description:
      'List the editable modules of the current game with their sizes. Call this first ' +
      'when you do not already know which file holds what you need.',
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
  }),

  read_file: tool({
    description:
      'Read one module. Returns the source the running game is actually using, which ' +
      'includes any edits already applied this session — not necessarily what is on disk.',
    inputSchema: jsonSchema<{ path: string }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, e.g. /games/x/src/config.js' },
      },
      required: ['path'],
      additionalProperties: false,
    }),
  }),

  patch_file: tool({
    description:
      'Replace an exact snippet in a module. Prefer this over write_file: reproducing a ' +
      'thousand-line file to change two lines is slow and invites transcription errors. ' +
      '`search` must appear EXACTLY ONCE — include surrounding lines to make it unique.',
    inputSchema: jsonSchema<{ path: string; search: string; replace: string }>({
      type: 'object',
      properties: {
        path: { type: 'string' },
        search: { type: 'string', description: 'Exact text to find. Must be unique in the file.' },
        replace: { type: 'string', description: 'Text to put in its place.' },
      },
      required: ['path', 'search', 'replace'],
      additionalProperties: false,
    }),
  }),

  write_file: tool({
    description:
      'Replace a module wholesale. Only for new files or rewrites too sweeping to patch.',
    inputSchema: jsonSchema<{ path: string; content: string }>({
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    }),
  }),

  reload: tool({
    description:
      'Hot-swap the game with every edit made so far and report the result. Call this once ' +
      'after your edits. If it fails, the error is yours to fix — read the file and try again.',
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
  }),
} as const;

export const SYSTEM_PROMPT = `You are editing a live browser game built on a small three.js
engine. The page hot-swaps your code without reloading, so you are changing a running world
rather than writing a file.

Work like an engineer with a debugger, not an oracle: look before you edit. Call list_files
and read_file to find what you need. Do not guess at code you have not read.

Rules that come from how the loader works, not from taste:

- Import only through the page's import map: 'three', 'three/addons/...', '#engine/...'.
  Relative imports between a game's own files are fine.
- A game module exports init(ctx) and returns { update, dispose, getState }. Never do work at
  module scope: a swapped module is evaluated again, so anything built on import happens twice
  with no way to undo it.
- dispose() must release what init() acquired — listeners, timers, and GPU resources.
  Geometries, materials and textures are not garbage collected.
- getState() carries values into the next init(), so a seeded world rebuilds rather than restarts.

Finish by calling reload, then say in one or two sentences what changed. If reload reports an
error, fix it — do not hand back a broken game.`;
