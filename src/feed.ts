// reads every module forum on a timer and keeps one index of the published modules in them, plus what's needed to tell who may see the paid ones

import { archivedThreads, attachmentsOf, bot, looksHidden, type Message, type Thread } from "./discord.ts";
import { forumsOf, type Env, type Forum } from "./env.ts";
import { loadListing, type Listing } from "./listing.ts";
import type { GuildFacts, Overwrite } from "./permissions.ts";
import { cleanTitle, isPaid, kindOf, summary, text, type Kind } from "./posts.ts";
import { deleteBlob, deleteKey, getJson, listJsonByPrefix, putBlob, putJson } from "./store.ts";
import { readModuleZip } from "./zip.ts";

// bigger than any look or source module should be; bigger zips are skipped rather than read on every run
const MaxZipBytes = 15 * 1024 * 1024;

// what the post's own zip says, kept so a post nobody touched isn't downloaded again
export interface PostRead {
  id: string;
  manifestName: string | null;
  moduleId: string | null;
  version: string | null;
  author: string | null;
  description: string;
  // which of the manifest's parts it has, for working out its kind when the post has no tags
  hints: Record<string, boolean>;
  hasIcon: boolean;
  created: string | null;
  // null for a module published as a link or a web page
  zip: { message: string; attachment: string; filename: string; size: number } | null;
  lastMessageId: string | null;
}

export interface FeedModule extends PostRead {
  listing: Listing;
  forum: string;
  // the forum post's title, so renaming the post renames the module
  name: string;
  kind: Kind;
  tags: string[];
  paid: boolean;
  postUrl: string;
}

export interface FeedIndex {
  updated: number;
  modules: FeedModule[];
  // every forum's tags in the forum's own order, which the store shows as its categories
  categories: string[];
  guild: GuildFacts;
  forums: Record<string, { paid: boolean; overwrites: Overwrite[] }>;
}

interface Channel {
  available_tags?: Array<{ id: string; name: string }>;
  permission_overwrites?: Overwrite[];
}

export async function loadIndex(env: Env): Promise<FeedIndex | null> {
  return getJson<FeedIndex>(env, "index");
}

export async function buildIndex(env: Env): Promise<FeedIndex> {
  const existing = await loadIndex(env);
  const previous = new Map(existing?.modules.map((m) => [m.id, m]) ?? []);
  const allListings = await listJsonByPrefix<Listing>(env, "listing:");
  const info = await bot<{ id: string; owner_id: string; roles: Array<{ id: string; permissions: string }> }>(env, `/guilds/${env.GUILD_ID}`);
  const guild: GuildFacts = { id: info.id, ownerId: info.owner_id, roles: info.roles.map((r) => ({ id: r.id, permissions: r.permissions })) };
  const active = await bot<{ threads: Thread[] }>(env, `/guilds/${env.GUILD_ID}/threads/active`);
  const modules: FeedModule[] = [];
  const categories = new Set<string>();
  const forums: FeedIndex["forums"] = {};
  for (const forum of forumsOf(env)) {
    const channel = await bot<Channel>(env, `/channels/${forum.id}`);
    forums[forum.id] = { paid: forum.paid, overwrites: channel.permission_overwrites ?? [] };
    const tagNames = tagsOf(channel);
    for (const name of tagNames.values()) categories.add(name);
    const threads = [...active.threads.filter((t) => t.parent_id === forum.id), ...(await archivedThreads(env, forum.id))];
    for (const thread of threads) {
      // a post stays out of the store until its maker runs /publish
      const listing = allListings.get(thread.id);
      if (!listing) continue;
      if (isLinked(listing)) {
        modules.push(toModule(env, forum, tagNames, thread, linkedRead(thread, listing), listing));
        continue;
      }
      const known = previous.get(thread.id);
      let read: PostRead | null;
      try {
        // the zip is only read again when the post moved
        read = known && known.lastMessageId === thread.last_message_id ? known : await readPost(env, thread, known);
      } catch (e) {
        // one broken post shouldn't empty the whole feed; it keeps what it had last time
        console.log(`couldn't read post ${thread.id}: ${(e as Error).message}`);
        read = known ?? null;
      }
      if (read) modules.push(toModule(env, forum, tagNames, thread, read, listing));
    }
  }
  modules.sort(newestFirst);
  const latest = await loadIndex(env);
  const index: FeedIndex = { updated: Date.now(), modules, categories: [...categories], guild, forums };
  // skip the write when nothing changed since the last cron run
  const same = latest && JSON.stringify({ ...latest, updated: 0 }) === JSON.stringify({ ...index, updated: 0 });
  if (!same) await putJson(env, "index", index);
  return same ? latest : index;
}

// reads the zip on the message someone picked with a command and makes it the post's zip from now on; null when it isn't a module, and nothing changes
export async function pickZip(env: Env, thread: Thread, message: Message): Promise<PostRead | null> {
  const starter = await bot<Message>(env, `/channels/${thread.id}/messages/${thread.id}`).catch(() => null);
  const read = await readZip(env, thread, message, starter);
  if (!read) return null;
  const pick: Pick = { message: message.id, at: snowflakeNow() };
  await putJson(env, `pick:${thread.id}`, pick);
  return read;
}

// puts one post into the list straight away, so a command's change shows without waiting for the cron
export async function refreshPost(env: Env, thread: Thread, read?: PostRead): Promise<FeedModule | null> {
  const forum = forumsOf(env).find((f) => f.id === thread.parent_id);
  if (!forum) return null;
  const index = await loadIndex(env);
  // the first list isn't in yet, so building it reads this post too
  if (!index) return (await buildIndex(env)).modules.find((m) => m.id === thread.id) ?? null;
  const listing = await loadListing(env, thread.id);
  if (!listing) return null;
  const known = index.modules.find((m) => m.id === thread.id && m.zip);
  const postRead = isLinked(listing) ? linkedRead(thread, listing) : read ?? known ?? (await readPost(env, thread));
  if (!postRead) return null;
  const module = toModule(env, forum, tagsOf(await bot<Channel>(env, `/channels/${forum.id}`)), thread, postRead, listing);
  index.modules = [...index.modules.filter((m) => m.id !== thread.id), module].sort(newestFirst);
  index.updated = Date.now();
  await putJson(env, "index", index);
  return module;
}

// drops an unpublished post from the cached index right away, along with its cached icon and zip pick
export async function removePost(env: Env, postId: string): Promise<void> {
  await Promise.all([deleteBlob(env, `icon:${postId}`), deleteKey(env, `pick:${postId}`)]);
  const index = await loadIndex(env);
  if (!index) return;
  const next = index.modules.filter((m) => m.id !== postId);
  if (next.length === index.modules.length) return;
  index.modules = next;
  index.updated = Date.now();
  await putJson(env, "index", index);
}

// tags and titles change without a new message, so they're always taken from the post as it is now
function toModule(env: Env, forum: Forum, tagNames: Map<string, string>, thread: Thread, read: PostRead, listing: Listing): FeedModule {
  const tags = (thread.applied_tags ?? []).map((id) => tagNames.get(id)).filter((n): n is string => !!n);
  return {
    ...read,
    listing,
    forum: forum.id,
    name: cleanTitle(thread.name),
    kind: kindOf(tags, thread.name, read.hints),
    tags,
    paid: isPaid(tags, forum.paid),
    postUrl: `https://discord.com/channels/${env.GUILD_ID}/${thread.id}`,
  };
}

// a post with no zip of its own to read: a link, a web page, or a pack, whose zips are read when it's published
function isLinked(listing: Listing): boolean {
  return listing.install === "link" || listing.install === "web" || listing.install === "pack";
}

// a module published as a link has no zip to read, so the store shows what the post and its listing say
function linkedRead(thread: Thread, listing: Listing): PostRead {
  return {
    id: thread.id,
    manifestName: null,
    moduleId: null,
    version: null,
    author: listing.author ?? null,
    description: "",
    hints: {},
    hasIcon: false,
    created: thread.thread_metadata?.create_timestamp ?? null,
    zip: null,
    lastMessageId: thread.last_message_id,
  };
}

function tagsOf(channel: Channel): Map<string, string> {
  return new Map((channel.available_tags ?? []).map((t) => [t.id, t.name]));
}

function newestFirst(a: FeedModule, b: FeedModule): number {
  return (b.created ?? "").localeCompare(a.created ?? "");
}

const ManifestParts = ["player", "glass", "look", "font", "pages", "base", "search", "stream", "lyrics"];

// a zip picked with /update, and when; it stays the post's module until the author posts a newer zip
interface Pick {
  message: string;
  at: string;
}

// the zip picked with /update, or else the newest one the post's own author attached; a later zip in the same post is an update
async function readPost(env: Env, thread: Thread, known?: PostRead): Promise<PostRead | null> {
  const messages = await bot<Message[]>(env, `/channels/${thread.id}/messages?limit=50`);
  // with message content hidden every post would look zipless and fall out of the store, so the run keeps what it had instead
  if (messages.length && messages.every(looksHidden)) throw new Error("every message came back empty; message content intent is off");
  const starter = messages.find((m) => m.id === thread.id) ?? null;
  const newest = messages.find((m) => m.author.id === thread.owner_id && m.attachments.some(isZip));
  const pick = await getJson<Pick>(env, `pick:${thread.id}`);
  const picked = pick && (!newest || BigInt(newest.id) < BigInt(pick.at))
    ? messages.find((m) => m.id === pick.message) ?? (await bot<Message>(env, `/channels/${thread.id}/messages/${pick.message}`).catch(() => null))
    : null;
  const zipMessage = picked ?? newest;
  if (!zipMessage) return null;
  const attachment = attachmentsOf(zipMessage).find(isZip);
  if (known?.zip && attachment && known.zip.message === zipMessage.id && known.zip.attachment === attachment.id) {
    return { ...known, lastMessageId: thread.last_message_id };
  }
  return readZip(env, thread, zipMessage, starter);
}

// downloads a message's zip and reads its manifest and icon
async function readZip(env: Env, thread: Thread, zipMessage: Message, starter: Message | null): Promise<PostRead | null> {
  const attachment = attachmentsOf(zipMessage).find(isZip);
  if (!attachment || attachment.size > MaxZipBytes) return null;
  const download = await fetch(attachment.url);
  if (!download.ok) throw new Error(`zip download said ${download.status}`);
  const zip = await readModuleZip(new Uint8Array(await download.arrayBuffer()));
  if (!zip) return null;
  const m = zip.manifest;
  if (zip.icon) await putBlob(env, `icon:${thread.id}`, zip.icon.bytes, zip.icon.type);
  else await deleteBlob(env, `icon:${thread.id}`);
  return {
    id: thread.id,
    manifestName: text(m.name, 80),
    moduleId: text(m.id, 120),
    version: text(m.version, 40),
    author: text(m.author, 80) ?? starter?.author.global_name ?? starter?.author.username ?? null,
    description: text(m.description, 300) ?? summary(starter?.content ?? ""),
    hints: Object.fromEntries(ManifestParts.map((part) => [part, m[part] != null])),
    hasIcon: !!zip.icon,
    created: thread.thread_metadata?.create_timestamp ?? null,
    zip: { message: zipMessage.id, attachment: attachment.id, filename: attachment.filename, size: attachment.size },
    lastMessageId: thread.last_message_id,
  };
}

// discord ids count milliseconds since 2015, so any message posted after this moment has a bigger id
function snowflakeNow(): string {
  return String(BigInt(Date.now() - 1420070400000) << 22n);
}

export function isZip(a: { filename: string; content_type?: string }): boolean {
  return a.filename.toLowerCase().endsWith(".zip") || (a.content_type ?? "").toLowerCase().includes("zip");
}
