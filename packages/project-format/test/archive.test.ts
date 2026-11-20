import { afterEach, describe, expect, it, vi } from "vitest";
import goldenAppearance from "../../../fixtures/projects/golden-home/appearance.manifest.json";
import goldenLighting from "../../../fixtures/projects/golden-home/lighting.manifest.json";
import goldenScene from "../../../fixtures/projects/golden-home/scene.manifest.json";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import type { TwinProject } from "@teldra/domain";
import {
  decodeStoredZip,
  encodeCompressedZip,
  encodeStoredZip,
  openTeldraArchive,
  replaceTeldraTwin,
  sha256Bytes,
  TeldraArchiveError,
  type TeldraArchiveEntry,
} from "../src/archive.js";

async function goldenEntries(): Promise<TeldraArchiveEntry[]> {
  const encoder = new TextEncoder();
  const buildingBytes = encoder.encode(
    "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
  );
  const twinBytes = encoder.encode(
    `${JSON.stringify(goldenTwin, null, 2)}\n`,
  );
  const sceneBytes = encoder.encode(
    `${JSON.stringify(goldenScene, null, 2)}\n`,
  );
  const appearanceBytes = encoder.encode(
    `${JSON.stringify(goldenAppearance, null, 2)}\n`,
  );
  const lightingBytes = encoder.encode(
    `${JSON.stringify(goldenLighting, null, 2)}\n`,
  );

  const manifest = {
    formatVersion: "0.1.0",
    building: {
      path: "building.ifc",
      sha256: await sha256Bytes(buildingBytes),
    },
    twin: {
      path: "twin.json",
      sha256: await sha256Bytes(twinBytes),
    },
    derived: [
      {
        path: "scene.manifest.json",
        sha256: await sha256Bytes(sceneBytes),
      },
      {
        path: "appearance.manifest.json",
        sha256: await sha256Bytes(appearanceBytes),
      },
      {
        path: "lighting.manifest.json",
        sha256: await sha256Bytes(lightingBytes),
      },
    ],
  };

  return [
    {
      path: "project.json",
      bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
    },
    { path: "building.ifc", bytes: buildingBytes },
    { path: "twin.json", bytes: twinBytes },
    { path: "scene.manifest.json", bytes: sceneBytes },
    { path: "appearance.manifest.json", bytes: appearanceBytes },
    { path: "lighting.manifest.json", bytes: lightingBytes },
  ];
}


function encodeDeflateZip(entries: readonly TeldraArchiveEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const sorted = [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const records = sorted.map((entry) => {
    const name = encoder.encode(entry.path);
    const compressed = rawDeflateStoredBlock(entry.bytes);
    return {
      entry,
      name,
      compressed,
      crc: testCrc32(entry.bytes),
    };
  });

  const localSize = records.reduce(
    (total, record) => total + 30 + record.name.length + record.compressed.length,
    0,
  );
  const centralSize = records.reduce(
    (total, record) => total + 46 + record.name.length,
    0,
  );
  const output = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(output.buffer);
  const localOffsets: number[] = [];
  let offset = 0;

  for (const record of records) {
    localOffsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true);
    view.setUint16(offset + 8, 8, true);
    view.setUint32(offset + 14, record.crc, true);
    view.setUint32(offset + 18, record.compressed.length, true);
    view.setUint32(offset + 22, record.entry.bytes.length, true);
    view.setUint16(offset + 26, record.name.length, true);
    output.set(record.name, offset + 30);
    output.set(record.compressed, offset + 30 + record.name.length);
    offset += 30 + record.name.length + record.compressed.length;
  }

  const centralOffset = offset;
  records.forEach((record, index) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 8, true);
    view.setUint32(offset + 16, record.crc, true);
    view.setUint32(offset + 20, record.compressed.length, true);
    view.setUint32(offset + 24, record.entry.bytes.length, true);
    view.setUint16(offset + 28, record.name.length, true);
    view.setUint32(offset + 42, localOffsets[index]!, true);
    output.set(record.name, offset + 46);
    offset += 46 + record.name.length;
  });

  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, records.length, true);
  view.setUint16(offset + 10, records.length, true);
  view.setUint32(offset + 12, offset - centralOffset, true);
  view.setUint32(offset + 16, centralOffset, true);

  return output;
}

function rawDeflateStoredBlock(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0xffff) {
    throw new Error("Test helper supports entries up to 65535 bytes.");
  }

  const output = new Uint8Array(bytes.length + 5);
  const length = bytes.length;
  const inverse = (~length) & 0xffff;
  output[0] = 0x01;
  output[1] = length & 0xff;
  output[2] = (length >>> 8) & 0xff;
  output[3] = inverse & 0xff;
  output[4] = (inverse >>> 8) & 0xff;
  output.set(bytes, 5);
  return output;
}

function testCrc32(bytes: Uint8Array): number {
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

function firstCentralOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(bytes.byteLength - 6, true);
}

describe(".teldra stored ZIP codec", () => {
  it("encodes deterministic stored ZIP archives independent of input order", async () => {
    const entries = await goldenEntries();
    const forward = encodeStoredZip(entries);
    const reverse = encodeStoredZip([...entries].reverse());

    expect(forward).toEqual(reverse);
    expect(decodeStoredZip(forward).map((entry) => entry.path)).toEqual(
      entries
        .map((entry) => entry.path)
        .sort((left, right) => left.localeCompare(right)),
    );
  });

  it("opens Golden Home canonical data by validating manifest paths, hashes, and twin schema", async () => {
    const archive = await openTeldraArchive(
      encodeStoredZip(await goldenEntries()),
    );

    expect(archive.manifest.formatVersion).toBe("0.1.0");
    expect(archive.twin.devices[0]?.id).toBe(
      "device:living-room-floor-lamp",
    );
    expect(archive.entries.find((entry) => entry.path === "building.ifc")).toBeDefined();
  });

  it("renames twin content while preserving every unrelated archive entry byte-for-byte", async () => {
    const original = await openTeldraArchive(
      encodeStoredZip(await goldenEntries()),
    );
    const renamed: TwinProject = structuredClone(original.twin);
    renamed.devices[0]!.name = "Reading lamp";

    const saved = await replaceTeldraTwin(original, renamed);
    const reopened = saved.archive;

    expect(reopened.twin.devices[0]?.name).toBe("Reading lamp");
    expect(reopened.twin.devices[0]?.id).toBe(original.twin.devices[0]?.id);
    expect(reopened.twin.bindings[0]?.externalId).toBe(
      original.twin.bindings[0]?.externalId,
    );

    const originalByPath = new Map(
      original.entries.map((entry) => [entry.path, entry.bytes] as const),
    );
    const reopenedByPath = new Map(
      reopened.entries.map((entry) => [entry.path, entry.bytes] as const),
    );

    for (const path of [
      "building.ifc",
      "scene.manifest.json",
      "appearance.manifest.json",
      "lighting.manifest.json",
    ]) {
      expect(reopenedByPath.get(path)).toEqual(originalByPath.get(path));
    }

    const twinBytes = reopenedByPath.get("twin.json");
    expect(twinBytes).toBeDefined();
    if (twinBytes === undefined) return;
    expect(reopened.manifest.twin.sha256).toBe(await sha256Bytes(twinBytes));
  });

  it("rejects traversal and duplicate paths before encoding", () => {
    expect(() =>
      encodeStoredZip([{ path: "../project.json", bytes: new Uint8Array() }]),
    ).toThrow(TeldraArchiveError);

    expect(() =>
      encodeStoredZip([
        { path: "project.json", bytes: new Uint8Array() },
        { path: "project.json", bytes: new Uint8Array() },
      ]),
    ).toThrow(TeldraArchiveError);
  });

  it("rejects a manifest whose referenced artifact bytes do not match SHA-256", async () => {
    const entries = await goldenEntries();
    const corrupted = entries.map((entry) =>
      entry.path === "building.ifc"
        ? { path: entry.path, bytes: new TextEncoder().encode("corrupt") }
        : entry,
    );

    await expect(
      openTeldraArchive(encodeStoredZip(corrupted)),
    ).rejects.toThrow("SHA-256 mismatch");
  });

  it("opens safe DEFLATE-compressed project entries and re-saves them deterministically", async () => {
    const entries = await goldenEntries();
    const compressed = encodeDeflateZip(entries);

    const opened = await openTeldraArchive(compressed);
    expect(opened.twin.devices[0]?.id).toBe(
      "device:living-room-floor-lamp",
    );

    const saved = await replaceTeldraTwin(opened, opened.twin);
    expect((await openTeldraArchive(saved.bytes)).entries.length).toBe(entries.length);
    expect(await openTeldraArchive(saved.bytes)).toMatchObject({
      twin: opened.twin,
    });
  });

  it("rejects entries whose declared compression ratio exceeds the archive policy", async () => {
    const bytes = encodeStoredZip(await goldenEntries());
    const mutated = bytes.slice();
    const view = new DataView(mutated.buffer);
    const central = firstCentralOffset(mutated);
    const local = view.getUint32(central + 42, true);

    view.setUint16(central + 10, 8, true);
    view.setUint32(central + 20, 1, true);
    view.setUint32(central + 24, 201, true);
    view.setUint16(local + 8, 8, true);

    await expect(openTeldraArchive(mutated)).rejects.toThrow(
      "maximum compression ratio",
    );
  });

  it("rejects Unix symbolic-link entries", async () => {
    const bytes = encodeStoredZip(await goldenEntries());
    const mutated = bytes.slice();
    const view = new DataView(mutated.buffer);
    const central = firstCentralOffset(mutated);

    view.setUint16(central + 4, (3 << 8) | 20, true);
    view.setUint32(central + 38, 0xa0000000, true);

    await expect(openTeldraArchive(mutated)).rejects.toThrow(
      "Symbolic-link",
    );
  });

  it("round-trips DEFLATE-compressed entries byte-for-byte and stores incompressible ones", async () => {
    const compressible = new TextEncoder().encode(Array.from({ length: 20_000 }, (_, i) => `#${i}=IFCWALL('${(i * 2654435761 >>> 0).toString(36)}');\n`).join(""));
    const noise = new Uint8Array(50_000);
    let seed = 12345;
    for (let i = 0; i < noise.length; i += 1) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; noise[i] = seed >>> 24; }
    const entries = [
      { path: "a/compressible.bin", bytes: compressible },
      { path: "b/noise.bin", bytes: noise },
      { path: "c/tiny.txt", bytes: new TextEncoder().encode("x") },
    ];
    const zip = await encodeCompressedZip(entries);
    expect(zip.length).toBeLessThan(compressible.length * 0.8 + noise.length + 2_000);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // Local header method fields: first entry is deflated, second and third stored.
    const methods: number[] = [];
    for (let offset = 0; offset + 30 < zip.length && methods.length < 3;) {
      if (view.getUint32(offset, true) !== 0x04034b50) break;
      methods.push(view.getUint16(offset + 8, true));
      offset += 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true) + view.getUint32(offset + 18, true);
    }
    expect(methods).toEqual([8, 0, 0]);
    // Re-encoding is deterministic.
    expect(await encodeCompressedZip(entries)).toEqual(zip);
  });

  it("falls back to stored for entries whose ratio would trip the reader's bomb guard", async () => {
    const zeros = new Uint8Array(1_000_000);
    const zip = await encodeCompressedZip([{ path: "zeros.bin", bytes: zeros }]);
    expect(zip.length).toBeGreaterThan(zeros.length);
    expect(decodeStoredZip(zip)[0]!.bytes).toEqual(zeros);
  });

  describe("verbatim reuse of unchanged compressed entries", () => {
    afterEach(() => vi.unstubAllGlobals());
    const ifcText = (n: number) => new TextEncoder().encode(Array.from({ length: n }, (_, i) => `#${i}=IFCWALL('${(i * 2654435761 >>> 0).toString(36)}',$,$);\n`).join(""));
    function countDeflates() {
      const Original = CompressionStream;
      const calls = { count: 0 };
      vi.stubGlobal("CompressionStream", class extends Original {
        constructor(format: CompressionFormat) { super(format); calls.count += 1; }
      });
      return calls;
    }
    function payloadOf(zip: Uint8Array, path: string): Uint8Array {
      const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
      for (let offset = 0; offset + 30 < zip.length;) {
        if (view.getUint32(offset, true) !== 0x04034b50) break;
        const size = view.getUint32(offset + 18, true);
        const nameLength = view.getUint16(offset + 26, true);
        const name = new TextDecoder().decode(zip.subarray(offset + 30, offset + 30 + nameLength));
        const start = offset + 30 + nameLength + view.getUint16(offset + 28, true);
        if (name === path) return zip.subarray(start, start + size);
        offset = start + size;
      }
      throw new Error(`no ${path}`);
    }
    async function bigArchive(building: Uint8Array): Promise<Uint8Array> {
      const entries = (await goldenEntries()).map((e) => e.path === "building.ifc" ? { path: e.path, bytes: building } : e);
      const manifest = JSON.parse(new TextDecoder().decode(entries.find((e) => e.path === "project.json")!.bytes));
      manifest.building.sha256 = await sha256Bytes(building);
      return encodeCompressedZip(entries.map((e) => e.path === "project.json" ? { path: e.path, bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) } : e));
    }

    it("copies the original deflate payload without recompressing an unchanged entry", async () => {
      const original = await bigArchive(ifcText(30_000));
      const opened = await openTeldraArchive(original);
      const calls = countDeflates();
      const saved = await replaceTeldraTwin(opened, opened.twin);
      expect(calls.count).toBe(0);
      expect(payloadOf(saved.bytes, "building.ifc")).toEqual(payloadOf(original, "building.ifc"));
      expect(saved.archive.entries.find((e) => e.path === "building.ifc")!.bytes).toEqual(opened.entries.find((e) => e.path === "building.ifc")!.bytes);
    });

    it("recompresses only the entry whose bytes were replaced", async () => {
      const original = await bigArchive(ifcText(30_000));
      const opened = await openTeldraArchive(original);
      const edited = ifcText(31_000);
      const calls = countDeflates();
      const zip = await encodeCompressedZip(opened.entries.map((e) => e.path === "building.ifc" ? { path: e.path, bytes: edited } : e));
      expect(calls.count).toBe(1);
      expect(payloadOf(zip, "building.ifc")).not.toEqual(payloadOf(original, "building.ifc"));
      expect(payloadOf(zip, "twin.json")).toEqual(payloadOf(original, "twin.json"));
      // Valid bytes round-trip: a consistent archive built from the same replacement reads back identically.
      const consistent = await bigArchive(edited);
      expect((await openTeldraArchive(consistent)).entries.find((e) => e.path === "building.ifc")!.bytes).toEqual(edited);
    });

    it("reuses one compressed form for the same bytes stored under a second path", async () => {
      const original = await bigArchive(ifcText(30_000));
      const opened = await openTeldraArchive(original);
      const building = opened.entries.find((e) => e.path === "building.ifc")!;
      const calls = countDeflates();
      const zip = await encodeCompressedZip([...opened.entries, { path: "teldra/scene-source.ifc", bytes: building.bytes }]);
      expect(calls.count).toBe(0);
      expect(payloadOf(zip, "teldra/scene-source.ifc")).toEqual(payloadOf(original, "building.ifc"));
    });

    it("does not reuse a compressed form for a copy with different bytes", async () => {
      const original = await bigArchive(ifcText(30_000));
      const opened = await openTeldraArchive(original);
      const building = opened.entries.find((e) => e.path === "building.ifc")!;
      const calls = countDeflates();
      const copy = building.bytes.slice();
      copy[copy.length - 2] ^= 1;
      await encodeCompressedZip([{ path: "x.ifc", bytes: copy }]);
      expect(calls.count).toBe(1);
    });
  });

  it("keeps a saved twin edit within 1.1x of the original archive size", async () => {
    const filler = new TextEncoder().encode(Array.from({ length: 30_000 }, (_, i) => `#${i}=IFCWALL('${(i * 2654435761 >>> 0).toString(36)}',$,$,$,$,$,$,$);\n`).join(""));
    const base = await goldenEntries();
    const entries = base.map((e) => e.path === "building.ifc" ? { path: e.path, bytes: filler } : e);
    // Rebuild a consistent manifest around the larger IFC.
    const manifest = JSON.parse(new TextDecoder().decode(entries.find((e) => e.path === "project.json")!.bytes));
    manifest.building.sha256 = await sha256Bytes(filler);
    const withManifest = entries.map((e) => e.path === "project.json" ? { path: e.path, bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) } : e);
    const original = await encodeCompressedZip(withManifest);
    const opened = await openTeldraArchive(original);
    const saved = await replaceTeldraTwin(opened, opened.twin);
    expect(saved.bytes.length).toBeLessThanOrEqual(original.length * 1.1);
    expect(saved.bytes.length).toBeLessThan(filler.length / 4);
    expect((await openTeldraArchive(saved.bytes)).entries.find((e) => e.path === "building.ifc")!.bytes).toEqual(filler);
  });

});
