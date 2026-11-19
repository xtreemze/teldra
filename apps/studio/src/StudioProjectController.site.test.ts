import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import { canonicalTwinFingerprint } from "@teldra/application";
import { assertTwinIntegrity, type SitePlacement, type TwinProject } from "@teldra/domain";
import { openProjectPersistence, type ProjectStorageAdapter, type StoredProject } from "@teldra/project-format";
import { StudioProjectController } from "./StudioProjectController";

class MemoryStorage implements ProjectStorageAdapter<TwinProject> {
  primary: StoredProject<TwinProject> | null;
  backup: StoredProject<TwinProject> | null = null;
  recovery: StoredProject<TwinProject> | null = null;
  staged: StoredProject<TwinProject> | null = null;
  locked = false;
  constructor(primary: StoredProject<TwinProject>) { this.primary = structuredClone(primary); }
  async acquireWriteLock() { if (this.locked) return false; this.locked = true; return true; }
  async releaseWriteLock() { this.locked = false; }
  async readPrimary() { return structuredClone(this.primary); }
  async readBackup() { return structuredClone(this.backup); }
  async readRecovery() { return structuredClone(this.recovery); }
  async stagePrimary(_k: string, _o: string, project: StoredProject<TwinProject>) { this.staged = structuredClone(project); return "stage:1"; }
  async commitStaged() { if (!this.staged) throw new Error("No staged project."); this.backup = structuredClone(this.primary); this.primary = structuredClone(this.staged); this.staged = null; }
  async discardStaged() { this.staged = null; }
  async writeRecovery(_k: string, _o: string, project: StoredProject<TwinProject>) { this.recovery = structuredClone(project); }
  async clearRecovery() { this.recovery = null; }
}

const fixture = goldenTwin as unknown as TwinProject;
// Synthetic site: a made-up location, not a real address.
const placement: SitePlacement = {
  anchor: { crs: "EPSG:4326", latitudeDegrees: 0.5003, longitudeDegrees: 0.5025, height: { metres: 12, reference: "ellipsoidal" } },
  orientation: { northReference: "geographic-north", projectNorthBearingDegrees: 30 },
  provenance: { status: "user-confirmed", source: "manual", dataset: "user-entered", retrievedAt: "2026-01-01T00:00:00Z", confirmedAt: "2026-01-01T00:00:01Z" },
};

async function open(storage: MemoryStorage, key: string) {
  const opened = await openProjectPersistence(storage, assertTwinIntegrity, "golden-home", key);
  if (opened.primary === null) throw new Error("expected a primary project");
  return new StudioProjectController(opened.primary.canonical, opened.session);
}

describe("StudioProjectController.placeBuildingSite", () => {
  it("shares twin undo/redo history, dirties the project and survives save and reopen", async () => {
    const storage = new MemoryStorage({ revision: 1, fingerprint: canonicalTwinFingerprint(fixture), canonical: structuredClone(fixture) });
    const controller = await open(storage, "test:site-1");
    expect(controller.twin.building.sitePlacement).toBeUndefined();

    controller.placeBuildingSite(placement);
    expect(controller.twin.building.sitePlacement).toEqual(placement);
    expect(controller.dirty).toBe(true);
    expect(controller.history.canUndo).toBe(true);

    controller.renameDevice("device:living-room-floor-lamp", "Reading lamp");
    expect(controller.undo()).toBe(true);
    expect(controller.twin.building.sitePlacement).toEqual(placement);
    expect(controller.undo()).toBe(true);
    expect(controller.twin.building.sitePlacement).toBeUndefined();
    expect(controller.redo()).toBe(true);
    expect(controller.twin.building.sitePlacement).toEqual(placement);

    await controller.save();
    expect(controller.dirty).toBe(false);
    await storage.releaseWriteLock(); // the first session closes before the project is reopened

    const reopened = await open(storage, "test:site-2");
    expect(reopened.twin.building.sitePlacement).toEqual(placement);
  });

  it("clears the placement with null as one undoable step", async () => {
    const storage = new MemoryStorage({ revision: 1, fingerprint: canonicalTwinFingerprint(fixture), canonical: structuredClone(fixture) });
    const controller = await open(storage, "test:site-3");
    controller.placeBuildingSite(placement);
    controller.placeBuildingSite(null);
    expect(controller.twin.building.sitePlacement).toBeUndefined();
    controller.undo();
    expect(controller.twin.building.sitePlacement).toEqual(placement);
  });
});
