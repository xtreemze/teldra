import { describe, expect, it } from "vitest";
import goldenAppearance from "../../../fixtures/projects/golden-home/appearance.manifest.json";
import goldenLighting from "../../../fixtures/projects/golden-home/lighting.manifest.json";
import goldenScene from "../../../fixtures/projects/golden-home/scene.manifest.json";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
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
});
