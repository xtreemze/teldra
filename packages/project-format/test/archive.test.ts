import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TwinProject } from "@teldra/domain";
import {
  decodeStoredZip,
  encodeStoredZip,
  openTeldraArchive,
  replaceTeldraTwin,
  sha256Bytes,
  TeldraArchiveError,
  type TeldraArchiveEntry,
} from "../src/archive.js";

const fixtureRoot = resolve("../../fixtures/projects/golden-home");
const fixtureFiles = [
  "project.json",
  "building.ifc",
  "twin.json",
  "scene.manifest.json",
  "appearance.manifest.json",
  "lighting.manifest.json",
] as const;

async function goldenEntries(): Promise<TeldraArchiveEntry[]> {
  return Promise.all(
    fixtureFiles.map(async (path) => ({
      path,
      bytes: new Uint8Array(await readFile(resolve(fixtureRoot, path))),
    })),
  );
}

describe(".teldra stored ZIP codec", () => {
  it("encodes deterministic stored ZIP archives independent of input order", async () => {
    const entries = await goldenEntries();
    const forward = encodeStoredZip(entries);
    const reverse = encodeStoredZip([...entries].reverse());

    expect(forward).toEqual(reverse);
    expect(decodeStoredZip(forward).map((entry) => entry.path)).toEqual(
      [...fixtureFiles].sort((left, right) => left.localeCompare(right)),
    );
  });

  it("opens Golden Home by validating manifest paths, hashes, and twin schema", async () => {
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

    for (const path of fixtureFiles) {
      if (path === "project.json" || path === "twin.json") continue;
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
});
