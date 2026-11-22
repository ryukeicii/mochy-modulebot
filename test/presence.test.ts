// the bot's online connection against a pretend gateway: signing in, heartbeats, resuming after a dead connection, and giving up politely on a bad token

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Presence, type ObjectState } from "../src/presence.ts";
import { GatewayIntents } from "../src/prompt.ts";
import type { D1, D1Statement, Env } from "../src/env.ts";
import { putJson } from "../src/store.ts";

const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function memoryD1(): D1 {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql);
  const make = (query: string, params: unknown[] = []): D1Statement & { _run: () => unknown } => ({
    bind: (...values) => make(query, values),
    first: async <T = Record<string, unknown>>() => (db.prepare(query).get(...(params as any[])) as T | undefined) ?? null,
    all: async <T = Record<string, unknown>>() => ({ results: db.prepare(query).all(...(params as any[])) as T[] }),
    run: async () => db.prepare(query).run(...(params as any[])),
    _run: () => db.prepare(query).run(...(params as any[])),
  });
  return {
    prepare: (query) => make(query),
    batch: async (statements) => statements.map((s) => (s as D1Statement & { _run: () => unknown })._run()),
  };
}

// a gateway socket the test talks through: what the bot sent, and a way to answer it
class FakeSocket {
  sent: Array<{ op: number; d?: any }> = [];
  closedWith: number | null = null;
  private listeners: Record<string, Array<(event: any) => void>> = {};
  accept() {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
  }
  addEventListener(type: string, listener: (event: any) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  async say(payload: Record<string, unknown>) {
    for (const listener of this.listeners.message ?? []) listener({ data: JSON.stringify(payload) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  async hangUp(code: number) {
    for (const listener of this.listeners.close ?? []) listener({ code });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const sockets: FakeSocket[] = [];
const dialed: string[] = [];
const posted: Array<{ path: string; body: any }> = [];
const channels: Record<string, unknown> = {
  "/channels/2001": { id: "2001", name: "Existing", parent_id: "free", owner_id: "maker", last_message_id: "2002" },
  "/channels/9999": { id: "9999", name: "General", parent_id: "other-cat", owner_id: "maker", last_message_id: "9999" },
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("gateway") || url.includes("resume")) {
    dialed.push(url);
    const socket = new FakeSocket();
    sockets.push(socket);
    return { status: 101, webSocket: socket } as unknown as Response;
  }
  const path = new URL(url).pathname.replace("/api/v10", "");
  if (init?.method === "POST") {
    posted.push({ path, body: JSON.parse(String(init.body)) });
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }
  if (path in channels) return new Response(JSON.stringify(channels[path]), { headers: { "Content-Type": "application/json" } });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const store = new Map<string, unknown>();
let alarmAt = 0;
const state: ObjectState = {
  storage: {
    get: async <T>(key: string) => structuredClone(store.get(key)) as T | undefined,
    put: async (key, value) => void store.set(key, structuredClone(value)),
    setAlarm: async (time) => void (alarmAt = time),
  },
};
const db = memoryD1();
const env = { BOT_TOKEN: "bot-token", GUILD_ID: "g", FORUMS: '[{"id":"free","paid":false}]', DB: db } as Env;
const presence = new Presence(state, env);
const last = () => sockets[sockets.length - 1];

test("signs in, beats, resumes and backs off", async () => {
  await presence.fetch();
  assert.equal(dialed[0], "https://gateway.discord.gg/?v=10&encoding=json");
  await last().say({ op: 10, d: { heartbeat_interval: 40000 } });
  const identify = last().sent[0];
  assert.equal(identify.op, 2);
  assert.equal(identify.d.token, "bot-token");
  assert.equal(identify.d.intents, GatewayIntents);
  assert.equal(identify.d.presence.status, "online");
  assert.ok(alarmAt - Date.now() <= 40000, "the first heartbeat lands within one interval");

  await last().say({ op: 0, t: "READY", s: 1, d: { session_id: "s1", resume_gateway_url: "wss://resume.discord.gg" } });
  assert.deepEqual(store.get("session"), { id: "s1", resumeUrl: "wss://resume.discord.gg", seq: 1, intents: GatewayIntents });

  // a heartbeat goes out, gets its answer, and the next one is an interval away
  await presence.alarm();
  assert.deepEqual(last().sent.at(-1), { op: 1, d: 1 });
  await last().say({ op: 11 });
  await presence.alarm();
  assert.equal(last().sent.filter((p) => p.op === 1).length, 2);

  // no answer this time: the old connection is closed in a way that keeps the session, and the new one resumes it
  const dead = last();
  await presence.alarm();
  assert.equal(dead.closedWith, 4000);
  assert.equal(dialed.at(-1), "https://resume.discord.gg/?v=10&encoding=json");
  await last().say({ op: 10, d: { heartbeat_interval: 40000 } });
  assert.deepEqual(last().sent[0], { op: 6, d: { token: "bot-token", session_id: "s1", seq: 1 } });

  // discord throws the session out, so the next try signs in fresh at the main gateway
  await last().say({ op: 9, d: false });
  await presence.alarm();
  assert.equal(dialed.at(-1), "https://gateway.discord.gg/?v=10&encoding=json");
  await last().say({ op: 10, d: { heartbeat_interval: 40000 } });
  assert.equal(last().sent[0].op, 2);

  // a rejected token waits for the cron instead of trying again straight away
  await last().hangUp(4004);
  assert.ok(alarmAt - Date.now() > 9 * 60 * 1000, "a bad token waits about ten minutes");
});

test("live detection prompts for new zips and links, ignores chat and non-authors", async () => {
  const fresh = new Presence(state, env);
  await fresh.fetch();
  await last().say({ op: 10, d: { heartbeat_interval: 40000 } });
  await last().say({ op: 0, t: "READY", s: 1, d: { session_id: "s2", resume_gateway_url: "wss://resume.discord.gg" } });

  // new forum post with zip + banner -> offers Publish
  await last().say({ op: 0, t: "THREAD_CREATE", s: 2, d: { id: "1001", guild_id: "g", parent_id: "free", owner_id: "maker", name: "Cool Look" } });
  await last().say({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 3,
    d: {
      id: "1001",
      channel_id: "1001",
      guild_id: "g",
      author: { id: "maker", username: "maker" },
      content: "my look",
      attachments: [
        { id: "a1", filename: "cool.zip", size: 1000, url: "https://cdn.test/cool.zip" },
        { id: "p1", filename: "banner.png", size: 500, url: "https://cdn.test/banner.png", content_type: "image/png" },
      ],
    },
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].path, "/channels/1001/messages");
  assert.equal(posted[0].body.components[0].components[0].custom_id, "prompt:publish:1001:1001");
  assert.ok(!posted[0].body.content.includes("—"), "no em-dashes in prompt");

  // random user uploading a zip or normal chat -> ignored
  await last().say({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 4,
    d: { id: "1002", channel_id: "1001", guild_id: "g", author: { id: "fan", username: "fan" }, content: "nice", attachments: [{ id: "a2", filename: "x.zip", size: 100, url: "https://cdn.test/x.zip" }] },
  });
  await last().say({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 5,
    d: { id: "9999", channel_id: "9999", guild_id: "g", author: { id: "maker", username: "maker" }, content: "zip in general", attachments: [{ id: "a3", filename: "x.zip", size: 100, url: "https://cdn.test/x.zip" }] },
  });
  assert.equal(posted.length, 1);

  // already published post with a new zip -> offers Update
  await putJson(env, "listing:2001", { install: "zip", publisher: "maker", description: "", banner: null, previews: [], icon: null, publishedAt: 1 });
  await last().say({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 6,
    d: { id: "2002", channel_id: "2001", guild_id: "g", author: { id: "maker", username: "maker" }, content: "v2", attachments: [{ id: "a4", filename: "v2.zip", size: 1000, url: "https://cdn.test/v2.zip" }] },
  });
  assert.equal(posted.length, 2);
  assert.equal(posted[1].body.components[0].components[0].custom_id, "prompt:update:2001:2002");

  // new starter post with github link + banner -> offers Publish Link / Publish Web
  await last().say({ op: 0, t: "THREAD_CREATE", s: 7, d: { id: "3001", guild_id: "g", parent_id: "free", owner_id: "maker", name: "Link Mod" } });
  await last().say({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 8,
    d: {
      id: "3001",
      channel_id: "3001",
      guild_id: "g",
      author: { id: "maker", username: "maker" },
      content: "check https://github.com/someone/mod",
      attachments: [{ id: "p2", filename: "pic.png", size: 500, url: "https://cdn.test/pic.png", content_type: "image/png" }],
    },
  });
  assert.equal(posted.length, 3);
  assert.equal(posted[2].body.components[0].components[0].custom_id, "prompt:publishlink:3001:3001");
  assert.equal(posted[2].body.components[0].components[1].custom_id, "prompt:publishweb:3001:3001");
});
