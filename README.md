# Mochy module feed

A Cloudflare Worker behind Mochy's **Module Browser**. It reads the module forums in Mochy's Bar with a bot every 10 minutes,
opens each post's zip for its manifest and icon, and keeps one list. The app signs people in with Discord through the worker,
and only people in the server can see the list or download a zip. A paid forum shows its modules to everyone in the server, but
locked: only people who can see that forum in Discord can download from it.

The app never holds a Discord token. It gets a random session id; the worker keeps the person's tokens, asks Discord again
every 10 minutes whether they're still in the server and which roles they have, and passes zips through so Discord's file
links (which run out after a day) are always fresh.

## Posting a module

One forum post per module, and **a post only shows in the store once its maker publishes it** with `/publish`, `/publishlink`
or `/publishweb`.

- **Title:** the module's name in the store. A `[LOOKS]` or `[PLAYERTHEME]` prefix is fine; it's taken off. Renaming the post
  renames the module within 10 minutes.
- **Tags:** the forum's tags say what kind it is. A tag with "player" in it makes a player theme; "look", "theme", "skin",
  "glass" or "font" a look; "source", "audio", "lyrics", "metadata" or "provider" a source. "Paid" or "premium" marks it
  paid. With no tags, the title's prefix or the manifest decides.
- **Attach the `.zip`** (the same one Mochy adds from a file) and a picture of it in the same message.

Every command points at a message: paste its link (copy it from the message's menu), or just its id when you run it inside
the post. The post's author and mods can use them. When one works the bot posts what changed in the post for everyone; when
something's wrong, only you see why.

| Command | What it does |
|---|---|
| `/publish` | Puts the post in the store. The message needs the `.zip` and at least one picture: the first picture becomes the banner and the message's words the description. The author gets the publisher role. |
| `/publishlink` | For a module people add by link (a GitHub project or a module's address): the message needs the link and a picture. The store's ADD adds it from that link, so its updates come from there too. |
| `/publishweb` | For a module that lives on a web page: the message needs the page's link and a picture, and the store's button opens it. |
| `/modulepack` | For several modules in one post: the message needs at least two `.zip` files or links (or both, up to 10) and a picture. Each zip is read for its name, version and icon; a link takes its name from `[Name](link)` or the GitHub project. People add each one on its own from the pack's page. Run it again to change what's in the pack. |
| `/update` | Makes that message's zip the module now. A picture next to it becomes the new banner. Without it, the newest zip from the author takes over within 10 minutes; a picked zip stays until the author posts a newer one. |
| `/preview` | The message's pictures (up to 8) become the store page's previews. |
| `/banner` | The message's first picture becomes the store page's banner. |
| `/icon` | The message's first picture becomes the store icon, in place of the zip's own. |
| `/setchart` | `lvl` 1 to 5 and a published post (its link or id, or `clear`): puts that module at that spot in the store's "Best from community". Only members with a role in `CHART_ROLES`, the server's owner and its admins can use it. |
| `/whatis` | Answers everyone with a link to the module guide. |
| `/src` | Answers everyone with a link to this repo. |
| `/help` | Lists every command and what it does, only for whoever asked. |

Every command's name, its short line in Discord and its line in `/help` live in `src/catalog.ts`, which `npm run register`
reads too, so a new command goes there first.

For the link ones the message's words, without the link, become the description, and its author shows as the maker.
`/update` only swaps zips; run the link command again to change a link, or `/publish` to switch to a zip.

Pictures are copied into the worker (up to 8 MB each), since Discord's own picture links run out after a day. If a command
answers that it can't see what's in messages, Message Content Intent is off in the Developer Portal.

## Setting it up

1. **The Discord application.** In the [Developer Portal](https://discord.com/developers/applications), make a new
   application (not the one Mochy's Rich Presence uses).
   - **Bot:** add a bot, copy its token, and turn on **Message Content Intent** (without it Discord hides a post's
     attachments from the bot).
   - **General Information:** copy the *Public Key* into `PUBLIC_KEY` in `wrangler.toml` (slash commands are signed with it).
   - **OAuth2:** copy the client id and client secret, and add the redirect `https://<your worker>/callback`.
   - **Invite the bot** to Mochy's Bar with the `bot` and `applications.commands` scopes and *View Channels*, *Read Message
     History*, *Send Messages in Threads* and *Manage Roles*, and make sure it can see every module forum, the paid ones included. Drag the bot's role
     above the publisher role (`PUBLISHER_ROLE`), or it can't hand that one out. *Send Messages in Threads* lets the bot reply with one-click Publish/Update buttons when a maker posts a new module or uploads a new `.zip`.
2. **The worker.**
   ```
   npm install
   npx wrangler d1 create mochy-module-feed                       # put the database_id it prints into wrangler.toml
   npx wrangler d1 execute mochy-module-feed --remote --file=schema.sql
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put CLIENT_SECRET
   npx wrangler secret put STORE_KEY        # the same key as MODULE_STORE_KEY in Mochy's local.properties and GitHub secrets
   ```
   In `wrangler.toml` set `CLIENT_ID`, and list every module forum in `FORUMS`, for example
   `[{"id": "1566642801482006599", "paid": false}, {"id": "<paid forum id>", "paid": true}]`. Then `npx wrangler deploy`.
   The first list is read on the first cron run or the first time someone opens the browser.
3. **The commands.** Once it's deployed, run `BOT_TOKEN=<bot token> npm run register -- https://<your worker>`. It checks
   `CLIENT_ID` and `PUBLIC_KEY` against the bot, adds the commands to Mochy's Bar and sets the app's Interactions Endpoint URL
   to `https://<your worker>/interactions`.
4. **Mochy.** Put the worker's address in `ModuleFeed.FeedUrl` (`modules/browser/ModuleFeed.kt`) and build.

## Official builds only

The store only answers official Mochy builds. They carry `MODULE_STORE_KEY`, which lives in Mochy's `local.properties` and
its GitHub Actions secrets but never in its public code, and sign each request with it: an HMAC-SHA256 over the time, the
method, the path and the session (`X-Mochy-Time`, `X-Mochy-Sign`), or over the state in the sign-in link (`t`, `sig`). The
worker checks it against `STORE_KEY` and turns anything else away with `403 unofficial_build`, which the app shows as its
"you're using a fork" page. A signature more than five minutes off is turned away too, so a copied request soon stops
working. Pictures, icons, signing out and Discord's own calls need no signature.

This stops forks built from the source. The key is inside every official APK, scrambled but there, so someone who digs it
out could still get in; changing the key (all three places) and shipping a new build shuts them out again.

## Staying online

Discord only shows a bot online while it holds a gateway connection, and a worker can't keep one open. `Presence`
(`src/presence.ts`) is a Durable Object that does: its alarm sends the heartbeat every ~41 s, a dropped connection resumes
the same session instead of signing in again (Discord allows 1000 sign-ins a day), and the cron wakes it every 10 minutes in
case it ever stopped. A rejected token waits for the cron rather than retrying. Kept awake all day it uses about 83% of the
free plan's daily Durable Object time; going over only takes the green dot away until the next day.

## The api the app uses

Every call but `/login`, `/callback`, `/icons/<post>`, `/pictures/...` and `/interactions` (Discord's, signed with the public key) takes
`Authorization: Bearer <session>` and the build's signature (see Official builds only); `/login` carries its signature in the link.

| Call | What it does |
|---|---|
| `GET /login?state=<app state>` | Off to Discord to sign in; comes back to `mochy-modules://signed-in?session=…&state=…` (or `error=…`) |
| `GET /me` | `name`, `avatar`, `member`, `invite` |
| `GET /modules` | `me` (as `/me`) and the published modules: `id` (the post), `name`, `moduleId`, `version`, `author`, `description`, `kind` (`look`, `player`, `source`, `other`), `tags`, `paid`, `locked`, `icon`, `banner`, `previews`, `postUrl`, `size` (a pack's zips together), `updated` (milliseconds: the zip's message, or the last link publish), `install` (`zip`, `link`, `web` or `pack`), `link` and `pack` (a pack's modules: `id`, `kind`, `name`, `moduleId`, `version`, `size`, `icon`, `link`); `chart`, the post ids of "Best from community" in order; and `categories`, every forum tag in order, which the store shows as its chips. `403 not_member` with the invite when they're not in the server, `503 warming_up` before the first read |
| `GET /modules/<post>/zip` | The module's zip, or with `?item=<id>` one of a pack's; `403 locked` for a paid one they can't see, `404 not_a_zip` for a linked one or a pack without `item` |
| `GET /icons/<post>` | The icon from the zip |
| `GET /pictures/<post>/<id>` | A banner, preview or `/icon` picture, cached for good since a new picture gets a new id |
| `POST /signout` | Forgets the session |

## Tests

`npm test` (Node 23 or newer, which runs TypeScript as is). They read a small stand-in module zip, check the permission maths, and run
the whole worker against a pretend Discord: signing in, the cron, the list, the paid lock, the downloads, the store commands, `/whatis`, `/src` and `/help`; and the online connection against a pretend gateway.
