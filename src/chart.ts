// the five spots of "best from community" at the top of the store, set with /setchart by the chart keepers

import type { Env } from "./env.ts";

export const ChartSize = 5;

// post ids by spot, null where a spot is empty
export async function loadChart(env: Env): Promise<Array<string | null>> {
  const saved = (await env.FEED.get("chart", "json")) as Array<string | null> | null;
  return Array.from({ length: ChartSize }, (_, i) => saved?.[i] ?? null);
}

export async function saveChart(env: Env, chart: Array<string | null>): Promise<void> {
  await env.FEED.put("chart", JSON.stringify(chart));
}
