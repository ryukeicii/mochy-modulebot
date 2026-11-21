// mochy's module feed: discord sign-in for the app, the module list for people in the server, and the zips; a cron and the module commands keep the list fresh, and the bot stays online

import { bot, tokens, type Message } from "./discord.ts";
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

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/interactions") return await interaction(request, env, ctx);
      if (request.method === "GET" && url.pathname === "/login") {
        const state = url.searchParams.get("state") ?? "";
        if (!(await signedByOfficialBuild(env, url.searchParams.get("t"), url.searchParams.get("sig"), "GET", "/login", state))) return unofficial();
        return login(url, env);
      }
      if (request.method === "GET" && url.pathname === "/callback") return await callback(url, env);
      if (request.method === "GET" && url.pathname.startsWith("/icons/")) return await icon(url.pathname.slice(7), env);
      if (request.method === "GET" && url.pathname.startsWith("/pictures/")) return await picture(url.pathname.slice(10), env);
      const signedIn = await load(env, request);
      if (request.method === "POST" && url.pathname === "/signout") {
        if (signedIn) await forget(env, signedIn.id);
        return json({ ok: true });
      }
      const bearer = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      const signature = [request.headers.get("X-Mochy-Time"), request.headers.get("X-Mochy-Sign")] as const;
      if (!(await signedByOfficialBuild(env, signature[0], signature[1], request.method, url.pathname, bearer))) return unofficial();
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
      if (request.method === "GET" && zip) return await download(zip[1], index, session, env);
      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.log(`${url.pathname} failed: ${(e as Error).stack ?? e}`);
      return json({ error: "server" }, 500);
    }
  },

  async scheduled(_event: unknown, env: Env, ctx: Context): Promise<void> {
    ctx.waitUntil(buildIndex(env));
    ctx.waitUntil(keepOnline(env));
  },
};

// wakes the bot's gateway connection if it ever stopped, so it's never offline for more than a cron run
async function keepOnline(env: Env): Promise<void> {
  try {
    await env.PRESENCE.get(env.PRESENCE.idFromName("bot")).fetch("https://presence/");
  } catch (e) {
    console.log(`couldn't wake the bot: ${(e as Error).message}`);
  }
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

// the app's own state comes back with the session, so the app knows the sign-in it gets back is the one it started
function login(url: URL, env: Env): Response {
  const state = url.searchParams.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return json({ error: "bad_state" }, 400);
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.search = new URLSearchParams({
    client_id: env.CLIENT_ID,
    response_type: "code",
    redirect_uri: `${url.origin}/callback`,
    scope: Scopes,
    state,
    prompt: "none",
  }).toString();
  return Response.redirect(authorize.toString(), 302);
}

async function callback(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
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
      size: m.zip?.size ?? null,
    }];
  });
}

// the zip comes through here: discord's own file links run out after a day, so a fresh one is asked for every time
async function download(postId: string, index: FeedIndex, session: Session, env: Env): Promise<Response> {
  const module = index.modules.find((m) => m.id === postId);
  if (!module) return json({ error: "not_found" }, 404);
  const locked = lockedFor(module, index, session);
  if (locked === null) return json({ error: "not_found" }, 404);
  if (locked) return json({ error: "locked" }, 403);
  // a linked module is added from its link, so there's no zip to hand over
  const zip = module.zip;
  if (!zip) return json({ error: "not_a_zip" }, 404);
  const message = await bot<Message>(env, `/channels/${postId}/messages/${zip.message}`);
  const attachment = message.attachments.find((a) => a.id === zip.attachment) ?? message.attachments.find((a) => a.filename.toLowerCase().endsWith(".zip"));
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
