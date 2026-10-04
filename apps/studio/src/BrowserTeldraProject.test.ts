import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import {
  canonicalTwinFingerprint,
} from "@teldra/application";
import type { TwinProject } from "@teldra/domain";
import type { StoredProject } from "@teldra/project-format";
import {
  decodeTeldraArchive,
  encodeTeldraArchive,
  sha256Hex,
  type TeldraArchive,
} from "@teldra/project-format/archive";
import {
  BrowserTeldraStorageAdapter,
  type BrowserProjectFileHandle,
  type BrowserProjectWritable,
  type BrowserRecoveryStore,
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

class MemoryFileHandle implements BrowserProjectFileHandle {
  readonly name = "golden-home.teldra";
  bytes: Uint8Array;
  failWrite = false;

  constructor(bytes: Uint8Array) {
    this.bytes = new Uint8Array(bytes);
  }

  async getFile(): Promise<Blob> {
    return new Blob([new Uint8Array(this.bytes).buffer]);
  }

  async createWritable(): Promise<BrowserProjectWritable> {
    let staged: Uint8Array | null = null;
    const handle = this;

    return {
      async write(data) {
        staged = new Uint8Array(data);
      },
      async close() {
        if (handle.failWrite) {
          throw new Error("simulated file replacement failure");
        }
        if (staged === null) {
          throw new Error("nothing written");
        }
        handle.bytes = staged;
      },
      async abort() {
        staged = null;
      },
    };
  }
}

async function createFixtureArchive(): Promise<TeldraArchive> {
  const twin = structuredClone(goldenTwin) as TwinProject;
  const twinBytes = new TextEncoder().encode(
    `${JSON.stringify(twin, null, 2)}\n`,
  );
  const building = new TextEncoder().encode("IFC fixture");

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
    derived: [],
  };

  return {
    manifest,
    twin,
    entries: new Map([
      [
        "project.json",
        new TextEncoder().encode(
          `${JSON.stringify(manifest, null, 2)}\n`,
        ),
      ],
      ["building.ifc", building],
      ["twin.json", twinBytes],
      [
        "assets/source/readme.txt",
        new TextEncoder().encode("preserve me"),
      ],
    ]),
  };
}

describe("BrowserTeldraStorageAdapter", () => {
  it("writes an edited twin while preserving non-twin archive entries", async () => {
    const source = await createFixtureArchive();
    const handle = new MemoryFileHandle(
      encodeTeldraArchive(source),
    );
    const recovery = new MemoryRecoveryStore();
    const adapter = await BrowserTeldraStorageAdapter.create(
      handle,
      recovery,
    );

    expect(
      await adapter.acquireWriteLock(adapter.projectKey, "test"),
    ).toBe(true);

    const primary = await adapter.readPrimary(adapter.projectKey);
    const next = structuredClone(primary.canonical);
    next.devices[0]!.name = "Reading lamp";

    const candidate = {
      revision: 1,
      fingerprint: canonicalTwinFingerprint(next),
      canonical: next,
    };
    const stage = await adapter.stagePrimary(
      adapter.projectKey,
      "test",
      candidate,
    );
    await adapter.commitStaged(
      adapter.projectKey,
      "test",
      stage,
    );

    const reopened = await decodeTeldraArchive(handle.bytes);
    expect(reopened.twin.devices[0]?.name).toBe("Reading lamp");
    expect(reopened.twin.devices[0]?.id).toBe(
      source.twin.devices[0]?.id,
    );
    expect(
      new TextDecoder().decode(
        reopened.entries.get("assets/source/readme.txt"),
      ),
    ).toBe("preserve me");

    const backup = await adapter.readBackup(adapter.projectKey);
    expect(backup?.canonical.devices[0]?.name).toBe(
      source.twin.devices[0]?.name,
    );

    await adapter.releaseWriteLock(adapter.projectKey, "test");
  });

  it("does not replace the file when the host write fails", async () => {
    const source = await createFixtureArchive();
    const original = encodeTeldraArchive(source);
    const handle = new MemoryFileHandle(original);
    const adapter = await BrowserTeldraStorageAdapter.create(
      handle,
      new MemoryRecoveryStore(),
    );

    await adapter.acquireWriteLock(adapter.projectKey, "test");

    const primary = await adapter.readPrimary(adapter.projectKey);
    const next = structuredClone(primary.canonical);
    next.devices[0]!.name = "Will fail";

    const stage = await adapter.stagePrimary(
      adapter.projectKey,
      "test",
      {
        revision: 1,
        fingerprint: canonicalTwinFingerprint(next),
        canonical: next,
      },
    );

    handle.failWrite = true;

    await expect(
      adapter.commitStaged(adapter.projectKey, "test", stage),
    ).rejects.toThrow("simulated file replacement failure");

    expect(handle.bytes).toEqual(original);
    await adapter.releaseWriteLock(adapter.projectKey, "test");
  });

  it("keeps autosave recovery host-local rather than adding it to the archive", async () => {
    const source = await createFixtureArchive();
    const handle = new MemoryFileHandle(
      encodeTeldraArchive(source),
    );
    const recovery = new MemoryRecoveryStore();
    const adapter = await BrowserTeldraStorageAdapter.create(
      handle,
      recovery,
    );

    await adapter.acquireWriteLock(adapter.projectKey, "test");
    const primary = await adapter.readPrimary(adapter.projectKey);

    await adapter.writeRecovery(
      adapter.projectKey,
      "test",
      primary,
    );

    expect(
      await adapter.readRecovery(adapter.projectKey),
    ).toEqual(primary);

    const archive = await decodeTeldraArchive(handle.bytes);
    expect([...archive.entries.keys()]).not.toContain(
      "recovery.json",
    );

    await adapter.clearRecovery(adapter.projectKey, "test");
    expect(
      await adapter.readRecovery(adapter.projectKey),
    ).toBeNull();

    await adapter.releaseWriteLock(adapter.projectKey, "test");
  });
});
