// puts the module commands into mochy's bar and points discord at the worker; run it once after deploying: BOT_TOKEN=... npm run register -- https://<worker address>

import { readFileSync } from "node:fs";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const setting = (name: string) => toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? "";
const token = process.env.BOT_TOKEN;
const worker = process.argv[2]?.replace(/\/+$/, "");
if (!token || !worker?.startsWith("https://")) {
  console.error("usage: BOT_TOKEN=<bot token> npm run register -- https://<worker address>");
  process.exit(1);
}

async function api<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} said ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

// a bot token from another application, or a key that isn't in wrangler.toml yet, would only show up later as commands that never answer
const app = await api<{ id: string; verify_key: string }>("/applications/@me", "GET");
if (app.id !== setting("CLIENT_ID")) throw new Error(`this bot belongs to application ${app.id}, but wrangler.toml's CLIENT_ID is ${setting("CLIENT_ID")}`);
if (app.verify_key !== setting("PUBLIC_KEY")) throw new Error(`put PUBLIC_KEY = "${app.verify_key}" in wrangler.toml, deploy, then run this again`);

// every module command points at a message, by its link or, inside the post, its id
const message = (description: string) => [{ name: "message", type: 3, required: true, description }];
const commands = [
  { name: "publish", description: "Put your module in Mochy's store: a message with its .zip and a picture", options: message("The message's link, or its id when you're in the post") },
  { name: "publishlink", description: "Publish a module people add by link (GitHub and the like): a message with the link and a picture", options: message("The message's link, or its id when you're in the post") },
  { name: "publishweb", description: "Publish a module as a web page the store opens: a message with the page's link and a picture", options: message("The message's link, or its id when you're in the post") },
  { name: "update", description: "Update a module from a message with its new zip", options: message("The message's link, or its id when you're in the post") },
  { name: "preview", description: "Set the preview pictures on a module's store page", options: message("A message with the pictures: its link, or its id in the post") },
  { name: "banner", description: "Set the banner on a module's store page", options: message("A message with the picture: its link, or its id in the post") },
  { name: "icon", description: "Set a module's icon in the store", options: message("A message with the picture: its link, or its id in the post") },
  { name: "whatis", description: "What Mochy modules are, and how to make one" },
  { name: "src", description: "Where this bot's code lives" },
].map((c) => ({ type: 1, ...c }));

// a server's own command shows up straight away; a global one can take an hour
await api(`/applications/${app.id}/guilds/${setting("GUILD_ID")}/commands`, "PUT", commands);
// discord pings the address before saving it, so the worker has to be deployed with the right key first
await api("/applications/@me", "PATCH", { interactions_endpoint_url: `${worker}/interactions` });
console.log(`${commands.map((c) => "/" + c.name).join(" ")} are in the server and discord sends them to ${worker}/interactions`);
