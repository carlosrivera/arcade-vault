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
import { generateText, type ModelMessage } from 'ai';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Config } from './config.ts';
import { SYSTEM_PROMPT, TOOLS } from './tools.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

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
   * One step of the agent loop.
   *
   * The client posts the conversation so far and gets back either a final
   * answer or tool calls to run. The browser executes them — it holds the
   * authoritative source, including edits not yet on disk — appends the
   * results, and posts again. The loop lives on the client because the tools
   * do.
   */
  app.post('/api/agent', async (c) => {
    let body: { messages?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON.' }, 400);
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: 'messages must be a non-empty array.' }, 400);
    }

    const result = await generateText({
      model: openrouter(config.model),
      system: SYSTEM_PROMPT,
      // The client owns message shape — including assistant tool-call parts
      // and tool results — and the SDK's message union is not worth
      // reconstructing across the wire just to re-narrow it here.
      messages: messages as ModelMessage[],
      tools: TOOLS,
    });

    return c.json({
      text: result.text,
      toolCalls: result.toolCalls.map((call) => ({
        id: call.toolCallId,
        name: call.toolName,
        args: call.input,
      })),
      finishReason: result.finishReason,
      usage: result.usage,
    });
  });

  app.onError((err, c) => {
    console.error('[server]', err);
    return c.json({ error: err.message }, 500);
  });

  return app;
}
