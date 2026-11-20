// discord's slash commands reach the worker here: the signature check, the "thinking..." and the answer once the command is done

import { Commands, type Interaction, type Outcome } from "./commands.ts";
import { deleteReply, editReply, followUp } from "./discord.ts";
import type { Context, Env } from "./env.ts";

const Ping = 1;
const Command = 2;
const Pong = 1;
const Answer = 4;
const ThinkingAnswer = 5;
// only the person who ran the command sees this answer, so mistakes don't fill a post with bot chatter
const OnlyYou = 1 << 6;

// commands that answer with the same words every time, straight away and for everyone
const Quick: Record<string, string> = {
  whatis: "here son https://realidkroo.github.io/Mochy-Music/wiki/#modules-types",
  src: "https://github.com/ryukeicii/mochy-modulebot",
};

export async function interaction(request: Request, env: Env, ctx: Context): Promise<Response> {
  const body = await request.text();
  if (!(await signedByDiscord(request, body, env.PUBLIC_KEY))) return new Response("bad signature", { status: 401 });
  const event = JSON.parse(body) as Interaction;
  if (event.type === Ping) return reply({ type: Pong });
  const quick = event.type === Command ? Quick[event.data?.name ?? ""] : undefined;
  if (quick) return reply({ type: Answer, data: { content: quick, allowed_mentions: { parse: [] } } });
  const run = event.type === Command ? Commands[event.data?.name ?? ""] : undefined;
  if (run) {
    // reading a zip or a picture can take longer than the 3 seconds discord waits, so it says "thinking" first and answers when done
    ctx.waitUntil(answer(event, env, run));
    return reply({ type: ThinkingAnswer, data: { flags: OnlyYou } });
  }
  return reply({ type: Answer, data: { content: "I don't know that command.", flags: OnlyYou } });
}

// problems are told only to whoever ran it; a done command is a new public message in the post
async function answer(event: Interaction, env: Env, run: (event: Interaction, env: Env) => Promise<Outcome>): Promise<void> {
  let outcome: Outcome;
  try {
    outcome = await run(event, env);
  } catch (e) {
    console.log(`/${event.data?.name} failed: ${(e as Error).stack ?? e}`);
    outcome = { text: "Something went wrong reading this post. Try again in a minute." };
  }
  const { application_id: app, token } = event;
  try {
    // the first follow-up after a "thinking..." would take its place and stay private, so the private one is answered first
    await editReply(app, token, outcome.note ?? outcome.text);
    if (!outcome.done) return;
    await followUp(app, token, outcome.text);
    // with a note to keep, the private answer stays; otherwise it's cleared so only the public one is left
    if (!outcome.note) await deleteReply(app, token);
  } catch (e) {
    console.log(`couldn't answer /${event.data?.name}: ${(e as Error).message}`);
  }
}

function reply(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

// discord signs every interaction; without this check anyone could post fake commands to this address
async function signedByDiscord(request: Request, body: string, publicKey: string): Promise<boolean> {
  const signature = hex(request.headers.get("X-Signature-Ed25519") ?? "");
  const timestamp = request.headers.get("X-Signature-Timestamp") ?? "";
  const key = hex(publicKey);
  if (!signature || !timestamp || !key) return false;
  try {
    const verifier = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, verifier, signature, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

function hex(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(text)) return null;
  return new Uint8Array(text.match(/../g)!.map((pair) => parseInt(pair, 16)));
}
