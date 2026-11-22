// a signed-in person, kept by the worker: the app only ever holds a random session id, never their discord tokens

import { asUser, DiscordError, tokens, type Tokens } from "./discord.ts";
import type { Env } from "./env.ts";
import { deleteKey, getJson, putJson } from "./store.ts";

// roles and membership are asked again this often, so a newly bought role or a kick shows up while keeping writes minimal
const RecheckMs = 60 * 60 * 1000;
const SessionTtlSeconds = 60 * 24 * 60 * 60;

const askedAt = new Map<string, number>();

export interface Session {
  userId: string;
  name: string;
  avatar: string | null;
  member: boolean;
  roles: string[];
  checked: number;
  access: string;
  refresh: string;
  expiresAt: number;
}

// sessions are stored under a hash of their id, so a peek at the storage can't be used to sign in as anyone
async function keyOf(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return "session:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newSessionId(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function save(env: Env, id: string, session: Session): Promise<void> {
  await putJson(env, await keyOf(id), session, SessionTtlSeconds);
}

export async function forget(env: Env, id: string): Promise<void> {
  await deleteKey(env, await keyOf(id));
}

export async function fromTokens(env: Env, granted: Tokens): Promise<Session> {
  const me = await asUser(granted.access_token, "/users/@me");
  if (!me.ok) throw new DiscordError(me.status, await me.text());
  const user = (await me.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };
  const session: Session = {
    userId: user.id,
    name: user.global_name || user.username,
    avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null,
    member: false,
    roles: [],
    checked: 0,
    access: granted.access_token,
    refresh: granted.refresh_token,
    expiresAt: Date.now() + granted.expires_in * 1000,
  };
  return (await recheck(env, session, true)) ?? session;
}

// the session behind an app's bearer id, with membership asked again when it's gone stale; null when it's gone or discord dropped the sign-in
export async function load(env: Env, request: Request): Promise<{ id: string; session: Session } | null> {
  const id = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return null;
  const stored = await getJson<Session>(env, await keyOf(id));
  if (!stored) return null;
  // the stored time isn't bumped on every check, so this worker remembers when it last asked discord
  const lastAsked = askedAt.get(id);
  if (stored.member && lastAsked && Date.now() - lastAsked < RecheckMs) return { id, session: stored };
  const session = await recheck(env, stored, false);
  if (session) askedAt.set(id, Date.now());
  if (!session) {
    await forget(env, id).catch(() => {});
    return null;
  }
  if (changed(stored, session)) await save(env, id, session).catch((e) => console.log(`couldn't update session: ${(e as Error).message}`));
  return { id, session };
}

// only something that matters is worth a kv write; the checked time alone isn't, it just means we look again next hour
function changed(before: Session, after: Session): boolean {
  return before.member !== after.member || before.access !== after.access || before.roles.join() !== after.roles.join();
}

async function recheck(env: Env, session: Session, force: boolean): Promise<Session | null> {
  // someone not in the server yet is asked every time, so "i've joined, check again" works straight away
  if (!force && session.member && Date.now() - session.checked < RecheckMs) return session;
  let current = session;
  if (Date.now() > session.expiresAt - 60_000) {
    try {
      const renewed = await tokens(env, { grant_type: "refresh_token", refresh_token: session.refresh });
      current = { ...session, access: renewed.access_token, refresh: renewed.refresh_token, expiresAt: Date.now() + renewed.expires_in * 1000 };
    } catch {
      return null;
    }
  }
  const member = await asUser(current.access, `/users/@me/guilds/${env.GUILD_ID}/member`);
  if (member.status === 401) return null;
  if (member.ok) {
    const body = (await member.json()) as { roles?: string[] };
    return { ...current, member: true, roles: body.roles ?? [], checked: Date.now() };
  }
  // not in the server (or discord is having a moment): they can still see who they're signed in as and the join button
  if (member.status === 404 || member.status === 403) return { ...current, member: false, roles: [], checked: Date.now() };
  return current;
}
