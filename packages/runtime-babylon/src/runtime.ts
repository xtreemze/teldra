import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import {
  parseSceneManifest,
  type TeldraSceneManifest,
} from "@teldra/scene-manifest";
import { toRenderCoordinates } from "./coordinates.js";
import {
  BabylonIdentityError,
  indexSceneManifest,
  resolveTwinIdentity,
  type TwinRenderIdentity,
} from "./identity.js";

export type BabylonBackend = "webgpu" | "webgl";

export interface BabylonTwinRuntime {
  readonly backend: BabylonBackend;
  readonly manifest: TeldraSceneManifest;
  load(glbUrl: string): Promise<void>;
  pick(clientX: number, clientY: number): TwinRenderIdentity | null;
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
    defaultCamera.attachControl(canvas, true);
    defaultCamera.lowerRadiusLimit = 0.25;

    new HemisphericLight(
      "teldra-preview-light",
      new Vector3(0, 1, 0),
      scene,
    );
  }

  ensureLoadersRegistered();

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
        mesh.computeWorldMatrix(true);

        const identity = resolveTwinIdentity(mesh, manifestByNodeKey);
        if (identity !== null) {
          identityByMesh.set(mesh, identity);
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
    },

    pick(clientX: number, clientY: number): TwinRenderIdentity | null {
      const rect = canvas.getBoundingClientRect();
      const point = toRenderCoordinates(
        {
          x: clientX - rect.left,
          y: clientY - rect.top,
        },
        {
          width: rect.width,
          height: rect.height,
        },
        {
          width: engine.getRenderWidth(),
          height: engine.getRenderHeight(),
        },
      );
      const result = scene.pick(point.x, point.y);
      const pickedMesh = result?.pickedMesh ?? null;

      if (pickedMesh === null) {
        return null;
      }

      return (
        identityByMesh.get(pickedMesh) ??
        resolveTwinIdentity(pickedMesh, manifestByNodeKey)
      );
    },

    start(): void {
      engine.runRenderLoop(() => scene.render());
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
