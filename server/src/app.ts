// app.ts — the HTTP surface, as a Web-Standard fetch handler.
//
// Nothing here touches a runtime API: requests and responses are the platform
// Request/Response, and streaming is a ReadableStream. That is what lets the
// same file run under `deno serve` today and deploy to Cloudflare Workers
// later without a rewrite — workerd and Deno implement the same primitives.
//
// This server exists for one reason: to hold the OpenRouter key. A browser
// cannot keep a secret, so the model call is proxied rather than made from the
// page. It deliberately does not write to disk — edits live in the browser
// (IndexedDB) and are applied to the running game as hot-reload overrides, so
// nothing is committed until you choose to export it.

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { streamText } from 'ai';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Config } from './config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const SYSTEM_PROMPT = `You are editing a live browser game built on a small
three.js engine. The page hot-swaps your code without reloading, so you are
changing a running world rather than writing a file.

Rules that come from how the loader works, not from taste:

- Modules are rebuilt from source on every swap. Import only through the page's
  import map: 'three', 'three/addons/...', '#engine/...'. Relative imports
  resolve fine between game files, but never invent paths outside the game.
- A game module exports init(ctx) and returns { update, dispose, getState }.
  Never do work at module scope: a swapped module is evaluated again, and
  anything built on import happens twice with no way to undo it.
- dispose() must release what init() acquired — listeners, timers, and GPU
  resources. Geometries, materials and textures are not garbage collected.
- getState() carries values into the next init(), so a seeded world can be
  rebuilt exactly rather than restarted.

Reply with a fenced block per file you are changing, tagged with its path.
Two forms:

Small, surgical changes — PREFER THIS. Reproducing a thousand-line module to
alter two numbers is slow and invites transcription errors:

\`\`\`js path=/games/<id>/src/<file>.js mode=patch
<<<<<<< SEARCH
pitch: 58 * (Math.PI / 180),
=======
pitch: 24 * (Math.PI / 180),
>>>>>>> REPLACE
\`\`\`

Each SEARCH must appear EXACTLY ONCE in the current file — include enough
surrounding lines to be unique. Several pairs may share one block.

Whole-file replacement, for new files or sweeping rewrites:

\`\`\`js path=/games/<id>/src/<file>.js
// ...entire file...
\`\`\`

Only emit files you are actually changing.`;

export function createApp(config: Config) {
  const app = new Hono();
  const openrouter = createOpenRouter({ apiKey: config.openRouterKey });

  app.use(
    '/api/*',
    cors({
      origin: config.allowedOrigins,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
    }),
  );

  app.get('/api/health', (c) => c.json({ ok: true, model: config.model }));

  /**
   * Stream a model reply.
   *
   * The client sends the conversation plus the current source of whatever
   * files it wants changed; the model replies with complete replacement
   * modules, which the page applies as hot-reload overrides.
   */
  app.post('/api/chat', async (c) => {
    let body: { messages?: ChatMessage[]; files?: Record<string, string> };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON.' }, 400);
    }

    const messages = body.messages ?? [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: 'messages must be a non-empty array.' }, 400);
    }

    // Current source goes in as context so the model rewrites what is actually
    // running, not what it imagines the file looks like.
    const files = body.files ?? {};
    const fileContext = Object.entries(files)
      .map(([path, source]) => `--- ${path} ---\n${source}`)
      .join('\n\n');

    const result = streamText({
      model: openrouter(config.model),
      system: fileContext ? `${SYSTEM_PROMPT}\n\nCurrent source:\n\n${fileContext}` : SYSTEM_PROMPT,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    return result.toTextStreamResponse();
  });

  app.onError((err, c) => {
    console.error('[server]', err);
    return c.json({ error: err.message }, 500);
  });

  return app;
}
