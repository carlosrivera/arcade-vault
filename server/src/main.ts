// main.ts — Deno entry point.
//
// The only runtime-specific file. createApp() in app.ts is a plain Web fetch
// handler, so deploying to Cloudflare Workers means adding a sibling entry
// that does `export default { fetch: app.fetch }` — the app itself is unchanged.

import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = createApp(config);

console.log(`vault chat backend  →  http://localhost:${config.port}`);
console.log(`  model    ${config.model}`);
console.log(`  origins  ${config.allowedOrigins.join(', ')}`);

// Loopback only. This endpoint can rewrite the code of a running game, so it
// is a development tool and must not be reachable from the network.
Deno.serve({ port: config.port, hostname: '127.0.0.1' }, app.fetch);
