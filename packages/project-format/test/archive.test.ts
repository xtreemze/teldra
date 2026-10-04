import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  decodeTeldraArchive,
  encodeTeldraArchive,
  replaceTeldraTwin,
  sha256Hex,
  TeldraArchiveError,
  type TeldraArchive,
} from "../src/archive.js";

const fixtureRoot = new URL(
  "../../../fixtures/projects/golden-home/",
  import.meta.url,
);

async function readFixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(path, fixtureRoot)));
}

async function goldenArchive(): Promise<TeldraArchive> {
  const paths = [
    "project.json",
    "building.ifc",
    "twin.json",
    "scene.manifest.json",
    "appearance.manifest.json",
    "lighting.manifest.json",
  ] as const;

  const entries = new Map<string, Uint8Array>();
  for (const path of paths) {
    entries.set(path, await readFixture(path));
  }

  const manifest = JSON.parse(
    new TextDecoder().decode(entries.get("project.json")),
  );
  const twin = JSON.parse(
    new TextDecoder().decode(entries.get("twin.json")),
  );

  return {
    manifest,
    twin,
    entries,
  };
}

describe(".teldra archive codec", () => {
  it("round-trips the Golden Home through a deterministic stored ZIP", async () => {
    const source = await goldenArchive();
    const encoded = encodeTeldraArchive(source);
    const decoded = await decodeTeldraArchive(encoded);

    expect(decoded.manifest).toEqual(source.manifest);
    expect(decoded.twin).toEqual(source.twin);

    for (const [path, bytes] of source.entries) {
      expect(decoded.entries.get(path)).toEqual(bytes);
    }

    expect(encodeTeldraArchive(decoded)).toEqual(encoded);
  });

  it("replaces only twin.json and project.json while preserving every other entry", async () => {
    const source = await goldenArchive();
    const originalBuilding = source.entries.get("building.ifc");
    const originalScene = source.entries.get("scene.manifest.json");
    const originalAppearance = source.entries.get("appearance.manifest.json");
    const originalLighting = source.entries.get("lighting.manifest.json");

    const nextTwin = structuredClone(source.twin);
    nextTwin.devices[0]!.name = "Reading lamp";

    const updated = await replaceTeldraTwin(source, nextTwin);

    expect(updated.entries.get("building.ifc")).toEqual(originalBuilding);
    expect(updated.entries.get("scene.manifest.json")).toEqual(originalScene);
    expect(updated.entries.get("appearance.manifest.json")).toEqual(
      originalAppearance,
    );
    expect(updated.entries.get("lighting.manifest.json")).toEqual(
      originalLighting,
    );

    expect(updated.entries.get("twin.json")).not.toEqual(
      source.entries.get("twin.json"),
    );
    expect(updated.entries.get("project.json")).not.toEqual(
      source.entries.get("project.json"),
    );

    const twinBytes = updated.entries.get("twin.json");
    expect(twinBytes).toBeDefined();
    if (twinBytes === undefined) return;

    expect(updated.manifest.twin.sha256).toBe(
      await sha256Hex(twinBytes),
    );

    const reopened = await decodeTeldraArchive(
      encodeTeldraArchive(updated),
    );
    expect(reopened.twin.devices[0]?.name).toBe("Reading lamp");
    expect(reopened.twin.devices[0]?.id).toBe(
      source.twin.devices[0]?.id,
    );
  });

  it("rejects an archive when a canonical artifact hash does not match", async () => {
    const source = await goldenArchive();
    const corruptedEntries = new Map(source.entries);
    corruptedEntries.set(
      "building.ifc",
      new TextEncoder().encode("not the golden IFC"),
    );

    await expect(
      decodeTeldraArchive(
        encodeTeldraArchive({
          ...source,
          entries: corruptedEntries,
        }),
      ),
    ).rejects.toThrow(TeldraArchiveError);
  });

  it("rejects path traversal when writing an archive", async () => {
    const source = await goldenArchive();
    const unsafeEntries = new Map(source.entries);
    unsafeEntries.set("../escape.txt", new Uint8Array([1]));

    expect(() =>
      encodeTeldraArchive({
        ...source,
        entries: unsafeEntries,
      }),
    ).toThrow("Parent traversal");
  });
});
