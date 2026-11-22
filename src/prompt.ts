// live detection for new module posts and zip uploads: posts a reply with publish/update buttons and handles button clicks

import { Commands, firstLink, type Interaction, type Outcome } from "./commands.ts";
import { attachmentsOf, bot, botWrite, textOf, type Message, type Thread } from "./discord.ts";
import { forumsOf, type Env } from "./env.ts";
import { isZip } from "./feed.ts";
import { isImage, loadListing } from "./listing.ts";

// guilds (THREAD_CREATE), guild messages (MESSAGE_CREATE) and message content (attachments/links)
export const GatewayIntents = (1 << 0) | (1 << 9) | (1 << 15);

const MaxZipBytes = 15 * 1024 * 1024;
const ModBits = (1n << 3n) | (1n << 13n) | (1n << 34n);

const ActionRow = 1;
const Button = 2;
const Primary = 1;
const Secondary = 2;
const Success = 3;

interface ButtonSpec {
  style: number;
  label: string;
  custom_id: string;
}

// quick pure-memory check so normal chat messages never trigger a discord or d1 lookup
export function looksPromptable(message: Message & { channel_id?: string; author?: { id: string; bot?: boolean } }): boolean {
  if (!message.author || message.author.bot) return false;
  const files = attachmentsOf(message);
  if (files.some((a) => isZip(a) && a.size <= MaxZipBytes)) return true;
  if (message.id === message.channel_id && files.some(isImage)) {
    const link = externalLink(textOf(message));
    if (link) return true;
  }
  return false;
}

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

// called when a relevant message lands in a module forum thread from the post's author
export async function promptForMessage(env: Env, thread: Thread, message: Message): Promise<boolean> {
  if (!forumsOf(env).some((f) => f.id === thread.parent_id)) return false;
  if (message.author.id !== thread.owner_id) return false;

  const files = attachmentsOf(message);
  const zip = files.find((a) => isZip(a) && a.size <= MaxZipBytes);
  const hasImage = files.some(isImage);
  const listing = await loadListing(env, thread.id);

  if (zip) {
    if (!listing) {
      if (hasImage) {
        const text = pick([
          `yo you want to publish **${zip.filename}** to the store?`,
          `saw **${zip.filename}**, wanna put this on the module store?`,
          `yo want to send **${zip.filename}** to the store?`,
          `new zip dropped (**${zip.filename}**), publish it?`,
        ]);
        await sendPrompt(env, thread.id, message.id, text, [
          { style: Success, label: "Publish", custom_id: `prompt:publish:${thread.id}:${message.id}` },
          { style: Secondary, label: "Nah", custom_id: `prompt:dismiss:${thread.id}:${message.id}` },
        ]);
        return true;
      }
      // if this zip was posted as a reply, check whether the starter message already holds the banner picture
      if (message.id !== thread.id) {
        const starter = await bot<Message>(env, `/channels/${thread.id}/messages/${thread.id}`).catch(() => null);
        if (starter && attachmentsOf(starter).some(isImage)) {
          const text = pick([
            `yo you want to publish **${zip.filename}** using this post's banner?`,
            `saw **${zip.filename}**, wanna publish it with the banner up top?`,
            `yo want to send **${zip.filename}** to the store with this post's banner?`,
          ]);
          await sendPrompt(env, thread.id, message.id, text, [
            { style: Success, label: "Publish", custom_id: `prompt:publish:${thread.id}:${thread.id}:${message.id}` },
            { style: Secondary, label: "Nah", custom_id: `prompt:dismiss:${thread.id}:${message.id}` },
          ]);
          return true;
        }
      }
      const text = pick([
        `saw **${zip.filename}** but there's no banner pic yet. drop a pic and run \`/publish\` whenever you're ready`,
        `yo **${zip.filename}** needs a banner picture first, add one then run \`/publish\``,
        `got **${zip.filename}**, just add a banner image and hit \`/publish\` to put it on the store`,
      ]);
      await sendPrompt(
        env,
        thread.id,
        message.id,
        text,
        [{ style: Secondary, label: "Got it", custom_id: `prompt:dismiss:${thread.id}:${message.id}` }],
      );
      return true;
    }

    // already published as a zip module: offer a one-click update when the author uploads a new zip
    if (!listing.install || listing.install === "zip") {
      const text = pick([
        `yo new zip (**${zip.filename}**), want to update the store listing?`,
        `saw **${zip.filename}**, wanna push this update to the store?`,
        `yo you want to update this module with **${zip.filename}**?`,
        `new version dropped (**${zip.filename}**), update it on the store?`,
      ]);
      await sendPrompt(env, thread.id, message.id, text, [
        { style: Primary, label: "Update", custom_id: `prompt:update:${thread.id}:${message.id}` },
        { style: Secondary, label: "Nah", custom_id: `prompt:dismiss:${thread.id}:${message.id}` },
      ]);
      return true;
    }
    return false;
  }

  // new starter message with a banner image and an external module/web link
  if (!listing && message.id === thread.id && hasImage && externalLink(textOf(message))) {
    const text = pick([
      "yo you want to publish this to the store?",
      "saw the link, wanna put this on the module store?",
      "yo want to send this post to the store?",
    ]);
    await sendPrompt(env, thread.id, message.id, text, [
      { style: Success, label: "Publish Link", custom_id: `prompt:publishlink:${thread.id}:${message.id}` },
      { style: Primary, label: "Publish Web", custom_id: `prompt:publishweb:${thread.id}:${message.id}` },
      { style: Secondary, label: "Nah", custom_id: `prompt:dismiss:${thread.id}:${message.id}` },
    ]);
    return true;
  }

  return false;
}

// handles clicks on Publish / Update / Dismiss buttons posted by live detection
export async function handlePromptComponent(event: Interaction, env: Env): Promise<Outcome & { silent?: boolean }> {
  const customId = event.data?.custom_id ?? "";
  const parts = customId.split(":");
  if (parts[0] !== "prompt" || parts.length < 4) return { text: "That button is no longer valid." };
  const [, action, threadId, firstMsgId, secondMsgId] = parts;
  const userId = event.member?.user.id;
  if (!userId || !/^\d+$/.test(threadId) || !/^\d+$/.test(firstMsgId) || (secondMsgId && !/^\d+$/.test(secondMsgId))) {
    return { text: "That button is no longer valid." };
  }

  const thread = await bot<Thread>(env, `/channels/${threadId}`).catch(() => null);
  if (!thread || !forumsOf(env).some((f) => f.id === thread.parent_id)) return { text: "That post isn't in a module forum." };
  const isMod = (BigInt(event.member?.permissions ?? "0") & ModBits) !== 0n;
  if (thread.owner_id !== userId && !isMod) return { text: "Only the person who made this post can use these buttons." };

  const removePrompt = async () => {
    const promptMsgId = event.message?.id;
    const channelId = event.channel_id ?? threadId;
    if (promptMsgId) {
      await botWrite(env, "DELETE", `/channels/${channelId}/messages/${promptMsgId}`).catch(() => {});
    }
  };

  if (action === "dismiss") {
    await removePrompt();
    return { text: "Dismissed.", silent: true };
  }

  const synthetic = (name: string, options: Array<{ name: string; value: string }>): Interaction => ({
    ...event,
    type: 2,
    channel_id: threadId,
    data: { name, options },
  });

  let outcome: Outcome;
  if (action === "publish") {
    const options = secondMsgId
      ? [{ name: "message", value: firstMsgId }, { name: "module", value: secondMsgId }]
      : [{ name: "message", value: firstMsgId }];
    outcome = await Commands.publish(synthetic("publish", options), env);
  } else if (action === "update") {
    outcome = await Commands.update(synthetic("update", [{ name: "message", value: firstMsgId }]), env);
  } else if (action === "publishlink") {
    outcome = await Commands.publishlink(synthetic("publishlink", [{ name: "message", value: firstMsgId }]), env);
  } else if (action === "publishweb") {
    outcome = await Commands.publishweb(synthetic("publishweb", [{ name: "message", value: firstMsgId }]), env);
  } else {
    return { text: "That button is no longer valid." };
  }

  if (outcome.done) await removePrompt();
  return outcome;
}

async function sendPrompt(env: Env, channelId: string, replyToId: string, content: string, buttons: ButtonSpec[]): Promise<void> {
  await botWrite(env, "POST", `/channels/${channelId}/messages`, {
    content,
    allowed_mentions: { parse: [] },
    message_reference: { message_id: replyToId, fail_if_not_exists: false },
    components: [
      {
        type: ActionRow,
        components: buttons.map((b) => ({ type: Button, ...b })),
      },
    ],
  });
}

function externalLink(content: string): string | null {
  const link = firstLink(content);
  if (!link) return null;
  const host = new URL(link).hostname.toLowerCase();
  if (host === "cdn.discordapp.com" || host === "media.discordapp.net") return null;
  return link;
}
