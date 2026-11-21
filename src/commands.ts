// the module commands: /publish, /publishlink and /publishweb put a post in the store, /update swaps its zip, and /preview, /banner and /icon set its store page's pictures

import { bot, botWrite, looksHidden, type Attachment, type Message, type Thread } from "./discord.ts";
import { forumsOf, type Env } from "./env.ts";
import { isZip, pickZip, refreshPost, type FeedModule } from "./feed.ts";
import { cleanTitle } from "./posts.ts";
import { ChartSize, loadChart, saveChart } from "./chart.ts";
import { dropPictures, isImage, loadListing, MaxPictureBytes, MaxPreviews, savePicture, saveListing, type Install, type Listing } from "./listing.ts";

// mods can change anyone's post: administrator, manage messages or manage threads
const ModBits = (1n << 3n) | (1n << 13n) | (1n << 34n);
const MaxDescription = 1500;

const NotAModule = "That zip isn't a module I can read. It needs a manifest.json and has to be under 15 MB.";
const NotPublished = "This post isn't in the store yet. Run /publish on it first.";
const NoPictures = "That message has no pictures.";

export interface Interaction {
  type: number;
  application_id: string;
  token: string;
  channel_id?: string;
  data?: { name: string; options?: Array<{ name: string; value: string | number }> };
  member?: { user: { id: string }; permissions: string };
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
  publish: (event, env) => withTarget(event, env, publish),
  publishlink: (event, env) => withTarget(event, env, (target) => publishLinked(target, env, "link")),
  publishweb: (event, env) => withTarget(event, env, (target) => publishLinked(target, env, "web")),
  update: (event, env) => withTarget(event, env, update),
  preview: (event, env) => withTarget(event, env, preview),
  banner: (event, env) => withTarget(event, env, (target) => onePicture(target, env, "banner")),
  icon: (event, env) => withTarget(event, env, (target) => onePicture(target, env, "icon")),
  setchart: setChart,
};

function option(event: Interaction, name: string): string {
  return String(event.data?.options?.find((o) => o.name === name)?.value ?? "").trim();
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

// a message link names its own post; a bare id means a message in the post the command was run in
function messageFrom(input: string, here: string | undefined): { channel: string; message: string } | null {
  const link = input.trim().match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)/);
  if (link) return { channel: link[1], message: link[2] };
  if (/^\d+$/.test(input.trim()) && here) return { channel: here, message: input.trim() };
  return null;
}

async function publish({ thread, message, userId }: Target, env: Env): Promise<Outcome> {
  const pictures = message.attachments.filter(isImage);
  if (!message.attachments.some(isZip) || !pictures.length) {
    return { text: "To publish, point me at a message with the module's .zip and at least one picture of it. The first picture becomes the store banner." };
  }
  if (tooBig(pictures[0])) return { text: tooBigText(pictures[0]) };
  const read = await pickZip(env, thread, message);
  if (!read) return { text: NotAModule };
  const old = await loadListing(env, thread.id);
  const listing: Listing = {
    install: "zip",
    link: null,
    author: null,
    publisher: userId,
    description: message.content.trim().slice(0, MaxDescription) || old?.description || "",
    banner: await savePicture(env, thread.id, pictures[0]),
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
  const old = await loadListing(env, thread.id);
  const words = message.content.replace(`<${link}>`, "").replace(link, "").replace(/ {2,}/g, " ").trim();
  const listing: Listing = {
    install,
    link,
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
  const how = install === "link" ? "added from its link" : "a web page";
  return { text: `Published **${nameOf(module, thread)}**, ${how}.`, done: true, note: await giveRole(env, thread.owner_id) };
}

// the first web address in a message, without the brackets or punctuation people put around links
function firstLink(content: string): string | null {
  return content.match(/https:\/\/[^\s<>()*`|]+/)?.[0].replace(/[.,!?;:]+$/, "") ?? null;
}

async function update({ thread, message }: Target, env: Env): Promise<Outcome> {
  const old = await loadListing(env, thread.id);
  if (!old) return { text: NotPublished };
  if (old.install === "link" || old.install === "web") {
    return { text: "This one is published as a link, so there's no zip to swap. Run /publishlink or /publishweb again to change its link, or /publish to switch it to a zip." };
  }
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

async function preview({ thread, message }: Target, env: Env): Promise<Outcome> {
  const old = await loadListing(env, thread.id);
  if (!old) return { text: NotPublished };
  const pictures = message.attachments.filter(isImage).slice(0, MaxPreviews);
  if (!pictures.length) return { text: NoPictures };
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

// the chart keepers put a published post at one of the five spots of "best from community"
async function setChart(event: Interaction, env: Env): Promise<Outcome> {
  const keepers = env.CHART_KEEPERS.split(",").map((id) => id.trim());
  if (!keepers.includes(event.member?.user.id ?? "")) return { text: "Only the chart keepers can change the chart." };
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
  if (old) await dropPictures(env, postId, [old.banner, old.icon, ...old.previews], [listing.banner, listing.icon, ...listing.previews]);
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
