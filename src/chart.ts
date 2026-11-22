// the five spots of "best from community" at the top of the store, set with /setchart by the chart keepers

import type { Env } from "./env.ts";
import { getJson, putJson } from "./store.ts";

export const ChartSize = 5;

// post ids by spot, null where a spot is empty
export async function loadChart(env: Env): Promise<Array<string | null>> {
  const saved = await getJson<Array<string | null>>(env, "chart");
  return Array.from({ length: ChartSize }, (_, i) => saved?.[i] ?? null);
}

export async function saveChart(env: Env, chart: Array<string | null>): Promise<void> {
  await putJson(env, "chart", chart);
}
