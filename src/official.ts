// only official mochy builds may use the store: they carry a key that isn't in mochy's public code and sign each request with it, so a fork built from the source is turned away

import type { Env } from "./env.ts";

// a signature older than this, or this far in the future, is turned away, so a copied request soon stops working
const WindowSeconds = 300;

// the signature covers when it was made, what was asked for, and the session (or the sign-in's state)
export async function signedByOfficialBuild(env: Env, time: string | null, signature: string | null, method: string, path: string, extra: string): Promise<boolean> {
  if (!env.STORE_KEY || !time || !signature || !/^\d+$/.test(time) || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  if (Math.abs(Date.now() / 1000 - Number(time)) > WindowSeconds) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STORE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const given = new Uint8Array(signature.match(/../g)!.map((pair) => parseInt(pair, 16)));
  // verify compares in constant time, so the answer's timing gives nothing away
  return crypto.subtle.verify("HMAC", key, given, new TextEncoder().encode(`${time}\n${method}\n${path}\n${extra}`));
}
