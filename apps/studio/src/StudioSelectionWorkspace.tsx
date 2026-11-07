import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { FurnitureEditSession, FurnitureWorldPose, TwinRenderIdentity } from "@teldra/runtime-babylon";
import type { FurnitureGeometryScale } from "@teldra/application";
import { ProjectDeviceEditor } from "./ProjectDeviceEditor";
import { IfcFurnitureEdit, type FurnitureEditControls } from "./IfcFurnitureEdit";
import { transformShortcut, numericFurniturePose, numericFurnitureScale, type TransformModal } from "./transform-shortcuts";
import { SelectedDeviceLiveState } from "./SelectedDeviceLiveState";
import { SpatialEdit } from "./SpatialEdit";
import { signalMobileFeedback } from "./mobile-feedback";
import { MobileTransformPad } from "./MobileTransformPad";
import type { StudioLiveStateController } from "./StudioLiveStateController";
import type { StudioProjectController } from "./StudioProjectController";
import {
  TwinViewport,
  type TwinViewportHandle,
} from "./TwinViewport";
import "./StudioSelectionWorkspace.css";

export interface StudioSelectionWorkspaceProps {
  readonly controller: StudioProjectController;
  readonly manifest: unknown;
  readonly glbUrl: string;
  readonly onViewportReady?: (handle: TwinViewportHandle) => void;
  readonly liveState?: StudioLiveStateController;
}

export function StudioSelectionWorkspace(
  props: StudioSelectionWorkspaceProps,
) {
  const [selectionVersion, setSelectionVersion] = createSignal(0);
  const [sceneOpen, setSceneOpen] = createSignal(typeof window === "undefined" || !window.matchMedia("(max-width: 48rem)").matches);
  const [inspectorOpen, setInspectorOpen] = createSignal(
    Boolean(props.controller.selectedCanonicalId) &&
    (typeof window === "undefined" || !window.matchMedia("(max-width: 48rem)").matches),
  );
  const [search, setSearch] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [actionError, setActionError] = createSignal("");
  const [mobileProjectOpen, setMobileProjectOpen] = createSignal(false);
  const [mobileContextOpen, setMobileContextOpen] = createSignal(false);
  const [mobileHapticsEnabled, setMobileHapticsEnabled] = createSignal(true);
  const tactile = (kind: "select" | "menu" | "edit" | "applied" | "error") =>
    signalMobileFeedback(kind, mobileHapticsEnabled());
  const [viewport, setViewport] = createSignal<TwinViewportHandle>();
  const [viewportDraft, setViewportDraft] = createSignal<FurnitureWorldPose>();
  const [viewportScaleDraft, setViewportScaleDraft] = createSignal<FurnitureGeometryScale>();
  const [editingFurniture, setEditingFurniture] = createSignal(false);
  const [editMode, setEditMode] = createSignal<"translate" | "rotate" | "scale">("translate");
  const [translationSnap, setTranslationSnap] = createSignal(0);
  const [rotationSnap, setRotationSnap] = createSignal(0);
  const [editRequest, setEditRequest] = createSignal(0);
  const [transformModal, setTransformModal] = createSignal<TransformModal | null>(null);
  const [transformMessage, setTransformMessage] = createSignal("");
  let workspaceRoot!: HTMLDivElement;
  let editSession: FurnitureEditSession | undefined;
  let furnitureControls: FurnitureEditControls | null = null;
  let numericStartPose: FurnitureWorldPose | undefined;
  let numericStartScale: FurnitureGeometryScale | undefined;

  const refreshSelection = () =>
    setSelectionVersion((version) => version + 1);

  const selectedCanonicalId = () => {
    selectionVersion();
    return props.controller.selectedCanonicalId;
  };

  const selectedDevice = () => {
    selectionVersion();
    return props.controller.selectedDevice;
  };

  const selectedBuildingRef = () => {
    selectionVersion();
    return props.controller.selectedBuildingRef;
  };

  const selectCanonicalId = (canonicalId: string | null) => {
    // An onPick fired when the held pointer is released must not close its menu.
    if (canonicalId === props.controller.selectedCanonicalId && mobileContextOpen()) return;
    if (canonicalId !== props.controller.selectedCanonicalId) { stopFurnitureEdit(); setEditRequest(0); }
    props.controller.selectCanonicalId(canonicalId);
    if (canonicalId !== null) {
      if (window.matchMedia("(max-width: 48rem)").matches) {
        setSceneOpen(false);
        setInspectorOpen(false);
      } else {
        setInspectorOpen(true);
      }
      tactile("select");
    }
    setMobileContextOpen(false);
    refreshSelection();
  };

  const selectRenderIdentity = (identity: TwinRenderIdentity | null) => {
    selectCanonicalId(identity?.canonicalId ?? null);
  };
  const matches = (...parts: (string | undefined)[]) => {
    const query = search().trim().toLocaleLowerCase();
    return query === "" || parts.some((part) => part?.toLocaleLowerCase().includes(query));
  };
  const devices = () => { selectionVersion(); return props.controller.twin.devices.filter((device) => matches(device.name, device.id)); };
  const buildingRefs = () => props.controller.twin.building.refs.filter((ref) => matches(ref.name, ref.kind, ref.id, ref.ifcGlobalId));
  const history = () => { selectionVersion(); return props.controller.history; };
  const dirty = () => { selectionVersion(); return props.controller.dirty; };
  const changeHistory = (direction: "undo" | "redo") => {
    stopFurnitureEdit();
    props.controller[direction]();
    refreshSelection();
    setActionError("");
  };
  const save = async () => {
    setSaving(true);
    setActionError("");
    try { await props.controller.save(); refreshSelection(); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  const projectPlacements = () => {
    try { viewport()?.applyScenePlacements(props.controller.placementOverrides); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  };
  const stopFurnitureEdit = () => {
    editSession?.cancel();
    editSession?.detach();
    editSession = undefined;
    numericStartPose = undefined; numericStartScale = undefined;
    setTransformModal(null);
    setEditingFurniture(false);
    setViewportDraft(undefined); setViewportScaleDraft(undefined);
    projectPlacements();
  };
  const previewNumericTransform = (modal: TransformModal | null) => {
    if (!modal || !editSession) return;
    if (modal.mode === "scale") {
      if (!numericStartScale) return;
      const scale = numericFurnitureScale(numericStartScale, modal);
      if (scale || modal.numeric === "") {
        const next = scale ?? numericStartScale;
        editSession.setScale(next);
        setViewportScaleDraft(next);
      }
      return;
    }
    if (!numericStartPose) return;
    if (modal.mode === "translate") editSession.setAxisConstraint(modal.axis);
    const pose = numericFurniturePose(numericStartPose, modal);
    if (pose || modal.numeric === "") {
      const next = pose ?? numericStartPose;
      editSession.setPose(next);
      setViewportDraft(next);
    }
  };
  const previewTouchTransform = (pose: FurnitureWorldPose) => {
    if (!editSession) return;
    try {
      editSession.setPose(pose);
      setViewportDraft(pose);
      setActionError("");
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  };
  const previewTouchScale = (scale: FurnitureGeometryScale) => {
    if (!editSession) return;
    try {
      editSession.setScale(scale);
      setViewportScaleDraft(scale);
      setActionError("");
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  };
  const applyTouchTransform = () => {
    if (!furnitureControls?.apply()) {
      setActionError("Transform was not applied. Check the inspector for the IFC validation error.");
      return;
    }
    setTransformMessage("IFC transform updated. Save the project to retain it.");
  };
  const cancelTouchTransform = () => {
    furnitureControls?.cancel();
    stopFurnitureEdit();
    setEditRequest(0);
    setTransformMessage("Touch transform cancelled. IFC placement unchanged.");
  };
  const furnitureEditingChanged = (editing: boolean) => {
    if (!editing) { stopFurnitureEdit(); setEditRequest(0); return; }
    const id = selectedCanonicalId();
    if (!id || !viewport()) { setActionError("The 3D viewport is not ready for furniture editing."); return; }
    try {
      editSession = viewport()!.beginFurnitureEdit(props.controller.furniturePlacement(id), setViewportDraft,
        undefined, setViewportScaleDraft);
      editSession.setMode(editMode());
      setEditingFurniture(true);
      if (window.matchMedia("(max-width: 48rem)").matches) setInspectorOpen(false);
      if (transformModal()) {
        numericStartPose = props.controller.furniturePose(id);
        const support = props.controller.furnitureScaleStatus(id);
        numericStartScale = support.supported ? support.scale : undefined;
        previewNumericTransform(transformModal());
      }
      setActionError("");
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
  };
  const startMobileFurnitureEdit = (mode: "translate" | "rotate" | "scale") => {
    if (!["furniture", "fixture", "other", "distribution-element"].includes(selectedBuildingRef()?.kind ?? "") || !viewport()) return;
    setEditMode(mode);
    setMobileContextOpen(false);
    setMobileProjectOpen(false);
    setSceneOpen(false);
    setInspectorOpen(true);
    if (editingFurniture()) {
      editSession?.setMode(mode);
      if (mode === "translate") editSession?.setAxisConstraint(null);
    } else {
      setEditRequest((request) => request + 1);
    }
    tactile("edit");
  };
  const openMobileContext = () => {
    if (!selectedCanonicalId() || editingFurniture()) return;
    setMobileProjectOpen(false);
    setMobileContextOpen(true);
    tactile("menu");
  };
  createEffect(() => { selectionVersion(); viewport(); projectPlacements(); });
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !workspaceRoot) return;
    const canvas = workspaceRoot.querySelector<HTMLCanvasElement>(".teldra-twin-viewport__canvas");
    // Do not intercept form typing, global browser shortcuts or keys from other viewports.
    if (event.target !== canvas) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey &&
        (key === "s" || key === "z") && !event.repeat) {
      event.preventDefault(); event.stopPropagation();
      if (editingFurniture()) {
        setTransformMessage("Apply or cancel the current IFC transform before saving or undoing.");
      } else if (key === "s") void save();
      else changeHistory(event.shiftKey ? "redo" : "undo");
      return;
    }
    const selectedId = selectedBuildingRef()?.id;
    const scaleSupport = selectedId ? props.controller.furnitureScaleStatus(selectedId) : null;
    const step = transformShortcut(transformModal(), event,
      editingFurniture() ? scaleSupport?.supported === true : ["furniture", "fixture", "other", "distribution-element"].includes(selectedBuildingRef()?.kind ?? ""));
    if (!step.handled) return;
    event.preventDefault(); event.stopPropagation();
    if (step.intent === "unsupported" || step.intent === "message") {
      setTransformMessage(step.message ?? "Transform not supported.");
      return;
    }
    if (step.intent === "begin") {
      const ref = selectedBuildingRef();
      if (!ref || !["furniture", "fixture", "other", "distribution-element"].includes(ref.kind)) {
        setTransformMessage("Select an IFC furniture object before using G, R or S.");
        return;
      }
      if (!viewport()) {
        setTransformMessage("The 3D viewport must finish loading before editing.");
        return;
      }
      const mode = step.state!.mode;
      setEditMode(mode);
      if (editingFurniture()) {
        numericStartPose = viewportDraft() ?? props.controller.furniturePose(ref.id);
        const support = props.controller.furnitureScaleStatus(ref.id);
        numericStartScale = viewportScaleDraft() ?? (support.supported ? support.scale : undefined);
        editSession?.setMode(mode);
        if (mode === "translate") editSession?.setAxisConstraint(null);
      } else {
        setInspectorOpen(true);
        setEditRequest((request) => request + 1);
      }
      setTransformModal(step.state);
      setTransformMessage("");
      return;
    }
    if (step.intent === "preview") {
      setTransformModal(step.state);
      previewNumericTransform(step.state);
      setTransformMessage("");
      return;
    }
    if (step.intent === "cancel") {
      furnitureControls?.cancel();
      stopFurnitureEdit();
      setEditRequest(0);
      setTransformMessage("Transform cancelled; IFC project unchanged.");
      return;
    }
    if (step.intent === "confirm") {
      if (!editingFurniture() || !furnitureControls) {
        setTransformMessage("Transform is not ready; wait for IFC validation.");
        return;
      }
      if (furnitureControls.apply()) {
        setTransformModal(null);
        setTransformMessage("IFC transform applied. Save the project to retain it.");
      }
    }
  };
  onMount(() => {
    window.addEventListener("keydown", keydown, true);

    // Hold is an alternative to the visible object-action menu, not a unique command.
    // Motion, multi-touch, or active IFC gizmos must never trigger a contextual action.
    let pending: {pointerId: number; x: number; y: number} | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelHold = () => {
      if (holdTimer !== undefined) clearTimeout(holdTimer);
      holdTimer = undefined;
      pending = null;
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      // Any second pointer converts the gesture to navigation, not long press.
      if (pending) cancelHold();
      if (!window.matchMedia("(max-width: 48rem)").matches ||
          !event.isPrimary || event.button !== 0 || editingFurniture() ||
          !(event.target instanceof HTMLCanvasElement) ||
          !event.target.classList.contains("teldra-twin-viewport__canvas")) return;
      cancelHold();
      pending = {pointerId: event.pointerId, x: event.clientX, y: event.clientY};
      holdTimer = setTimeout(() => {
        const point = pending;
        cancelHold();
        if (!point || editingFurniture()) return;
        const hit = viewport()?.pick(point.x, point.y);
        if (!hit) return;
        selectRenderIdentity(hit);
        openMobileContext();
      }, 480);
    };
    const pointerMove = (event: PointerEvent) => {
      if (pending && (event.pointerId !== pending.pointerId ||
          Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 10)) cancelHold();
    };
    workspaceRoot.addEventListener("pointerdown", pointerDown, true);
    workspaceRoot.addEventListener("pointermove", pointerMove, true);
    workspaceRoot.addEventListener("pointerup", cancelHold, true);
    workspaceRoot.addEventListener("pointercancel", cancelHold, true);
    onCleanup(() => {
      window.removeEventListener("keydown", keydown, true);
      workspaceRoot.removeEventListener("pointerdown", pointerDown, true);
      workspaceRoot.removeEventListener("pointermove", pointerMove, true);
      workspaceRoot.removeEventListener("pointerup", cancelHold, true);
      workspaceRoot.removeEventListener("pointercancel", cancelHold, true);
      cancelHold();
    });
  });
  onCleanup(stopFurnitureEdit);

  return (
    <div ref={workspaceRoot} class="teldra-studio-selection-workspace">
      <div class="teldra-studio-selection-workspace__mobile-header" role="group" aria-label="Mobile Studio navigation">
        <button type="button" aria-expanded={sceneOpen()} aria-controls="teldra-scene-panel"
          disabled={editingFurniture()} title={editingFurniture() ? "Apply or cancel the active transform first" : "Browse the scene"}
          onClick={() => {setSceneOpen(!sceneOpen()); setInspectorOpen(false); setMobileProjectOpen(false); setMobileContextOpen(false);}}>Scene</button>
        <output aria-live="polite">{dirty() ? "Unsaved changes" : "Saved"}</output>
        <Show when={editingFurniture()}><button type="button" aria-expanded={inspectorOpen()} aria-controls="teldra-object-panel"
          onClick={() => setInspectorOpen(!inspectorOpen())}>{inspectorOpen() ? "Gestures" : "Numbers"}</button></Show>
        <button type="button" aria-expanded={mobileProjectOpen()} aria-controls="teldra-mobile-project-menu"
          onClick={() => {setMobileProjectOpen(!mobileProjectOpen()); setMobileContextOpen(false);}}>Project</button>
      </div>
      <Show when={mobileProjectOpen()}>
        <div id="teldra-mobile-project-menu" class="teldra-studio-selection-workspace__mobile-project-menu" role="group" aria-label="Mobile project menu">
          <button type="button" disabled={!history().canUndo || editingFurniture()} onClick={() => {changeHistory("undo");setMobileProjectOpen(false);}}>Undo</button>
          <button type="button" disabled={!history().canRedo || editingFurniture()} onClick={() => {changeHistory("redo");setMobileProjectOpen(false);}}>Redo</button>
          <button type="button" disabled={!dirty() || saving() || editingFurniture()} onClick={() => void save()}>{saving() ? "Saving…" : "Save project"}</button>
          <button type="button" aria-pressed={mobileHapticsEnabled()} onClick={() => setMobileHapticsEnabled(!mobileHapticsEnabled())}>Haptics {mobileHapticsEnabled() ? "on" : "off"}</button>
          <Show when={actionError()}><p role="alert">{actionError()}</p></Show>
        </div>
      </Show>
      <div class="teldra-studio-selection-workspace__project-actions" role="group" aria-label="Project actions">
        <button type="button" aria-expanded={sceneOpen()} aria-controls="teldra-scene-panel" onClick={() => {setSceneOpen(!sceneOpen()); if (window.matchMedia("(max-width: 48rem)").matches) setInspectorOpen(false);}}>Scene</button>
        <button type="button" aria-expanded={inspectorOpen()} aria-controls="teldra-object-panel" onClick={() => {setInspectorOpen(!inspectorOpen()); if (window.matchMedia("(max-width: 48rem)").matches) setSceneOpen(false);}}>Inspector</button>
        <output aria-live="polite" data-testid={selectedDevice() ? "project-dirty-state" : undefined}>{dirty() ? "Unsaved changes" : "Saved"}</output>
        <button type="button" disabled={!history().canUndo || editingFurniture()} onClick={() => changeHistory("undo")}>Undo</button>
        <button type="button" disabled={!history().canRedo || editingFurniture()} onClick={() => changeHistory("redo")}>Redo</button>
        <button type="button" disabled={!dirty() || saving() || editingFurniture()} onClick={() => void save()}>{saving() ? "Saving…" : "Save project"}</button>
        <Show when={["furniture", "fixture", "other", "distribution-element"].includes(selectedBuildingRef()?.kind ?? "")}>
          <Show when={!editingFurniture()} fallback={
            <div class="teldra-studio-selection-workspace__gizmo" role="group" aria-label="Furniture manipulation mode">
              <button type="button" aria-keyshortcuts="G" title="Move (G)" aria-pressed={editMode() === "translate"} onClick={() => { setEditMode("translate"); editSession?.setMode("translate"); editSession?.setAxisConstraint(null); }}>Move</button>
              <button type="button" aria-keyshortcuts="R" title="Rotate about IFC world Z (R)" aria-pressed={editMode() === "rotate"} onClick={() => { setEditMode("rotate"); editSession?.setMode("rotate"); }}>Rotate</button>
              <button type="button" aria-keyshortcuts="S" aria-pressed={editMode() === "scale"}
                disabled={!props.controller.furnitureScaleStatus(selectedCanonicalId()!).supported}
                title={(() => { const support = props.controller.furnitureScaleStatus(selectedCanonicalId()!);
                  return support.supported ? "Local IFC geometry scale (S)" : support.reason; })()}
                onClick={() => { setEditMode("scale"); editSession?.setMode("scale"); }}>Scale</button>
            </div>
          }>
            <button type="button" disabled={!viewport()} title={viewport() ? "Manipulate selected furniture with 3D gizmos" : "3D scene is still loading"} onClick={() => { setInspectorOpen(true); setEditRequest((request) => request + 1); }}>Edit transform</button>
          </Show>
        </Show>
        <Show when={editingFurniture()}><span class="teldra-studio-selection-workspace__hint">Apply or cancel the placement before saving or changing history.</span></Show>
        <Show when={actionError()}><p role="alert">{actionError()}</p></Show>
      </div>
      <Show when={transformModal() || transformMessage()}>
        <div class="teldra-studio-selection-workspace__transform-hint" role="status" aria-live="polite" data-testid="transform-shortcut-status">
          <Show when={transformModal()}>{modal => <span>{modal().mode === "translate" ? "Move (G)" : modal().mode === "rotate" ? "Rotate (R)" : "Scale (S)"} {modal().axis?.toUpperCase() ?? ""} {modal().numeric} · X/Y/Z constrain · Enter apply · Esc cancel</span>}</Show>
          <Show when={transformMessage()}><span>{transformMessage()}</span></Show>
        </div>
      </Show>
      <Show when={selectedCanonicalId() && !sceneOpen() && !inspectorOpen() && !editingFurniture()}>
        <div class="teldra-studio-selection-workspace__mobile-selection" role="group" aria-label="Mobile selection actions">
          <div class="teldra-studio-selection-workspace__mobile-selection-label">
            <strong>{selectedDevice()?.name ?? selectedBuildingRef()?.name ?? selectedBuildingRef()?.kind ?? "Selected object"}</strong>
            <small>{selectedDevice() ? "Device" : selectedBuildingRef()?.kind ?? "Building object"}</small>
          </div>
          <Show when={["furniture", "fixture", "other", "distribution-element"].includes(selectedBuildingRef()?.kind ?? "")}>
            <button type="button" disabled={!viewport()} onClick={() => startMobileFurnitureEdit("translate")}>Move</button>
            <button type="button" disabled={!viewport()} onClick={() => startMobileFurnitureEdit("rotate")}>Rotate</button>
          </Show>
          <button type="button" onClick={() => {setInspectorOpen(true);setMobileContextOpen(false);}}>Details</button>
          <button type="button" aria-label="More object actions" aria-expanded={mobileContextOpen()} onClick={openMobileContext}>···</button>
        </div>
      </Show>
      <Show when={mobileContextOpen() && selectedCanonicalId()}>
        <div class="teldra-studio-selection-workspace__mobile-context" role="group" aria-label="Selected object actions">
          <strong>{selectedDevice()?.name ?? selectedBuildingRef()?.name ?? "Selected object"}</strong>
          <button type="button" onClick={() => {setInspectorOpen(true);setMobileContextOpen(false);}}>Details</button>
          <Show when={["furniture", "fixture", "other", "distribution-element"].includes(selectedBuildingRef()?.kind ?? "")}>
            <button type="button" disabled={!viewport()} onClick={() => startMobileFurnitureEdit("translate")}>Move</button>
            <button type="button" disabled={!viewport()} onClick={() => startMobileFurnitureEdit("rotate")}>Rotate</button>
            <button type="button" onClick={() => startMobileFurnitureEdit("scale")}>Scale</button>
          </Show>
          <button type="button" onClick={() => setMobileContextOpen(false)}>Close menu</button>
        </div>
      </Show>
      <Show when={editingFurniture() && ["furniture", "fixture", "other", "distribution-element"].includes(selectedBuildingRef()?.kind ?? "") && !inspectorOpen()}>
        <MobileTransformPad mode={editMode()}
          pose={() => viewportDraft() ?? props.controller.furniturePose(selectedCanonicalId()!)}
          scale={() => viewportScaleDraft() ?? (() => {
            const state = props.controller.furnitureScaleStatus(selectedCanonicalId()!);
            return state.supported ? state.scale : null;
          })()}
          translationSnap={translationSnap()} rotationSnap={rotationSnap()}
          onPreview={previewTouchTransform} onScalePreview={previewTouchScale}
          hapticsEnabled={mobileHapticsEnabled()} onHapticsChange={setMobileHapticsEnabled}
          scaleAvailable={(() => {
            const selected = selectedCanonicalId();
            return selected ? props.controller.furnitureScaleStatus(selected).supported : false;
          })()}
          onModeChange={mode => {
            if (mode === "scale") {
              const state = props.controller.furnitureScaleStatus(selectedCanonicalId()!);
              if (!state.supported) { setActionError(state.reason); tactile("error"); return; }
            }
            setEditMode(mode);
            editSession?.setMode(mode);
            if (mode === "translate") editSession?.setAxisConstraint(null);
            tactile("edit");
          }}
          onApply={applyTouchTransform} onCancel={cancelTouchTransform} />
      </Show>
      <section class="teldra-studio-selection-workspace__viewport">
        <TwinViewport
          manifest={props.manifest}
          glbUrl={props.glbUrl}
          onReady={(handle) => { setViewport(handle); props.onViewportReady?.(handle); }}
          selectedCanonicalId={selectedCanonicalId() ?? null}
          onSelect={selectRenderIdentity}
        />
      </section>

      <aside
        class="teldra-studio-selection-workspace__inspector"
        aria-label="Project selection and device inspector"
      >
        <section id="teldra-scene-panel" class="teldra-studio-selection-workspace__scene-panel" hidden={!sceneOpen()} aria-labelledby="studio-device-list-title">
          <h2 id="studio-device-list-title">Scene</h2>
          <p class="teldra-studio-selection-workspace__hint">Select an item here or in the scene.</p>
          <label class="teldra-studio-selection-workspace__search">Search scene<input type="search" placeholder="Name, type, or ID" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} /></label>
          <h3>Devices <span class="teldra-studio-selection-workspace__count">{devices().length}</span></h3>
          <ul class="teldra-studio-selection-workspace__device-list" aria-label="Devices">
            <For each={devices()}>
              {(device) => (
                <li>
                  <button
                    type="button"
                    aria-pressed={selectedCanonicalId() === device.id}
                    onClick={() => selectCanonicalId(device.id)}
                    onContextMenu={(event) => {if (!window.matchMedia("(max-width: 48rem)").matches) return;event.preventDefault();selectCanonicalId(device.id);openMobileContext();}}
                  >
                    <span>{device.name}</span>
                    <code>{device.id}</code>
                  </button>
                </li>
              )}
            </For>
          </ul>
          <Show when={devices().length === 0}><p class="teldra-studio-selection-workspace__hint">No matching devices.</p></Show>
          <h3>Building <span class="teldra-studio-selection-workspace__count">{buildingRefs().length}</span></h3>
          <ul class="teldra-studio-selection-workspace__device-list" aria-label="Building objects">
            <For each={buildingRefs()}>{(ref) => <li><button type="button" aria-pressed={selectedCanonicalId() === ref.id} onClick={() => selectCanonicalId(ref.id)} onContextMenu={(event) => {if (!window.matchMedia("(max-width: 48rem)").matches) return;event.preventDefault();selectCanonicalId(ref.id);openMobileContext();}}><span>{ref.name ?? ref.kind}</span><small>{ref.kind}</small></button></li>}</For>
          </ul>
          <Show when={buildingRefs().length === 0}><p class="teldra-studio-selection-workspace__hint">No matching building items.</p></Show>
        </section>

        <div id="teldra-object-panel" class="teldra-studio-selection-workspace__properties" hidden={!inspectorOpen()}>
        <Show when={["furniture", "fixture", "other", "distribution-element"].includes(selectedBuildingRef()?.kind ?? "") && selectedBuildingRef()}>{(ref) => <>
          <IfcFurnitureEdit controller={props.controller} canonicalId={ref().id} externalVersion={selectionVersion()} onChange={() => {refreshSelection(); tactile("applied");}}
            onEditingChange={furnitureEditingChanged} onControlsReady={controls => { furnitureControls = controls; }}
            editMode={editMode()} editRequest={editRequest()} viewportDraft={viewportDraft()} viewportScaleDraft={viewportScaleDraft()}
            onSnapChange={(metres, radians) => { setTranslationSnap(metres); setRotationSnap(radians); editSession?.setSnap(metres, radians); }}
            onPreview={(pose) => { if (pose) { editSession?.setPose(pose); setViewportDraft(pose); } else { setViewportDraft(undefined); projectPlacements(); } }}
            onScalePreview={(scale) => { if (scale) { editSession?.setScale(scale); setViewportScaleDraft(scale); } else { setViewportScaleDraft(undefined); projectPlacements(); } }}
            onScaleUnavailable={reason => setTransformMessage("Scale (S) is not available: " + reason)} />
        </>}</Show>

        <section
          class="teldra-studio-selection-workspace__selection"
          aria-labelledby="studio-selection-title"
        >
          <h2 id="studio-selection-title">Selection</h2>
          <Show
            when={selectedCanonicalId()}
            fallback={<p data-testid="workspace-selection-kind">Nothing selected</p>}
          >
            {(selectedId) => (
              <>
                <p>
                  <span>Canonical ID</span>{" "}
                  <code data-testid="workspace-selected-canonical-id">
                    {selectedId()}
                  </code>
                </p>

                <Show when={selectedDevice()}>
                  {(device) => (
                    <p data-testid="workspace-selection-kind">
                      Device: {device().name}
                    </p>
                  )}
                </Show>

                <Show
                  when={!selectedDevice()}
                >
                  <p data-testid="workspace-selection-kind">
                    {selectedBuildingRef() !== undefined
                      ? `Building: ${selectedBuildingRef()?.name ?? selectedBuildingRef()?.kind}`
                      : "Building / scene entity"}
                  </p>
                </Show>
                <Show when={selectedBuildingRef()}>{(ref) => <dl class="teldra-studio-selection-workspace__details">
                  <div><dt>Source name</dt><dd>{ref().name ?? "Unnamed"}</dd></div>
                  <div><dt>Type</dt><dd>{ref().kind}</dd></div>
                  <div><dt>IFC GlobalId</dt><dd><code>{ref().ifcGlobalId}</code></dd></div>
                  <div><dt>Editing</dt><dd>{["furniture", "fixture", "other", "distribution-element"].includes(ref().kind) ? "Furniture placement can be edited below after IFC validation." : "This building item is sourced from IFC."}</dd></div>
                </dl>}</Show>
              </>
            )}
          </Show>
        </section>

        <Show when={selectedDevice()}>
          {(device) => (
            <>
              <ProjectDeviceEditor
                controller={props.controller}
                deviceId={device().id}
                hideProjectActions
                externalVersion={selectionVersion()}
                onChange={refreshSelection}
              />
              <SpatialEdit controller={props.controller} deviceId={device().id} externalVersion={selectionVersion()} hideHistory onChange={refreshSelection} />
              <Show when={props.liveState}>
                {(liveState) => (
                  <SelectedDeviceLiveState
                    controller={liveState()}
                    device={device()}
                  />
                )}
              </Show>
            </>
          )}
        </Show>
        </div>
      </aside>
    </div>
  );
}
