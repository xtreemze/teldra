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

  let defaultCamera: ArcRotateCamera | undefined;

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
    // Babylon assigns a positive tabindex when camera controls attach.
    // Preserve keyboard focus without moving the canvas ahead of document order.
    canvas.tabIndex = 0;
    defaultCamera.lowerRadiusLimit = 0.25;

    new HemisphericLight(
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

    async load(glbUrl: string): Promise<void> {
      const container = await LoadAssetContainerAsync(glbUrl, scene);
      container.addAllToScene();

      const renderMeshes = container.meshes.filter(
        (mesh) => mesh.getTotalVertices() > 0,
      );
      const loadedBuildingNodeKeys = new Set<string>();

      for (const mesh of renderMeshes) {
        mesh.isPickable = true;
        mesh.computeWorldMatrix(true);

        const identity = resolveTwinIdentity(mesh, manifestByNodeKey);
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
        defaultCamera.zoomOn(renderMeshes);
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
      const handleClick = (event: MouseEvent) => {
        listener(pickAtClient(event.clientX, event.clientY));
      };

      canvas.addEventListener("click", handleClick);

      return () => {
        canvas.removeEventListener("click", handleClick);
      };
    },

    start(): void {
      engine.runRenderLoop(() => scene.render());
      // Babylon may assign tabindex=1 during deferred engine/camera setup.
      // Normalize after render-loop setup so the canvas remains in DOM tab order.
      canvas.tabIndex = 0;
    },

    stop(): void {
      engine.stopRenderLoop();
    },

    resize(): void {
      engine.resize();
    },

    dispose(): void {
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
