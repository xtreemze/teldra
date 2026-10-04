import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import {
  canonicalTwinFingerprint,
} from "@teldra/application";
import type { TwinProject } from "@teldra/domain";
import {
  encodeStoredZip,
  openTeldraArchive,
  sha256Bytes,
  type StoredProject,
  type TeldraArchiveEntry,
} from "@teldra/project-format";
import {
  BrowserTeldraFileStorage,
  openBrowserTeldraProject,
  supportsBrowserTeldraFileAccess,
  type BrowserAssetUrlFactory,
  type BrowserRecoveryStore,
  type BrowserTeldraFileHandle,
  type BrowserWritableFile,
} from "./BrowserTeldraProject";

class MemoryRecoveryStore implements BrowserRecoveryStore {
  readonly values = new Map<string, StoredProject<TwinProject>>();

  async get(slot: "backup" | "recovery", projectKey: string) {
    const value = this.values.get(`${slot}:${projectKey}`);
    return value === undefined ? null : structuredClone(value);
  }

  async set(
    slot: "backup" | "recovery",
    projectKey: string,
    project: StoredProject<TwinProject>,
  ) {
    this.values.set(
      `${slot}:${projectKey}`,
      structuredClone(project),
    );
  }

  async delete(slot: "backup" | "recovery", projectKey: string) {
    this.values.delete(`${slot}:${projectKey}`);
  }
}

class MemoryFileHandle implements BrowserTeldraFileHandle {
  readonly name = "golden-home.teldra";
  #bytes: Uint8Array;
  failWrite = false;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes.slice();
  }

  async getFile(): Promise<Blob> {
    const buffer = new ArrayBuffer(this.#bytes.byteLength);
    new Uint8Array(buffer).set(this.#bytes);
    return new Blob([buffer]);
  }

  async createWritable(): Promise<BrowserWritableFile> {
    let staged: Uint8Array | null = null;
    return {
      write: async (data) => {
        staged = data.slice();
      },
      close: async () => {
        if (this.failWrite) {
          throw new Error("simulated file replacement failure");
        }
        if (staged === null) throw new Error("Nothing written.");
        this.#bytes = staged;
      },
      abort: async () => {
        staged = null;
      },
    };
  }

  bytes(): Uint8Array {
    return this.#bytes.slice();
  }
}

async function makeGoldenArchive(): Promise<{
  readonly handle: MemoryFileHandle;
  readonly buildingBytes: Uint8Array;
}> {
  const encoder = new TextEncoder();
  const twinBytes = encoder.encode(
    `${JSON.stringify(goldenTwin, null, 2)}\n`,
  );
  const buildingBytes = encoder.encode(
    "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
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
    derived: [],
  };
  const projectBytes = encoder.encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const entries: TeldraArchiveEntry[] = [
    { path: "project.json", bytes: projectBytes },
    { path: "building.ifc", bytes: buildingBytes },
    { path: "twin.json", bytes: twinBytes },
    {
      path: "assets/source/readme.txt",
      bytes: encoder.encode("preserve me"),
    },
  ];

  return {
    handle: new MemoryFileHandle(encodeStoredZip(entries)),
    buildingBytes,
  };
}


class RecordingAssetUrlFactory implements BrowserAssetUrlFactory {
  readonly created: Array<{
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly url: string;
  }> = [];
  readonly revoked: string[] = [];

  create(bytes: Uint8Array, mediaType: string): string {
    const url = `blob:teldra-test:${this.created.length + 1}`;
    this.created.push({
      bytes: bytes.slice(),
      mediaType,
      url,
    });
    return url;
  }

  revoke(url: string): void {
    this.revoked.push(url);
  }
}

async function makeRenderableArchive(
  sceneAssetShaOverride?: string,
): Promise<{
  readonly handle: MemoryFileHandle;
  readonly glbBytes: Uint8Array;
}> {
  const encoder = new TextEncoder();
  const twinBytes = encoder.encode(
    `${JSON.stringify(goldenTwin, null, 2)}\n`,
  );
  const buildingBytes = encoder.encode("IFC renderable fixture");
  const glbBytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]);
  const buildingSha256 = await sha256Bytes(buildingBytes);
  const glbSha256 = sceneAssetShaOverride ?? (await sha256Bytes(glbBytes));

  const sceneManifest = {
    schemaVersion: "0.1.0",
    coordinateSystem: {
      unit: "metre",
      handedness: "right",
      upAxis: "Z",
    },
    source: {
      buildingPath: "building.ifc",
      buildingSha256,
    },
    scene: {
      assetPath: "cache/scene.glb",
      assetSha256: glbSha256,
      format: "glb",
      canonicalToScene: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
    },
    nodes: [],
  };
  const sceneBytes = encoder.encode(
    `${JSON.stringify(sceneManifest, null, 2)}\n`,
  );

  const projectManifest = {
    formatVersion: "0.1.0",
    building: {
      path: "building.ifc",
      sha256: buildingSha256,
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
    ],
  };

  return {
    handle: new MemoryFileHandle(
      encodeStoredZip([
        {
          path: "project.json",
          bytes: encoder.encode(
            `${JSON.stringify(projectManifest, null, 2)}\n`,
          ),
        },
        { path: "building.ifc", bytes: buildingBytes },
        { path: "twin.json", bytes: twinBytes },
        { path: "scene.manifest.json", bytes: sceneBytes },
        { path: "cache/scene.glb", bytes: glbBytes },
      ]),
    ),
    glbBytes,
  };
}

describe("browser .teldra project workflow", () => {
  it("opens, edits, saves, and reopens while preserving IFC bytes and canonical identity", async () => {
    const { handle, buildingBytes } = await makeGoldenArchive();
    const recovery = new MemoryRecoveryStore();
    const first = await openBrowserTeldraProject(
      handle,
      "test:first",
      recovery,
    );
    const deviceId = "device:living-room-floor-lamp";

    expect(first.controller.twin.devices[0]?.id).toBe(deviceId);
    first.controller.renameDevice(deviceId, "Reading lamp");
    expect(first.controller.dirty).toBe(true);
    expect(first.controller.undo()).toBe(true);
    expect(first.controller.redo()).toBe(true);
    await first.controller.save();
    expect(first.controller.dirty).toBe(false);
    await first.close();

    const reopenedArchive = await openTeldraArchive(handle.bytes());
    expect(
      reopenedArchive.entries.find((entry) => entry.path === "building.ifc")?.bytes,
    ).toEqual(buildingBytes);
    expect(
      new TextDecoder().decode(
        reopenedArchive.entries.find(
          (entry) => entry.path === "assets/source/readme.txt",
        )?.bytes,
      ),
    ).toBe("preserve me");

    const second = await openBrowserTeldraProject(
      handle,
      "test:second",
      recovery,
    );
    expect(second.controller.twin.devices[0]?.id).toBe(deviceId);
    expect(second.controller.twin.devices[0]?.name).toBe("Reading lamp");
    expect(
      second.controller.twin.bindings[0]?.externalId,
    ).toBe("light.living_room_floor_lamp");
    await second.close();
  });

  it("persists backup and autosave recovery across adapter recreation without writing recovery into the archive", async () => {
    const { handle } = await makeGoldenArchive();
    const recovery = new MemoryRecoveryStore();
    const first = await BrowserTeldraFileStorage.open(handle, recovery);

    expect(
      await first.acquireWriteLock(first.projectKey, "writer:first"),
    ).toBe(true);

    const primary = await first.readPrimary(first.projectKey);
    const next = structuredClone(primary.canonical);
    next.devices[0]!.name = "Saved name";
    const saved: StoredProject<TwinProject> = {
      revision: 1,
      fingerprint: canonicalTwinFingerprint(next),
      canonical: next,
    };
    const stage = await first.stagePrimary(
      first.projectKey,
      "writer:first",
      saved,
    );
    await first.commitStaged(
      first.projectKey,
      "writer:first",
      stage,
    );

    const recoveryTwin = structuredClone(next);
    recoveryTwin.devices[0]!.name = "Autosaved draft";
    const autosaved: StoredProject<TwinProject> = {
      revision: 2,
      fingerprint: canonicalTwinFingerprint(recoveryTwin),
      canonical: recoveryTwin,
    };
    await first.writeRecovery(
      first.projectKey,
      "writer:first",
      autosaved,
    );
    await first.releaseWriteLock(first.projectKey, "writer:first");

    const second = await BrowserTeldraFileStorage.open(handle, recovery);
    expect(
      (await second.readBackup(second.projectKey))?.canonical.devices[0]?.name,
    ).toBe(goldenTwin.devices[0]?.name);
    expect(
      (await second.readRecovery(second.projectKey))?.canonical.devices[0]?.name,
    ).toBe("Autosaved draft");

    const archive = await openTeldraArchive(handle.bytes());
    expect(archive.entries.map((entry) => entry.path)).not.toContain(
      "recovery.json",
    );
  });

  it("enforces one writer for the same project and releases ownership deterministically", async () => {
    const { handle } = await makeGoldenArchive();
    const recovery = new MemoryRecoveryStore();
    const first = await BrowserTeldraFileStorage.open(handle, recovery);
    const second = await BrowserTeldraFileStorage.open(handle, recovery);

    expect(first.projectKey).toBe(second.projectKey);
    expect(
      await first.acquireWriteLock(first.projectKey, "writer:first"),
    ).toBe(true);
    expect(
      await second.acquireWriteLock(second.projectKey, "writer:second"),
    ).toBe(false);

    await first.releaseWriteLock(first.projectKey, "writer:first");

    expect(
      await second.acquireWriteLock(second.projectKey, "writer:second"),
    ).toBe(true);
    await second.releaseWriteLock(second.projectKey, "writer:second");
  });

  it("does not replace the project file when the host write fails", async () => {
    const { handle } = await makeGoldenArchive();
    const original = handle.bytes();
    const storage = await BrowserTeldraFileStorage.open(
      handle,
      new MemoryRecoveryStore(),
    );

    await storage.acquireWriteLock(storage.projectKey, "writer");
    const primary = await storage.readPrimary(storage.projectKey);
    const next = structuredClone(primary.canonical);
    next.devices[0]!.name = "Will fail";
    const stage = await storage.stagePrimary(
      storage.projectKey,
      "writer",
      {
        revision: 1,
        fingerprint: canonicalTwinFingerprint(next),
        canonical: next,
      },
    );

    handle.failWrite = true;
    await expect(
      storage.commitStaged(storage.projectKey, "writer", stage),
    ).rejects.toThrow("simulated file replacement failure");
    expect(handle.bytes()).toEqual(original);

    await storage.releaseWriteLock(storage.projectKey, "writer");
  });

  it("reports direct file access capability without mutating project state", () => {
    expect(
      supportsBrowserTeldraFileAccess({
        showOpenFilePicker: async () => [],
      }),
    ).toBe(true);
    expect(supportsBrowserTeldraFileAccess({})).toBe(false);
    expect(supportsBrowserTeldraFileAccess(null)).toBe(false);
  });

  it("resolves a validated scene GLB to a browser-lifetime URL and revokes it on close", async () => {
    const { handle, glbBytes } = await makeRenderableArchive();
    const urls = new RecordingAssetUrlFactory();
    const project = await openBrowserTeldraProject(
      handle,
      "scene:owner",
      new MemoryRecoveryStore(),
      urls,
    );

    expect(project.scene?.manifest.scene.assetPath).toBe("cache/scene.glb");
    expect(project.scene?.glbUrl).toBe("blob:teldra-test:1");
    expect(urls.created).toEqual([
      {
        bytes: glbBytes,
        mediaType: "model/gltf-binary",
        url: "blob:teldra-test:1",
      },
    ]);

    await project.close();
    expect(urls.revoked).toEqual(["blob:teldra-test:1"]);
  });

  it("fails safely when the scene manifest GLB hash does not match the archive bytes", async () => {
    const { handle } = await makeRenderableArchive("0".repeat(64));

    await expect(
      openBrowserTeldraProject(
        handle,
        "scene:bad-hash",
        new MemoryRecoveryStore(),
        new RecordingAssetUrlFactory(),
      ),
    ).rejects.toThrow("Scene GLB");
  });

  it("keeps projects without render cache editable without creating an asset URL", async () => {
    const { handle } = await makeGoldenArchive();
    const urls = new RecordingAssetUrlFactory();
    const project = await openBrowserTeldraProject(
      handle,
      "scene:none",
      new MemoryRecoveryStore(),
      urls,
    );

    expect(project.scene).toBeUndefined();
    expect(urls.created).toEqual([]);
    await project.close();
  });

});
