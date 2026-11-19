import type { IfcWallEditor } from "@teldra/application";
import type { PlanSource } from "@teldra/projection";

export interface PlanEditingStorey { readonly globalId: string; readonly name: string; readonly elevation: number }

/**
 * What the Studio shell provides to the 2D plan editor. The plan view never owns canonical state:
 * every preview/apply/undo/redo goes through `wallEditor`, the SAME `IfcWallEditor` instance (and therefore
 * the same command history) that the 3D viewport and agent surface use.
 */
/*
 * STUDIO INTEGRATION (pending; owned by the StudioProjectController / StudioSelectionWorkspace agent):
 *   1. controller: expose `wallEditor` (the one IfcWallEditor already used for 3D wall edits / agent surface) and an IfcAPI.
 *   2. workspace: build the host once:
 *        const planHost: PlanEditingHost = {
 *          wallEditor: props.controller.wallEditor,
 *          readPlanSource: (bytes) => readPlanSource(props.controller.ifcApi, bytes),   // from @teldra/ifc-edit
 *          selection: { get: () => selectedWallGlobalId(), set: (id) => selectWallByGlobalId(id) },
 *          onCommitted: () => props.controller.afterWallEditCommitted(),   // scene regeneration + dirty flag
 *        };
 *   3. workspace: pass it to the existing draft panel: <WallPlanDraft host={planHost} currentRevision=... />
 * `currentRevision` is also used as the plan's reactive revision, so 3D/agent edits refresh the plan.
 */
export interface PlanEditingHost {
  readonly wallEditor: IfcWallEditor;
  /** Selectable storeys. Defaults to `readPlanSource(...).storeys` when omitted. */
  readonly storeys?: readonly PlanEditingStorey[];
  /** Reads the current canonical plan input from IFC bytes (e.g. `(bytes) => readPlanSource(api, bytes)` from @teldra/ifc-edit). */
  readonly readPlanSource: (bytes: Uint8Array) => PlanSource;
  /** Selected wall IFC GlobalId (null when nothing or a non-wall is selected). `get` should be reactive when backed by Solid signals. */
  readonly selection: { get(): string | null; set(globalId: string | null): void };
  /** Called after every successful apply/undo/redo so Studio can regenerate derived scenes and refresh dirty state. */
  onCommitted(): void;
  /** Optional IFC GlobalId -> Teldra canonical id map for projection identity. */
  readonly canonicalIdByGlobalId?: () => ReadonlyMap<string, string>;
}
