import { describe, expect, it } from "vitest";
import {
  AUTHORITATIVE_PROJECT_STATE_KINDS,
  STATE_OWNERSHIP,
  isAuthoritativeProjectStateKind,
  projectSerializationDisposition,
  selectAuthoritativeProjectState,
  type RuntimeStateKind,
} from "../src/index.js";

describe("runtime state ownership", () => {
  it("classifies every required state category", () => {
    expect(Object.keys(STATE_OWNERSHIP).sort()).toEqual(
      [
        "cache-build",
        "camera-viewport",
        "canonical-ifc",
        "canonical-project",
        "command-history",
        "connection-adapter",
        "editor-draft",
        "live-device",
        "projection",
        "renderer-resource",
        "selection-focus",
        "session",
      ].sort(),
    );
  });

  it("allows only canonical project and IFC state into authoritative serialization", () => {
    const authoritative = Object.keys(STATE_OWNERSHIP).filter((kind) =>
      isAuthoritativeProjectStateKind(kind as RuntimeStateKind),
    );

    expect(authoritative.sort()).toEqual(
      [...AUTHORITATIVE_PROJECT_STATE_KINDS].sort(),
    );
  });

  it.each([
    "camera-viewport",
    "selection-focus",
    "live-device",
    "renderer-resource",
    "editor-draft",
  ] as const)("%s is prohibited from project serialization", (kind) => {
    expect(projectSerializationDisposition(kind)).toBe("forbidden");
  });

  it("keeps deterministic projections and build caches disposable rather than authoritative", () => {
    expect(projectSerializationDisposition("projection")).toBe("derived-cache");
    expect(projectSerializationDisposition("cache-build")).toBe("derived-cache");
    expect(STATE_OWNERSHIP.projection.reconstructible).toBe(true);
    expect(STATE_OWNERSHIP["cache-build"].reconstructible).toBe(true);
  });

  it("filters runtime and UI state out of canonical serialization", () => {
    const canonicalProject = { twin: "canonical" };
    const canonicalIfc = new Uint8Array([1, 2, 3]);

    const serialized = selectAuthoritativeProjectState({
      "canonical-project": canonicalProject,
      "canonical-ifc": canonicalIfc,
      "camera-viewport": { alpha: 1, beta: 2 },
      "selection-focus": { selectedIds: ["device:lamp"] },
      "live-device": { brightness: 0.4 },
      "renderer-resource": { gpuBuffer: "opaque-runtime-handle" },
      "editor-draft": { name: "uncommitted lamp rename" },
      projection: { meshes: ["derived"] },
      "cache-build": { sceneGlb: "disposable" },
      session: { panel: "properties" },
      "command-history": { cursor: 2 },
      "connection-adapter": { connected: true },
    });

    expect(serialized).toEqual({
      "canonical-project": canonicalProject,
      "canonical-ifc": canonicalIfc,
    });
  });

  it("limits undo/redo participation to canonical mutations", () => {
    expect(STATE_OWNERSHIP["canonical-project"].undoRedo).toBe("participates");
    expect(STATE_OWNERSHIP["canonical-ifc"].undoRedo).toBe("participates");
    expect(STATE_OWNERSHIP["command-history"].undoRedo).toBe("records-history");

    for (const kind of [
      "live-device",
      "projection",
      "session",
      "selection-focus",
      "camera-viewport",
      "editor-draft",
      "renderer-resource",
      "cache-build",
      "connection-adapter",
    ] as const) {
      expect(STATE_OWNERSHIP[kind].undoRedo).toBe("does-not-participate");
    }
  });

  it("does not make SolidJS authoritative for canonical or live state", () => {
    expect(STATE_OWNERSHIP["canonical-project"].solidBoundary).toBe(
      "read-model-only",
    );
    expect(STATE_OWNERSHIP["canonical-ifc"].solidBoundary).toBe(
      "read-model-only",
    );
    expect(STATE_OWNERSHIP["live-device"].solidBoundary).toBe("read-model-only");
    expect(STATE_OWNERSHIP["renderer-resource"].solidBoundary).toBe(
      "read-model-only",
    );
  });
});
