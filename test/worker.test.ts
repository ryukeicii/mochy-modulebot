// the whole worker against a pretend discord: signing in, the cron reading the forums, the list, the paid lock, the zips and /update

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../src/index.ts";
import { CommandList } from "../src/catalog.ts";
import type { Env, KV } from "../src/env.ts";

const zipBytes = readFileSync(new URL("./fixtures/look.zip", import.meta.url));
const View = String(1 << 10);

// a kv that keeps everything in a map, metadata included
function memoryKv(): KV {
  const store = new Map<string, { value: string | Uint8Array; metadata?: unknown }>();
  const read = (key: string, type?: string) => {
    const hit = store.get(key);
    if (!hit) return null;
    if (type === "json") return JSON.parse(hit.value as string);
    if (type === "arrayBuffer") return (hit.value as Uint8Array).slice().buffer;
    return hit.value as string;
  };
  return {
    get: (async (key: string, type?: string) => read(key, type)) as KV["get"],
    put: async (key, value, options) => {
      store.set(key, { value: typeof value === "string" ? value : new Uint8Array(value as ArrayBuffer), metadata: options?.metadata });
    },
    getWithMetadata: async (key) => ({ value: read(key, "arrayBuffer") as ArrayBuffer | null, metadata: store.get(key)?.metadata ?? null }),
    delete: async (key) => {
      store.delete(key);
    },
  };
}

const freeThread = { id: "1001", name: "[LOOKS] Liquid Glass", parent_id: "free", owner_id: "maker", last_message_id: "1001", applied_tags: ["t-looks"], thread_metadata: { archived: false, create_timestamp: "2026-11-01T00:00:00Z" } };
const hiddenThread = { id: "3001", name: "Unlisted Thing", parent_id: "free", owner_id: "maker2", last_message_id: "3004", applied_tags: [], thread_metadata: { archived: false, create_timestamp: "2026-11-03T00:00:00Z" } };
const paidThread = { id: "2001", name: "Gold Glass", parent_id: "paid", owner_id: "maker", last_message_id: "2001", applied_tags: [], thread_metadata: { archived: true, create_timestamp: "2026-11-02T00:00:00Z" } };
const post = (id: string) => [{ id, content: "a glass for the bars", author: { id: "maker", username: "maker" }, attachments: [{ id: `a${id}`, filename: "look.zip", size: zipBytes.length, url: `https://cdn.test/${id}.zip` }] }];

// who each pretend access token belongs to, and their roles in the server; "outsider" isn't in it
const people: Record<string, { id: string; roles: string[] | null }> = {
  "token-member": { id: "u1", roles: [] },
  "token-buyer": { id: "u2", roles: ["buyer"] },
  "token-outsider": { id: "u3", roles: null },
};

const picture = (id: string) => ({ id, filename: `${id}.png`, size: 1000, url: `https://cdn.test/${id}.png`, content_type: "image/png" });
const zipFile = (id: string) => ({ id, filename: "look.zip", size: zipBytes.length, url: `https://cdn.test/${id}.zip` });
// messages the store commands point at: a zip with a picture, two pictures, and the hidden post's own
const withPicture = { id: "1004", content: "A glass for the bars.", author: { id: "maker", username: "maker" }, attachments: [picture("pic1"), zipFile("z1004")] };
const twoPictures = { id: "1005", content: "", author: { id: "maker", username: "maker" }, attachments: [picture("pic2"), picture("pic3")] };
const hiddenPublish = { id: "3004", content: "Fresh look.", author: { id: "maker2", username: "maker2" }, attachments: [picture("pic9"), zipFile("z3004")] };
// a message as discord sends it with message content intent off, and two that publish by link
const hidden = { id: "1006", content: "", author: { id: "maker", username: "maker" }, attachments: [] };
const githubLink = { id: "3005", content: "Get it here https://github.com/someone/glass-module and enjoy", author: { id: "maker2", username: "maker2", global_name: "Maker Two" }, attachments: [picture("pic7")] };
const webPage = { id: "3006", content: "Try it on <https://example.com/glass>.", author: { id: "maker2", username: "maker2" }, attachments: [picture("pic8")] };
let hideEverything = false;
const rolesGiven: string[] = [];
let roleFails = false;

// an older zip still in the free post, for /update to pick; and what the bot answered each slash command
const olderZip = { id: "999", content: "older one", author: { id: "maker", username: "maker" }, attachments: [{ id: "a999", filename: "old.zip", size: zipBytes.length, url: "https://cdn.test/999.zip" }] };
const chatter = { id: "1002", content: "nice", author: { id: "fan", username: "fan" }, attachments: [] };
const answers: string[] = [];
// zips posted later, newest first, put at the top of the free post
const later: Array<typeof olderZip> = [];

let botCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const auth = new Headers(init?.headers).get("Authorization") ?? "";
  const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  if (url.hostname === "cdn.test") return new Response(zipBytes);
  const path = url.pathname.replace("/api/v10", "");
  if (path === "/oauth2/token") {
    const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
    return ok({ access_token: `token-${code}`, refresh_token: "r", expires_in: 3600 });
  }
  if (path.startsWith("/webhooks/client/")) {
    const method = init?.method ?? "GET";
    const content = init?.body ? (JSON.parse(String(init.body)) as { content: string }).content : "";
    answers.push(method === "PATCH" ? content : method === "POST" ? `public: ${content}` : "private answer cleared");
    return ok({});
  }
  if (auth.startsWith("Bot ")) {
    botCalls++;
    if (init?.method === "PUT" && path.startsWith("/guilds/g/members/")) {
      if (roleFails) return new Response('{"message": "Missing Permissions"}', { status: 403 });
      rolesGiven.push(path);
      return new Response(null, { status: 204 });
    }
    const routes: Record<string, unknown> = {
      "/guilds/g": { id: "g", owner_id: "owner", roles: [{ id: "g", permissions: View }, { id: "buyer", permissions: "0" }] },
      "/guilds/g/threads/active": { threads: [freeThread, hiddenThread] },
      "/channels/free": { available_tags: [{ id: "t-looks", name: "Looks" }], permission_overwrites: [] },
      "/channels/paid": { available_tags: [], permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: View }, { id: "buyer", type: 0, allow: View, deny: "0" }] },
      "/channels/free/threads/archived/public": { threads: [], has_more: false },
      "/channels/paid/threads/archived/public": { threads: [paidThread], has_more: false },
      "/channels/1001/messages": hideEverything ? [{ ...hidden, id: "1001" }] : [...later, ...post("1001")],
      "/channels/2001/messages": post("2001"),
      "/channels/1001": freeThread,
      "/channels/1001/messages/1001": post("1001")[0],
      "/channels/1001/messages/999": olderZip,
      "/channels/1001/messages/1002": chatter,
      "/channels/1001/messages/1004": withPicture,
      "/channels/1001/messages/1005": twoPictures,
      "/channels/3001": hiddenThread,
      "/channels/3001/messages": [hiddenPublish, ...post("3001")],
      "/channels/3001/messages/3001": post("3001")[0],
      "/channels/3001/messages/3004": hiddenPublish,
      "/channels/3001/messages/3005": githubLink,
      "/channels/3001/messages/3006": webPage,
      "/channels/1001/messages/1006": hidden,
      "/channels/2001/messages/2001": post("2001")[0],
    };
    return path in routes ? ok(routes[path]) : new Response("{}", { status: 404 });
  }
  const person = people[auth.replace("Bearer ", "")];
  if (!person) return new Response("{}", { status: 401 });
  if (path === "/users/@me") return ok({ id: person.id, username: person.id, avatar: null });
  if (path === "/users/@me/guilds/g/member") return person.roles ? ok({ roles: person.roles }) : new Response("{}", { status: 404 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

// discord's half of the slash command signing, with a key made just for the tests
const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");

const env: Env = {
  FEED: memoryKv(),
  PRESENCE: { idFromName: () => "bot", get: () => ({ fetch: async () => new Response("{}") }) },
  BOT_TOKEN: "bot",
  CLIENT_SECRET: "secret",
  STORE_KEY: "test-store-key",
  CLIENT_ID: "client",
  PUBLIC_KEY: publicKey,
  GUILD_ID: "g",
  FORUMS: '[{"id": "free"}, {"id": "paid", "paid": true}]',
  INVITE_URL: "https://discord.gg/test",
  PUBLISHER_ROLE: "role-publisher",
  CHART_KEEPERS: "keeper, other-keeper",
  APP_REDIRECT: "mochy-modules://signed-in",
};
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
// signs the way an official build does: over the time, the method, the path and the session, or the sign-in's state
async function sign(method: string, path: string, extra: string, key = env.STORE_KEY, time = Math.floor(Date.now() / 1000)) {
  const hmac = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${time}\n${method}\n${path}\n${extra}`))).toString("hex");
  return { time: String(time), signature };
}

async function call(path: string, session?: string, method = "GET", signed = true): Promise<Response> {
  const url = new URL(`https://feed.test${path}`);
  const headers: Record<string, string> = session ? { Authorization: `Bearer ${session}` } : {};
  if (signed && url.pathname === "/login") {
    const { time, signature } = await sign("GET", "/login", url.searchParams.get("state") ?? "");
    url.searchParams.set("t", time);
    url.searchParams.set("sig", signature);
  } else if (signed) {
    const { time, signature } = await sign(method, url.pathname, session ?? "");
    headers["X-Mochy-Time"] = time;
    headers["X-Mochy-Sign"] = signature;
  }
  return worker.fetch(new Request(url, { method, headers }), env, ctx);
}

// signs in with a pretend discord code and digs the session out of the page that sends the browser back to the app
async function signIn(who: string): Promise<string> {
  const start = await call("/login?state=abcdefghijklmnop1234");
  assert.equal(start.status, 302);
  assert.match(start.headers.get("Location") ?? "", /scope=identify\+guilds\.members\.read/);
  const page = await (await call(`/callback?code=${who}&state=abcdefghijklmnop1234`)).text();
  const session = page.match(/session=([0-9a-f]{64})/)?.[1];
  assert.ok(session, "the page back to the app carries a session");
  assert.match(page, /state=abcdefghijklmnop1234/);
  return session;
}

// what /publish leaves behind, for the two posts the round trip expects in the store
const listing = { publisher: "maker", description: "", banner: null, previews: [], icon: null, publishedAt: 1 };

test("the whole round trip", async () => {
  await env.FEED.put("listing:1001", JSON.stringify(listing));
  await env.FEED.put("listing:2001", JSON.stringify(listing));
  const member = await signIn("member");
  // nothing read yet: the first ask starts the cron's work and says to come back
  assert.equal((await call("/modules", member)).status, 503);
  await Promise.all(pending);
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);

  const listed = (await (await call("/modules", member)).json()) as { me: { name: string; member: boolean }; modules: Array<Record<string, unknown>> };
  assert.deepEqual([listed.me.name, listed.me.member], ["u1", true]);
  const byName = Object.fromEntries(listed.modules.map((m) => [m.id, m]));
  assert.equal(listed.modules.length, 2);
  assert.equal(byName["1001"].name, "Liquid Glass");
  assert.equal(byName["1001"].moduleId, "liquid-glass");
  assert.equal(byName["1001"].kind, "look");
  assert.equal(byName["1001"].locked, false);
  assert.equal(byName["2001"].paid, true);
  assert.equal(byName["2001"].locked, true);
  assert.equal(byName["1001"].icon, "https://feed.test/icons/1001");

  const icon = await call("/icons/1001");
  assert.equal(icon.headers.get("Content-Type"), "image/png");

  const free = await call("/modules/1001/zip", member);
  assert.equal(free.status, 200);
  assert.equal((await free.arrayBuffer()).byteLength, zipBytes.length);
  assert.equal((await call("/modules/2001/zip", member)).status, 403);

  const buyer = await signIn("buyer");
  const bought = (await (await call("/modules", buyer)).json()) as { modules: Array<Record<string, unknown>> };
  assert.equal(bought.modules.find((m) => m.id === "2001")?.locked, false);
  assert.equal((await call("/modules/2001/zip", buyer)).status, 200);

  const outsider = await signIn("outsider");
  const refused = await call("/modules", outsider);
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { error: string }).error, "not_member");
  assert.equal((await call("/modules", "0".repeat(64))).status, 401);

  // a second run with nothing new in the posts reads no messages and no zips again
  const before = botCalls;
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  const perRun = botCalls - before;
  assert.ok(perRun <= 6, `an unchanged run asked discord ${perRun} times`);

  await call("/signout", member, "POST");
  assert.equal((await call("/modules", member)).status, 401);
});

// sends a slash command the way discord does, signed, and waits for the bot's answer
async function slash(body: Record<string, unknown>, sign = true): Promise<{ status: number; type?: number; answer?: string }> {
  const text = JSON.stringify({ application_id: "client", token: "t", ...body });
  const timestamp = "1700000000";
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(timestamp + (sign ? text : "tampered")));
  const headers = { "X-Signature-Ed25519": Buffer.from(signature).toString("hex"), "X-Signature-Timestamp": timestamp };
  const answered = answers.length;
  const response = await worker.fetch(new Request("https://feed.test/interactions", { method: "POST", body: text, headers }), env, ctx);
  await Promise.all(pending);
  if (response.status !== 200) return { status: response.status };
  return { status: 200, type: ((await response.json()) as { type: number }).type, answer: answers.slice(answered).join(" | ") };
}

// what a done command looks like: the private answer, the public message, and the private answer cleared away
const done = (text: string) => `${text} | public: ${text} | private answer cleared`;
const updated = done("Updated **Liquid Glass** to 2.2.");

const command = (name: string, who: string, message: string, permissions = "0", channel = "1001") =>
  slash({ type: 2, channel_id: channel, data: { name, options: [{ name: "message", value: message }] }, member: { user: { id: who }, permissions } });
const update = (who: string, message: string, permissions = "0", channel = "1001") => command("update", who, message, permissions, channel);

test("/update picks a message's zip and keeps it", async () => {
  assert.equal((await slash({ type: 1 }, false)).status, 401);
  assert.equal((await slash({ type: 1 })).type, 1);

  const done = await update("maker", "https://discord.com/channels/916351383341522994/1001/999");
  assert.equal(done.type, 5);
  assert.equal(done.answer, updated);
  assert.equal((await update("maker", "999")).answer, updated);
  assert.equal((await env.FEED.get("index", "json") as { modules: Array<{ id: string; zip: { message: string } }> }).modules.find((m) => m.id === "1001")?.zip.message, "999");

  // the next cron run keeps the pick even though a newer zip from the author sits in the post
  freeThread.last_message_id = "1003";
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  assert.equal((await env.FEED.get("index", "json") as { modules: Array<{ id: string; zip: { message: string } }> }).modules.find((m) => m.id === "1001")?.zip.message, "999");

  // but a zip the author posts after the pick takes over
  later.unshift({ ...olderZip, id: String(1n << 62n), attachments: [{ ...olderZip.attachments[0], id: "a-new" }] });
  freeThread.last_message_id = String(1n << 62n);
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  assert.equal((await env.FEED.get("index", "json") as { modules: Array<{ id: string; zip: { message: string } }> }).modules.find((m) => m.id === "1001")?.zip.message, String(1n << 62n));

  assert.match((await update("fan", "999")).answer ?? "", /Only the person who made this post can change it/);
  assert.equal((await update("mod", "999", String(1n << 34n))).answer, updated);
  assert.match((await update("maker", "1002")).answer ?? "", /couldn't find a \.zip/);
  assert.match((await update("maker", "999", "0", "elsewhere")).answer ?? "", /isn't in a module post/);
  assert.match((await update("maker", "not a link")).answer ?? "", /copy its link/);
});

test("publishing fills the store page", async () => {
  const listed = async () => {
    const member = await signIn("member");
    const body = (await (await call("/modules", member)).json()) as { modules: Array<Record<string, any>> };
    return Object.fromEntries(body.modules.map((m) => [m.id, m]));
  };
  assert.equal((await listed())["3001"], undefined, "a post nobody published stays out of the store");
  assert.match((await command("update", "maker2", "3004", "0", "3001")).answer ?? "", /Run \/publish on it first/);
  assert.match((await command("publish", "maker2", "3001", "0", "3001")).answer ?? "", /at least one picture/);

  assert.equal((await command("publish", "maker2", "3004", "0", "3001")).answer, done("Published **Unlisted Thing** 2.2."));
  assert.deepEqual(rolesGiven, ["/guilds/g/members/maker2/roles/role-publisher"]);
  let store = await listed();
  assert.equal(store["3001"].name, "Unlisted Thing");
  assert.equal(store["3001"].description, "Fresh look.");
  assert.equal(store["3001"].banner, "https://feed.test/pictures/3001/pic9");

  // pictures for the liquid glass post: two previews, then the first of them as its banner, then a new icon
  assert.equal((await command("preview", "maker", "1005")).answer, done("**Liquid Glass** has 2 new previews."));
  assert.equal((await command("banner", "maker", "1005")).answer, done("New banner for **Liquid Glass**."));
  assert.equal((await command("icon", "maker", "1004")).answer, done("New icon for **Liquid Glass**."));
  assert.match((await command("icon", "maker", "1002")).answer ?? "", /no pictures/);
  // a zip with a picture next to it updates the zip and makes the picture the banner
  assert.equal((await command("update", "maker", "1004")).answer, done("Updated **Liquid Glass** to 2.2."));
  store = await listed();
  assert.deepEqual(store["1001"].previews, ["https://feed.test/pictures/1001/pic2", "https://feed.test/pictures/1001/pic3"]);
  assert.equal(store["1001"].banner, "https://feed.test/pictures/1001/pic1");
  assert.equal(store["1001"].icon, "https://feed.test/pictures/1001/pic1");
  const served = await call("/pictures/1001/pic2");
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("Content-Type"), "image/png");

  // renaming the forum post renames the module at the next cron run
  hiddenThread.name = "[LOOKS] Renamed Thing";
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  assert.equal((await listed())["3001"].name, "Renamed Thing");

  // without the right to hand out roles the publish still goes through, and only the publisher hears about the role
  roleFails = true;
  assert.equal((await command("publish", "maker2", "3004", "0", "3001")).answer, "Published, but I couldn't hand out the publisher role. The bot needs Manage Roles, with its own role above that one. | public: Published **Renamed Thing** 2.2.");
});

test("publishing by link or as a web page, and hidden messages", async () => {
  const member = await signIn("member");
  const listed = async () => Object.fromEntries(((await (await call("/modules", member)).json()) as { modules: Array<Record<string, any>> }).modules.map((m) => [m.id, m]));

  assert.match((await command("publish", "maker", "1006")).answer ?? "", /Turn on Message Content Intent/);

  roleFails = false;
  assert.equal((await command("publishlink", "maker2", "3005", "0", "3001")).answer, done("Published **Renamed Thing**, added from its link."));
  let store = await listed();
  assert.equal(store["3001"].install, "link");
  assert.equal(store["3001"].link, "https://github.com/someone/glass-module");
  assert.equal(store["3001"].description, "Get it here and enjoy");
  assert.equal(store["3001"].author, "Maker Two");
  assert.equal(store["3001"].banner, "https://feed.test/pictures/3001/pic7");
  assert.equal((await call("/modules/3001/zip", member)).status, 404, "a linked module has no zip to hand out");
  assert.match((await command("update", "maker2", "3004", "0", "3001")).answer ?? "", /published as a link/);

  assert.equal((await command("publishweb", "maker2", "3006", "0", "3001")).answer, done("Published **Renamed Thing**, a web page."));
  assert.match((await command("publishweb", "maker2", "3004", "0", "3001")).answer ?? "", /web page's link and at least one picture/);

  // the cron keeps a web module as it is, and a post whose messages all come back hidden keeps its zip instead of leaving the store
  hideEverything = true;
  freeThread.last_message_id = "1007";
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  store = await listed();
  assert.equal(store["3001"].install, "web");
  assert.equal(store["3001"].link, "https://example.com/glass");
  assert.equal(store["1001"].install, "zip");
  assert.ok(store["1001"].size > 0, "the hidden post kept its zip");
  hideEverything = false;
});

test("the chart keepers fill best from community", async () => {
  const member = await signIn("member");
  const setChart = (who: string, lvl: number, post: string) =>
    slash({ type: 2, channel_id: "elsewhere", data: { name: "setchart", options: [{ name: "lvl", value: lvl }, { name: "post", value: post }] }, member: { user: { id: who }, permissions: String(1n << 3n) } });
  const store = async () => (await (await call("/modules", member)).json()) as { chart: string[]; categories: string[] };

  assert.match((await setChart("maker", 1, "1001")).answer ?? "", /Only the chart keepers/);
  assert.equal((await setChart("keeper", 1, "https://discord.com/channels/916351383341522994/1001")).answer, done("**Liquid Glass** is #1 on the chart."));
  assert.equal((await setChart("other-keeper", 3, "3001")).answer, done("**Renamed Thing** is #3 on the chart."));
  assert.deepEqual((await store()).chart, ["1001", "3001"]);
  // moving a module clears its old spot, and clear empties one
  await setChart("keeper", 2, "1001");
  assert.deepEqual(JSON.parse(String(await env.FEED.get("chart"))), [null, "1001", "3001", null, null]);
  assert.equal((await setChart("keeper", 3, "clear")).answer, done("Spot 3 on the chart is empty now."));
  assert.deepEqual((await store()).chart, ["1001"]);
  assert.match((await setChart("keeper", 6, "1001")).answer ?? "", /from 1 to 5/);
  assert.match((await setChart("keeper", 1, "nonsense")).answer ?? "", /its link, or its id/);
  assert.deepEqual((await store()).categories, ["Looks"], "the forum tags are the store's categories");
});

test("only official builds get in", async () => {
  const member = await signIn("member");
  const turnedAway = async (response: Response) => {
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: string }).error, "unofficial_build");
  };
  await turnedAway(await call("/modules", member, "GET", false));
  await turnedAway(await call("/login?state=abcdefghijklmnop1234", undefined, "GET", false));
  // a fork's own key, a signature for another path, and one from ten minutes ago are all turned away
  const forged = await sign("GET", "/modules", member, "a-fork-key");
  await turnedAway(await worker.fetch(new Request("https://feed.test/modules", { headers: { Authorization: `Bearer ${member}`, "X-Mochy-Time": forged.time, "X-Mochy-Sign": forged.signature } }), env, ctx));
  const elsewhere = await sign("GET", "/me", member);
  await turnedAway(await worker.fetch(new Request("https://feed.test/modules", { headers: { Authorization: `Bearer ${member}`, "X-Mochy-Time": elsewhere.time, "X-Mochy-Sign": elsewhere.signature } }), env, ctx));
  const stale = await sign("GET", "/modules", member, env.STORE_KEY, Math.floor(Date.now() / 1000) - 600);
  await turnedAway(await worker.fetch(new Request("https://feed.test/modules", { headers: { Authorization: `Bearer ${member}`, "X-Mochy-Time": stale.time, "X-Mochy-Sign": stale.signature } }), env, ctx));
  assert.equal((await call("/modules", member)).status, 200, "an official build still gets in");
  // pictures and signing out need no signature
  assert.equal((await call("/pictures/1001/pic2", undefined, "GET", false)).status, 200);
  assert.equal((await call("/signout", member, "POST", false)).status, 200);
});

// a command that answers straight away, with what it said and whether everyone sees it
async function quick(name: string, onlyYou = false): Promise<string> {
  const text = JSON.stringify({ application_id: "client", token: "t", type: 2, data: { name } });
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode("1" + text));
  const response = await worker.fetch(new Request("https://feed.test/interactions", { method: "POST", body: text, headers: { "X-Signature-Ed25519": Buffer.from(signature).toString("hex"), "X-Signature-Timestamp": "1" } }), env, ctx);
  const body = (await response.json()) as { type: number; data: { content: string; flags?: number } };
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, onlyYou ? 1 << 6 : undefined);
  return body.data.content;
}

test("/whatis and /src answer everyone with their links", async () => {
  assert.equal(await quick("whatis"), "here son https://realidkroo.github.io/Mochy-Music/wiki/#modules-types");
  assert.equal(await quick("src"), "https://github.com/ryukeicii/mochy-modulebot");
});

test("/help lists every command, only for whoever asked", async () => {
  const help = await quick("help", true);
  for (const command of CommandList) assert.ok(help.includes(`\`/${command.name}\``), `/help mentions /${command.name}`);
  assert.ok(help.length < 2000, "fits in one discord message");
  for (const command of CommandList) assert.ok(command.description.length <= 100, `/${command.name}'s description fits discord`);
});
