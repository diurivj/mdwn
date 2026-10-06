/**
 * Minimal, dependency-free ZIP reader/writer for mdwn's owned-Files export
 * (ticket 28) and the Import archive preflight (ticket 29).
 *
 * The format is deliberately plain: local file headers, file data, a central
 * directory, and the end-of-central-directory record. Entry names are UTF-8
 * with the language-encoding flag set; regular files use DEFLATE (raw) when
 * it shrinks the payload and STORE otherwise. ZIP64, data descriptors,
 * encryption, and multi-disk archives are rejected. The reader enforces
 * relative, traversal-free member paths so a hostile archive can never name a
 * path outside the extraction root.
 *
 * Browser and Node both provide CompressionStream/DecompressionStream; callers
 * that lack them still get a valid STORE-only archive on the write path.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;
const END_MIN_BYTES = 22;
const COMMENT_MAX_BYTES = 0xffff;

export type ZipEntry = {
  /** Relative member path using `/` separators; a directory ends with `/`. */
  path: string;
  directory: boolean;
  data: Uint8Array;
};

export type ZipInput = {
  path: string;
  directory?: boolean;
  /** Present for regular files; omitted (or empty) for directories. */
  data?: Uint8Array;
};

export type ZipErrorCode =
  | "invalid-path"
  | "duplicate-path"
  | "too-many-entries"
  | "too-large"
  | "malformed"
  | "unsupported"
  | "checksum-mismatch";

/** Contains no plaintext names beyond the offending local path validation. */
export class ZipError extends Error {
  constructor(readonly code: ZipErrorCode) {
    super(`mdwn/zip: ${code}`);
    this.name = "ZipError";
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Split a member path and reject absolute, empty, `.`, or `..` components. */
export function validateZipPath(path: string): string[] {
  if (
    typeof path !== "string" ||
    !path.length ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\0") ||
    path.includes("\\")
  )
    throw new ZipError("invalid-path");
  const components = path.split("/").filter((component) => component !== "");
  if (
    !components.length ||
    components.length !== path.split("/").length ||
    components.some((component) => component === "." || component === "..")
  )
    throw new ZipError("invalid-path");
  return components;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((length, part) => length + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Response(bytes.slice()).body!.pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new ZipError("unsupported");
  try {
    const stream = new Response(bytes.slice()).body!.pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ZipError("malformed");
  }
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Build one ZIP archive. Entries appear in the given order; directories are stored. */
export async function createZip(inputs: readonly ZipInput[], options: { at?: Date } = {}): Promise<Uint8Array> {
  if (inputs.length > MAX_U16) throw new ZipError("too-many-entries");
  const at = options.at ?? new Date();
  const { time, date } = dosDateTime(at);
  const names = new Set<string>();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const input of inputs) {
    const components = validateZipPath(
      input.directory && input.path.endsWith("/") ? input.path.slice(0, -1) : input.path,
    );
    const path = `${components.join("/")}${input.directory ? "/" : ""}`;
    if (names.has(path)) throw new ZipError("duplicate-path");
    names.add(path);
    const name = encoder.encode(path);
    if (name.length > MAX_U16) throw new ZipError("invalid-path");
    const data = input.directory ? new Uint8Array() : (input.data ?? new Uint8Array());
    if (input.directory && data.length) throw new ZipError("invalid-path");
    let method = METHOD_STORE;
    let payload = data;
    if (!input.directory) {
      const deflated = await deflateRaw(data);
      if (deflated !== null && deflated.length < data.length) {
        method = METHOD_DEFLATE;
        payload = deflated;
      }
    }
    const checksum = crc32(data);
    const header = new Uint8Array(30 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, LOCAL_SIGNATURE, true);
    headerView.setUint16(4, VERSION_NEEDED, true);
    headerView.setUint16(6, FLAG_UTF8, true);
    headerView.setUint16(8, method, true);
    headerView.setUint16(10, time, true);
    headerView.setUint16(12, date, true);
    headerView.setUint32(14, checksum, true);
    headerView.setUint32(18, payload.length, true);
    headerView.setUint32(22, data.length, true);
    headerView.setUint16(26, name.length, true);
    headerView.setUint16(28, 0, true);
    header.set(name, 30);
    local.push(header, payload);
    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, CENTRAL_SIGNATURE, true);
    recordView.setUint16(4, VERSION_NEEDED, true);
    recordView.setUint16(6, VERSION_NEEDED, true);
    recordView.setUint16(8, FLAG_UTF8, true);
    recordView.setUint16(10, method, true);
    recordView.setUint16(12, time, true);
    recordView.setUint16(14, date, true);
    recordView.setUint32(16, checksum, true);
    recordView.setUint32(20, payload.length, true);
    recordView.setUint32(24, data.length, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint16(30, 0, true);
    recordView.setUint16(32, 0, true);
    recordView.setUint16(34, 0, true);
    recordView.setUint16(36, 0, true);
    recordView.setUint32(38, input.directory ? 0x10 : 0, true);
    recordView.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    offset += header.length + payload.length;
    if (offset > MAX_U32) throw new ZipError("too-large");
  }
  const localBytes = concat(local);
  const centralBytes = concat(central);
  const end = new Uint8Array(END_MIN_BYTES);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_SIGNATURE, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, inputs.length, true);
  endView.setUint16(10, inputs.length, true);
  endView.setUint32(12, centralBytes.length, true);
  endView.setUint32(16, localBytes.length, true);
  endView.setUint16(20, 0, true);
  const archive = concat([localBytes, centralBytes, end]);
  if (archive.length > MAX_U32) throw new ZipError("too-large");
  return archive;
}

type CentralRecord = {
  path: string;
  directory: boolean;
  method: number;
  flags: number;
  checksum: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

function findEnd(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const earliest = Math.max(0, bytes.length - END_MIN_BYTES - COMMENT_MAX_BYTES);
  for (let offset = bytes.length - END_MIN_BYTES; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) !== END_SIGNATURE) continue;
    // The comment length must account for every byte after this record, so a
    // signature inside a comment is never mistaken for the real terminator.
    if (offset + END_MIN_BYTES + view.getUint16(offset + 20, true) === bytes.length) return offset;
  }
  throw new ZipError("malformed");
}

/** Parse one ZIP archive into entries, verifying structure, sizes, and CRC-32. */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  if (!(bytes instanceof Uint8Array) || bytes.length < END_MIN_BYTES) throw new ZipError("malformed");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(bytes);
  const disk = view.getUint16(end + 4, true),
    centralDisk = view.getUint16(end + 6, true);
  const count = view.getUint16(end + 8, true),
    total = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true),
    centralOffset = view.getUint32(end + 16, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    count !== total ||
    centralOffset + centralSize !== end ||
    centralSize > bytes.length
  )
    throw new ZipError("unsupported");
  const records: CentralRecord[] = [];
  const seen = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new ZipError("malformed");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const recordCommentLength = view.getUint16(offset + 32, true);
    const internal = view.getUint16(offset + 36, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (offset + 46 + nameLength + extraLength + recordCommentLength > end || !nameLength)
      throw new ZipError("malformed");
    if (flags & FLAG_ENCRYPTED) throw new ZipError("unsupported");
    if (flags & FLAG_DATA_DESCRIPTOR) throw new ZipError("unsupported");
    if (compressedSize === MAX_U32 || size === MAX_U32 || localOffset === MAX_U32 || internal !== 0)
      throw new ZipError("unsupported");
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new ZipError("unsupported");
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      throw new ZipError("malformed");
    }
    const directory = name.endsWith("/");
    const path = directory ? name.slice(0, -1) : name;
    const components = validateZipPath(path);
    const canonical = `${components.join("/")}${directory ? "/" : ""}`;
    if (seen.has(canonical)) throw new ZipError("duplicate-path");
    seen.add(canonical);
    records.push({ path: components.join("/"), directory, method, flags, checksum, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + recordCommentLength;
  }
  if (offset !== end) throw new ZipError("malformed");
  const entries: ZipEntry[] = [];
  for (const record of records) {
    const { localOffset } = record;
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE)
      throw new ZipError("malformed");
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const nameLength = view.getUint16(localOffset + 26, true);
    const extraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + nameLength + extraLength;
    if (
      localFlags !== record.flags ||
      localMethod !== record.method ||
      localOffset >= centralOffset ||
      dataStart + record.compressedSize > centralOffset
    )
      throw new ZipError("malformed");
    const payload = bytes.subarray(dataStart, dataStart + record.compressedSize);
    const data = record.method === METHOD_DEFLATE ? await inflateRaw(payload) : new Uint8Array(payload);
    if (data.length !== record.size || crc32(data) !== record.checksum) throw new ZipError("checksum-mismatch");
    entries.push({ path: record.path, directory: record.directory, data });
  }
  return entries;
}
