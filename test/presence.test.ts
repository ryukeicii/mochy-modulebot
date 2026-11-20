// the bot's online connection against a pretend gateway: signing in, heartbeats, resuming after a dead connection, and giving up politely on a bad token

import assert from "node:assert/strict";
import { test } from "node:test";
import { Presence, type ObjectState } from "../src/presence.ts";
import type { Env } from "../src/env.ts";

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
globalThis.fetch = (async (input: RequestInfo | URL) => {
  dialed.push(String(input));
  const socket = new FakeSocket();
  sockets.push(socket);
  return { status: 101, webSocket: socket } as unknown as Response;
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
const presence = new Presence(state, { BOT_TOKEN: "bot-token" } as Env);
const last = () => sockets[sockets.length - 1];

test("signs in, beats, resumes and backs off", async () => {
  await presence.fetch();
  assert.equal(dialed[0], "https://gateway.discord.gg/?v=10&encoding=json");
  await last().say({ op: 10, d: { heartbeat_interval: 40000 } });
  const identify = last().sent[0];
  assert.equal(identify.op, 2);
  assert.equal(identify.d.token, "bot-token");
  assert.equal(identify.d.intents, 0);
  assert.equal(identify.d.presence.status, "online");
  assert.ok(alarmAt - Date.now() <= 40000, "the first heartbeat lands within one interval");

  await last().say({ op: 0, t: "READY", s: 1, d: { session_id: "s1", resume_gateway_url: "wss://resume.discord.gg" } });
  assert.deepEqual(store.get("session"), { id: "s1", resumeUrl: "wss://resume.discord.gg", seq: 1 });

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
