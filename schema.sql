-- key-value entries (index, chart, commands_hash, listings, zip picks and sign-in sessions)
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv(expires_at) WHERE expires_at IS NOT NULL;

-- binary assets (module icons and store pictures), chunked so pictures up to 8 MB stay under D1's 2 MB row limit
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blob_chunks (
  key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key, idx)
);
