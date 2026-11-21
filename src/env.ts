// what the worker is given: its storage, discord's keys and which forums hold modules (wrangler.toml and secrets)

// lets work carry on after the answer has gone out, like a cron run or a slash command's reply
export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

// the little of cloudflare's kv this uses, typed here so the worker needs no packages
export interface KV {
  get(key: string, type: "json"): Promise<unknown>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  getWithMetadata(key: string, type: "arrayBuffer"): Promise<{ value: ArrayBuffer | null; metadata: unknown }>;
  delete(key: string): Promise<void>;
}

// the durable object that keeps the bot online, reached by name
export interface Objects {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string): Promise<Response> };
}

export interface Env {
  FEED: KV;
  PRESENCE: Objects;
  // secrets: wrangler secret put BOT_TOKEN, wrangler secret put CLIENT_SECRET
  BOT_TOKEN: string;
  CLIENT_SECRET: string;
  CLIENT_ID: string;
  // the application's public key, which discord signs slash commands with (Developer Portal, General Information)
  PUBLIC_KEY: string;
  GUILD_ID: string;
  // [{"id": "<forum channel id>", "paid": false}, ...]
  FORUMS: string;
  INVITE_URL: string;
  // the role someone gets for publishing a module
  PUBLISHER_ROLE: string;
  // who may use /setchart: discord user ids, split by commas
  CHART_KEEPERS: string;
  // where the app waits for the sign-in to come back
  APP_REDIRECT: string;
}

export interface Forum {
  id: string;
  paid: boolean;
}

export function forumsOf(env: Env): Forum[] {
  const list = JSON.parse(env.FORUMS) as Array<{ id: string; paid?: boolean }>;
  return list.map((f) => ({ id: String(f.id), paid: f.paid === true }));
}
