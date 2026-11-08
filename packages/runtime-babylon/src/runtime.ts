import { Camera } from "@babylonjs/core/Cameras/camera";
import { cameraState, orientCamera, syncProjection, zoomCamera, panCamera, fitCamera, syncCameraDepth, isMeshInteractable, stopCameraMotion, OneShotLoad, SceneLayers, type ViewState, type ViewDirection, type ViewProjection } from "./view-controls.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Material } from "@babylonjs/core/Materials/material";
import { SelectionOutline } from "./selection-outline.js";
import { applySourceLighting, assignSourceLights, applySourceLightPlacements } from "./source-lighting.js";
import { sourceMaterialProjection } from "./source-material.js";
import { applyPreviewShadowDetail, SH3D_EDITING_SHADOW_DETAIL } from "./preview-shadow-detail.js";
import { FloorTextureInspector } from "./floor-texture-inspector.js";
import { FloorMinificationInspector, type FloorMinificationMode } from "./floor-minification-inspector.js";
import { clientToFramebufferPixel, describeSurfacePick, normalizeGpuRgb, inspectGpuMips, type SurfaceProbe, type GpuFloorEvidence } from "./surface-probe.js";
import { furnitureSceneDelta, FurnitureGizmoBridge, type FurnitureEditSession, type FurniturePlacement, type FurnitureWorldPose, type ScenePlacement } from "./furniture-gizmo.js";
import type { FurnitureMeasuredBounds } from "./furniture-bounds.js";
import { createMeshBatch, type BatchPart, type MeshBatch } from "./mesh-batching.js";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import {
  parseSceneManifest,
  type TeldraSceneManifest,
} from "@teldra/scene-manifest";
import {
  BabylonIdentityError,
  indexSceneManifest,
  resolveTwinIdentity,
  type TwinRenderIdentity,
} from "./identity.js";

export type BabylonBackend = "webgpu" | "webgl";

export interface BabylonClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

export type GpuFloorInspection = GpuFloorEvidence & {
  readonly surface?: SurfaceProbe | null;
  readonly mipAvailability?: "allocated" | "inferred";
  readonly mipAvailabilityError?: string;
  readonly capture?: {
    readonly backend: BabylonBackend;
    readonly framebufferFormat: string;
    readonly pixel: readonly [number, number];
    readonly renderSize: readonly [number, number];
    readonly camera: ViewState | null;
    readonly floorMinification: FloorMinificationMode;
    readonly floorTextureInspection: boolean;
    readonly lightGain: number;
    readonly shadowDetail: number;
    readonly declaredSceneSha256: string;
    readonly declaredBuildingSha256: string;
    readonly textureSrgbStorage: boolean | null;
  };
};

export interface BabylonTwinRuntime {
  readonly backend: BabylonBackend;
  readonly manifest: TeldraSceneManifest;
  assetSummary(): { meshParts: number; visibleMeshParts: number; hiddenSourceParts: number; sourcePhongMaterials: number; textures: number; texturesReady: boolean; lightingProfile: string; localLightSources: number; roomTexturedParts: number; roomTexturesBound: number; roomTexturesReady: number; floorTextureSamplerCount: number; floorInspectionMaterials: number; floorUnlitMaterials: number; activeGroundMeshes: number };
  renderStats(): { backend: BabylonBackend; reverseDepth: boolean; nearPlane: number; farPlane: number; width: number; height: number; hardwareScaling: number; fps: number; activeMeshes: number; drawCalls: number; sampleCount: number; cpuFrameMsP50: number | null; cpuFrameMsP95: number | null };
  batchingStats(): { eligibleParts: number; candidateGroups: number; possibleDrawCallReduction: number; sameCanonicalPotentialReduction: number };
  applyScenePlacements(placements: readonly ScenePlacement[]): void;
  /** Exact indexed triangle extents in the original IFC local axes. */
  measureFurnitureGeometry(canonicalId: string, original: FurnitureWorldPose): FurnitureMeasuredBounds;
  /** Pure preflight: no canonical IFC change or scene mutation. */
  assertFurnitureAffineProjectable(canonicalId: string, canonicalDelta: readonly number[]): void;
  beginFurnitureEdit(placement: FurniturePlacement, onPreview: (pose: FurnitureWorldPose) => void,
    onDragState?: (dragging: boolean) => void, onScalePreview?: (scale: import("./furniture-gizmo.js").GeometryScale) => void): FurnitureEditSession;
  setHiddenSourceContentVisible(visible: boolean): void;
  layers(): ReturnType<SceneLayers["list"]>;
  setLayerVisible(id: string, visible: boolean): void;
  viewState(): ViewState | null;
  onViewChanged(listener: (state: ViewState) => void): () => void;
  orient(direction: ViewDirection): void;
  orbit(horizontal: number, vertical: number): void;
  setProjection(projection: ViewProjection): void;
  zoom(factor: number): void;
  pan(right: number, up: number): void;
  fit(canonicalId?: string): boolean;
  resetView(): void;
  fitHome(): boolean;
  appearance(): {texturesEnabled: boolean; lightGain: number; shadowDetail: number; floorTextureInspection: boolean; floorMinification: FloorMinificationMode};
  setAppearance(settings: {texturesEnabled?: boolean; lightGain?: number; shadowDetail?: number; floorTextureInspection?: boolean; floorMinification?: FloorMinificationMode}): void;
  load(glbUrl: string): Promise<void>;
  projectNode(nodeKey: string): BabylonClientPoint | null;
  setSelection(canonicalId: string | null): void;
  pick(clientX: number, clientY: number): TwinRenderIdentity | null;
  inspectSurfaceAt(clientX: number, clientY: number): SurfaceProbe | null;
  inspectGpuAt(clientX: number, clientY: number): Promise<GpuFloorInspection>;
  onPick(listener: (identity: TwinRenderIdentity | null) => void): () => void;
  start(): void;
  stop(): void;
  resize(): void;
  dispose(): void;
}

export interface BabylonTwinRuntimeOptions {
  antialias?: boolean;
  attachDefaultCamera?: boolean;
  /** Experimental: merge compatible opaque parts while preserving face identity. */
  batchOpaqueParts?: boolean;
  /** Diagnosis: bypass WebGPU selection without mutating scene or project data. */
  forceWebGL?: boolean;
  /** Auto: reversed Z on WebGPU, standard Z on WebGL. Override to compare. */
  depthMode?: "auto" | "reverse" | "standard";
}

let loadersRegistered = false;

export async function createBabylonTwinRuntime(
  canvas: HTMLCanvasElement,
  manifestInput: unknown,
  options: BabylonTwinRuntimeOptions = {},
): Promise<BabylonTwinRuntime> {
  const manifest = parseSceneManifest(manifestInput);
  const manifestByNodeKey = indexSceneManifest(manifest);
  const identityByMesh = new WeakMap<AbstractMesh, TwinRenderIdentity>();
  const meshByNodeKey = new Map<string, AbstractMesh>();
  const meshesByCanonicalId = new Map<string, AbstractMesh[]>();
  const { engine, backend, framebufferFormat } = await createEngine(
    canvas,
    options.antialias ?? true,
    options.forceWebGL ?? false,
    options.depthMode ?? "auto",
  );
  const scene = new Scene(engine);
  const instrumentation = new SceneInstrumentation(scene);
  const selectionOutline = new SelectionOutline(scene);
  let selectionId: string | null = null;
  scene.useRightHandedSystem = true;

  const normalizeCanvasTabOrder = () => {
    if (canvas.tabIndex > 0) {
      canvas.tabIndex = 0;
    }
  };
  const tabIndexObserver = new MutationObserver(normalizeCanvasTabOrder);
  tabIndexObserver.observe(canvas, {
    attributes: true,
    attributeFilter: ["tabindex"],
  });

  let defaultCamera: ArcRotateCamera | undefined;
  // Canvas navigation follows Blender when a middle mouse button is available.
  let releaseBlenderPointer: (() => void) | undefined;
  let loadedMeshParts = 0;
  let lightingProfile = "preview";
  let previewLight: HemisphericLight | undefined;
  const sourceMaterials = new Map<Material, Material>();
  const sourceHiddenMeshes = new Set<AbstractMesh>();
  let layers = new SceneLayers();
  const loadGate = new OneShotLoad();
  let renderMeshes: AbstractMesh[] = [];
  const lightBases = new Map<import("@babylonjs/core/Lights/light").Light, number>();
  let texturesEnabled = true, lightGain = 1, shadowDetail = 0, floorTextureInspection = false;
  // Preserve original renderer materials while giving floor imagery a genuine
  // emissive, light-independent inspection path.
  const floorInspector = new FloorTextureInspector();
  const floorMinification = new FloorMinificationInspector(engine.getCaps().maxAnisotropy ?? 1);
  const materialTextures = new Map<Material, BaseTexture | null>();

  let physicalMeshes: AbstractMesh[] = [];
  const batchesByMesh = new Map<AbstractMesh, MeshBatch>();
  const batchByPart = new Map<AbstractMesh, MeshBatch>();
  const furniture = new FurnitureGizmoBridge(scene, Matrix.FromArray(manifest.scene.canonicalToScene),
    id => meshesByCanonicalId.get(id) ?? []);
  let projectedPlacementIds = new Set<string>();
  let committedPlacements: readonly ScenePlacement[] = [];
  const viewListeners = new Set<(state: ViewState) => void>();
  const pickSubscriptions = new Set<() => void>();
  const pendingGpuProbes = new Set<() => void>();
  let disposed = false;
  let started = false;
  let loading = false;
  const frameSamples: number[] = [];
  const renderFrame = () => {
    const start = performance.now();
    selectionOutline.update(selectionId ? meshesByCanonicalId.get(selectionId) ?? [] : []);
    scene.render();
    frameSamples.push(performance.now() - start);
    if (frameSamples.length > 120) frameSamples.shift();
  };
  let lastView = "";
  scene.onBeforeRenderObservable.add(() => {
    if (defaultCamera) {
      syncCameraDepth(defaultCamera);
      syncProjection(defaultCamera, engine.getRenderWidth() / engine.getRenderHeight());
    }
  });
  scene.onAfterRenderObservable.add(() => {
    if (!defaultCamera || !viewListeners.size) return;
    const state = cameraState(defaultCamera);
    const key = JSON.stringify([state.alpha, state.beta, state.radius, state.target, state.projection]);
    if (key !== lastView) { lastView = key; for (const listener of viewListeners) listener(state); }
  });

  if (options.attachDefaultCamera ?? true) {
    defaultCamera = new ArcRotateCamera(
      "teldra-camera",
      -Math.PI / 2,
      Math.PI / 3,
      8,
      Vector3.Zero(),
      scene,
    );
    scene.activeCamera = defaultCamera;
    scene.cameraToUseForPointers = defaultCamera;
    // Preserve left orbit / right pan and touch gestures. Babylon's pointer
    // input does not reliably recognize MMB on every target, so own only that
    // button here, using the same camera, without a parallel navigation model.
    defaultCamera.attachControl(canvas, true, false);
    const pointers = defaultCamera.inputs.attached.pointers as {buttons: number[]} | undefined;
    if (pointers) pointers.buttons = [0, 2];
    let middle: {id: number; x: number; y: number; pan: boolean} | null = null;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 1 || middle) return;
      middle = {id: event.pointerId, x: event.clientX, y: event.clientY, pan: event.shiftKey};
      stopCameraMotion(defaultCamera!);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMove = (event: PointerEvent) => {
      if (!middle || event.pointerId !== middle.id) return;
      const dx = event.clientX - middle.x, dy = event.clientY - middle.y;
      middle.x = event.clientX; middle.y = event.clientY;
      const camera = defaultCamera!;
      if (middle.pan) panCamera(camera, -dx / 150, dy / 150);
      else {
        stopCameraMotion(camera);
        camera.alpha -= dx / 200;
        camera.beta = Math.max(camera.lowerBetaLimit ?? 0.001,
          Math.min(camera.upperBetaLimit ?? Math.PI - 0.001, camera.beta + dy / 200));
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onUp = (event: PointerEvent) => {
      if (!middle || event.pointerId !== middle.id) return;
      middle = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const preventMiddleAutoscroll = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };
    const cancelMiddle = () => { middle = null; };
    canvas.addEventListener("pointerdown", onDown, true);
    canvas.addEventListener("mousedown", preventMiddleAutoscroll, true);
    canvas.addEventListener("auxclick", preventMiddleAutoscroll, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("blur", cancelMiddle);
    releaseBlenderPointer = () => {
      canvas.removeEventListener("pointerdown", onDown, true);
      canvas.removeEventListener("mousedown", preventMiddleAutoscroll, true);
      canvas.removeEventListener("auxclick", preventMiddleAutoscroll, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("blur", cancelMiddle);
    };
    normalizeCanvasTabOrder();
    defaultCamera.lowerRadiusLimit = 0.01;
    defaultCamera.lowerBetaLimit = 0.001;
    defaultCamera.upperBetaLimit = Math.PI - 0.001;
    defaultCamera.wheelDeltaPercentage = 0.1;
    defaultCamera.pinchDeltaPercentage = 0.01;
    defaultCamera.panningSensibility = 100;
    defaultCamera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");

    previewLight = new HemisphericLight(
      "teldra-preview-light",
      new Vector3(0, 1, 0),
      scene,
    );
  }

  ensureLoadersRegistered();

  const resolvePickedMesh = (
    pickedMesh: AbstractMesh | null | undefined,
    faceId = -1,
  ): TwinRenderIdentity | null => {
    if (pickedMesh === null || pickedMesh === undefined) {
      return null;
    }

    const batch = batchesByMesh.get(pickedMesh);
    if (batch) return batch.identityForFace(faceId);
    return (
      identityByMesh.get(pickedMesh) ??
      resolveTwinIdentity(pickedMesh, manifestByNodeKey)
    );
  };

  const pickAtClient = (
    clientX: number,
    clientY: number,
  ): TwinRenderIdentity | null => {
    const rect = canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      localX < 0 ||
      localY < 0 ||
      localX > rect.width ||
      localY > rect.height
    ) {
      return null;
    }

    const picked = scene.pick(
        localX,
        localY,
        (mesh) => isMeshInteractable(mesh) && identityByMesh.has(mesh),
        false,
        scene.cameraToUseForPointers ?? undefined,
      );
    return resolvePickedMesh(picked?.pickedMesh, picked?.faceId);
  };

  const projectNodeToClient = (
    nodeKey: string,
  ): BabylonClientPoint | null => {
    const mesh = meshByNodeKey.get(nodeKey);
    const camera = scene.cameraToUseForPointers ?? scene.activeCamera;
    const rect = canvas.getBoundingClientRect();

    if (
      mesh === undefined ||
      camera === null ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }

    mesh.computeWorldMatrix(true);

    // First establish a real surface point using a world-space ray. This
    // separates mesh/CPU-picking readiness from screen-coordinate conversion.
    const sourceCenter = mesh.getBoundingInfo().boundingSphere.centerWorld;
    const batch = batchByPart.get(mesh);
    const center = batch ? Vector3.TransformCoordinates(sourceCenter, batch.mesh.computeWorldMatrix(true)) : sourceCenter;
    const origin = camera.globalPosition;
    const direction = center.subtract(origin);
    if (direction.lengthSquared() <= Number.EPSILON) {
      return null;
    }
    direction.normalize();

    const surfacePick = scene.pickWithRay(
      new Ray(origin, direction),
      (candidate) => isMeshInteractable(candidate) && (identityByMesh.get(candidate)?.nodeKey === nodeKey ||
        batchesByMesh.get(candidate)?.parts.some(part => part.identity.nodeKey === nodeKey) === true),
      false,
    );
    const surfacePoint = surfacePick?.pickedPoint;

    if (surfacePoint === null || surfacePoint === undefined) {
      return null;
    }
    if (resolvePickedMesh(surfacePick?.pickedMesh, surfacePick?.faceId)?.nodeKey !== nodeKey) return null;

    const renderWidth = engine.getRenderWidth();
    const renderHeight = engine.getRenderHeight();
    const viewport = camera.viewport.toGlobal(renderWidth, renderHeight);
    const projected = Vector3.Project(
      surfacePoint,
      Matrix.Identity(),
      scene.getTransformMatrix(),
      viewport,
    );

    if (projected.z < 0 || projected.z > 1) {
      return null;
    }

    const hardwareScaling = engine.getHardwareScalingLevel();
    const point = {
      clientX: rect.left + projected.x * hardwareScaling,
      clientY: rect.top + projected.y * hardwareScaling,
    };

    return pickAtClient(point.clientX, point.clientY)?.nodeKey === nodeKey
      ? point
      : null;
  };

  return {
    backend,
    manifest,
    batchingStats() {
      const groups = new Map<string, number>();
      const canonicalGroups = new Map<string, number>();
      let eligibleParts = 0;
      for (const mesh of renderMeshes) {
        const identity = identityByMesh.get(mesh);
        const material = mesh.material;
        if (!identity || !mesh.isEnabled() || !mesh.isVisible || !material ||
          mesh.skeleton || mesh.morphTargetManager || mesh.getClassName() !== "Mesh" ||
          mesh.subMeshes.length !== 1 || material.needAlphaBlendingForMesh(mesh) || material.needAlphaTesting()) continue;
        const source = mesh.metadata?.gltf?.extras?.teldraSourceLayer;
        const key = JSON.stringify([identity.canonicalId, identity.nodeKey, material.uniqueId,
          source?.levelId ?? null, sourceHiddenMeshes.has(mesh)]);
        groups.set(key, (groups.get(key) ?? 0) + 1);
        const canonicalKey = JSON.stringify([identity.canonicalId, material.uniqueId, source?.levelId ?? null, sourceHiddenMeshes.has(mesh)]);
        canonicalGroups.set(canonicalKey, (canonicalGroups.get(canonicalKey) ?? 0) + 1);
        eligibleParts++;
      }
      const candidates = [...groups.values()].filter(count => count > 1);
      return {eligibleParts, candidateGroups: candidates.length,
        possibleDrawCallReduction: candidates.reduce((total, count) => total + count - 1, 0),
        sameCanonicalPotentialReduction: [...canonicalGroups.values()].reduce((total, count) => total + Math.max(0, count - 1), 0)};
    },
    measureFurnitureGeometry(canonicalId, original) {
      return furniture.measureSourceGeometry(canonicalId, original);
    },
    assertFurnitureAffineProjectable(canonicalId, canonicalDelta) {
      furniture.assertAffineProjectable(canonicalId, canonicalDelta);
    },
    applyScenePlacements(placements) {
      for (const placement of placements) {
        if (!meshesByCanonicalId.has(placement.canonicalId)) {
          throw new Error(`No render parts for ${placement.canonicalId}.`);
        }
        if (placement.matrix.length !== 16 || !placement.matrix.every(Number.isFinite) ||
          Math.abs(Matrix.FromArray(placement.matrix).determinant()) < 1e-12) throw new Error("Invalid scene placement matrix.");
      }
      const next = new Set(placements.map(placement => placement.canonicalId));
      for (const id of projectedPlacementIds) if (!next.has(id)) furniture.applyMatrix({canonicalId: id, matrix: Matrix.Identity().asArray()});
      for (const placement of placements) furniture.applyMatrix(placement);
      projectedPlacementIds = next;
      committedPlacements = placements;
      applySourceLightPlacements(scene, placements, Matrix.FromArray(manifest.scene.canonicalToScene));
      assignSourceLights(scene, physicalMeshes);
    },
    beginFurnitureEdit(placement, onPreview, onDragState, onScalePreview) {
      const frame=Matrix.FromArray(manifest.scene.canonicalToScene);
      let draftPose=placement.current, draftScale=placement.currentScale ?? [1,1,1] as const;
      const updateLights=()=>{
        const ratio=placement.sourceScale ? draftScale.map((value,i)=>value/placement.sourceScale![i]!) as [number,number,number] : [1,1,1] as const;
        const delta=furnitureSceneDelta(Matrix.Identity(),placement.original,draftPose,ratio).asArray();
        applySourceLightPlacements(scene,[...committedPlacements.filter(item=>item.canonicalId!==placement.canonicalId),{canonicalId:placement.canonicalId,matrix:delta}],frame);
      };
      const session=furniture.begin(placement, pose=>{draftPose=pose;updateLights();onPreview(pose);},
        dragging=>{if(!dragging)assignSourceLights(scene,physicalMeshes);onDragState?.(dragging);},
        scale=>{draftScale=scale;updateLights();onScalePreview?.(scale);});
      return {...session,setPose(pose){session.setPose(pose);draftPose=pose;updateLights();},
        setScale(scale){session.setScale(scale);draftScale=scale;updateLights();},
        cancel(){session.cancel();applySourceLightPlacements(scene,committedPlacements,frame);assignSourceLights(scene,physicalMeshes);}};
    },
    renderStats() {
      const sorted = [...frameSamples].sort((a, b) => a - b);
      const percentile = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1]! : null;
      return { backend, reverseDepth: engine.useReverseDepthBuffer,
        nearPlane: defaultCamera?.minZ ?? 0, farPlane: defaultCamera?.maxZ ?? 0,
        width: engine.getRenderWidth(), height: engine.getRenderHeight(),
        hardwareScaling: engine.getHardwareScalingLevel(), fps: engine.getFps(),
        activeMeshes: scene.getActiveMeshes().length, drawCalls: instrumentation.drawCallsCounter.current,
        sampleCount: sorted.length, cpuFrameMsP50: percentile(0.5), cpuFrameMsP95: percentile(0.95) };
    },
    assetSummary() {
      // Report the actual post-GLB, post-Phong-projection state on room surfaces.
      // This distinguishes embedded/ready images from a texture successfully bound
      // to the StandardMaterial currently rendered by Babylon.
      const roomTexturedParts = renderMeshes.filter(mesh => {
        const id = identityByMesh.get(mesh)?.canonicalId ?? "";
        return /^(sh3d:)?room:/.test(id) &&
          typeof mesh.material?.metadata?.gltf?.extras?.teldraSourceMaterial?.map_Kd === "string";
      });
      const roomTexturesBound = roomTexturedParts.filter(mesh =>
        mesh.material instanceof StandardMaterial && mesh.material.diffuseTexture !== null);
      return {
        roomTexturedParts: roomTexturedParts.length,
        roomTexturesBound: roomTexturesBound.length,
        roomTexturesReady: roomTexturesBound.filter(mesh =>
          (mesh.material as StandardMaterial).diffuseTexture?.isReady() === true).length,
        floorTextureSamplerCount: floorMinification.textureCount,
        floorInspectionMaterials: floorInspector.materialCount,
        floorUnlitMaterials: floorInspector.activeCount,
        // Include merged/batched physical meshes, not just unbatched source parts:
        // a visible coplanar ground plane can occlude valid room textures.
        activeGroundMeshes: physicalMeshes.filter(mesh =>
          mesh.isEnabled() && mesh.isVisible &&
          identityByMesh.get(mesh)?.canonicalId === "presentation:sh3d-visual").length,
        lightingProfile,
        localLightSources: scene.lights.filter(light=>light.name.startsWith("sh3d-local-")).length,
        meshParts: loadedMeshParts,
        visibleMeshParts: renderMeshes.filter(mesh => layers.isVisible(mesh)).length,
        hiddenSourceParts: sourceHiddenMeshes.size,
        sourcePhongMaterials: new Set([...sourceMaterials]
          .filter(([source, projected]) => source !== projected)
          .map(([source]) => source.metadata?.gltf?.extras?.teldraSourceMaterial?.materialKey ?? source.uniqueId)).size,
        textures: scene.textures.length,
        texturesReady: scene.textures.every(texture => texture.isReady()),
      };
    },
    setHiddenSourceContentVisible(visible: boolean) {
      layers.setHiddenVisible(visible);
    },

    layers: () => layers.list(),
    setLayerVisible: (id, visible) => layers.setVisible(id, visible),
    viewState: () => defaultCamera ? cameraState(defaultCamera) : null,
    onViewChanged(listener) {
      viewListeners.add(listener);
      if (defaultCamera) listener(cameraState(defaultCamera));
      return () => { viewListeners.delete(listener); };
    },
    orbit(horizontal, vertical) {
      if (!defaultCamera) return;
      stopCameraMotion(defaultCamera);
      defaultCamera.alpha += horizontal;
      defaultCamera.beta = Math.max(0.001, Math.min(Math.PI - 0.001, defaultCamera.beta + vertical));
    },
    orient(direction) { if (defaultCamera) orientCamera(defaultCamera, direction); },
    setProjection(projection) {
      if (defaultCamera) defaultCamera.mode = projection === "orthographic" ? Camera.ORTHOGRAPHIC_CAMERA : Camera.PERSPECTIVE_CAMERA;
    },
    zoom(factor) { if (defaultCamera) zoomCamera(defaultCamera, factor); },
    pan(right, up) { if (defaultCamera) panCamera(defaultCamera, right, up); },
    fit(canonicalId) {
      return defaultCamera ? fitCamera(defaultCamera, physicalMeshes.filter(mesh =>
        !canonicalId || identityByMesh.get(mesh)?.canonicalId === canonicalId)) : false;
    },
    fitHome() {
      if (!defaultCamera) return false;
      const home = physicalMeshes.filter(mesh => {
        const id = identityByMesh.get(mesh)?.canonicalId ?? "";
        return /^(sh3d:)?(pieceOfFurniture|furniture|shelfUnit|room|space|light|fixture):/.test(id);
      });
      return fitCamera(defaultCamera, home.length ? home : physicalMeshes);
    },
    appearance: () => ({texturesEnabled, lightGain, shadowDetail, floorTextureInspection, floorMinification: floorMinification.currentMode}),
    setAppearance(settings) {
      if (settings.floorMinification !== undefined) floorMinification.setMode(settings.floorMinification);
      if (settings.floorTextureInspection === true && !texturesEnabled &&
          settings.texturesEnabled !== true) {
        throw new Error("Enable textures before inspecting floor images.");
      }
      if (settings.texturesEnabled === false) {
        floorInspector.setEnabled(false);
        floorTextureInspection = false;
      }
      if (settings.floorTextureInspection !== undefined && settings.texturesEnabled !== false) {
        floorInspector.setEnabled(settings.floorTextureInspection);
        floorTextureInspection = settings.floorTextureInspection;
      }
      if (settings.shadowDetail !== undefined) {
        applyPreviewShadowDetail(scene, settings.shadowDetail);
        shadowDetail = settings.shadowDetail;
      }
      if (settings.lightGain !== undefined) {
        if (!Number.isFinite(settings.lightGain) || settings.lightGain < 0.25 || settings.lightGain > 2) throw new Error("Light gain must be between 0.25 and 2.");
        lightGain = settings.lightGain;
        for (const light of scene.lights) { const base = lightBases.get(light) ?? light.intensity; lightBases.set(light, base); light.intensity = base * lightGain; }
      }
      if (settings.texturesEnabled !== undefined) {
        texturesEnabled = settings.texturesEnabled;
        for (const mesh of physicalMeshes) {
          const material = mesh.material;
          if (material instanceof StandardMaterial) {
            if (!materialTextures.has(material)) materialTextures.set(material, material.diffuseTexture);
            material.diffuseTexture = texturesEnabled ? materialTextures.get(material)! : null;
          } else if (material instanceof PBRMaterial) {
            if (!materialTextures.has(material)) materialTextures.set(material, material.albedoTexture);
            material.albedoTexture = texturesEnabled ? materialTextures.get(material)! : null;
          }
        }
      }
    },
    resetView() {
      if (!defaultCamera) return;
      defaultCamera.mode = Camera.PERSPECTIVE_CAMERA;
      orientCamera(defaultCamera, "isometric");
      fitCamera(defaultCamera, physicalMeshes);
    },
    async load(glbUrl: string): Promise<void> {
      if (disposed) throw new Error("Cannot load a disposed Babylon runtime.");
      loadGate.begin();
      for (const cancel of pendingGpuProbes) cancel();
      loading = true;
      if (started) engine.stopRenderLoop();
      let container: Awaited<ReturnType<typeof LoadAssetContainerAsync>> | undefined;
      const stagedMaterials = new Map<Material, Material>();
      const stagedHidden = new Set<AbstractMesh>();
      const stagedLayers = new SceneLayers();
      const stagedIdentities = new Map<AbstractMesh, TwinRenderIdentity>();
      const stagedBatches: MeshBatch[] = [];
      const initialLights = new Set(scene.lights);
      const initialAmbient = scene.ambientColor.clone();
      const initialClear = scene.clearColor.clone();
      try {
        container = glbUrl.startsWith("blob:")
          ? await LoadAssetContainerAsync(glbUrl, scene, {
              pluginExtension: ".glb",
            })
          : await LoadAssetContainerAsync(glbUrl, scene);
        if (disposed) {
          throw new Error("Cannot load a disposed Babylon runtime.");
        }
        const meshes = container.meshes.filter(
          (mesh) => mesh.getTotalVertices() > 0,
        );
        const loadedBuildingNodeKeys = new Set<string>();

        for (const mesh of meshes) {
          if (mesh.metadata?.gltf?.extras?.teldraSourceVisibility?.hidden === true) {
            stagedHidden.add(mesh);

          }
          if (mesh.material !== null) {
            let projected = stagedMaterials.get(mesh.material);
            if (projected === undefined) {
              projected = sourceMaterialProjection(mesh.material, scene);
              stagedMaterials.set(mesh.material, projected);
            }
            mesh.material = projected;
          }
          mesh.isPickable = true;
          mesh.computeWorldMatrix(true);

          const identity = resolveTwinIdentity(mesh, manifestByNodeKey);
          stagedLayers.add(mesh, identity?.canonicalId ?? "presentation:unknown", stagedHidden.has(mesh));
          if (identity !== null) {
            stagedIdentities.set(mesh, identity);
            if (identity.ifcGlobalId !== undefined) {
              loadedBuildingNodeKeys.add(identity.nodeKey);
            }
          }
        }

        const missingBuildingNodeKeys = manifest.nodes
          .filter((node) => node.kind === "building")
          .map((node) => node.nodeKey)
          .filter((nodeKey) => !loadedBuildingNodeKeys.has(nodeKey));

        if (missingBuildingNodeKeys.length > 0) {
          throw new BabylonIdentityError(
            "Loaded GLB is missing manifest building identities: " +
              missingBuildingNodeKeys.join(", "),
          );
        }

        if (options.batchOpaqueParts) {
          const groups = new Map<string, BatchPart[]>();
          for (const [mesh, identity] of stagedIdentities) {
            const material = mesh.material;
            if (!(mesh instanceof Mesh) || mesh.getClassName() !== "Mesh" || !material || material.fillMode !== Material.TriangleFillMode || mesh.skeleton ||
                mesh.morphTargetManager || mesh.animations.length || mesh.instances.length || mesh.hasThinInstances ||
                mesh.isUnIndexed || mesh.infiniteDistance || mesh.billboardMode !== 0 || mesh.actionManager || !mesh.isVisible || mesh.visibility <= 0 || mesh.subMeshes.length !== 1 ||
                material.needAlphaBlendingForMesh(mesh) || material.needAlphaTesting()) continue;
            let animatedParent = false;
            for (let parent = mesh.parent; parent; parent = parent.parent) if (parent.animations.length) animatedParent = true;
            if (animatedParent) continue;
            const source = mesh.metadata?.gltf?.extras?.teldraSourceLayer;
            const key = JSON.stringify([identity.canonicalId, material.uniqueId, source?.levelId ?? null,
              stagedHidden.has(mesh), mesh.sideOrientation, mesh.layerMask, mesh.renderingGroupId,
              mesh.receiveShadows, mesh.visibility, mesh.alphaIndex, mesh.hasVertexAlpha, mesh.useVertexColors,
              mesh.applyFog, [...mesh.getVerticesDataKinds()].sort()]);
            const parts = groups.get(key) ?? [];
            parts.push({mesh, identity}); groups.set(key, parts);
          }
          for (const parts of groups.values()) {
            const batch = createMeshBatch(parts);
            if (!batch) continue;
            stagedLayers.addBatch(batch.mesh, parts.map(part => part.mesh));
            stagedBatches.push(batch);
          }
        }
        const batchedParts = new Set(stagedBatches.flatMap(batch => batch.parts.map(part => part.mesh)));
        const physical = [...meshes.filter(mesh => !batchedParts.has(mesh as Mesh)), ...stagedBatches.map(batch => batch.mesh)];

        const lighting = meshes.map(mesh => mesh.metadata?.gltf?.extras?.teldraSourceLighting)
          .find(value => value !== undefined);
        const hasSourceLighting = applySourceLighting(lighting, scene);
        if (hasSourceLighting) {
          previewLight?.setEnabled(false);
          // Preview grading is intentionally separate from the SH3D lighting profile.
          shadowDetail = SH3D_EDITING_SHADOW_DETAIL;
          applyPreviewShadowDetail(scene, shadowDetail);
        }
        container.addAllToScene();
        if(hasSourceLighting)assignSourceLights(scene,physical);
        await scene.whenReadyAsync();
        if (disposed) throw new Error("Cannot complete loading a disposed Babylon runtime.");
        if (defaultCamera && physical.length) fitCamera(defaultCamera, physical);
        // This warm-up render is outside Babylon's RAF loop. Submit it in the
        // same browser task that acquires the WebGPU swapchain texture. Leaving
        // it queued until the first RAF expires that texture and invalidates the
        // shared upload/render submission, including all initial image mipmaps.
        engine.beginFrame();
        try { renderFrame(); }
        finally { engine.endFrame(); }
        // Publish only after validation, readiness, and the initial frame succeed.
        layers = stagedLayers;
        renderMeshes = meshes;
        physicalMeshes = physical;
        loadedMeshParts = meshes.length;
        for (const mesh of stagedHidden) sourceHiddenMeshes.add(mesh);
        for (const [source, projected] of stagedMaterials) sourceMaterials.set(source, projected);
        for (const [mesh, identity] of stagedIdentities) {
          identityByMesh.set(mesh, identity);
          meshByNodeKey.set(identity.nodeKey, mesh);
          if (!batchedParts.has(mesh as Mesh)) {
            const parts = meshesByCanonicalId.get(identity.canonicalId) ?? [];
            parts.push(mesh); meshesByCanonicalId.set(identity.canonicalId, parts);
          }
        }
        for (const batch of stagedBatches) {
          batchesByMesh.set(batch.mesh, batch);
          const identity = batch.parts[0]!.identity;
          identityByMesh.set(batch.mesh, identity);
          for (const part of batch.parts) batchByPart.set(part.mesh, batch);
          const parts = meshesByCanonicalId.get(identity.canonicalId) ?? [];
          parts.push(batch.mesh); meshesByCanonicalId.set(identity.canonicalId, parts);
        }
        // The floor material is explicitly source-bound and textured.
        // No walls, furniture, or untextured ceilings are affected.
        for (const [mesh, identity] of stagedIdentities) {
          if (/^(sh3d:)?room:/.test(identity.canonicalId) &&
              mesh.material instanceof StandardMaterial && mesh.material.diffuseTexture &&
              mesh.material.diffuseTexture) {
            floorInspector.register(mesh.material);
            floorMinification.register(mesh.material);
          }
        }
        if (hasSourceLighting) {
          previewLight?.dispose();
          previewLight = undefined;
          lightingProfile = "sh3d-preview-v1";
        }
      } catch (error) {
        for (const batch of stagedBatches) batch.mesh.dispose(false, false);
        container?.dispose();
        for (const [source, projected] of stagedMaterials) {
          if (source !== projected) projected.dispose(false, false);
        }
        if (!disposed) {
          previewLight?.setEnabled(true);
          shadowDetail = 0;
          applyPreviewShadowDetail(scene, 0);
          for (const light of [...scene.lights]) if (!initialLights.has(light)) light.dispose();
          scene.ambientColor = initialAmbient;
          scene.clearColor = initialClear;
        }
        throw error;
      } finally {
        loading = false;
        loadGate.finish();
        if (started && !disposed) engine.runRenderLoop(renderFrame);
      }
    },

    projectNode(nodeKey: string): BabylonClientPoint | null {
      return projectNodeToClient(nodeKey);
    },

    setSelection(canonicalId){selectionId=canonicalId;},
    pick(clientX: number, clientY: number): TwinRenderIdentity | null {
      return pickAtClient(clientX, clientY);
    },
    inspectSurfaceAt(clientX: number, clientY: number): SurfaceProbe | null {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left, y = clientY - rect.top;
      if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 ||
          x >= rect.width || y >= rect.height) return null;
      // Do not filter by identity: a non-source overlay may be exactly the
      // surface obscuring a valid textured room floor.
      const hit = scene.pick(x, y,
        mesh => isMeshInteractable(mesh) && mesh.getTotalVertices() > 0,
        false, scene.cameraToUseForPointers ?? undefined);
      return describeSurfacePick(hit, resolvePickedMesh(hit?.pickedMesh, hit?.faceId));
    },

    inspectGpuAt(clientX: number, clientY: number): Promise<GpuFloorInspection> {
      const unavailable = (reason: string): GpuFloorInspection => ({
        framebufferRgb:null, framebufferError:reason, textureSize:null, mips:[],
      });
      if (disposed || !started || loading) return Promise.resolve(unavailable("Viewport is not rendering"));
      // Capture the CPU hit and initiate framebuffer readback in one completed
      // scene frame. Never repick after awaiting a GPU result from an older pose.
      return new Promise(resolve => {
        let finished = false;
        const cancel = () => finish(unavailable("GPU capture cancelled"));
        const finish = (result: GpuFloorInspection) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          scene.onAfterRenderObservable.remove(observer);
          pendingGpuProbes.delete(cancel);
          resolve(result);
        };
        const observer = scene.onAfterRenderObservable.addOnce(() => {
          const rect = canvas.getBoundingClientRect();
          const renderSize = [engine.getRenderWidth(), engine.getRenderHeight()] as const;
          const pixel = clientToFramebufferPixel(clientX,clientY,rect,...renderSize,backend);
          if (!pixel) { finish(unavailable("Outside viewport")); return; }
          const picked = scene.pick(clientX-rect.left, clientY-rect.top,
            mesh => isMeshInteractable(mesh) && mesh.getTotalVertices() > 0,
            false, scene.cameraToUseForPointers ?? undefined);
          const surface = describeSurfacePick(picked, resolvePickedMesh(picked?.pickedMesh, picked?.faceId));
          const material = picked?.pickedMesh?.material;
          const texture = material instanceof StandardMaterial ? material.diffuseTexture :
            material instanceof PBRMaterial ? material.albedoTexture : null;
          const uv = picked?.faceId !== undefined && picked.faceId >= 0
            ? picked.getTextureCoordinates()?.asArray() : null;
          const capture: NonNullable<GpuFloorInspection["capture"]> = {
            backend, framebufferFormat, pixel, renderSize,
            camera: defaultCamera ? cameraState(defaultCamera) : null,
            floorMinification: floorMinification.currentMode, floorTextureInspection,
            lightGain, shadowDetail,
            declaredSceneSha256: manifest.scene.assetSha256,
            declaredBuildingSha256: manifest.source.buildingSha256,
            textureSrgbStorage: texture?.getInternalTexture()?._useSRGBBuffer ?? null,
          };
          // Invoke while the current frame's attachment is still available.
          let framebuffer: Promise<ArrayBufferView>;
          try { framebuffer = engine.readPixels(pixel[0],pixel[1],1,1,true,true); }
          catch (reason) { framebuffer = Promise.reject(reason); }
          void (async () => {
            let framebufferRgb: [number,number,number] | null = null;
            let framebufferError: string | null = null;
            try {
              framebufferRgb = normalizeGpuRgb(await framebuffer, framebufferFormat.startsWith("bgra") ? "bgra" : "rgba");
              if (!framebufferRgb) framebufferError = "No compatible framebuffer pixel returned";
            } catch (reason) {
              framebufferError = reason instanceof Error ? reason.message.slice(0,240) : "Framebuffer readback unsupported";
            }
            if (finished || disposed) return;
            const levels = texture ? await inspectGpuMips(texture, uv ? [uv[0]!,uv[1]!] : null)
              : {textureSize:null,mips:[]};
            finish(disposed ? unavailable("Runtime disposed during GPU readback")
              : {framebufferRgb,framebufferError,...levels,surface,capture});
          })().catch(reason => finish(unavailable(reason instanceof Error ? reason.message.slice(0,240) : "GPU capture unavailable")));
        });
        const timeout = setTimeout(() => finish(unavailable("GPU capture timed out")), 10000);
        pendingGpuProbes.add(cancel);
      });
    },
    onPick(listener): () => void {
      let down: {x: number; y: number} | undefined;
      let dragged = false;
      const pointerDown = (event: PointerEvent) => { down = {x: event.clientX, y: event.clientY}; dragged = event.button !== 0 || furniture.isInteracting(); };
      const pointerMove = (event: PointerEvent) => {
        if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) dragged = true;
      };
      const cancel = () => { dragged = true; down = undefined; };
      const handleClick = (event: MouseEvent) => {
        if (!dragged) listener(pickAtClient(event.clientX, event.clientY));
        down = undefined;
      };
      canvas.addEventListener("pointerdown", pointerDown);
      canvas.addEventListener("pointermove", pointerMove);
      canvas.addEventListener("pointercancel", cancel);

      canvas.addEventListener("click", handleClick);

      const unsubscribe = () => {
        canvas.removeEventListener("click", handleClick);
        canvas.removeEventListener("pointerdown", pointerDown);
        canvas.removeEventListener("pointermove", pointerMove);
        canvas.removeEventListener("pointercancel", cancel);
        pickSubscriptions.delete(unsubscribe);
      };
      pickSubscriptions.add(unsubscribe);
      return unsubscribe;
    },

    start(): void {
      if (disposed || started) return;
      started = true;
      if (!loading) engine.runRenderLoop(renderFrame);
      normalizeCanvasTabOrder();
    },

    stop(): void {
      started = false;
      engine.stopRenderLoop();
      for (const cancel of pendingGpuProbes) cancel();
    },

    resize(): void {
      engine.resize();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const cancel of pendingGpuProbes) cancel();
      for (const unsubscribe of pickSubscriptions) unsubscribe();
      viewListeners.clear();
      tabIndexObserver.disconnect();
      releaseBlenderPointer?.();
      furniture.dispose();
      selectionOutline.dispose();
      floorInspector.restore();
      floorMinification.restore();
      instrumentation.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}

async function createEngine(
  canvas: HTMLCanvasElement,
  antialias: boolean,
  forceWebGL: boolean,
  depthMode: "auto" | "reverse" | "standard",
): Promise<{ engine: AbstractEngine; backend: BabylonBackend; framebufferFormat: string }> {
  if (!["auto", "reverse", "standard"].includes(depthMode)) throw new Error("Invalid depth mode.");
  if (!forceWebGL && await WebGPUEngine.IsSupportedAsync) {
    const colorFormat = navigator.gpu.getPreferredCanvasFormat();
    const engine = new WebGPUEngine(canvas, {
      antialias,
      adaptToDeviceRatio: true,
      swapChainFormat: colorFormat,
    });
    await engine.initAsync();
    // Reverse Z provides much better far-depth precision on mobile WebGPU.
    // Must be configured before scene/camera creation.
    engine.useReverseDepthBuffer = depthMode !== "standard";

    return {
      engine,
      backend: "webgpu",
      framebufferFormat: colorFormat,
    };
  }

  const engine = new Engine(canvas, antialias, {
    adaptToDeviceRatio: true,
  });
  engine.useReverseDepthBuffer = depthMode === "reverse";
  return {engine, backend: "webgl", framebufferFormat: "rgba8"};
}

function ensureLoadersRegistered(): void {
  if (loadersRegistered) {
    return;
  }

  registerBuiltInLoaders();
  loadersRegistered = true;
}
