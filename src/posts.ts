// turns a forum post into a module card: its kind from the post's tags (or a [LOOKS] style prefix), a clean title, and what the zip says

export type Kind = "look" | "player" | "source" | "other";

// tags win, then a bracketed prefix in the title, then what the module's own manifest brings
export function kindOf(tagNames: string[], title: string, manifest: Record<string, unknown>): Kind {
  const words = [...tagNames, ...(title.match(/\[[^\]]+\]/g) ?? [])].join(" ").toLowerCase();
  if (/player/.test(words)) return "player";
  if (/look|theme|skin|glass|font/.test(words)) return "look";
  if (/source|audio|lyric|metadata|provider/.test(words)) return "source";
  if (manifest.player) return "player";
  if (manifest.glass || manifest.look || manifest.font || manifest.pages) return "look";
  if (manifest.base || manifest.search || manifest.stream || manifest.lyrics) return "source";
  return "other";
}

// "[LOOKS] Liquid Glass" and "[PLAYERTHEME]  Liquid Glass" both read "Liquid Glass"
export function cleanTitle(title: string): string {
  return title.replace(/^(\s*\[[^\]]*\]\s*)+/, "").trim() || title.trim();
}

export function isPaid(tagNames: string[], forumPaid: boolean): boolean {
  return forumPaid || tagNames.some((name) => /paid|premium/i.test(name));
}

// the first line or two of the post, for when the manifest has no description of its own
export function summary(content: string, max = 240): string {
  const text = content.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

export function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}
