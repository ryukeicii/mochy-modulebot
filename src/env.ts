// what the worker is given: its storage, discord's keys and which forums hold modules (wrangler.toml and secrets)

// lets work carry on after the answer has gone out, like a cron run or a slash command's reply
export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

// the little of cloudflare's d1 this uses, typed here so the worker needs no packages
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1 {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

// the durable object that keeps the bot online, reached by name
export interface Objects {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string): Promise<Response> };
}

export interface Env {
  DB: D1;
  PRESENCE: Objects;
  // secrets: wrangler secret put BOT_TOKEN, CLIENT_SECRET and STORE_KEY
  BOT_TOKEN: string;
  CLIENT_SECRET: string;
  // the key official mochy builds sign with; without it set, every app request is turned away
  STORE_KEY: string;
  CLIENT_ID: string;
  // the application's public key, which discord signs slash commands with (Developer Portal, General Information)
  PUBLIC_KEY: string;
  GUILD_ID: string;
  // [{"id": "<forum channel id>", "paid": false}, ...]
  FORUMS: string;
  INVITE_URL: string;
  // the role someone gets for publishing a module
  PUBLISHER_ROLE: string;
  // the roles whose members may use /setchart, split by commas; the owner and admins always may
  CHART_ROLES: string;
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
