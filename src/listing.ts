// what /publish and friends set for a post's store page: its description, banner, previews and icon, with the pictures kept in d1

import type { Attachment } from "./discord.ts";
import type { Env } from "./env.ts";
import { deleteBlob, deleteKey, getJson, putBlob, putJson } from "./store.ts";

// discord's own picture links run out after a day, so each picture is copied; this keeps one quick to load
export const MaxPictureBytes = 8 * 1024 * 1024;
export const MaxPreviews = 8;

export interface Picture {
  id: string;
  type: string;
}

// how the store adds a module: the post's zip, a link mochy adds like a pasted one (github and the like), a web page it opens, or a pack of several
export type Install = "zip" | "link" | "web" | "pack";

// one module in a pack: a zip in the pack's message, or a link people add it from
export interface PackItem {
  kind: "zip" | "link";
  // the zip's attachment id, or "link" and its place in the pack
  id: string;
  name: string;
  moduleId: string | null;
  version: string | null;
  size: number | null;
  // the zip's own icon, kept like the store's other pictures
  icon: Picture | null;
  link: string | null;
  // the message holding the zip, so it can be handed out with a fresh discord link
  message: string | null;
}

// a post shows in the store only once it has one of these, made by /publish, /publishlink or /publishweb
export interface Listing {
  // missing on listings made before links could be published, which are all zips
  install?: Install;
  link?: string | null;
  // who made a linked module or a pack, since there's no one manifest to say
  author?: string | null;
  // the modules in a pack, in the order they were posted
  pack?: PackItem[];
  publisher: string;
  description: string;
  banner: Picture | null;
  previews: Picture[];
  // set with /icon, and wins over the icon in the zip
  icon: Picture | null;
  publishedAt: number;
  // when a linked module's link was last published; a zip module goes by its zip's message instead
  updatedAt?: number;
}

export async function loadListing(env: Env, postId: string): Promise<Listing | null> {
  return getJson<Listing>(env, `listing:${postId}`);
}

export async function saveListing(env: Env, postId: string, listing: Listing): Promise<void> {
  await putJson(env, `listing:${postId}`, listing);
}

export async function deleteListing(env: Env, postId: string): Promise<void> {
  await deleteKey(env, `listing:${postId}`);
}

export function isImage(a: Attachment): boolean {
  return (a.content_type ?? "").startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(a.filename);
}

// copies a picture from discord into d1 under the attachment's own id, so its address changes whenever the picture does
export async function savePicture(env: Env, postId: string, attachment: Attachment): Promise<Picture> {
  if (attachment.size > MaxPictureBytes) throw new Error(`${attachment.filename} is over the picture limit`);
  const download = await fetch(attachment.url);
  if (!download.ok) throw new Error(`picture download said ${download.status}`);
  const type = attachment.content_type?.startsWith("image/") ? attachment.content_type : "image/png";
  await putBlob(env, `picture:${postId}:${attachment.id}`, new Uint8Array(await download.arrayBuffer()), type);
  return { id: attachment.id, type };
}

// clears out pictures a change left behind, keeping any that are still in use
export async function dropPictures(env: Env, postId: string, old: Array<Picture | null>, kept: Array<Picture | null>): Promise<void> {
  const keep = new Set(kept.filter((p): p is Picture => !!p).map((p) => p.id));
  for (const picture of old) {
    if (picture && !keep.has(picture.id)) await deleteBlob(env, `picture:${postId}:${picture.id}`);
  }
}

// every picture a store page holds, its pack's icons included, so a change can clear out the ones it replaced
export function picturesOf(listing: Listing | null): Array<Picture | null> {
  if (!listing) return [];
  return [listing.banner, listing.icon, ...listing.previews, ...(listing.pack ?? []).map((item) => item.icon)];
}
