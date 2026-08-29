# @vault/server

Local chat backend for editing games from the browser.

## Why it exists

One reason: to hold the OpenRouter key. A browser cannot keep a secret, so the
model call is proxied rather than made from the page.

It deliberately **does not write to disk**. Edits live in the browser
(IndexedDB) and are applied to the running game as hot-reload overrides, so
nothing reaches the repository until you press *export*.

## Run it

```bash
cp server/.env.example server/.env   # add your key from openrouter.ai/keys
pnpm server                          # or: cd server && deno task dev
pnpm serve                           # the site, in another shell
```

Then open <http://localhost:8080> and click the ✎ bubble. On any other origin
the panel is not merely hidden — `chat.js` is never fetched.

## Runtime

The handler in `src/app.ts` uses only Web Standard APIs — `Request`,
`Response`, `ReadableStream` — which both Deno and Cloudflare's `workerd`
implement. `src/main.ts` is the only Deno-specific file.

Deploying to Cloudflare Workers therefore means adding a sibling entry point,
not a rewrite:

```ts
// src/worker.ts
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

export default {
  fetch(req: Request, env: Record<string, string>) {
    return createApp(loadConfig({ get: (k) => env[k] })).fetch(req);
  },
};
```

`loadConfig` already takes an env source for exactly this reason: Deno reads
`Deno.env`, Workers gets a per-request binding.

## Later: accounts and shared content

The browser-local store is a deliberate first stage. When this goes live,
Cloudflare covers the rest without a new vendor: **D1** for accounts and game
metadata, **R2** for user-generated assets. `storage.js` is the seam — its
`exportEdits()` already produces committable files, and the same interface can
write to an API instead.
