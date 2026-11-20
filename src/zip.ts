// just enough of a zip reader to pull a module's manifest.json and icon out of a post's zip, without any packages

const EndOfDirectory = 0x06054b50;
const DirectoryEntry = 0x02014b50;
const LocalHeader = 0x04034b50;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

// the central directory lists every file; it sits at the end, found from the end-of-directory record
export function listZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  // the end record is 22 bytes plus a comment of up to 64 KB, so it's somewhere in the last 65.5 KB
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === EndOfDirectory) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== DirectoryEntry) throw new Error("broken zip directory");
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    entries.push({
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// one file's bytes: stored ones as they are, deflated ones through the runtime's own inflater
export async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== LocalHeader) throw new Error(`broken zip entry ${entry.name}`);
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error(`${entry.name} is packed in a way this reader doesn't know`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ModuleZip {
  manifest: Record<string, unknown>;
  icon: { bytes: Uint8Array; type: string } | null;
}

const IconTypes: Record<string, string> = { png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg" };

// the manifest nearest the zip's top (mochy allows one folder around it) and the icon it names, next to it
export async function readModuleZip(bytes: Uint8Array): Promise<ModuleZip | null> {
  const entries = listZip(bytes);
  const manifestEntry = entries
    .filter((e) => e.name === "manifest.json" || e.name.endsWith("/manifest.json"))
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (!manifestEntry) return null;
  const root = manifestEntry.name.slice(0, manifestEntry.name.length - "manifest.json".length);
  const manifest = JSON.parse(new TextDecoder().decode(await readEntry(bytes, manifestEntry)));
  if (typeof manifest !== "object" || manifest === null) return null;
  let icon: ModuleZip["icon"] = null;
  const iconPath = typeof manifest.icon === "string" ? manifest.icon.replace(/^\/+/, "") : null;
  const type = iconPath ? IconTypes[iconPath.split(".").pop()?.toLowerCase() ?? ""] : undefined;
  const iconEntry = iconPath && type ? entries.find((e) => e.name === root + iconPath) : undefined;
  if (iconEntry && type && iconEntry.size <= 512 * 1024) icon = { bytes: await readEntry(bytes, iconEntry), type };
  return { manifest, icon };
}
