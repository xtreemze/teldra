import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import type { TwinProject } from "@teldra/domain";
import {
  decodeTeldraArchive,
  encodeTeldraArchive,
  replaceTeldraTwin,
  sha256Hex,
  TeldraArchiveError,
  type TeldraArchive,
} from "../src/archive.js";

async function goldenArchive(): Promise<TeldraArchive> {
  const twin = structuredClone(goldenTwin) as TwinProject;
  const encoder = new TextEncoder();
  const twinBytes = encoder.encode(
    `${JSON.stringify(twin, null, 2)}\n`,
  );
  const building = encoder.encode(
    "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
  );
  const scene = encoder.encode(
    `${JSON.stringify({ fixture: "scene" }, null, 2)}\n`,
  );
  const appearance = encoder.encode(
    `${JSON.stringify({ fixture: "appearance" }, null, 2)}\n`,
  );
  const lighting = encoder.encode(
    `${JSON.stringify({ fixture: "lighting" }, null, 2)}\n`,
  );

  const manifest = {
    formatVersion: "0.1.0" as const,
    building: {
      path: "building.ifc",
      sha256: await sha256Hex(building),
    },
    twin: {
      path: "twin.json",
      sha256: await sha256Hex(twinBytes),
    },
    derived: [
      {
        path: "scene.manifest.json",
        sha256: await sha256Hex(scene),
      },
      {
        path: "appearance.manifest.json",
        sha256: await sha256Hex(appearance),
      },
      {
        path: "lighting.manifest.json",
        sha256: await sha256Hex(lighting),
      },
    ],
  };

  return {
    manifest,
    twin,
    entries: new Map([
      [
        "project.json",
        encoder.encode(
          `${JSON.stringify(manifest, null, 2)}\n`,
        ),
      ],
      ["building.ifc", building],
      ["twin.json", twinBytes],
      ["scene.manifest.json", scene],
      ["appearance.manifest.json", appearance],
      ["lighting.manifest.json", lighting],
    ]),
  };
}

describe(".teldra archive codec", () => {
  it("round-trips a Golden Home twin through a deterministic stored ZIP", async () => {
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
      new TextEncoder().encode("not the expected IFC"),
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
