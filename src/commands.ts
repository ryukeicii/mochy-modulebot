// the module commands: /publish, /publishlink, /publishweb and /modulepack put a post in the store, /update swaps its zip, /unpublish removes it, and /preview, /banner and /icon set its store page's pictures

import { attachmentsOf, bot, botWrite, looksHidden, textOf, type Attachment, type Message, type Thread } from "./discord.ts";
import { forumsOf, type Env } from "./env.ts";
import { isZip, pickZip, refreshPost, removePost, type FeedModule } from "./feed.ts";
import { cleanTitle } from "./posts.ts";
import { ChartSize, loadChart, saveChart } from "./chart.ts";
import { deleteListing, dropPictures, isImage, loadListing, MaxPictureBytes, MaxPreviews, picturesOf, savePicture, saveListing, type Install, type Listing, type PackItem } from "./listing.ts";
import { readModuleZip } from "./zip.ts";

// mods can change anyone's post: administrator, manage messages or manage threads
const ModBits = (1n << 3n) | (1n << 13n) | (1n << 34n);
const Administrator = 1n << 3n;
const MaxDescription = 1500;
// a pack reads every zip in one go, so it stays small enough to finish well inside a worker's limits
const MaxPackItems = 10;
const MaxZipBytes = 15 * 1024 * 1024;

const NotAModule = "That zip isn't a module I can read. It needs a manifest.json and has to be under 15 MB.";
const NotPublished = "This post isn't in the store yet. Run /publish on it first.";
const NoPictures = "That message has no pictures.";

export interface Interaction {
  type: number;
  application_id: string;
  token: string;
  channel_id?: string;
  data?: { name: string; options?: Array<{ name: string; value: string | number | boolean }> };
  member?: { user: { id: string }; permissions: string; roles?: string[] };
}

// done ones go out as a public message in the post; a note is extra for whoever ran it
export interface Outcome {
  text: string;
  done?: boolean;
  note?: string;
}

interface Target {
  thread: Thread;
  message: Message;
  userId: string;
}

type Run = (target: Target, env: Env) => Promise<Outcome>;

export const Commands: Record<string, (event: Interaction, env: Env) => Promise<Outcome>> = {
  publish: (event, env) => withTarget(event, env, (target) => publish(target, env, option(event, "module"))),
  publishlink: (event, env) => withTarget(event, env, (target) => publishLinked(target, env, "link")),
  publishweb: (event, env) => withTarget(event, env, (target) => publishLinked(target, env, "web")),
  modulepack: (event, env) => withTarget(event, env, modulePack),
  update: (event, env) => withTarget(event, env, update),
  preview: (event, env) => withTarget(event, env, (target) => preview(target, env, boolOption(event, "addimage"))),
  banner: (event, env) => withTarget(event, env, (target) => onePicture(target, env, "banner")),
  icon: (event, env) => withTarget(event, env, (target) => onePicture(target, env, "icon")),
  unpublish,
  setchart: setChart,
};

function option(event: Interaction, name: string): string {
  return String(event.data?.options?.find((o) => o.name === name)?.value ?? "").trim();
}

function boolOption(event: Interaction, name: string): boolean {
  const value = event.data?.options?.find((o) => o.name === name)?.value;
  return value === true || value === "true";
}

async function withTarget(event: Interaction, env: Env, run: Run): Promise<Outcome> {
  const target = await findTarget(event, env);
  return typeof target === "string" ? { text: target } : run(target, env);
}

// the message a command points at, once it's known to be in a module post the person may change
async function findTarget(event: Interaction, env: Env): Promise<Target | string> {
  const userId = event.member?.user.id;
  const where = messageFrom(option(event, "message"), event.channel_id);
  if (!userId || !where) return "Give me the message: copy its link, or its id when you're in the post.";
  const thread = await bot<Thread>(env, `/channels/${where.channel}`).catch(() => null);
  if (!thread || !forumsOf(env).some((f) => f.id === thread.parent_id)) return "That message isn't in a module post.";
  const isMod = (BigInt(event.member?.permissions ?? "0") & ModBits) !== 0n;
  if (thread.owner_id !== userId && !isMod) return "Only the person who made this post can change it.";
  const message = await bot<Message>(env, `/channels/${thread.id}/messages/${where.message}`).catch(() => null);
  if (!message) return "I couldn't find that message.";
  if (looksHidden(message)) return "I can't see what's in messages right now. Turn on Message Content Intent for the bot in the Developer Portal (Bot page), then try again.";
  return { thread, message, userId };
}

// a message link names its post and message, a post link means its starter message (same id in discord forums), and a bare id means a message in the post the command was run in
function messageFrom(input: string, here: string | undefined): { channel: string; message: string } | null {
  const trimmed = input.trim();
  const link = trimmed.match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)/);
  if (link) return { channel: link[1], message: link[2] };
  const post = trimmed.match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)/);
  if (post) return { channel: post[1], message: post[1] };
  if (/^\d+$/.test(trimmed) && here) return { channel: here, message: trimmed };
  return null;
}

async function publish({ thread, message, userId }: Target, env: Env, sourceInput = ""): Promise<Outcome> {
  const source = sourceInput.trim();
  if (source) {
    const ref = messageFrom(source, thread.id);
    if (ref) {
      if (ref.channel !== thread.id) return { text: "That module message is in a different post." };
      const sourceMessage = ref.message === message.id ? message : await bot<Message>(env, `/channels/${thread.id}/messages/${ref.message}`).catch(() => null);
      if (!sourceMessage) return { text: "I couldn't find that module message." };
      if (looksHidden(sourceMessage)) return { text: "I can't see what's in messages right now. Turn on Message Content Intent for the bot in the Developer Portal (Bot page), then try again." };
      const msgAttachments = attachmentsOf(message);
      const srcAttachments = attachmentsOf(sourceMessage);
      const banner = msgAttachments.find(isImage) ?? srcAttachments.find(isImage);
      if (!banner) return { text: "To publish, at least one of the messages needs a picture for the store banner." };
      if (tooBig(banner)) return { text: tooBigText(banner) };
      if (srcAttachments.some(isZip)) {
        return publishZip(thread, message, sourceMessage, banner, userId, env);
      }
      const srcLink = firstLink(textOf(sourceMessage));
      if (srcLink) {
        return publishWithLink(thread, message, banner, srcLink, userId, env, "link");
      }
      // also accept swapped order where the first message holds the zip/link and the second holds the banner
      if (msgAttachments.some(isZip)) {
        return publishZip(thread, message, message, banner, userId, env);
      }
      const msgLink = firstLink(textOf(message));
      if (msgLink) {
        return publishWithLink(thread, message, banner, msgLink, userId, env, "link");
      }
      return { text: `I couldn't find a .zip or module link on that second message (${describeMessage(sourceMessage)}).` };
    }
    const link = firstLink(source);
    if (link) {
      const host = new URL(link).hostname.toLowerCase();
      if (host === "cdn.discordapp.com" || host === "media.discordapp.net") {
        return { text: "Discord file links expire after a day — pass the message's link or id instead so the store can always fetch a fresh copy." };
      }
      const banner = attachmentsOf(message).find(isImage);
      if (!banner) return { text: "To publish, point me at a message with at least one picture for the store banner." };
      if (tooBig(banner)) return { text: tooBigText(banner) };
      return publishWithLink(thread, message, banner, link, userId, env, "link");
    }
    return { text: "Give me a message link/id with the .zip, or a https:// module link (GitHub and the like)." };
  }
  const msgAttachments = attachmentsOf(message);
  const pictures = msgAttachments.filter(isImage);
  if (!msgAttachments.some(isZip) || !pictures.length) {
    return { text: "To publish, point me at a message with the module's .zip and at least one picture of it. The first picture becomes the store banner." };
  }
  if (tooBig(pictures[0])) return { text: tooBigText(pictures[0]) };
  return publishZip(thread, message, message, pictures[0], userId, env);
}

async function publishZip(thread: Thread, infoMessage: Message, zipMessage: Message, banner: Attachment, userId: string, env: Env): Promise<Outcome> {
  const read = await pickZip(env, thread, zipMessage);
  if (!read) return { text: NotAModule };
  const old = await loadListing(env, thread.id);
  const listing: Listing = {
    install: "zip",
    link: null,
    author: null,
    publisher: userId,
    description: infoMessage.content.trim().slice(0, MaxDescription) || old?.description || "",
    banner: await savePicture(env, thread.id, banner),
    previews: old?.previews ?? [],
    icon: old?.icon ?? null,
    publishedAt: old?.publishedAt ?? Date.now(),
  };
  await changeListing(env, thread.id, old, listing);
  const module = await refreshPost(env, thread, read);
  return { text: `Published **${nameOf(module, thread)}**${read.version ? ` ${read.version}` : ""}.`, done: true, note: await giveRole(env, thread.owner_id) };
}

// a module published with a link and a picture; the store adds it from the link, or opens the page for a web one
async function publishLinked({ thread, message, userId }: Target, env: Env, install: Install): Promise<Outcome> {
  const link = firstLink(message.content);
  const pictures = message.attachments.filter(isImage);
  if (!link || !pictures.length) {
    const what = install === "link" ? "the module's link (a GitHub project or a module's address)" : "the web page's link";
    return { text: `To publish this way, point me at a message with ${what} and at least one picture. The first picture becomes the store banner.` };
  }
  if (tooBig(pictures[0])) return { text: tooBigText(pictures[0]) };
  return publishWithLink(thread, message, pictures[0], link, userId, env, install);
}

async function publishWithLink(thread: Thread, message: Message, banner: Attachment, link: string, userId: string, env: Env, install: Install): Promise<Outcome> {
  const old = await loadListing(env, thread.id);
  const words = message.content.replace(`<${link}>`, "").replace(link, "").replace(/ {2,}/g, " ").trim();
  const listing: Listing = {
    install,
    link,
    author: message.author.global_name ?? message.author.username,
    publisher: userId,
    description: words.slice(0, MaxDescription) || old?.description || "",
    banner: await savePicture(env, thread.id, banner),
    previews: old?.previews ?? [],
    icon: old?.icon ?? null,
    publishedAt: old?.publishedAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await changeListing(env, thread.id, old, listing);
  const module = await refreshPost(env, thread);
  const how = install === "link" ? "added from its link" : "a web page";
  return { text: `Published **${nameOf(module, thread)}**, ${how}.`, done: true, note: await giveRole(env, thread.owner_id) };
}

// the first web address in a message, including bare github.com links, without brackets or trailing punctuation
function firstLink(content: string): string | null {
  for (const match of content.matchAll(/https?:\/\/[^\s<>()*`"']+/gi)) {
    const clean = match[0].replace(/^http:\/\//i, "https://").replace(/[.,!?;:]+$/, "");
    // skip discord channel/message links when scanning for a module address
    if (/^https:\/\/(?:www\.)?discord(?:app)?\.com\/channels\//i.test(clean)) continue;
    return clean;
  }
  const bareGithub = content.match(/(?:^|[\s<(])((?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^\s<>()*`"']*)?)/i);
  if (bareGithub) return `https://${bareGithub[1].replace(/^www\./i, "").replace(/[.,!?;:]+$/, "")}`;
  return null;
}

// short summary of what discord returned on a message when no zip or link was found
function describeMessage(message: Message): string {
  const files = attachmentsOf(message);
  const parts: string[] = [];
  if (files.length) parts.push(`files: ${files.map((f) => f.filename).slice(0, 3).join(", ")}`);
  else parts.push("no files");
  if (!message.content.trim()) parts.push("no text");
  else parts.push("no https:// link in text");
  if (message.embeds?.length) parts.push(`${message.embeds.length} embed${message.embeds.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

async function update({ thread, message }: Target, env: Env): Promise<Outcome> {
  const old = await loadListing(env, thread.id);
  if (!old) return { text: NotPublished };
  if (old.install === "link" || old.install === "web") {
    return { text: "This one is published as a link, so there's no zip to swap. Run /publishlink or /publishweb again to change its link, or /publish to switch it to a zip." };
  }
  if (old.install === "pack") return { text: "This one is a pack. Run /modulepack again with its new zips and links." };
  if (!message.attachments.some(isZip)) return { text: "I couldn't find a .zip on that message." };
  const picture = message.attachments.find(isImage);
  if (picture && tooBig(picture)) return { text: tooBigText(picture) };
  const read = await pickZip(env, thread, message);
  if (!read) return { text: NotAModule };
  // a picture next to the new zip becomes the banner
  if (picture) await changeListing(env, thread.id, old, { ...old, banner: await savePicture(env, thread.id, picture) });
  const module = await refreshPost(env, thread, read);
  return { text: `Updated **${nameOf(module, thread)}**${read.version ? ` to ${read.version}` : ""}.`, done: true };
}

async function preview({ thread, message }: Target, env: Env, addImage = false): Promise<Outcome> {
  const old = await loadListing(env, thread.id);
  if (!old) return { text: NotPublished };
  const allPictures = attachmentsOf(message).filter(isImage);
  if (!allPictures.length) return { text: NoPictures };
  if (addImage) {
    const room = MaxPreviews - old.previews.length;
    if (room <= 0) return { text: `**${cleanTitle(thread.name)}** already has the maximum of ${MaxPreviews} previews.` };
    const existingIds = new Set(old.previews.map((p) => p.id));
    const pictures = allPictures.filter((p) => !existingIds.has(p.id)).slice(0, room);
    if (!pictures.length) return { text: "Those pictures are already in the previews." };
    const big = pictures.find(tooBig);
    if (big) return { text: tooBigText(big) };
    const added = [];
    for (const picture of pictures) added.push(await savePicture(env, thread.id, picture));
    const previews = [...old.previews, ...added];
    await changeListing(env, thread.id, old, { ...old, previews });
    const module = await refreshPost(env, thread);
    const label = added.length === 1 ? "1 preview" : `${added.length} previews`;
    return { text: `Added ${label} to **${nameOf(module, thread)}** (${previews.length} total).`, done: true };
  }
  const pictures = allPictures.slice(0, MaxPreviews);
  const big = pictures.find(tooBig);
  if (big) return { text: tooBigText(big) };
  const previews = [];
  for (const picture of pictures) previews.push(await savePicture(env, thread.id, picture));
  await changeListing(env, thread.id, old, { ...old, previews });
  const module = await refreshPost(env, thread);
  const count = previews.length === 1 ? "a new preview" : `${previews.length} new previews`;
  return { text: `**${nameOf(module, thread)}** has ${count}.`, done: true };
}

async function onePicture({ thread, message }: Target, env: Env, part: "banner" | "icon"): Promise<Outcome> {
  const old = await loadListing(env, thread.id);
  if (!old) return { text: NotPublished };
  const picture = message.attachments.find(isImage);
  if (!picture) return { text: NoPictures };
  if (tooBig(picture)) return { text: tooBigText(picture) };
  await changeListing(env, thread.id, old, { ...old, [part]: await savePicture(env, thread.id, picture) });
  const module = await refreshPost(env, thread);
  return { text: `New ${part} for **${nameOf(module, thread)}**.`, done: true };
}

// takes a post off the store, clears its stored pictures, and vacates any chart spot it held
async function unpublish(event: Interaction, env: Env): Promise<Outcome> {
  const userId = event.member?.user.id;
  const input = option(event, "post");
  const postId = input
    ? input.match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)/)?.[1] ?? (/^\d+$/.test(input) ? input : null)
    : event.channel_id ?? null;
  if (!userId || !postId) return { text: "Run this inside a module post, or pass the post's link or id." };
  const thread = await bot<Thread>(env, `/channels/${postId}`).catch(() => null);
  if (!thread || !forumsOf(env).some((f) => f.id === thread.parent_id)) return { text: "That isn't a module post." };
  const isMod = (BigInt(event.member?.permissions ?? "0") & ModBits) !== 0n;
  if (thread.owner_id !== userId && !isMod) return { text: "Only the person who made this post can remove it." };
  const old = await loadListing(env, thread.id);
  if (!old) return { text: NotPublished };
  await deleteListing(env, thread.id);
  await dropPictures(env, thread.id, picturesOf(old), []);
  await removePost(env, thread.id);
  const chart = await loadChart(env);
  if (chart.includes(thread.id)) {
    await saveChart(env, chart.map((id) => (id === thread.id ? null : id)));
  }
  return { text: `Unpublished **${cleanTitle(thread.name)}**. It's off the store now.`, done: true };
}

// anyone with a chart role, the server's owner and its admins put a published post at one of the five spots of "best from community"
async function setChart(event: Interaction, env: Env): Promise<Outcome> {
  const chartRoles = env.CHART_ROLES.split(",").map((id) => id.trim());
  const keeper = (event.member?.roles ?? []).some((role) => chartRoles.includes(role));
  // discord hands the owner every permission in the command itself, administrator included
  const admin = (BigInt(event.member?.permissions ?? "0") & Administrator) !== 0n;
  if (!keeper && !admin) return { text: "Only the chart keepers and the server's admins can change the chart." };
  const spot = Number(option(event, "lvl"));
  if (!Number.isInteger(spot) || spot < 1 || spot > ChartSize) return { text: `Pick a spot from 1 to ${ChartSize}.` };
  const input = option(event, "post");
  const chart = await loadChart(env);
  if (/^(clear|none|-)$/i.test(input)) {
    chart[spot - 1] = null;
    await saveChart(env, chart);
    return { text: `Spot ${spot} on the chart is empty now.`, done: true };
  }
  // a post link is .../channels/<server>/<post>, sometimes with a message after it; a bare id is the post itself
  const postId = input.match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)/)?.[1] ?? (/^\d+$/.test(input) ? input : null);
  if (!postId) return { text: "Give me the module's post: its link, or its id." };
  const thread = await bot<Thread>(env, `/channels/${postId}`).catch(() => null);
  if (!thread || !forumsOf(env).some((f) => f.id === thread.parent_id)) return { text: "That isn't a module post." };
  if (!(await loadListing(env, thread.id))) return { text: "That post isn't in the store yet, so it can't go on the chart." };
  // a module sits on the chart once, so putting it somewhere new clears its old spot
  const next = chart.map((id) => (id === thread.id ? null : id));
  next[spot - 1] = thread.id;
  await saveChart(env, next);
  return { text: `**${cleanTitle(thread.name)}** is #${spot} on the chart.`, done: true };
}

// saves the store page and clears out the pictures the change replaced
async function changeListing(env: Env, postId: string, old: Listing | null, listing: Listing): Promise<void> {
  await saveListing(env, postId, listing);
  if (old) await dropPictures(env, postId, picturesOf(old), picturesOf(listing));
}

// several modules in one post: every zip and link in the message, and a picture for the banner; each is added on its own from the pack's page
async function modulePack({ thread, message, userId }: Target, env: Env): Promise<Outcome> {
  const zips = message.attachments.filter(isZip).slice(0, MaxPackItems);
  const links = linksIn(message.content).slice(0, MaxPackItems - zips.length);
  const pictures = message.attachments.filter(isImage);
  if (zips.length + links.length < 2 || !pictures.length) {
    return { text: "A pack needs a message with at least two modules, as .zip files or links (GitHub and the like), and a picture for its banner." };
  }
  if (tooBig(pictures[0])) return { text: tooBigText(pictures[0]) };
  const big = zips.find((zip) => zip.size > MaxZipBytes);
  if (big) return { text: `${big.filename} is over 15 MB, too big for the store.` };
  const items: PackItem[] = [];
  for (const zip of zips) {
    const item = await packZip(env, thread.id, message.id, zip);
    if (!item) return { text: `${zip.filename} isn't a module I can read. Every zip in a pack needs its own manifest.json.` };
    items.push(item);
  }
  links.forEach((link, index) => {
    items.push({ kind: "link", id: `link${index}`, name: link.label ?? nameOfLink(link.url), moduleId: null, version: null, size: null, icon: null, link: link.url, message: null });
  });
  const old = await loadListing(env, thread.id);
  const words = links.reduce((text, link) => text.replace(link.written, ""), message.content).replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const listing: Listing = {
    install: "pack",
    link: null,
    pack: items,
    author: message.author.global_name ?? message.author.username,
    publisher: userId,
    description: words.slice(0, MaxDescription) || old?.description || "",
    banner: await savePicture(env, thread.id, pictures[0]),
    previews: old?.previews ?? [],
    icon: old?.icon ?? null,
    publishedAt: old?.publishedAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await changeListing(env, thread.id, old, listing);
  const module = await refreshPost(env, thread);
  return { text: `Published **${nameOf(module, thread)}**, a pack of ${items.length} modules.`, done: true, note: await giveRole(env, thread.owner_id) };
}

// reads one of a pack's zips for its name, id, version and icon; null when it isn't a module
async function packZip(env: Env, postId: string, messageId: string, zip: Attachment): Promise<PackItem | null> {
  const download = await fetch(zip.url);
  if (!download.ok) throw new Error(`zip download said ${download.status}`);
  const read = await readModuleZip(new Uint8Array(await download.arrayBuffer()));
  if (!read) return null;
  const m = read.manifest;
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  let icon = null;
  if (read.icon) {
    icon = { id: `i${zip.id}`, type: read.icon.type };
    await env.FEED.put(`picture:${postId}:${icon.id}`, read.icon.bytes, { metadata: { type: icon.type } });
  }
  return {
    kind: "zip",
    id: zip.id,
    name: text(m.name, 80) ?? zip.filename.replace(/\.zip$/i, ""),
    moduleId: text(m.id, 120),
    version: text(m.version, 40),
    size: zip.size,
    icon,
    link: null,
    message: messageId,
  };
}

// every link in a message, with its name when it's written as [Name](link); [written] is how it appeared, to take it out of the description
function linksIn(content: string): Array<{ url: string; label: string | null; written: string }> {
  const found: Array<{ url: string; label: string | null; written: string }> = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/\[([^\]]+)\]\(<?(https:\/\/[^)\s>]+)>?\)/g)) {
    if (!seen.has(match[2])) found.push({ url: match[2], label: match[1].trim(), written: match[0] });
    seen.add(match[2]);
  }
  const rest = found.reduce((text, link) => text.replace(link.written, ""), content);
  for (const match of rest.matchAll(/<?(https:\/\/[^\s<>()*`|]+)>?/g)) {
    const url = match[1].replace(/[.,!?;:]+$/, "");
    if (!seen.has(url)) found.push({ url, label: null, written: match[0] });
    seen.add(url);
  }
  return found;
}

// a link's name when it wasn't given one: a github project's own name, or the site's
function nameOfLink(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const host = new URL(url).hostname.replace(/^www\./, "");
  return host === "github.com" && parts.length >= 2 ? parts[1] : host;
}

// publishing earns the post's maker a role; a missing permission only costs the role, never the publish
async function giveRole(env: Env, userId: string): Promise<string | undefined> {
  try {
    await botWrite(env, "PUT", `/guilds/${env.GUILD_ID}/members/${userId}/roles/${env.PUBLISHER_ROLE}`);
    return undefined;
  } catch (e) {
    console.log(`couldn't give the publisher role: ${(e as Error).message}`);
    return "Published, but I couldn't hand out the publisher role. The bot needs Manage Roles, with its own role above that one.";
  }
}

function nameOf(module: FeedModule | null, thread: Thread): string {
  return module?.name ?? cleanTitle(thread.name);
}

function tooBig(picture: Attachment): boolean {
  return picture.size > MaxPictureBytes;
}

function tooBigText(picture: Attachment): string {
  return `${picture.filename} is over 8 MB. Try a smaller picture.`;
}
