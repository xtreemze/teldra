import type { TwinProject } from "@teldra/domain";
import {
  parseProjectManifest,
  parseTwinProject,
  type TeldraProjectManifest,
} from "./index.js";

const PROJECT_MANIFEST_PATH = "project.json";
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;

const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SINGLE_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface TeldraArchive {
  readonly manifest: TeldraProjectManifest;
  readonly twin: TwinProject;
  readonly entries: ReadonlyMap<string, Uint8Array>;
}

export class TeldraArchiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TeldraArchiveError";
  }
}

interface CentralEntry {
  readonly path: string;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly externalAttributes: number;
  readonly madeByPlatform: number;
}

export async function decodeTeldraArchive(
  bytes: Uint8Array,
): Promise<TeldraArchive> {
  const entries = await readZipEntries(bytes);
  const manifestBytes = entries.get(PROJECT_MANIFEST_PATH);

  if (manifestBytes === undefined) {
    throw new TeldraArchiveError(
      `Teldra archive is missing "${PROJECT_MANIFEST_PATH}".`,
    );
  }

  const manifest = parseProjectManifest(
    parseJsonEntry(PROJECT_MANIFEST_PATH, manifestBytes),
  );

  await validateManifestArtifacts(entries, manifest);

  const twinBytes = entries.get(manifest.twin.path);
  if (twinBytes === undefined) {
    throw new TeldraArchiveError(
      `Teldra archive is missing twin artifact "${manifest.twin.path}".`,
    );
  }

  const twin = parseTwinProject(
    parseJsonEntry(manifest.twin.path, twinBytes),
  );

  return {
    manifest,
    twin,
    entries,
  };
}

export async function replaceTeldraTwin(
  archive: TeldraArchive,
  twin: TwinProject,
): Promise<TeldraArchive> {
  const parsedTwin = parseTwinProject(twin);
  const twinBytes = encodeJson(parsedTwin);
  const twinSha256 = await sha256Hex(twinBytes);

  const manifest: TeldraProjectManifest = {
    ...archive.manifest,
    twin: {
      ...archive.manifest.twin,
      sha256: twinSha256,
    },
  };

  const entries = cloneEntries(archive.entries);
  entries.set(archive.manifest.twin.path, twinBytes);
  entries.set(PROJECT_MANIFEST_PATH, encodeJson(manifest));

  return {
    manifest,
    twin: parsedTwin,
    entries,
  };
}

export function encodeTeldraArchive(archive: TeldraArchive): Uint8Array {
  return writeStoredZip(archive.entries);
}

export async function validateTeldraArchive(
  archive: TeldraArchive,
): Promise<void> {
  const decoded = await decodeTeldraArchive(encodeTeldraArchive(archive));

  if (decoded.manifest.twin.sha256 !== archive.manifest.twin.sha256) {
    throw new TeldraArchiveError(
      "Teldra archive twin hash changed during validation.",
    );
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.subtle === undefined) {
    throw new TeldraArchiveError(
      "SHA-256 is unavailable in this runtime.",
    );
  }

  const input = new Uint8Array(bytes).buffer;
  const digest = await cryptoApi.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function validateManifestArtifacts(
  entries: ReadonlyMap<string, Uint8Array>,
  manifest: TeldraProjectManifest,
): Promise<void> {
  const artifacts = [
    manifest.building,
    manifest.twin,
    ...(manifest.derived ?? []),
  ];

  const seenPaths = new Set<string>();

  for (const artifact of artifacts) {
    validateArchivePath(artifact.path);

    if (seenPaths.has(artifact.path)) {
      throw new TeldraArchiveError(
        `Project manifest references artifact "${artifact.path}" more than once.`,
      );
    }
    seenPaths.add(artifact.path);

    const bytes = entries.get(artifact.path);
    if (bytes === undefined) {
      throw new TeldraArchiveError(
        `Project manifest references missing artifact "${artifact.path}".`,
      );
    }

    const actual = await sha256Hex(bytes);
    if (actual !== artifact.sha256) {
      throw new TeldraArchiveError(
        `Artifact hash mismatch for "${artifact.path}": expected ${artifact.sha256}, got ${actual}.`,
      );
    }
  }
}

async function readZipEntries(
  bytes: Uint8Array,
): Promise<Map<string, Uint8Array>> {
  const view = dataView(bytes);
  const endOffset = findEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDiskNumber = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralDirectorySize = view.getUint32(endOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);

  if (
    diskNumber !== 0 ||
    centralDiskNumber !== 0 ||
    entriesOnDisk !== entryCount
  ) {
    throw new TeldraArchiveError(
      "Multi-disk ZIP archives are not supported for .teldra projects.",
    );
  }

  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new TeldraArchiveError(
      `Archive contains ${entryCount} entries; maximum is ${MAX_ARCHIVE_ENTRIES}.`,
    );
  }

  assertRange(
    bytes,
    centralDirectoryOffset,
    centralDirectorySize,
    "central directory",
  );

  const centralEntries: CentralEntry[] = [];
  let cursor = centralDirectoryOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index += 1) {
    assertRange(bytes, cursor, 46, "central directory entry");

    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new TeldraArchiveError(
        `Invalid central directory header at entry ${index}.`,
      );
    }

    const madeBy = view.getUint16(cursor + 4, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const headerLength = 46 + nameLength + extraLength + commentLength;

    assertRange(bytes, cursor, headerLength, "central directory entry");

    const path = decodeFileName(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      flags,
    );
    validateArchivePath(path);
    validateZipEntryPolicy({
      path,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      madeByPlatform: madeBy >>> 8,
    });

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new TeldraArchiveError(
        "Archive exceeds the maximum total uncompressed size.",
      );
    }

    centralEntries.push({
      path,
      flags,
      method,
      crc32: expectedCrc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttributes,
      madeByPlatform: madeBy >>> 8,
    });

    cursor += headerLength;
  }

  if (cursor > centralDirectoryOffset + centralDirectorySize) {
    throw new TeldraArchiveError(
      "Central directory exceeds its declared size.",
    );
  }

  const result = new Map<string, Uint8Array>();

  for (const entry of centralEntries) {
    if (result.has(entry.path)) {
      throw new TeldraArchiveError(
        `Archive contains duplicate entry "${entry.path}".`,
      );
    }

    const data = await readCentralEntryData(bytes, view, entry);

    if (data.byteLength !== entry.uncompressedSize) {
      throw new TeldraArchiveError(
        `Entry "${entry.path}" has unexpected uncompressed size.`,
      );
    }

    const actualCrc32 = crc32(data);
    if (actualCrc32 !== entry.crc32) {
      throw new TeldraArchiveError(
        `CRC-32 mismatch for archive entry "${entry.path}".`,
      );
    }

    result.set(entry.path, data);
  }

  return result;
}

async function readCentralEntryData(
  bytes: Uint8Array,
  view: DataView,
  entry: CentralEntry,
): Promise<Uint8Array> {
  const offset = entry.localHeaderOffset;
  assertRange(bytes, offset, 30, `local header for "${entry.path}"`);

  if (view.getUint32(offset, true) !== ZIP_LOCAL_FILE_HEADER) {
    throw new TeldraArchiveError(
      `Invalid local ZIP header for "${entry.path}".`,
    );
  }

  const localFlags = view.getUint16(offset + 6, true);
  const localMethod = view.getUint16(offset + 8, true);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);

  if (localFlags !== entry.flags || localMethod !== entry.method) {
    throw new TeldraArchiveError(
      `ZIP header disagreement for "${entry.path}".`,
    );
  }

  const nameStart = offset + 30;
  const localPath = decodeFileName(
    bytes.subarray(nameStart, nameStart + nameLength),
    localFlags,
  );

  if (localPath !== entry.path) {
    throw new TeldraArchiveError(
      `ZIP local/central path mismatch for "${entry.path}".`,
    );
  }

  const dataOffset = nameStart + nameLength + extraLength;
  assertRange(
    bytes,
    dataOffset,
    entry.compressedSize,
    `data for "${entry.path}"`,
  );

  const compressed = bytes.subarray(
    dataOffset,
    dataOffset + entry.compressedSize,
  );

  if (entry.method === ZIP_METHOD_STORE) {
    return compressed.slice();
  }

  if (entry.method === ZIP_METHOD_DEFLATE) {
    return inflateRaw(compressed, entry.path);
  }

  throw new TeldraArchiveError(
    `Unsupported ZIP compression method ${entry.method} for "${entry.path}".`,
  );
}

async function inflateRaw(
  compressed: Uint8Array,
  path: string,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new TeldraArchiveError(
      `Archive entry "${path}" uses DEFLATE, but this runtime has no DecompressionStream support.`,
    );
  }

  try {
    const stream = new Blob([new Uint8Array(compressed)])
      .stream()
      .pipeThrough(
        new DecompressionStream("deflate-raw" as CompressionFormat),
      );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (error) {
    throw new TeldraArchiveError(
      `Could not inflate archive entry "${path}".`,
      { cause: error },
    );
  }
}

function writeStoredZip(
  sourceEntries: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const entries = [...sourceEntries.entries()]
    .map(([path, data]) => {
      validateArchivePath(path);
      if (data.byteLength > MAX_SINGLE_ENTRY_BYTES) {
        throw new TeldraArchiveError(
          `Entry "${path}" exceeds the maximum single-entry size.`,
        );
      }

      return {
        path,
        name: textEncoder.encode(path),
        data: new Uint8Array(data),
        crc32: crc32(data),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new TeldraArchiveError(
      `Archive contains more than ${MAX_ARCHIVE_ENTRIES} entries.`,
    );
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    totalUncompressed += entry.data.byteLength;
  }
  if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw new TeldraArchiveError(
      "Archive exceeds the maximum total uncompressed size.",
    );
  }

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const localHeader = new Uint8Array(30 + entry.name.byteLength);
    const localView = dataView(localHeader);

    localView.setUint32(0, ZIP_LOCAL_FILE_HEADER, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, ZIP_UTF8_FLAG, true);
    localView.setUint16(8, ZIP_METHOD_STORE, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, entry.crc32, true);
    localView.setUint32(18, entry.data.byteLength, true);
    localView.setUint32(22, entry.data.byteLength, true);
    localView.setUint16(26, entry.name.byteLength, true);
    localView.setUint16(28, 0, true);
    localHeader.set(entry.name, 30);

    const centralHeader = new Uint8Array(46 + entry.name.byteLength);
    const centralView = dataView(centralHeader);

    centralView.setUint32(0, ZIP_CENTRAL_DIRECTORY_HEADER, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, ZIP_UTF8_FLAG, true);
    centralView.setUint16(10, ZIP_METHOD_STORE, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, entry.crc32, true);
    centralView.setUint32(20, entry.data.byteLength, true);
    centralView.setUint32(24, entry.data.byteLength, true);
    centralView.setUint16(28, entry.name.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(entry.name, 46);

    localParts.push(localHeader, entry.data);
    centralParts.push(centralHeader);
    localOffset += localHeader.byteLength + entry.data.byteLength;
  }

  const centralDirectory = concatBytes(centralParts);
  const end = new Uint8Array(22);
  const endView = dataView(end);

  endView.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.byteLength, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  return concatBytes([
    ...localParts,
    centralDirectory,
    end,
  ]);
}

function validateZipEntryPolicy(entry: {
  readonly path: string;
  readonly flags: number;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly externalAttributes: number;
  readonly madeByPlatform: number;
}): void {
  if ((entry.flags & ZIP_ENCRYPTED_FLAG) !== 0) {
    throw new TeldraArchiveError(
      `Encrypted ZIP entry "${entry.path}" is not supported.`,
    );
  }

  if ((entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0) {
    throw new TeldraArchiveError(
      `ZIP data descriptors are not supported for "${entry.path}".`,
    );
  }

  if (
    entry.method !== ZIP_METHOD_STORE &&
    entry.method !== ZIP_METHOD_DEFLATE
  ) {
    throw new TeldraArchiveError(
      `Unsupported ZIP compression method ${entry.method} for "${entry.path}".`,
    );
  }

  if (entry.uncompressedSize > MAX_SINGLE_ENTRY_BYTES) {
    throw new TeldraArchiveError(
      `Entry "${entry.path}" exceeds the maximum single-entry size.`,
    );
  }

  if (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
  ) {
    throw new TeldraArchiveError(
      `Entry "${entry.path}" exceeds the maximum compression ratio.`,
    );
  }

  if (entry.madeByPlatform === 3) {
    const unixMode = entry.externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new TeldraArchiveError(
        `Symbolic-link ZIP entry "${entry.path}" is not allowed.`,
      );
    }
  }
}

function validateArchivePath(path: string): void {
  if (path.length === 0 || path.includes("\0")) {
    throw new TeldraArchiveError("Archive entry path must not be empty.");
  }

  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    throw new TeldraArchiveError(
      `Absolute archive path "${path}" is not allowed.`,
    );
  }

  if (path.includes("\\")) {
    throw new TeldraArchiveError(
      `Archive path "${path}" must use forward slashes.`,
    );
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new TeldraArchiveError(
      `Parent traversal in archive path "${path}" is not allowed.`,
    );
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumSize = 22;
  if (view.byteLength < minimumSize) {
    throw new TeldraArchiveError("Input is too small to be a ZIP archive.");
  }

  const earliest = Math.max(0, view.byteLength - minimumSize - 65_535);

  for (
    let offset = view.byteLength - minimumSize;
    offset >= earliest;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + minimumSize + commentLength === view.byteLength) {
        return offset;
      }
    }
  }

  throw new TeldraArchiveError(
    "ZIP end-of-central-directory record was not found.",
  );
}

function decodeFileName(bytes: Uint8Array, flags: number): string {
  if ((flags & ZIP_UTF8_FLAG) === 0 && bytes.some((value) => value >= 0x80)) {
    throw new TeldraArchiveError(
      "Non-UTF-8 ZIP filenames are not supported.",
    );
  }

  try {
    return textDecoder.decode(bytes);
  } catch (error) {
    throw new TeldraArchiveError(
      "Archive contains an invalid UTF-8 filename.",
      { cause: error },
    );
  }
}

function parseJsonEntry(path: string, bytes: Uint8Array): unknown {
  try {
    return JSON.parse(textDecoder.decode(bytes)) as unknown;
  } catch (error) {
    throw new TeldraArchiveError(
      `Archive entry "${path}" is not valid UTF-8 JSON.`,
      { cause: error },
    );
  }
}

function encodeJson(value: unknown): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function cloneEntries(
  entries: ReadonlyMap<string, Uint8Array>,
): Map<string, Uint8Array> {
  return new Map(
    [...entries.entries()].map(([path, bytes]) => [
      path,
      new Uint8Array(bytes),
    ]),
  );
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce(
    (total, part) => total + part.byteLength,
    0,
  );
  const result = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }

  return result;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
}

function assertRange(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  ) {
    throw new TeldraArchiveError(
      `Invalid ZIP range for ${label}.`,
    );
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc =
        (crc >>> 1) ^
        (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}
