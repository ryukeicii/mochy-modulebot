// every slash command the bot has: what discord shows under its name, and the longer line /help gives; npm run register reads it too

export interface CommandInfo {
  name: string;
  group: string;
  // discord's own short line, 100 characters at most
  description: string;
  help: string;
  // points at a message by its link, or its id inside the post
  takesMessage: boolean;
  // discord's options, for a command that takes something other than a message
  options?: unknown[];
}

export const CommandList: CommandInfo[] = [
  {
    name: "publish",
    group: "Publishing",
    description: "Put your module in Mochy's store from a message, with an optional zip message or link",
    help: "puts your module in the store from a message with a picture and description, plus an optional zip message or module link.",
    takesMessage: true,
    options: [
      { name: "message", type: 3, required: true, description: "Message with description and banner picture (link or id)" },
      { name: "module", type: 3, required: false, description: "Optional: message link/id with the .zip, or a module link (GitHub/URL)" },
    ],
  },
  {
    name: "publishlink",
    group: "Publishing",
    description: "Publish a module people add by link (GitHub and the like): a message with the link and a picture",
    help: "the same, for a module people add by link (a GitHub project or a module's address). The message needs the link and a picture, and updates come from that link.",
    takesMessage: true,
  },
  {
    name: "publishweb",
    group: "Publishing",
    description: "Publish a module as a web page the store opens: a message with the page's link and a picture",
    help: "the same, for a module that lives on a web page. The message needs the page's link and a picture, and the store's button opens it.",
    takesMessage: true,
  },
  {
    name: "modulepack",
    group: "Publishing",
    description: "Publish a pack of modules: a message with their zips or links and a picture",
    help: "the same, for a pack: a message with several .zip files and links (GitHub and the like), and a picture. People add each one on its own from the pack's page.",
    takesMessage: true,
  },
  {
    name: "update",
    group: "Changing a published module",
    description: "Update a module from a message with its new zip",
    help: "swaps in the .zip from a message. A picture next to it becomes the new banner.",
    takesMessage: true,
  },
  {
    name: "preview",
    group: "Changing a published module",
    description: "Set or add preview pictures on a module's store page",
    help: "uses a message's pictures (up to 8) as screenshots; set addimage to true to append instead of replacing.",
    takesMessage: true,
    options: [
      { name: "message", type: 3, required: true, description: "The message's link, or its id when you're in the post" },
      { name: "addimage", type: 5, required: false, description: "True to add images to existing previews instead of replacing them" },
    ],
  },
  {
    name: "banner",
    group: "Changing a published module",
    description: "Set the banner on a module's store page",
    help: "uses a message's first picture as the store page's banner.",
    takesMessage: true,
  },
  {
    name: "icon",
    group: "Changing a published module",
    description: "Set a module's icon in the store",
    help: "uses a message's first picture as the store icon, in place of the zip's own.",
    takesMessage: true,
  },
  {
    name: "unpublish",
    group: "Changing a published module",
    description: "Remove a published module from Mochy's store",
    help: "removes a post from the store and chart. Run inside the post, or pass its link or id.",
    takesMessage: false,
    options: [
      { name: "post", type: 3, required: false, description: "Optional: the post's link or id (leave empty inside the post)" },
    ],
  },
  {
    name: "setchart",
    group: "The chart",
    description: "Put a module at a spot from 1 to 5 in Best from community (chart keepers and admins)",
    help: "puts a module's post at a spot from 1 to 5 in Best from community, at the top of the store. Write clear instead of a post to empty a spot. Only the chart keepers and the server's admins can use it.",
    takesMessage: false,
    options: [
      { name: "lvl", type: 4, required: true, min_value: 1, max_value: 5, description: "The spot, from 1 at the top to 5" },
      { name: "post", type: 3, required: true, description: "The module's post: its link or id, or clear to empty the spot" },
    ],
  },
  { name: "whatis", group: "Everything else", description: "What Mochy modules are, and how to make one", help: "links the module guide.", takesMessage: false },
  { name: "src", group: "Everything else", description: "Where this bot's code lives", help: "links this bot's code.", takesMessage: false },
  { name: "help", group: "Everything else", description: "What every command does", help: "shows this list.", takesMessage: false },
];

// discord's slash command payloads, shared by register.ts and the worker's own auto-sync
export function commandPayloads() {
  return CommandList.map((c) => ({
    type: 1,
    name: c.name,
    description: c.description,
    ...(c.options
      ? { options: c.options }
      : c.takesMessage
        ? { options: [{ name: "message", type: 3, required: true, description: "The message's link, or its id when you're in the post" }] }
        : {}),
  }));
}

// the commands under their groups, with how to point at a message and who may change a post
export function helpText(): string {
  const groups = [...new Set(CommandList.map((c) => c.group))];
  const sections = groups.map((group) => {
    const lines = CommandList.filter((c) => c.group === group).map((c) => `\`/${c.name}\` ${c.help}`);
    return [`**${group}**`, ...lines].join("\n");
  });
  return [
    "**Hep me Mochy**",
    "Every module command takes a message: paste its link (from the message's menu), or just its id when you're inside the post.",
    ...sections,
    "Only the post's author and mods can change a post, and the module's name in the store is the post's title.",
  ].join("\n\n");
}
