import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import { canonicalTwinFingerprint } from "@teldra/application";
import {
  assertTwinIntegrity,
  type TwinProject,
} from "@teldra/domain";
import {
  openProjectPersistence,
  type ProjectStorageAdapter,
  type StoredProject,
} from "@teldra/project-format";
import { StudioProjectController } from "./StudioProjectController";

class MemoryStorage implements ProjectStorageAdapter<TwinProject> {
  primary: StoredProject<TwinProject> | null;
  backup: StoredProject<TwinProject> | null = null;
  recovery: StoredProject<TwinProject> | null = null;
  staged: StoredProject<TwinProject> | null = null;
  locked = false;

  constructor(primary: StoredProject<TwinProject>) {
    this.primary = structuredClone(primary);
  }

  async acquireWriteLock(): Promise<boolean> {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  async releaseWriteLock(): Promise<void> {
    this.locked = false;
  }

  async readPrimary() {
    return structuredClone(this.primary);
  }

  async readBackup() {
    return structuredClone(this.backup);
  }

  async readRecovery() {
    return structuredClone(this.recovery);
  }

  async stagePrimary(
    _projectKey: string,
    _ownerId: string,
    project: StoredProject<TwinProject>,
  ): Promise<string> {
    this.staged = structuredClone(project);
    return "stage:1";
  }

  async commitStaged(): Promise<void> {
    if (this.staged === null) throw new Error("No staged project.");
    this.backup = structuredClone(this.primary);
    this.primary = structuredClone(this.staged);
    this.staged = null;
  }

  async discardStaged(): Promise<void> {
    this.staged = null;
  }

  async writeRecovery(
    _projectKey: string,
    _ownerId: string,
    project: StoredProject<TwinProject>,
  ): Promise<void> {
    this.recovery = structuredClone(project);
  }

  async clearRecovery(): Promise<void> {
    this.recovery = null;
  }
}

const fixture = goldenTwin as TwinProject;
const deviceId = "device:living-room-floor-lamp";

describe("StudioProjectController", () => {
  it("drives dirty state, undo/redo, and persistence without SolidJS authority", async () => {
    const storage = new MemoryStorage({
      revision: 4,
      fingerprint: canonicalTwinFingerprint(fixture),
      canonical: fixture,
    });

    const opened = await openProjectPersistence(
      storage,
      assertTwinIntegrity,
      "golden-home",
      "test:editor",
    );

    expect(opened.primary).not.toBeNull();
    if (opened.primary === null) return;

    const controller = new StudioProjectController(
      opened.primary.canonical,
      opened.session,
    );

    expect(controller.revision).toBe(4);
    expect(controller.dirty).toBe(false);

    controller.renameDevice(deviceId, "Reading lamp");
    expect(controller.revision).toBe(5);
    expect(controller.dirty).toBe(true);

    expect(controller.undo()).toBe(true);
    expect(controller.revision).toBe(6);
    expect(controller.dirty).toBe(false);

    expect(controller.redo()).toBe(true);
    expect(controller.revision).toBe(7);
    expect(controller.dirty).toBe(true);

    await controller.save();

    expect(controller.dirty).toBe(false);
    expect(storage.primary?.revision).toBe(7);
    expect(
      storage.primary?.canonical.devices.find(
        (device) => device.id === deviceId,
      )?.name,
    ).toBe("Reading lamp");
    expect(
      storage.primary?.canonical.bindings[0]?.externalId,
    ).toBe("light.living_room_floor_lamp");
  });
});
