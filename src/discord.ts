// discord's rest api, as the bot (reading the forums), as a signed-in person (checking they're in the server) or as a slash command's reply

import type { Env } from "./env.ts";

const Api = "https://discord.com/api/v10";

export class DiscordError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`discord said ${status}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

// one wait for a rate limit, then it gives up, so a cron run never hangs on discord
async function call(path: string, auth: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...(auth ? { Authorization: auth } : {}), "User-Agent": "MochyModuleFeed (https://github.com/realidkroo, 1.0)", ...init.headers };
  const send = () => fetch(Api + path, { ...init, headers });
  let response = await send();
  if (response.status === 429) {
    const retry = Number((await response.clone().json().catch(() => ({})) as { retry_after?: number }).retry_after ?? 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(retry, 10) * 1000));
    response = await send();
  }
  return response;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new DiscordError(response.status, await response.text());
  return (await response.json()) as T;
}

export const bot = <T>(env: Env, path: string) => call(path, `Bot ${env.BOT_TOKEN}`).then((r) => json<T>(r));

// changes something as the bot, like handing someone a role
export async function botWrite(env: Env, method: string, path: string): Promise<void> {
  const response = await call(path, `Bot ${env.BOT_TOKEN}`, { method });
  if (!response.ok) throw new DiscordError(response.status, await response.text());
}

export const asUser = (token: string, path: string) => call(path, `Bearer ${token}`);

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

// swaps a sign-in code, or a refresh token, for a person's tokens; the secret never leaves the worker
export async function tokens(env: Env, grant: Record<string, string>): Promise<Tokens> {
  const body = new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, ...grant });
  return json<Tokens>(await call("/oauth2/token", "", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
}

// a slash command's own answers; the interaction's token is the key, so the bot needs no right to post in the channel
async function webhook(method: string, path: string, content?: string): Promise<void> {
  const body = content === undefined ? undefined : JSON.stringify({ content, allowed_mentions: { parse: [] } });
  const response = await call(path, "", { method, body, headers: { "Content-Type": "application/json" } });
  if (!response.ok) throw new DiscordError(response.status, await response.text());
}

// swaps the "thinking..." for the real answer, seen by whoever the first answer was for
export const editReply = (applicationId: string, token: string, content: string) =>
  webhook("PATCH", `/webhooks/${applicationId}/${token}/messages/@original`, content);

// a new message everyone in the channel sees
export const followUp = (applicationId: string, token: string, content: string) =>
  webhook("POST", `/webhooks/${applicationId}/${token}`, content);

export const deleteReply = (applicationId: string, token: string) =>
  webhook("DELETE", `/webhooks/${applicationId}/${token}/messages/@original`);

export interface Thread {
  id: string;
  name: string;
  parent_id: string;
  owner_id: string;
  last_message_id: string | null;
  applied_tags?: string[];
  thread_metadata?: { archived: boolean; archive_timestamp?: string; create_timestamp?: string };
}

export interface Attachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  content_type?: string;
}

export interface Message {
  id: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null };
  attachments: Attachment[];
}

// a forum's archived posts, newest first; posts go quiet and archive themselves, so most modules end up here
export async function archivedThreads(env: Env, forumId: string, max = 300): Promise<Thread[]> {
  const found: Thread[] = [];
  let before: string | undefined;
  while (found.length < max) {
    const query = before ? `?limit=100&before=${encodeURIComponent(before)}` : "?limit=100";
    const page = await bot<{ threads: Thread[]; has_more: boolean }>(env, `/channels/${forumId}/threads/archived/public${query}`);
    found.push(...page.threads);
    const last = page.threads[page.threads.length - 1];
    before = last?.thread_metadata?.archive_timestamp;
    if (!page.has_more || !before) break;
  }
  return found;
}
