import type { IfcAPI } from "web-ifc";
import { createElementTessellator } from "@teldra/ifc-edit";
import {
  SceneRegenerationCoordinator, type SceneMeshSink, type SceneNodeRecord, type SceneRegenerationResult,
} from "@teldra/projection";
import type { TeldraSceneManifest } from "@teldra/scene-manifest";

/**
 * Studio wiring for in-browser regeneration of derived 3D meshes after canonical IFC edits.
 *
 * INTEGRATION (one call): after every successful `IfcWallEditor`/`IfcFurnitureEditor`
 * apply, undo or redo, call
 *
 *   const result = await regeneration.regenerate(editor);
 *
 * and handle the result:
 *  - "applied" / "noop" / "stale": nothing else to do (`stale` means a newer request covers it);
 *  - "rebuild-required" / "failed": the previous scene is still displayed; fall back to the existing
 *    full scene rebuild, then call `regeneration.markRebuilt(editor.history.revision, newManifest.nodes)`.
 *
 * Create it once per loaded scene (`createSceneRegeneration(runtime, manifest, api, editor.history.revision)`);
 * discard it when the scene is fully reloaded. Furniture pose-only edits are already projected via
 * `runtime.applyScenePlacements` and need not be regenerated; scale edits do.
 */
export interface RegenerationSource {
  readonly bytes: Uint8Array;
  readonly history: { readonly revision: number };
  readonly lastAffectedGlobalIds: readonly string[];
}
export interface SceneRegeneration {
  readonly coordinator: SceneRegenerationCoordinator;
  /** Canonical IFC revision the viewport currently reflects. */
  readonly reflectedRevision: number;
  regenerate(editor: RegenerationSource): Promise<SceneRegenerationResult>;
  markRebuilt(revision: number, nodes: readonly SceneNodeRecord[]): void;
}

export function createSceneRegeneration(
  sink: SceneMeshSink,
  manifest: TeldraSceneManifest,
  api: IfcAPI,
  initialRevision: number,
  resolveCanonicalId?: (globalId: string) => string | undefined,
): SceneRegeneration {
  const coordinator = new SceneRegenerationCoordinator({
    nodes: manifest.nodes, canonicalToScene: manifest.scene.canonicalToScene, initialRevision, sink,
    ...(resolveCanonicalId ? { resolveCanonicalId } : {}),
  });
  return {
    coordinator,
    get reflectedRevision() { return coordinator.reflectedRevision; },
    regenerate(editor) {
      // Snapshot bytes and revision together, synchronously, so a later edit cannot be mixed in.
      const revision = editor.history.revision;
      const tessellate = createElementTessellator(api, editor.bytes);
      return coordinator.request({ revision, changedGlobalIds: editor.lastAffectedGlobalIds, tessellate });
    },
    markRebuilt: (revision, nodes) => coordinator.markRebuilt(revision, nodes),
  };
}
