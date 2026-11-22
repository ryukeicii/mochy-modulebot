// d1 storage for json/text entries (with optional ttl) and chunked binary blobs (icons and pictures up to 8 MB)

import type { Env } from "./env.ts";

// safely under d1's 2 MB max row/blob limit
export const BlobChunkBytes = 512 * 1024;

export async function getText(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)")
    .bind(key, Date.now())
    .first<{ value: string }>();
  return row ? row.value : null;
}

export async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await getText(env, key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function putText(env: Env, key: string, value: string, expirationTtlSeconds?: number): Promise<void> {
  const expiresAt = expirationTtlSeconds ? Date.now() + expirationTtlSeconds * 1000 : null;
  await env.DB.prepare(
    "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
  )
    .bind(key, value, expiresAt)
    .run();
}

export async function putJson(env: Env, key: string, value: unknown, expirationTtlSeconds?: number): Promise<void> {
  await putText(env, key, JSON.stringify(value), expirationTtlSeconds);
}

export async function deleteKey(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
}

// reads every entry under a prefix in one query, keyed by the suffix after the prefix
export async function listJsonByPrefix<T>(env: Env, prefix: string): Promise<Map<string, T>> {
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM kv WHERE key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?)",
  )
    .bind(prefix, end, Date.now())
    .all<{ key: string; value: string }>();
  const map = new Map<string, T>();
  for (const row of results) map.set(row.key.slice(prefix.length), JSON.parse(row.value) as T);
  return map;
}

export async function pruneExpired(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(Date.now()).run();
}

export async function putBlob(env: Env, key: string, data: Uint8Array | ArrayBuffer, contentType: string): Promise<void> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const statements = [
    env.DB.prepare("DELETE FROM blob_chunks WHERE key = ?").bind(key),
    env.DB.prepare("INSERT INTO blobs (key, content_type) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET content_type = excluded.content_type")
      .bind(key, contentType),
  ];
  if (bytes.byteLength === 0) {
    statements.push(env.DB.prepare("INSERT INTO blob_chunks (key, idx, data) VALUES (?, ?, ?)").bind(key, 0, new Uint8Array(0)));
  } else {
    for (let offset = 0, idx = 0; offset < bytes.byteLength; offset += BlobChunkBytes, idx++) {
      const slice = bytes.slice(offset, Math.min(offset + BlobChunkBytes, bytes.byteLength));
      statements.push(env.DB.prepare("INSERT INTO blob_chunks (key, idx, data) VALUES (?, ?, ?)").bind(key, idx, slice));
    }
  }
  await env.DB.batch(statements);
}

export async function getBlob(env: Env, key: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  const { results } = await env.DB.prepare(
    "SELECT b.content_type, c.data FROM blobs b JOIN blob_chunks c ON b.key = c.key WHERE b.key = ? ORDER BY c.idx",
  )
    .bind(key)
    .all<{ content_type: string; data: unknown }>();
  if (!results.length) return null;
  const type = results[0].content_type || "image/png";
  if (results.length === 1) return { bytes: toBytes(results[0].data), type };
  const parts = results.map((r) => toBytes(r.data));
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, type };
}

export async function deleteBlob(env: Env, key: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM blob_chunks WHERE key = ?").bind(key),
    env.DB.prepare("DELETE FROM blobs WHERE key = ?").bind(key),
  ]);
}

// cloudflare d1 returns blob columns as number[] in workers, while local sqlite returns Uint8Array/ArrayBuffer
function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) return new Uint8Array(raw);
  throw new Error(`unexpected blob chunk type: ${typeof raw}`);
}
