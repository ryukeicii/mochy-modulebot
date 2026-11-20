// the pieces that don't need discord: reading a module zip, the permission maths, and turning a post into a card

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canView } from "../src/permissions.ts";
import { cleanTitle, isPaid, kindOf } from "../src/posts.ts";
import { readModuleZip } from "../src/zip.ts";

test("reads a module zip's manifest and icon", async () => {
  const zip = await readModuleZip(new Uint8Array(readFileSync(new URL("./fixtures/look.zip", import.meta.url))));
  assert.ok(zip);
  assert.equal(zip.manifest.id, "liquid-glass");
  assert.equal(zip.icon?.type, "image/png");
  // a png starts with its signature
  assert.deepEqual([...zip.icon!.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("a zip with no manifest isn't a module", async () => {
  // an empty zip is just the 22 byte end record
  const empty = new Uint8Array(22);
  new DataView(empty.buffer).setUint32(0, 0x06054b50, true);
  assert.equal(await readModuleZip(empty), null);
});

const guild = {
  id: "g",
  ownerId: "owner",
  roles: [
    { id: "g", permissions: String(1 << 10) },
    { id: "buyer", permissions: "0" },
    { id: "admin", permissions: String(1 << 3) },
  ],
};
const paidForum = [
  { id: "g", type: 0, allow: "0", deny: String(1 << 10) },
  { id: "buyer", type: 0, allow: String(1 << 10), deny: "0" },
];

test("a forum hidden from everyone shows to the role it's opened to", () => {
  assert.equal(canView(guild, "someone", [], paidForum), false);
  assert.equal(canView(guild, "someone", ["buyer"], paidForum), true);
  assert.equal(canView(guild, "someone", ["admin"], paidForum), true);
  assert.equal(canView(guild, "owner", [], paidForum), true);
  assert.equal(canView(guild, "someone", [], []), true);
});

test("a member's own deny beats their role's allow", () => {
  const banned = [...paidForum, { id: "someone", type: 1, allow: "0", deny: String(1 << 10) }];
  assert.equal(canView(guild, "someone", ["buyer"], banned), false);
});

test("a post's kind comes from its tags, then its title, then its manifest", () => {
  assert.equal(kindOf(["Player theme"], "Anything", {}), "player");
  assert.equal(kindOf(["Looks"], "Anything", {}), "look");
  assert.equal(kindOf([], "[PLAYERTHEME] Neon", {}), "player");
  assert.equal(kindOf([], "[LOOKS] Neon", {}), "look");
  assert.equal(kindOf([], "Neon", { glass: true }), "look");
  assert.equal(kindOf([], "Neon", { base: true }), "source");
  assert.equal(kindOf([], "Neon", {}), "other");
});

test("titles lose their bracketed prefixes and paid follows the forum or a tag", () => {
  assert.equal(cleanTitle("[LOOKS] Liquid Glass"), "Liquid Glass");
  assert.equal(cleanTitle("[LOOKS][PLAYERTHEME]  Liquid Glass "), "Liquid Glass");
  assert.equal(cleanTitle("[LOOKS]"), "[LOOKS]");
  assert.equal(isPaid([], true), true);
  assert.equal(isPaid(["Paid"], false), true);
  assert.equal(isPaid(["Looks"], false), false);
});
