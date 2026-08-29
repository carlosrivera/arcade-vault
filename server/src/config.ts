// config.ts — runtime configuration, read from the environment.
//
// Deno and Workers expose environment variables differently (Deno.env vs a
// per-request `env` binding), so everything funnels through one accessor and
// the rest of the server stays runtime-agnostic.

export interface Config {
  /** OpenRouter API key. Server-side only — it must never reach the browser. */
  openRouterKey: string;
  /** Model slug, e.g. "anthropic/claude-sonnet-4.5". */
  model: string;
  port: number;
  /** Origins allowed to call this server. Localhost only by default. */
  allowedOrigins: string[];
}

type EnvSource = { get(key: string): string | undefined };

const denoEnv: EnvSource = {
  get: (key) => (globalThis as { Deno?: { env: EnvSource } }).Deno?.env.get(key),
};

export function loadConfig(env: EnvSource = denoEnv): Config {
  const key = env.get('OPENROUTER_API_KEY');
  if (!key) {
    throw new Error(
      'OPENROUTER_API_KEY is not set.\n' +
        '  cp server/.env.example server/.env  and put your key in it.\n' +
        '  Get one at https://openrouter.ai/keys',
    );
  }
  return {
    openRouterKey: key,
    model: env.get('MODEL') ?? 'anthropic/claude-sonnet-4.5',
    port: Number(env.get('PORT') ?? 8787),
    // The editing surface is a development tool: it can read and rewrite game
    // source, so it is bound to loopback rather than exposed to a network.
    allowedOrigins: (
      env.get('ALLOWED_ORIGINS') ??
      'http://localhost:8137,http://127.0.0.1:8137,http://localhost:8080,http://127.0.0.1:8080'
    )
      .split(',')
      .map((o) => o.trim()),
  };
}
