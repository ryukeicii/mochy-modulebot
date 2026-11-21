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
    description: "Put your module in Mochy's store: a message with its .zip and a picture",
    help: "puts your module in the store. Point it at a message with the .zip and a picture: the first picture becomes the banner, the message's words the description.",
    takesMessage: true,
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
    name: "update",
    group: "Changing a published module",
    description: "Update a module from a message with its new zip",
    help: "swaps in the .zip from a message. A picture next to it becomes the new banner.",
    takesMessage: true,
  },
  {
    name: "preview",
    group: "Changing a published module",
    description: "Set the preview pictures on a module's store page",
    help: "uses a message's pictures (up to 8) as the store page's screenshots.",
    takesMessage: true,
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
