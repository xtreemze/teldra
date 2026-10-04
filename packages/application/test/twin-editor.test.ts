import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import type { TwinProject } from "@teldra/domain";
import {
  TwinEditor,
  canonicalTwinFingerprint,
} from "../src/index.js";

const fixture = goldenTwin as TwinProject;
const deviceId = "device:living-room-floor-lamp";
const bindingId = "binding:living-room-floor-lamp:home-assistant";

describe("TwinEditor", () => {
  it("continues from a persisted application revision", () => {
    const editor = new TwinEditor(fixture, 12);

    expect(editor.revision).toBe(12);

    const commit = editor.renameDevice(deviceId, "Reading lamp");
    expect(commit.revisionBefore).toBe(12);
    expect(commit.revisionAfter).toBe(13);
  });

  it("renames a canonical device without changing canonical identity or bindings", () => {
    const editor = new TwinEditor(fixture);
    const before = structuredClone(editor.twin);

    editor.renameDevice(
      deviceId,
      "Reading lamp",
      "correlation:rename-floor-lamp",
    );

    expect(
      editor.twin.devices.find((device) => device.id === deviceId)?.name,
    ).toBe("Reading lamp");
    expect(editor.twin.devices.map((device) => device.id)).toEqual(
      before.devices.map((device) => device.id),
    );
    expect(editor.twin.building).toEqual(before.building);
    expect(
      editor.twin.bindings.find((binding) => binding.id === bindingId),
    ).toEqual(
      before.bindings.find((binding) => binding.id === bindingId),
    );
  });

  it("undoes back to the exact saved canonical fingerprint and redoes the edit", () => {
    const editor = new TwinEditor(fixture);
    const savedFingerprint = canonicalTwinFingerprint(editor.twin);

    editor.renameDevice(deviceId, "Reading lamp");
    const editedFingerprint = canonicalTwinFingerprint(editor.twin);

    expect(editedFingerprint).not.toBe(savedFingerprint);
    expect(editor.history.canUndo).toBe(true);

    editor.undo();
    expect(canonicalTwinFingerprint(editor.twin)).toBe(savedFingerprint);
    expect(editor.history.canRedo).toBe(true);

    editor.redo();
    expect(canonicalTwinFingerprint(editor.twin)).toBe(editedFingerprint);
  });

  it("rejects blank names without publishing canonical state", () => {
    const editor = new TwinEditor(fixture);
    const before = canonicalTwinFingerprint(editor.twin);

    expect(() => editor.renameDevice(deviceId, "   ")).toThrow(
      "Device name must not be empty",
    );

    expect(canonicalTwinFingerprint(editor.twin)).toBe(before);
    expect(editor.revision).toBe(0);
  });

  it("rejects unknown devices without changing history", () => {
    const editor = new TwinEditor(fixture);

    expect(() =>
      editor.renameDevice("device:missing", "Missing"),
    ).toThrow('Cannot rename unknown device "device:missing"');

    expect(editor.history.undoDepth).toBe(0);
    expect(editor.revision).toBe(0);
  });
});
