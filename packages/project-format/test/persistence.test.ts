import { describe, expect, it } from "vitest";
import {
  ProjectCorruptionError,
  ProjectLockError,
  ProjectSaveError,
  openProjectPersistence,
  restoreProjectFrom,
  type ProjectStorageAdapter,
  type StoredProject,
} from "../src/index.js";

interface CanonicalFixture {
  version: string;
  value: string;
}

interface DerivedFixture {
  scene?: string;
}

type FixtureProject = StoredProject<CanonicalFixture, DerivedFixture>;

class MemoryStorage
  implements ProjectStorageAdapter<CanonicalFixture, DerivedFixture>
{
  readonly primary = new Map<string, FixtureProject>();
  readonly backup = new Map<string, FixtureProject>();
  readonly recovery = new Map<string, FixtureProject>();
  readonly locks = new Map<string, string>();
  readonly staged = new Map<string, FixtureProject>();

  failCommit = false;
  #nextStage = 1;

  async acquireWriteLock(projectKey: string, ownerId: string): Promise<boolean> {
    const owner = this.locks.get(projectKey);
    if (owner !== undefined && owner !== ownerId) {
      return false;
    }

    this.locks.set(projectKey, ownerId);
    return true;
  }

  async releaseWriteLock(projectKey: string, ownerId: string): Promise<void> {
    if (this.locks.get(projectKey) === ownerId) {
      this.locks.delete(projectKey);
    }
  }

  async readPrimary(projectKey: string): Promise<FixtureProject | null> {
    return this.primary.get(projectKey) ?? null;
  }

  async readBackup(projectKey: string): Promise<FixtureProject | null> {
    return this.backup.get(projectKey) ?? null;
  }

  async readRecovery(projectKey: string): Promise<FixtureProject | null> {
    return this.recovery.get(projectKey) ?? null;
  }

  async stagePrimary(
    projectKey: string,
    ownerId: string,
    project: FixtureProject,
  ): Promise<string> {
    this.assertLock(projectKey, ownerId);
    const stageId = `${projectKey}:stage:${this.#nextStage++}`;
    this.staged.set(stageId, structuredClone(project));
    return stageId;
  }

  async commitStaged(
    projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void> {
    this.assertLock(projectKey, ownerId);

    const candidate = this.staged.get(stageId);
    if (candidate === undefined) {
      throw new Error("missing stage");
    }

    if (this.failCommit) {
      throw new Error("simulated interruption before atomic replace");
    }

    const existing = this.primary.get(projectKey);
    if (existing !== undefined) {
      this.backup.set(projectKey, structuredClone(existing));
    }

    this.primary.set(projectKey, structuredClone(candidate));
    this.staged.delete(stageId);
  }

  async discardStaged(
    projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void> {
    this.assertLock(projectKey, ownerId);
    this.staged.delete(stageId);
  }

  async writeRecovery(
    projectKey: string,
    ownerId: string,
    project: FixtureProject,
  ): Promise<void> {
    this.assertLock(projectKey, ownerId);
    this.recovery.set(projectKey, structuredClone(project));
  }

  async clearRecovery(projectKey: string, ownerId: string): Promise<void> {
    this.assertLock(projectKey, ownerId);
    this.recovery.delete(projectKey);
  }

  private assertLock(projectKey: string, ownerId: string): void {
    if (this.locks.get(projectKey) !== ownerId) {
      throw new Error("write lock not held");
    }
  }
}

const valid = (value: string, revision = 1): FixtureProject => ({
  revision,
  fingerprint: `sha256:${value}`,
  canonical: {
    version: "0.1.0",
    value,
  },
});

const validateCanonical = (canonical: CanonicalFixture): void => {
  if (canonical.version !== "0.1.0" || canonical.value.length === 0) {
    throw new Error("invalid canonical project");
  }
};

describe("project persistence semantics", () => {
  it("atomically replaces the primary and retains the prior primary as backup", async () => {
    const storage = new MemoryStorage();
    storage.primary.set("home", valid("A", 1));

    const opened = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:a",
    );

    const next = valid("B", 2);
    opened.session.markCurrent(next.revision, next.fingerprint);
    expect(opened.session.dirty).toBe(true);

    await opened.session.save(next);

    expect(storage.primary.get("home")).toEqual(next);
    expect(storage.backup.get("home")).toEqual(valid("A", 1));
    expect(opened.session.dirty).toBe(false);
    expect(opened.session.status).toBe("clean");

    await opened.session.close();
  });

  it("leaves the previous primary intact when an interrupted save fails before commit", async () => {
    const storage = new MemoryStorage();
    const original = valid("A", 1);
    storage.primary.set("home", original);
    storage.failCommit = true;

    const opened = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:a",
    );

    const next = valid("B", 2);
    opened.session.markCurrent(next.revision, next.fingerprint);

    await expect(opened.session.save(next)).rejects.toBeInstanceOf(
      ProjectSaveError,
    );

    expect(storage.primary.get("home")).toEqual(original);
    expect(storage.backup.has("home")).toBe(false);
    expect(storage.staged.size).toBe(0);
    expect(opened.session.dirty).toBe(true);
    expect(opened.session.status).toBe("save-failed");

    await opened.session.close();
  });

  it("keeps autosave in a separate recovery slot and detects it after reopen", async () => {
    const storage = new MemoryStorage();
    storage.primary.set("home", valid("A", 1));

    const first = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:a",
    );

    const autosaved = valid("B", 2);
    first.session.markCurrent(autosaved.revision, autosaved.fingerprint);
    await first.session.autosave(autosaved);

    expect(first.session.dirty).toBe(true);
    expect(storage.primary.get("home")).toEqual(valid("A", 1));
    expect(storage.recovery.get("home")).toEqual(autosaved);

    await first.session.close();

    const reopened = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:b",
    );

    expect(reopened.recoveryAvailable).toBe(true);
    expect(reopened.primary).toEqual(valid("A", 1));
    expect(reopened.recovery).toEqual(autosaved);

    await reopened.session.close();
  });

  it("restores recovery explicitly through the same atomic replacement path", async () => {
    const storage = new MemoryStorage();
    storage.primary.set("home", valid("A", 1));
    storage.recovery.set("home", valid("Recovered", 4));

    const restored = await restoreProjectFrom(
      storage,
      validateCanonical,
      "home",
      "recovery:operator",
      "recovery",
    );

    expect(restored).toEqual(valid("Recovered", 4));
    expect(storage.primary.get("home")).toEqual(valid("Recovered", 4));
    expect(storage.recovery.has("home")).toBe(false);
  });

  it("bases dirty state on canonical fingerprint rather than revision number alone", async () => {
    const storage = new MemoryStorage();
    const original = valid("A", 1);
    storage.primary.set("home", original);

    const opened = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:a",
    );

    opened.session.markCurrent(2, original.fingerprint);
    expect(opened.session.dirty).toBe(false);

    opened.session.markCurrent(3, "sha256:B");
    expect(opened.session.dirty).toBe(true);

    await opened.session.close();
  });

  it("opens successfully when disposable derived cache is absent", async () => {
    const storage = new MemoryStorage();
    storage.primary.set("home", valid("A", 1));

    const opened = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:a",
    );

    expect(opened.primary?.derived).toBeUndefined();
    expect(opened.session.status).toBe("clean");

    await opened.session.close();
  });

  it("fails explicitly on corrupt canonical data and reports valid recovery sources", async () => {
    const storage = new MemoryStorage();

    storage.primary.set("home", {
      revision: 3,
      fingerprint: "sha256:corrupt",
      canonical: { version: "0.1.0", value: "" },
      derived: { scene: "cache-is-not-authority" },
    });
    storage.backup.set("home", valid("Backup", 2));

    await expect(
      openProjectPersistence(
        storage,
        validateCanonical,
        "home",
        "window:a",
      ),
    ).rejects.toMatchObject({
      name: "ProjectCorruptionError",
      recoverableSources: ["backup"],
    });

    expect(storage.primary.get("home")?.canonical.value).toBe("");
    expect(storage.locks.has("home")).toBe(false);

    await restoreProjectFrom(
      storage,
      validateCanonical,
      "home",
      "recovery:operator",
      "backup",
    );

    expect(storage.primary.get("home")?.canonical.value).toBe("Backup");
  });

  it("enforces a single writer while allowing read-only inspection", async () => {
    const storage = new MemoryStorage();
    storage.primary.set("home", valid("A", 1));

    const writer = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:a",
    );

    await expect(
      openProjectPersistence(
        storage,
        validateCanonical,
        "home",
        "window:b",
      ),
    ).rejects.toBeInstanceOf(ProjectLockError);

    const reader = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:reader",
      "read-only",
    );

    expect(reader.primary).toEqual(valid("A", 1));
    await reader.session.close();

    await writer.session.close();

    const nextWriter = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:b",
    );
    expect(nextWriter.session.mode).toBe("read-write");
    await nextWriter.session.close();
  });

  it("does not silently accept a corrupt recovery candidate", async () => {
    const storage = new MemoryStorage();
    storage.primary.set("home", valid("A", 1));
    storage.recovery.set("home", {
      revision: 2,
      fingerprint: "sha256:bad-recovery",
      canonical: { version: "0.1.0", value: "" },
    });

    const opened = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:a",
    );

    expect(opened.recovery).toBeNull();
    expect(opened.recoveryAvailable).toBe(false);

    await opened.session.close();
  });

  it("rejects saving a stale candidate that no longer matches current state", async () => {
    const storage = new MemoryStorage();
    storage.primary.set("home", valid("A", 1));

    const opened = await openProjectPersistence(
      storage,
      validateCanonical,
      "home",
      "window:a",
    );

    const stale = valid("B", 2);
    opened.session.markCurrent(3, "sha256:C");

    await expect(opened.session.save(stale)).rejects.toThrow(
      "does not match the current application revision/fingerprint",
    );

    expect(storage.primary.get("home")).toEqual(valid("A", 1));
    await opened.session.close();
  });

  it("surfaces typed corruption failures", async () => {
    const storage = new MemoryStorage();
    storage.primary.set("home", {
      revision: 1,
      fingerprint: "sha256:bad",
      canonical: { version: "wrong", value: "x" },
    });

    try {
      await openProjectPersistence(
        storage,
        validateCanonical,
        "home",
        "window:a",
      );
      throw new Error("expected open to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectCorruptionError);
      expect((error as ProjectCorruptionError).recoverableSources).toEqual([]);
    }
  });
});
