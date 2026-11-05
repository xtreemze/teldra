import { Camera } from "@babylonjs/core/Cameras/camera";
import { cameraState, orientCamera, syncProjection, zoomCamera, panCamera, fitCamera, stopCameraMotion, SceneLayers, type ViewState, type ViewDirection, type ViewProjection } from "./view-controls.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Scene } from "@babylonjs/core/scene";
import type { Material } from "@babylonjs/core/Materials/material";
import { applySourceLighting } from "./source-lighting.js";
import { sourceMaterialProjection } from "./source-material.js";
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

export interface BabylonTwinRuntime {
  readonly backend: BabylonBackend;
  readonly manifest: TeldraSceneManifest;
  assetSummary(): { meshParts: number; visibleMeshParts: number; hiddenSourceParts: number; sourcePhongMaterials: number; textures: number; texturesReady: boolean; lightingProfile: string };
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
  load(glbUrl: string): Promise<void>;
  projectNode(nodeKey: string): BabylonClientPoint | null;
  pick(clientX: number, clientY: number): TwinRenderIdentity | null;
  onPick(listener: (identity: TwinRenderIdentity | null) => void): () => void;
  start(): void;
  stop(): void;
  resize(): void;
  dispose(): void;
}

export interface BabylonTwinRuntimeOptions {
  antialias?: boolean;
  attachDefaultCamera?: boolean;
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
  const { engine, backend } = await createEngine(
    canvas,
    options.antialias ?? true,
  );
  const scene = new Scene(engine);
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
  let loadedMeshParts = 0;
  let lightingProfile = "preview";
  let previewLight: HemisphericLight | undefined;
  const sourceMaterials = new Map<Material, Material>();
  const sourceHiddenMeshes = new Set<AbstractMesh>();
  const layers = new SceneLayers();
  let renderMeshes: AbstractMesh[] = [];
  const viewListeners = new Set<(state: ViewState) => void>();
  let lastView = "";
  scene.onBeforeRenderObservable.add(() => {
    if (defaultCamera) syncProjection(defaultCamera, engine.getRenderWidth() / engine.getRenderHeight());
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
    defaultCamera.attachControl(canvas, true);
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
  ): TwinRenderIdentity | null => {
    if (pickedMesh === null || pickedMesh === undefined) {
      return null;
    }

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

    return resolvePickedMesh(
      scene.pick(
        localX,
        localY,
        (mesh) => identityByMesh.has(mesh),
        false,
        scene.cameraToUseForPointers ?? undefined,
      )?.pickedMesh,
    );
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
    const center = mesh.getBoundingInfo().boundingSphere.centerWorld;
    const origin = camera.globalPosition;
    const direction = center.subtract(origin);
    if (direction.lengthSquared() <= Number.EPSILON) {
      return null;
    }
    direction.normalize();

    const surfacePick = scene.pickWithRay(
      new Ray(origin, direction),
      (candidate) => identityByMesh.get(candidate)?.nodeKey === nodeKey,
      false,
    );
    const surfacePoint = surfacePick?.pickedPoint;

    if (surfacePoint === null || surfacePoint === undefined) {
      return null;
    }

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
    assetSummary() {
      return {
        lightingProfile,
        meshParts: loadedMeshParts,
        visibleMeshParts: renderMeshes.filter(mesh => mesh.isEnabled()).length,
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
      return defaultCamera ? fitCamera(defaultCamera, renderMeshes.filter(mesh =>
        !canonicalId || identityByMesh.get(mesh)?.canonicalId === canonicalId)) : false;
    },
    resetView() {
      if (!defaultCamera) return;
      defaultCamera.mode = Camera.PERSPECTIVE_CAMERA;
      orientCamera(defaultCamera, "isometric");
      fitCamera(defaultCamera, renderMeshes);
    },
    async load(glbUrl: string): Promise<void> {
      const container = glbUrl.startsWith("blob:")
        ? await LoadAssetContainerAsync(glbUrl, scene, {
            pluginExtension: ".glb",
          })
        : await LoadAssetContainerAsync(glbUrl, scene);
      container.addAllToScene();

      renderMeshes = container.meshes.filter(
        (mesh) => mesh.getTotalVertices() > 0,
      );
      const lighting = renderMeshes.map(mesh => mesh.metadata?.gltf?.extras?.teldraSourceLighting)
        .find(value => value !== undefined);
      if (applySourceLighting(lighting, scene)) {
        previewLight?.dispose();
        previewLight = undefined;
        lightingProfile = "sh3d-preview-v1";
      }
      loadedMeshParts = renderMeshes.length;
      const loadedBuildingNodeKeys = new Set<string>();

      for (const mesh of renderMeshes) {
        if (mesh.metadata?.gltf?.extras?.teldraSourceVisibility?.hidden === true) {
          sourceHiddenMeshes.add(mesh);

        }
        if (mesh.material !== null) {
          let projected = sourceMaterials.get(mesh.material);
          if (projected === undefined) {
            projected = sourceMaterialProjection(mesh.material, scene);
            sourceMaterials.set(mesh.material, projected);
          }
          mesh.material = projected;
        }
        mesh.isPickable = true;
        mesh.computeWorldMatrix(true);

        const identity = resolveTwinIdentity(mesh, manifestByNodeKey);
        layers.add(mesh, identity?.canonicalId ?? "presentation:unknown", sourceHiddenMeshes.has(mesh));
        if (identity !== null) {
          identityByMesh.set(mesh, identity);
          meshByNodeKey.set(identity.nodeKey, mesh);
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
        container.dispose();
        throw new BabylonIdentityError(
          "Loaded GLB is missing manifest building identities: " +
            missingBuildingNodeKeys.join(", "),
        );
      }

      if (defaultCamera !== undefined && renderMeshes.length > 0) {
        fitCamera(defaultCamera, renderMeshes);
      }

      // A resolved load is a renderer-readiness boundary: camera framing,
      // world matrices, materials, and the first pickable frame are ready.
      await scene.whenReadyAsync();
      scene.render();
    },

    projectNode(nodeKey: string): BabylonClientPoint | null {
      return projectNodeToClient(nodeKey);
    },

    pick(clientX: number, clientY: number): TwinRenderIdentity | null {
      return pickAtClient(clientX, clientY);
    },

    onPick(listener): () => void {
      let down: {x: number; y: number} | undefined;
      let dragged = false;
      const pointerDown = (event: PointerEvent) => { down = {x: event.clientX, y: event.clientY}; dragged = event.button !== 0; };
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

      return () => {
        canvas.removeEventListener("click", handleClick);
        canvas.removeEventListener("pointerdown", pointerDown);
        canvas.removeEventListener("pointermove", pointerMove);
        canvas.removeEventListener("pointercancel", cancel);
      };
    },

    start(): void {
      engine.runRenderLoop(() => scene.render());
      normalizeCanvasTabOrder();
    },

    stop(): void {
      engine.stopRenderLoop();
    },

    resize(): void {
      engine.resize();
    },

    dispose(): void {
      viewListeners.clear();
      tabIndexObserver.disconnect();
      scene.dispose();
      engine.dispose();
    },
  };
}

async function createEngine(
  canvas: HTMLCanvasElement,
  antialias: boolean,
): Promise<{ engine: AbstractEngine; backend: BabylonBackend }> {
  if (await WebGPUEngine.IsSupportedAsync) {
    const engine = new WebGPUEngine(canvas, {
      antialias,
      adaptToDeviceRatio: true,
    });
    await engine.initAsync();

    return {
      engine,
      backend: "webgpu",
    };
  }

  return {
    engine: new Engine(canvas, antialias, {
      adaptToDeviceRatio: true,
    }),
    backend: "webgl",
  };
}

function ensureLoadersRegistered(): void {
  if (loadersRegistered) {
    return;
  }

  registerBuiltInLoaders();
  loadersRegistered = true;
}
