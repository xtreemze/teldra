import { resolveSceneSelection } from "./resolve-scene-selection.js";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { FurnitureEditSession, FurnitureWorldPose, TwinRenderIdentity, FurnitureMeasuredBounds } from "@teldra/runtime-babylon";
import type { FurnitureGeometryScale } from "@teldra/application";
import { ProjectDeviceEditor } from "./ProjectDeviceEditor";
import { IfcFurnitureEdit, type FurnitureEditControls } from "./IfcFurnitureEdit";
import { transformShortcut, numericFurniturePose, numericFurnitureScale, type TransformModal } from "./transform-shortcuts";
import { SelectedDeviceLiveState } from "./SelectedDeviceLiveState";
import { SpatialEdit } from "./SpatialEdit";
import { WallPlanDraft } from "./WallPlanDraft";
import { signalMobileFeedback, signalMobileSound } from "./mobile-feedback";
import { readMobileFeedbackPreferences, writeMobileFeedbackPreferences } from "./mobile-feedback-preferences";
import { MobileTransformPad } from "./MobileTransformPad";
import { MobileSheetHandle, type MobileSheetDetent } from "./MobileSheetHandle";
import { StudioIcon } from "./StudioIcon";
import type { StudioLiveStateController } from "./StudioLiveStateController";
import type { StudioProjectController } from "./StudioProjectController";
import {
  TwinViewport,
  type TwinViewportHandle,
} from "./TwinViewport";
import "./StudioSelectionWorkspace.css";

export interface StudioSelectionWorkspaceProps {
  readonly controller: StudioProjectController;
  readonly saveMode?: "direct" | "download" | undefined;
  readonly manifest: unknown;
  readonly glbUrl: string;
  readonly onExportRebakedScene?: () => Promise<void>;
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
  const [wallDraftOpen, setWallDraftOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [rebaking, setRebaking] = createSignal(false);
  const [actionError, setActionError] = createSignal("");
  const [mobileProjectOpen, setMobileProjectOpen] = createSignal(false);
  const [mobileContextOpen, setMobileContextOpen] = createSignal(false);
  const [sceneDetent, setSceneDetent] = createSignal<MobileSheetDetent>("half");
  const [inspectorDetent, setInspectorDetent] = createSignal<MobileSheetDetent>("half");
  const setMobileDetent = (kind: "scene" | "inspector", detent: MobileSheetDetent) => {
    (kind === "scene" ? setSceneDetent : setInspectorDetent)(detent);
    tactile("menu");
  };
  const closeMobileSheet = (kind: "scene" | "inspector") => {
    if (kind === "scene") setSceneOpen(false);
    else setInspectorOpen(false); // During IFC edits this reveals the existing gesture pad; no cancel.
  };
  const initialFeedback = readMobileFeedbackPreferences();
  const [mobileHapticsEnabled, setMobileHapticsEnabled] = createSignal(initialFeedback.hapticsEnabled);
  const [mobileSoundEnabled, setMobileSoundEnabled] = createSignal(initialFeedback.soundEnabled);
  const setHapticsPreference = (enabled: boolean) => {
    setMobileHapticsEnabled(enabled);
    writeMobileFeedbackPreferences({hapticsEnabled: enabled, soundEnabled: mobileSoundEnabled()});
  };
  const setSoundPreference = (enabled: boolean) => {
    setMobileSoundEnabled(enabled);
    writeMobileFeedbackPreferences({hapticsEnabled: mobileHapticsEnabled(), soundEnabled: enabled});
  };
  const [gestureGuideOpen, setGestureGuideOpen] = createSignal(false);
  const tactile = (kind: "select" | "menu" | "edit" | "applied" | "error") => {
    signalMobileFeedback(kind, mobileHapticsEnabled());
    signalMobileSound(kind, mobileSoundEnabled());
  };
  const [viewport, setViewport] = createSignal<TwinViewportHandle>();
  const [viewportDraft, setViewportDraft] = createSignal<FurnitureWorldPose>();
  const [viewportScaleDraft, setViewportScaleDraft] = createSignal<FurnitureGeometryScale>();
  const [measuredGeometry, setMeasuredGeometry] = createSignal<FurnitureMeasuredBounds>();
  const [measuredGeometryError, setMeasuredGeometryError] = createSignal("");
  const [editingFurniture, setEditingFurniture] = createSignal(false);
  const [editMode, setEditMode] = createSignal<"translate" | "rotate" | "scale">("translate");
  const [translationSnap, setTranslationSnap] = createSignal(0);
  const [rotationSnap, setRotationSnap] = createSignal(0);
  const [editRequest, setEditRequest] = createSignal(0);
  const [transformModal, setTransformModal] = createSignal<TransformModal | null>(null);
  const [transformMessage, setTransformMessage] = createSignal("");
  const [transformPreviewError, setTransformPreviewError] = createSignal("");
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
    selectCanonicalId(resolveSceneSelection(identity,
      props.controller.twin.devices.map(device => device.id),
      props.controller.twin.building.refs));
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
    if (rebaking()) return;
    setSaving(true);
    setActionError("");
    try { await props.controller.save(); refreshSelection(); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  const exportRebake = async () => {
    if (saving() || rebaking() || editingFurniture() || dirty()) {
      setActionError("Save all IFC changes and finish the active transform before rebuilding a copy.");
      return;
    }
    setActionError(""); setRebaking(true);
    try {
      await props.onExportRebakedScene?.();
      setTransformMessage("Rebuilt a separate validated 3D project copy. The open project is unchanged.");
      tactile("applied");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      tactile("error");
    } finally { setRebaking(false); }
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
    setTransformPreviewError("");
    setEditingFurniture(false);
    setViewportDraft(undefined); setViewportScaleDraft(undefined);
    setMeasuredGeometry(undefined); setMeasuredGeometryError("");
    projectPlacements();
  };
  const previewNumericTransform = (modal: TransformModal | null) => {
    if (!modal || !editSession) return;
    try {
      if (modal.mode === "scale") {
        if (!numericStartScale) return;
        const scale = numericFurnitureScale(numericStartScale, modal);
        if (scale || modal.numeric === "") {
          const next = scale ?? numericStartScale;
          editSession.setScale(next);
          setViewportScaleDraft(next);
          setTransformPreviewError("");
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
        setTransformPreviewError("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTransformPreviewError(message);
      setTransformMessage(message);
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
      const placement = props.controller.furniturePlacement(id);
      try {
        const measured = viewport()!.measureFurnitureGeometry(id, placement.original);
        setMeasuredGeometry(measured);
        setMeasuredGeometryError("");
      } catch (error) {
        setMeasuredGeometry(undefined);
        setMeasuredGeometryError(error instanceof Error ? error.message : String(error));
      }
      editSession = viewport()!.beginFurnitureEdit(placement, setViewportDraft,
        undefined, setViewportScaleDraft);
      // IfcFurnitureEdit already rejects unsupported Scale before calling this callback.
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
    // Scale eligibility cannot be known before asynchronous IFC preparation.
    // IfcFurnitureEdit rejects unsupported Scale with an explicit error before opening a session.
    setTransformMessage("");
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
  const handleCanvasGesture = (kind: "menu" | "undo" | "redo" | "frame", identity?: TwinRenderIdentity) => {
    if (kind === "menu") {
      if (!identity || editingFurniture()) return;
      selectRenderIdentity(identity);
      openMobileContext();
      return;
    }
    if (kind === "frame") {
      setTransformMessage("Framed selected object. Double-tap again to reframe.");
      tactile("select");
      return;
    }
    if (editingFurniture() || transformModal() || saving()) {
      setTransformMessage("Apply or cancel the active edit before using gesture history.");
      tactile("error");
      return;
    }
    if (kind === "undo" && !history().canUndo || kind === "redo" && !history().canRedo) {
      setTransformMessage(kind === "undo" ? "Nothing to undo." : "Nothing to redo.");
      tactile("error");
      return;
    }
    changeHistory(kind);
    setTransformMessage(kind === "undo" ? "Undid the last project change." : "Redid the last project change.");
    tactile("applied");
  };
  const openMobileContext = () => {
    if (!selectedCanonicalId() || editingFurniture()) return;
    setMobileProjectOpen(false);
    setMobileContextOpen(true);
    tactile("menu");
  };
  createEffect(() => { selectionVersion(); viewport(); projectPlacements(); });
  createEffect(() => {
    const current = viewport();
    props.controller.setAffineProjectionValidator(current
      ? (id, delta) => current.assertFurnitureAffineProjectable(id, delta)
      : null);
    onCleanup(() => props.controller.setAffineProjectionValidator(null));
  });
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
      setTransformPreviewError("");
      setTransformMessage("");
      return;
    }
    if (step.intent === "preview") {
      setTransformModal(step.state);
      setTransformMessage("");
      previewNumericTransform(step.state);
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
      if (transformPreviewError()) {
        setTransformMessage("Cannot apply this transform: " + transformPreviewError());
        return;
      }
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
    const compact = () => window.matchMedia("(max-width: 48rem)").matches;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (!compact() || event.key !== "Escape" || event.defaultPrevented) return;
      // Project/context menus close before the underlying IFC Escape handler can cancel a draft.
      if (mobileProjectOpen()) setMobileProjectOpen(false);
      else if (mobileContextOpen()) setMobileContextOpen(false);
      else {
        if (editingFurniture()) return; // Editor Escape retains its existing Cancel contract.
        if (sceneOpen()) closeMobileSheet("scene");
        else if (inspectorOpen()) closeMobileSheet("inspector");
        else return;
      }
      event.preventDefault();
      event.stopPropagation();
      workspaceRoot.querySelector<HTMLButtonElement>(editingFurniture()
        ? '[data-testid="mobile-project-trigger"]'
        : '[data-testid="mobile-scene-trigger"]')?.focus();
    };
    const closeOnCanvas = (event: PointerEvent) => {
      if (!compact() || editingFurniture() || !(event.target instanceof HTMLCanvasElement) ||
          !event.target.classList.contains("teldra-twin-viewport__canvas")) return;
      if (sceneOpen()) closeMobileSheet("scene");
      if (inspectorOpen()) closeMobileSheet("inspector");
      if (mobileProjectOpen()) setMobileProjectOpen(false);
      if (mobileContextOpen()) setMobileContextOpen(false);
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keydown", closeOnEscape, true);
    workspaceRoot.addEventListener("pointerdown", closeOnCanvas, true);
    onCleanup(() => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keydown", closeOnEscape, true);
      workspaceRoot.removeEventListener("pointerdown", closeOnCanvas, true);
    });
  });
  onCleanup(stopFurnitureEdit);

  return (
    <div ref={workspaceRoot} class="teldra-studio-selection-workspace">
      <div class="teldra-studio-selection-workspace__mobile-header" role="group" aria-label="Mobile Studio navigation">
        <button type="button" data-testid="mobile-scene-trigger" aria-expanded={sceneOpen()} aria-controls="teldra-scene-panel"
          disabled={editingFurniture()} title={editingFurniture() ? "Apply or cancel the active transform first" : "Browse the scene"}
          onClick={() => {setSceneOpen(!sceneOpen()); setInspectorOpen(false); setMobileProjectOpen(false); setMobileContextOpen(false);}}><StudioIcon name="scene" /> Scene</button>
        <output class="teldra-studio-selection-workspace__mobile-save-state" aria-live="polite">
          <span class="teldra-studio-selection-workspace__save-dot" data-state={dirty() ? "dirty" : "saved"} aria-hidden="true" />
          <span class="teldra-studio-selection-workspace__mobile-save-label">{dirty() ? "Unsaved" : "Saved"}</span>
        </output>
        <Show when={editingFurniture()}><button type="button" aria-expanded={inspectorOpen()} aria-controls="teldra-object-panel"
          onClick={() => setInspectorOpen(!inspectorOpen())}>{inspectorOpen() ? "Gestures" : "Numbers"}</button></Show>
        <button type="button" data-testid="mobile-project-trigger" aria-expanded={mobileProjectOpen()} aria-controls="teldra-mobile-project-menu"
          onClick={() => {setMobileProjectOpen(!mobileProjectOpen()); setMobileContextOpen(false);}}><StudioIcon name="project" /> Project</button>
      </div>
      <Show when={mobileProjectOpen()}>
        <div id="teldra-mobile-project-menu" class="teldra-studio-selection-workspace__mobile-project-menu" role="group" aria-label="Mobile project menu">
          <Show when={props.saveMode === "download"}><p class="teldra-studio-selection-workspace__mobile-save-help">Saving downloads a project copy; it does not overwrite the opened file.</p></Show>
          <button type="button" disabled={!history().canUndo || editingFurniture()} onClick={() => {changeHistory("undo");setMobileProjectOpen(false);}}><StudioIcon name="undo" /> Undo</button>
          <button type="button" disabled={!history().canRedo || editingFurniture()} onClick={() => {changeHistory("redo");setMobileProjectOpen(false);}}><StudioIcon name="redo" /> Redo</button>
          <button type="button" disabled={!dirty() || saving() || rebaking() || editingFurniture()} onClick={() => void save()}><StudioIcon name="save" /> {saving() ? "Saving…" : "Save project"}</button>
          <Show when={props.onExportRebakedScene}>
            <button type="button" title="Download a new IFC-verified 3D project; the current project stays open and unchanged"
              disabled={dirty() || saving() || rebaking() || editingFurniture()}
              onClick={() => void exportRebake()}>
              <StudioIcon name="export" /> {rebaking() ? "Rebuilding 3D…" : "Rebuild 3D copy"}
            </button>
          </Show>
          <button type="button" aria-pressed={mobileHapticsEnabled()} onClick={() => setHapticsPreference(!mobileHapticsEnabled())}>Haptics {mobileHapticsEnabled() ? "on" : "off"}</button>
          <button type="button" aria-pressed={mobileSoundEnabled()} onClick={() => {
            setSoundPreference(!mobileSoundEnabled());
            if (mobileSoundEnabled()) signalMobileSound("select", true);
          }}>Sounds {mobileSoundEnabled() ? "on" : "off"}</button>
          <button type="button" aria-expanded={gestureGuideOpen()} aria-controls="teldra-mobile-gesture-guide"
            onClick={() => setGestureGuideOpen(!gestureGuideOpen())}><StudioIcon name="gesture" /> Touch gesture guide</button>
          <Show when={gestureGuideOpen()}>
            <div id="teldra-mobile-gesture-guide" role="group" aria-label="Mobile touch gesture guide"
              class="teldra-studio-selection-workspace__gesture-guide">
              <p><strong>Navigate:</strong> drag one finger to orbit, two fingers to pan or pinch to zoom.</p>
              <p><strong>Objects:</strong> tap to select, hold to open actions, double-tap the selected item to frame it.</p>
              <p><strong>History:</strong> three fingers swipe left to undo or right to redo. Use Project menu buttons if your device reserves this gesture.</p>
              <p><strong>Editing:</strong> use Move, Rotate, or supported IFC Scale in the dedicated gesture pad. Apply to save the draft; Cancel to discard it.</p>
            </div>
          </Show>
          <Show when={actionError()}><p role="alert">{actionError()}</p></Show>
        </div>
      </Show>
      <div class="teldra-studio-selection-workspace__project-actions" role="group" aria-label="Project actions">
        <button type="button" aria-expanded={sceneOpen()} aria-controls="teldra-scene-panel" onClick={() => {setSceneOpen(!sceneOpen()); if (window.matchMedia("(max-width: 48rem)").matches) setInspectorOpen(false);}}><StudioIcon name="scene" /> Scene</button>
        <button type="button" aria-expanded={inspectorOpen()} aria-controls="teldra-object-panel" onClick={() => {setInspectorOpen(!inspectorOpen()); if (window.matchMedia("(max-width: 48rem)").matches) setSceneOpen(false);}}><StudioIcon name="inspector" /> Inspector</button>
        <output aria-live="polite" data-testid={selectedDevice() ? "project-dirty-state" : undefined}>{dirty() ? "Unsaved changes" : "Saved"}</output>
        <button type="button" disabled={!history().canUndo || editingFurniture()} onClick={() => changeHistory("undo")}><StudioIcon name="undo" /> Undo</button>
        <button type="button" disabled={!history().canRedo || editingFurniture()} onClick={() => changeHistory("redo")}><StudioIcon name="redo" /> Redo</button>
        <button type="button" disabled={!dirty() || saving() || rebaking() || editingFurniture()} onClick={() => void save()}><StudioIcon name="save" /> {saving() ? "Saving…" : "Save project"}</button>
        <Show when={props.onExportRebakedScene}>
          <button type="button" title="Download a validated rebuilt .teldra copy without replacing this open project"
            disabled={dirty() || saving() || rebaking() || editingFurniture()}
            onClick={() => void exportRebake()}>
            <StudioIcon name="export" /> {rebaking() ? "Rebuilding 3D…" : "Rebuild 3D copy"}
          </button>
        </Show>
        <Show when={["furniture", "fixture", "other", "distribution-element"].includes(selectedBuildingRef()?.kind ?? "")}>
          <Show when={!editingFurniture()} fallback={
            <div class="teldra-studio-selection-workspace__gizmo" role="group" aria-label="Furniture manipulation mode">
              <button type="button" aria-keyshortcuts="G" title="Move (G)" aria-pressed={editMode() === "translate"} onClick={() => { setEditMode("translate"); editSession?.setMode("translate"); editSession?.setAxisConstraint(null); }}><StudioIcon name="move" /> Move</button>
              <button type="button" aria-keyshortcuts="R" title="Rotate about IFC world Z (R)" aria-pressed={editMode() === "rotate"} onClick={() => { setEditMode("rotate"); editSession?.setMode("rotate"); }}><StudioIcon name="rotate" /> Rotate</button>
              <button type="button" aria-keyshortcuts="S" aria-pressed={editMode() === "scale"}
                disabled={!props.controller.furnitureScaleStatus(selectedCanonicalId()!).supported}
                title={(() => { const support = props.controller.furnitureScaleStatus(selectedCanonicalId()!);
                  return support.supported ? "Local IFC geometry scale (S)" : support.reason; })()}
                onClick={() => { setEditMode("scale"); editSession?.setMode("scale"); }}><StudioIcon name="scale" /> Scale</button>
            </div>
          }>
            <div class="teldra-studio-selection-workspace__gizmo" role="group" aria-label="Start IFC furniture transform">
              <button type="button" aria-keyshortcuts="G" disabled={!viewport()}
                title={viewport() ? "Move selected furniture with a 3D gizmo or precise numeric coordinates (G)" : "3D scene is still loading"}
                onClick={() => startMobileFurnitureEdit("translate")}><StudioIcon name="move" /> Move</button>
              <button type="button" aria-keyshortcuts="R" disabled={!viewport()}
                title={viewport() ? "Rotate selected furniture around its vertical axis (R)" : "3D scene is still loading"}
                onClick={() => startMobileFurnitureEdit("rotate")}><StudioIcon name="rotate" /> Rotate</button>
              <button type="button" aria-keyshortcuts="S" disabled={!viewport()}
                title="Check IFC-backed scale eligibility and edit dimensions (S)"
                onClick={() => startMobileFurnitureEdit("scale")}><StudioIcon name="scale" /> Scale</button>
            </div>
          </Show>
        </Show>
        <Show when={selectedCanonicalId() && !selectedDevice() && !["furniture", "fixture", "other", "distribution-element"].includes(selectedBuildingRef()?.kind ?? "")}>
          <span class="teldra-studio-selection-workspace__hint" role="status">The selected scene element {selectedBuildingRef()?.kind ? `(${selectedBuildingRef()?.kind})` : ""} has no supported IFC furniture transform. Wall, floor and opening creation or modification is not yet supported; no mesh-only changes will be saved.</span>
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
            <button type="button" disabled={!viewport()} onClick={() => startMobileFurnitureEdit("translate")}><StudioIcon name="move" /> Move</button>
            <button type="button" disabled={!viewport()} onClick={() => startMobileFurnitureEdit("rotate")}><StudioIcon name="rotate" /> Rotate</button>
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
            <button type="button" disabled={!viewport()} onClick={() => startMobileFurnitureEdit("translate")}><StudioIcon name="move" /> Move</button>
            <button type="button" disabled={!viewport()} onClick={() => startMobileFurnitureEdit("rotate")}><StudioIcon name="rotate" /> Rotate</button>
            <button type="button" aria-describedby="teldra-mobile-scale-explanation"
              title="Validate mapped IFC geometry for scaling"
              onClick={() => startMobileFurnitureEdit("scale")}><StudioIcon name="scale" /> Scale</button>
            <p id="teldra-mobile-scale-explanation" class="teldra-studio-selection-workspace__mobile-scale-unavailable">
              Scale is validated against IFC geometry before editing.
            </p>
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
          hapticsEnabled={mobileHapticsEnabled()} onHapticsChange={setHapticsPreference}
          soundEnabled={mobileSoundEnabled()} onSoundChange={setSoundPreference}
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
          gesturesDisabled={editingFurniture() || Boolean(transformModal()) || saving() || mobileContextOpen()}
          onTouchGesture={handleCanvasGesture}
        />
      </section>

      <aside
        class="teldra-studio-selection-workspace__inspector"
        aria-label="Project selection and device inspector"
      >
        <section id="teldra-scene-panel" class="teldra-studio-selection-workspace__scene-panel"
          classList={{"teldra-studio-selection-workspace__scene-panel--drafting": wallDraftOpen()}} hidden={!sceneOpen()}
          data-mobile-detent={sceneDetent()} aria-labelledby="studio-device-list-title">
          <MobileSheetHandle label="Scene" detent={sceneDetent()}
            onDetentChange={next => setMobileDetent("scene", next)} onClose={() => closeMobileSheet("scene")} />
          <h2 id="studio-device-list-title">Scene</h2>
          <button type="button" aria-expanded={wallDraftOpen()} aria-controls="teldra-wall-draft-panel"
            title="Draw a precision CAD wall draft. IFC Apply is not yet available."
            onClick={() => setWallDraftOpen(value => !value)}>Wall draft (2D)</button>
          <Show when={wallDraftOpen()}>
            <div id="teldra-wall-draft-panel" class="teldra-studio-selection-workspace__wall-draft">
              <WallPlanDraft currentRevision={() => props.controller.revision} />
            </div>
          </Show>
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

        <div id="teldra-object-panel" class="teldra-studio-selection-workspace__properties" hidden={!inspectorOpen()}
          data-mobile-detent={inspectorDetent()}>
        <MobileSheetHandle label="Inspector" detent={inspectorDetent()}
          onDetentChange={next => setMobileDetent("inspector", next)} onClose={() => closeMobileSheet("inspector")} />
        <Show when={["furniture", "fixture", "other", "distribution-element"].includes(selectedBuildingRef()?.kind ?? "") && selectedBuildingRef()}>{(ref) => <>
          <IfcFurnitureEdit controller={props.controller} canonicalId={ref().id} externalVersion={selectionVersion()} onChange={() => {refreshSelection(); tactile("applied");}}
            onEditingChange={furnitureEditingChanged} onControlsReady={controls => { furnitureControls = controls; }}
            editMode={editMode()} editRequest={editRequest()} viewportDraft={viewportDraft()} viewportScaleDraft={viewportScaleDraft()}
            measuredGeometry={measuredGeometry()} measuredGeometryError={measuredGeometryError()}
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
