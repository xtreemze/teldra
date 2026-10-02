import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import {
  parseSceneManifest,
  type TeldraSceneManifest,
} from "@teldra/scene-manifest";
import {
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
  const { engine, backend } = await createEngine(
    canvas,
    options.antialias ?? true,
  );
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;

  if (options.attachDefaultCamera ?? true) {
    const camera = new ArcRotateCamera(
      "teldra-camera",
      -Math.PI / 2,
      Math.PI / 3,
      8,
      Vector3.Zero(),
      scene,
    );
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 0.25;

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
    },

    pick(clientX: number, clientY: number): TwinRenderIdentity | null {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const result = scene.pick(x, y);

      return resolveTwinIdentity(result?.pickedMesh ?? null, manifestByNodeKey);
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
