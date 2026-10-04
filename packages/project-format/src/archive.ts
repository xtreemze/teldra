import type { TwinProject } from "@teldra/domain";
import {
  parseProjectManifest,
  parseTwinProject,
  type TeldraProjectManifest,
} from "./index.js";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORED_METHOD = 0;
const MAX_ENTRIES = 10_000;
const MAX_SINGLE_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const DOS_DATE_1980_01_01 = 0x0021;

export interface TeldraArchiveEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface OpenTeldraArchive {
  readonly entries: readonly TeldraArchiveEntry[];
  readonly manifest: TeldraProjectManifest;
  readonly twin: TwinProject;
}

export class TeldraArchiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TeldraArchiveError";
  }
}

export function encodeStoredZip(
  entries: readonly TeldraArchiveEntry[],
): Uint8Array {
  validateEntryCollection(entries);

  const sorted = [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const encoder = new TextEncoder();
  const records = sorted.map((entry) => {
    const name = encoder.encode(entry.path);
    if (name.length > 0xffff) {
      throw new TeldraArchiveError(
        `ZIP entry path is too long: "${entry.path}".`,
      );
    }

    const crc = crc32(entry.bytes);
    return { entry, name, crc };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const record of records) {
    localSize += 30 + record.name.length + record.entry.bytes.length;
    centralSize += 46 + record.name.length;
  }

  const totalSize = localSize + centralSize + 22;
  if (!Number.isSafeInteger(totalSize)) {
    throw new TeldraArchiveError("ZIP output size exceeds safe integer range.");
  }

  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  let offset = 0;
  const localOffsets: number[] = [];

  for (const record of records) {
    localOffsets.push(offset);
    view.setUint32(offset, LOCAL_FILE_HEADER, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, UTF8_FLAG, true);
    view.setUint16(offset + 8, STORED_METHOD, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, DOS_DATE_1980_01_01, true);
    view.setUint32(offset + 14, record.crc, true);
    view.setUint32(offset + 18, record.entry.bytes.length, true);
    view.setUint32(offset + 22, record.entry.bytes.length, true);
    view.setUint16(offset + 26, record.name.length, true);
    view.setUint16(offset + 28, 0, true);
    output.set(record.name, offset + 30);
    output.set(record.entry.bytes, offset + 30 + record.name.length);
    offset += 30 + record.name.length + record.entry.bytes.length;
  }

  const centralOffset = offset;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const localOffset = localOffsets[index]!;

    view.setUint32(offset, CENTRAL_DIRECTORY_HEADER, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, UTF8_FLAG, true);
    view.setUint16(offset + 10, STORED_METHOD, true);
    view.setUint16(offset + 12, 0, true);
    view.setUint16(offset + 14, DOS_DATE_1980_01_01, true);
    view.setUint32(offset + 16, record.crc, true);
    view.setUint32(offset + 20, record.entry.bytes.length, true);
    view.setUint32(offset + 24, record.entry.bytes.length, true);
    view.setUint16(offset + 28, record.name.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, localOffset, true);
    output.set(record.name, offset + 46);
    offset += 46 + record.name.length;
  }

  const centralDirectorySize = offset - centralOffset;
  view.setUint32(offset, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, records.length, true);
  view.setUint16(offset + 10, records.length, true);
  view.setUint32(offset + 12, centralDirectorySize, true);
  view.setUint32(offset + 16, centralOffset, true);
  view.setUint16(offset + 20, 0, true);

  return output;
}

export function decodeStoredZip(bytes: Uint8Array): readonly TeldraArchiveEntry[] {
  if (bytes.byteLength < 22) {
    throw new TeldraArchiveError("ZIP is too small to contain a central directory.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const commentLength = view.getUint16(eocdOffset + 20, true);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new TeldraArchiveError("Multi-disk ZIP archives are not supported.");
  }
  if (entryCount > MAX_ENTRIES) {
    throw new TeldraArchiveError(
      `ZIP contains ${entryCount} entries; maximum is ${MAX_ENTRIES}.`,
    );
  }
  if (eocdOffset + 22 + commentLength !== bytes.byteLength) {
    throw new TeldraArchiveError("ZIP end record or comment length is malformed.");
  }
  if (centralOffset + centralSize > eocdOffset) {
    throw new TeldraArchiveError("ZIP central directory is out of bounds.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: TeldraArchiveEntry[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    assertRange(bytes, offset, 46, "central directory header");
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER) {
      throw new TeldraArchiveError(
        `ZIP central directory entry ${index} has an invalid signature.`,
      );
    }

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const expectedCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLengthEntry = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    if ((flags & ~UTF8_FLAG) !== 0) {
      throw new TeldraArchiveError(
        "Encrypted, descriptor-based, or otherwise flagged ZIP entries are not supported.",
      );
    }
    if (method !== STORED_METHOD) {
      throw new TeldraArchiveError(
        "Only stored (uncompressed) ZIP entries are supported by the portable .teldra codec.",
      );
    }
    if (compressedSize !== uncompressedSize) {
      throw new TeldraArchiveError("Stored ZIP entry has mismatched sizes.");
    }
    if (uncompressedSize > MAX_SINGLE_ENTRY_BYTES) {
      throw new TeldraArchiveError(
        `ZIP entry exceeds ${MAX_SINGLE_ENTRY_BYTES} bytes.`,
      );
    }

    assertRange(
      bytes,
      offset + 46,
      nameLength + extraLength + commentLengthEntry,
      "central directory variable data",
    );
    const path = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    validateEntryPath(path);
    if (paths.has(path)) {
      throw new TeldraArchiveError(`Duplicate ZIP entry path "${path}".`);
    }
    paths.add(path);

    assertRange(bytes, localOffset, 30, "local file header");
    if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) {
      throw new TeldraArchiveError(
        `ZIP entry "${path}" has an invalid local header signature.`,
      );
    }

    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);

    if (localFlags !== flags || localMethod !== method) {
      throw new TeldraArchiveError(
        `ZIP entry "${path}" central/local metadata disagrees.`,
      );
    }

    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assertRange(bytes, dataOffset, uncompressedSize, `entry "${path}" data`);
    const data = bytes.slice(dataOffset, dataOffset + uncompressedSize);

    if (crc32(data) !== expectedCrc) {
      throw new TeldraArchiveError(`ZIP entry "${path}" failed CRC-32 validation.`);
    }

    totalBytes += data.byteLength;
    if (totalBytes > MAX_TOTAL_ENTRY_BYTES) {
      throw new TeldraArchiveError(
        `ZIP uncompressed content exceeds ${MAX_TOTAL_ENTRY_BYTES} bytes.`,
      );
    }

    entries.push({ path, bytes: data });
    offset += 46 + nameLength + extraLength + commentLengthEntry;
  }

  if (offset !== centralOffset + centralSize) {
    throw new TeldraArchiveError("ZIP central directory size does not match its entries.");
  }

  return entries;
}

export async function openTeldraArchive(
  bytes: Uint8Array,
): Promise<OpenTeldraArchive> {
  const entries = decodeStoredZip(bytes);
  const byPath = new Map(entries.map((entry) => [entry.path, entry] as const));

  const projectEntry = requireEntry(byPath, "project.json");
  const manifest = parseProjectManifest(parseJson(projectEntry, "project manifest"));
  validateManifestPaths(manifest);

  const referenced = [
    manifest.building,
    manifest.twin,
    ...(manifest.derived ?? []),
  ];

  for (const artifact of referenced) {
    const entry = requireEntry(byPath, artifact.path);
    const actual = await sha256Bytes(entry.bytes);
    if (actual !== artifact.sha256) {
      throw new TeldraArchiveError(
        `Artifact "${artifact.path}" SHA-256 mismatch: expected ${artifact.sha256}, got ${actual}.`,
      );
    }
  }

  const twinEntry = requireEntry(byPath, manifest.twin.path);
  const twin = parseTwinProject(parseJson(twinEntry, "twin document"));

  return {
    entries,
    manifest,
    twin,
  };
}

export async function replaceTeldraTwin(
  archive: OpenTeldraArchive,
  twin: TwinProject,
): Promise<{
  readonly bytes: Uint8Array;
  readonly archive: OpenTeldraArchive;
}> {
  const validatedTwin = parseTwinProject(structuredClone(twin));
  const twinBytes = new TextEncoder().encode(
    `${JSON.stringify(validatedTwin, null, 2)}\n`,
  );
  const twinSha256 = await sha256Bytes(twinBytes);

  const manifest: TeldraProjectManifest = {
    ...archive.manifest,
    twin: {
      ...archive.manifest.twin,
      sha256: twinSha256,
    },
  };
  const projectBytes = new TextEncoder().encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const replacements = new Map<string, Uint8Array>([
    ["project.json", projectBytes],
    [manifest.twin.path, twinBytes],
  ]);
  const entries = archive.entries.map((entry) => ({
    path: entry.path,
    bytes: replacements.get(entry.path) ?? entry.bytes,
  }));

  const bytes = encodeStoredZip(entries);
  const reopened = await openTeldraArchive(bytes);
  return { bytes, archive: reopened };
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function validateManifestPaths(manifest: TeldraProjectManifest): void {
  const artifacts = [
    manifest.building,
    manifest.twin,
    ...(manifest.derived ?? []),
  ];
  const paths = new Set<string>(["project.json"]);

  for (const artifact of artifacts) {
    validateEntryPath(artifact.path);
    if (paths.has(artifact.path)) {
      throw new TeldraArchiveError(
        `Project manifest references duplicate path "${artifact.path}".`,
      );
    }
    paths.add(artifact.path);
  }
}

function parseJson(entry: TeldraArchiveEntry, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes));
  } catch (error) {
    throw new TeldraArchiveError(
      `Invalid UTF-8 JSON in ${label} "${entry.path}".`,
      { cause: error },
    );
  }
}

function requireEntry(
  entries: ReadonlyMap<string, TeldraArchiveEntry>,
  path: string,
): TeldraArchiveEntry {
  const entry = entries.get(path);
  if (entry === undefined) {
    throw new TeldraArchiveError(`Required project entry "${path}" is missing.`);
  }
  return entry;
}

function validateEntryCollection(entries: readonly TeldraArchiveEntry[]): void {
  if (entries.length > MAX_ENTRIES) {
    throw new TeldraArchiveError(
      `ZIP contains ${entries.length} entries; maximum is ${MAX_ENTRIES}.`,
    );
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  for (const entry of entries) {
    validateEntryPath(entry.path);
    if (paths.has(entry.path)) {
      throw new TeldraArchiveError(`Duplicate ZIP entry path "${entry.path}".`);
    }
    paths.add(entry.path);

    if (entry.bytes.byteLength > MAX_SINGLE_ENTRY_BYTES) {
      throw new TeldraArchiveError(
        `ZIP entry "${entry.path}" exceeds ${MAX_SINGLE_ENTRY_BYTES} bytes.`,
      );
    }
    totalBytes += entry.bytes.byteLength;
    if (totalBytes > MAX_TOTAL_ENTRY_BYTES) {
      throw new TeldraArchiveError(
        `ZIP uncompressed content exceeds ${MAX_TOTAL_ENTRY_BYTES} bytes.`,
      );
    }
  }
}

function validateEntryPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new TeldraArchiveError(`Unsafe ZIP entry path "${path}".`);
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TeldraArchiveError(`Unsafe ZIP entry path "${path}".`);
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new TeldraArchiveError("ZIP end-of-central-directory record was not found.");
}

function assertRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): void {
  if (
    offset < 0 ||
    length < 0 ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset + length > bytes.byteLength
  ) {
    throw new TeldraArchiveError(`ZIP ${label} is out of bounds.`);
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
