// mochy's module feed: discord sign-in for the app, the module list for people in the server, and the zips; a cron and the module commands keep the list fresh, and the bot stays online

import { commandPayloads } from "./catalog.ts";
import { attachmentsOf, bot, botWrite, tokens, type Message } from "./discord.ts";
import type { Context, Env } from "./env.ts";
import { buildIndex, loadIndex, type FeedIndex, type FeedModule } from "./feed.ts";
import { interaction } from "./interactions.ts";
import type { Picture } from "./listing.ts";
import { loadChart } from "./chart.ts";
import { signedByOfficialBuild } from "./official.ts";
import { canView } from "./permissions.ts";
import { forget, fromTokens, load, newSessionId, save, type Session } from "./session.ts";

export { Presence } from "./presence.ts";

// who they are, and which roles they have in the server, which is all the paid forum's lock needs
const Scopes = "identify guilds.members.read";
let commandsCheckedAt = 0;

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const url = new URL(request.url);
    if (commandsCheckedAt === 0 || (commandsCheckedAt > 0 && Date.now() - commandsCheckedAt > 60_000)) {
      commandsCheckedAt = Date.now();
      ctx.waitUntil(syncCommands(env));
    }
    try {
      if (request.method === "POST" && url.pathname === "/interactions") return await interaction(request, env, ctx);
      if (request.method === "GET" && url.pathname === "/login") {
        const state = url.searchParams.get("state") ?? "";
        if (!(await signedByOfficialBuild(env, url.searchParams.get("t"), url.searchParams.get("sig"), "GET", "/login", state))) return unofficial();
        return await login(url, env);
      }
      if (request.method === "GET" && url.pathname === "/callback") return await callback(url, env);
      if (request.method === "GET" && url.pathname.startsWith("/icons/")) return await icon(url.pathname.slice(7), env);
      if (request.method === "GET" && url.pathname.startsWith("/pictures/")) return await picture(url.pathname.slice(10), env);
      // check the official build signature before touching kv or discord, so unsigned traffic can't trigger session lookups or token refreshes
      const bearer = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
      const signature = [request.headers.get("X-Mochy-Time"), request.headers.get("X-Mochy-Sign")] as const;
      if (!(await signedByOfficialBuild(env, signature[0], signature[1], request.method, url.pathname, bearer))) return unofficial();
      const signedIn = await load(env, request);
      if (request.method === "POST" && url.pathname === "/signout") {
        if (signedIn) await forget(env, signedIn.id);
        return json({ ok: true });
      }
      if (!signedIn) return json({ error: "signed_out" }, 401);
      const { session } = signedIn;
      if (request.method === "GET" && url.pathname === "/me") return json(me(session, env));
      if (!session.member) return json({ error: "not_member", invite: env.INVITE_URL, ...me(session, env) }, 403);
      const index = await loadIndex(env);
      if (!index) {
        ctx.waitUntil(buildIndex(env));
        return json({ error: "warming_up" }, 503);
      }
      if (request.method === "GET" && url.pathname === "/modules") {
        const modules = listFor(index, session, url.origin);
        // only spots holding a module this person can see; the app keeps them in chart order
        const shown = new Set(modules.map((m) => m.id));
        const chart = (await loadChart(env)).filter((id): id is string => !!id && shown.has(id));
        return json({ updated: index.updated, me: me(session, env), chart, categories: index.categories ?? [], modules });
      }
      const zip = url.pathname.match(/^\/modules\/(\d+)\/zip$/);
      if (request.method === "GET" && zip) return await download(zip[1], index, session, env, url.searchParams.get("item"));
      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.log(`${url.pathname} failed: ${(e as Error).stack ?? e}`);
      return json({ error: "server" }, 500);
    }
  },

  async scheduled(_event: unknown, env: Env, ctx: Context): Promise<void> {
    ctx.waitUntil(syncCommands(env));
    ctx.waitUntil(buildIndex(env));
    ctx.waitUntil(keepOnline(env));
  },
};

// pushes changed slash commands to discord using the worker's own bot token, skipping when the hash already matches
async function syncCommands(env: Env): Promise<void> {
  try {
    const payload = commandPayloads();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if ((await env.FEED.get("commands_hash")) === hash) {
      commandsCheckedAt = -1;
      return;
    }
    await botWrite(env, "PUT", `/applications/${env.CLIENT_ID}/guilds/${env.GUILD_ID}/commands`, payload);
    // latch synced once discord accepted the commands, even if kv daily writes are full
    commandsCheckedAt = -1;
    await env.FEED.put("commands_hash", hash).catch((e) => console.log(`couldn't store commands_hash: ${(e as Error).message}`));
  } catch (e) {
    console.log(`couldn't sync slash commands: ${(e as Error).message}`);
  }
}

// wakes the bot's gateway connection if it ever stopped, so it's never offline for more than a cron run
async function keepOnline(env: Env): Promise<void> {
  try {
    await env.PRESENCE.get(env.PRESENCE.idFromName("bot")).fetch("https://presence/");
  } catch (e) {
    console.log(`couldn't wake the bot: ${(e as Error).message}`);
  }
}

// a pack's size is all its zips together, null when it's only links
function packSize(m: FeedModule): number | null {
  const sizes = (m.listing.pack ?? []).map((item) => item.size).filter((size): size is number => size != null);
  return sizes.length ? sizes.reduce((a, b) => a + b, 0) : null;
}

// discord ids carry the time they were made, in milliseconds since the start of 2015
function snowflakeTime(id: string): number {
  return Number(BigInt(id) >> 22n) + 1420070400000;
}

// what a fork or a changed copy gets; the app shows its "you're using a fork" page for it
function unofficial(): Response {
  return json({ error: "unofficial_build" }, 403);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function me(session: Session, env: Env) {
  return { name: session.name, avatar: session.avatar, member: session.member, invite: env.INVITE_URL };
}

// stateless hmac-signed oauth state so /callback only accepts sign-ins that started at a signed /login, with zero kv writes
const LoginStateTtlSeconds = 600;
const StatePattern = /^[A-Za-z0-9_-]{16,128}$/;

async function signOAuthState(env: Env, state: string, time: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STORE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`oauth\n${time}\n${state}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${state}.${time}.${hex}`;
}

async function verifyOAuthState(env: Env, raw: string): Promise<string | null> {
  const parts = raw.split(".");
  if (parts.length !== 3 || !env.STORE_KEY) return null;
  const [state, timeStr, sigHex] = parts;
  if (!StatePattern.test(state) || !/^\d+$/.test(timeStr) || !/^[0-9a-f]{64}$/i.test(sigHex)) return null;
  if (Math.abs(Date.now() / 1000 - Number(timeStr)) > LoginStateTtlSeconds) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STORE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const given = new Uint8Array(sigHex.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const ok = await crypto.subtle.verify("HMAC", key, given, new TextEncoder().encode(`oauth\n${timeStr}\n${state}`));
  return ok ? state : null;
}

// the app's own state comes back with the session, so the app knows the sign-in it gets back is the one it started
async function login(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  if (!StatePattern.test(state)) return json({ error: "bad_state" }, 400);
  const signedState = await signOAuthState(env, state, Math.floor(Date.now() / 1000));
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.search = new URLSearchParams({
    client_id: env.CLIENT_ID,
    response_type: "code",
    redirect_uri: `${url.origin}/callback`,
    scope: Scopes,
    state: signedState,
    prompt: "none",
  }).toString();
  return Response.redirect(authorize.toString(), 302);
}

async function callback(url: URL, env: Env): Promise<Response> {
  const state = await verifyOAuthState(env, url.searchParams.get("state") ?? "");
  if (!state) return unofficial();
  const code = url.searchParams.get("code");
  const back = new URL(env.APP_REDIRECT);
  back.searchParams.set("state", state);
  if (!code) {
    back.searchParams.set("error", url.searchParams.get("error") ?? "cancelled");
    return backToApp(back);
  }
  const granted = await tokens(env, { grant_type: "authorization_code", code, redirect_uri: `${url.origin}/callback` });
  const id = newSessionId();
  await save(env, id, await fromTokens(env, granted));
  back.searchParams.set("session", id);
  return backToApp(back);
}

// a page rather than a bare redirect: some browsers won't follow a redirect into an app on their own, so there's a button too
function backToApp(target: URL): Response {
  const link = target.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${link}"><title>Back to Mochy</title>
<body style="background:#000;color:#fff;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<a href="${link}" style="color:#000;background:#fff;padding:14px 22px;border-radius:999px;text-decoration:none;font-weight:600">Back to Mochy</a>
<script>location.replace(${JSON.stringify(target.toString())})</script></body>`;
  return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// a forum they can't see in discord isn't listed, except a paid one, which shows locked so people know it's there
function lockedFor(module: FeedModule, index: FeedIndex, session: Session): boolean | null {
  const forum = index.forums[module.forum];
  if (!forum) return null;
  const visible = canView(index.guild, session.userId, session.roles, forum.overwrites);
  if (visible) return false;
  return module.paid ? true : null;
}

function listFor(index: FeedIndex, session: Session, origin: string) {
  return index.modules.flatMap((m) => {
    const locked = lockedFor(m, index, session);
    if (locked === null) return [];
    const picture = (p: Picture) => `${origin}/pictures/${m.id}/${p.id}`;
    return [{
      id: m.id,
      name: m.name,
      moduleId: m.moduleId,
      version: m.version,
      author: m.author,
      description: m.listing.description || m.description,
      kind: m.kind,
      tags: m.tags,
      paid: m.paid,
      locked,
      install: m.listing.install ?? "zip",
      link: m.listing.link ?? null,
      icon: m.listing.icon ? picture(m.listing.icon) : m.hasIcon ? `${origin}/icons/${m.id}` : null,
      banner: m.listing.banner ? picture(m.listing.banner) : null,
      previews: m.listing.previews.map(picture),
      postUrl: m.postUrl,
      size: m.zip?.size ?? packSize(m),
      // a pack's modules, each added on its own; a zip comes from /modules/<post>/zip?item=<its id>
      pack: (m.listing.pack ?? []).map((item) => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        moduleId: item.moduleId,
        version: item.version,
        size: item.size,
        icon: item.icon ? picture(item.icon) : null,
        link: item.link,
      })),
      // when it last changed, in milliseconds: the zip's message for a zip, the last publish for a link
      updated: m.zip ? snowflakeTime(m.zip.message) : (m.listing.updatedAt ?? m.listing.publishedAt),
    }];
  });
}

// the zip comes through here: discord's own file links run out after a day, so a fresh one is asked for every time
async function download(postId: string, index: FeedIndex, session: Session, env: Env, item: string | null): Promise<Response> {
  const module = index.modules.find((m) => m.id === postId);
  if (!module) return json({ error: "not_found" }, 404);
  const locked = lockedFor(module, index, session);
  if (locked === null) return json({ error: "not_found" }, 404);
  if (locked) return json({ error: "locked" }, 403);
  // a linked module is added from its link, so there's no zip to hand over
  // a pack's zip is one of its items; anything else has one zip of its own, or none for a link
  const packed = item ? module.listing.pack?.find((p) => p.kind === "zip" && p.id === item) : null;
  if (item && !packed) return json({ error: "not_found" }, 404);
  const zip = packed?.message ? { message: packed.message, attachment: packed.id } : module.zip;
  if (!zip) return json({ error: "not_a_zip" }, 404);
  const message = await bot<Message>(env, `/channels/${postId}/messages/${zip.message}`);
  const files = attachmentsOf(message);
  const attachment = files.find((a) => a.id === zip.attachment) ?? files.find((a) => a.filename.toLowerCase().endsWith(".zip"));
  if (!attachment) return json({ error: "gone" }, 410);
  const file = await fetch(attachment.url);
  if (!file.ok || !file.body) return json({ error: "gone" }, 502);
  return new Response(file.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${attachment.filename.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}

// a store page's banner, previews or icon; each picture's address carries its own id, so it can be kept for good
async function picture(path: string, env: Env): Promise<Response> {
  const parts = path.match(/^(\d+)\/(\w+)$/);
  if (!parts) return json({ error: "not_found" }, 404);
  const { value, metadata } = await env.FEED.getWithMetadata(`picture:${parts[1]}:${parts[2]}`, "arrayBuffer");
  if (!value) return json({ error: "not_found" }, 404);
  const type = (metadata as { type?: string } | null)?.type ?? "image/png";
  return new Response(value, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" } });
}

async function icon(postId: string, env: Env): Promise<Response> {
  if (!/^\d+$/.test(postId)) return json({ error: "not_found" }, 404);
  const { value, metadata } = await env.FEED.getWithMetadata(`icon:${postId}`, "arrayBuffer");
  if (!value) return json({ error: "not_found" }, 404);
  const type = (metadata as { type?: string } | null)?.type ?? "image/png";
  return new Response(value, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600" } });
}
