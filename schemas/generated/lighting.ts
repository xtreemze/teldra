/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */

export type Sha256 = string;
/**
 * @minItems 3
 * @maxItems 3
 */
export type Vector3 = [number, number, number];
export type ProbeInfluence =
  | {
      shape: "sphere";
      radius: number;
    }
  | {
      shape: "box";
      halfExtents: Vector3;
    };

export interface TeldraLightingManifest {
  schemaVersion: "0.1.0";
  source: Source;
  radianceSpace: "linear-srgb";
  composition: "additive-linear";
  radianceBases: RadianceBasis[];
  reflectionProbes: ReflectionProbe[];
  toolchain: Toolchain;
}
export interface Source {
  sceneManifestPath: string;
  sceneManifestSha256: Sha256;
  appearanceManifestPath: string;
  appearanceManifestSha256: Sha256;
  bakeSettingsSha256: Sha256;
}
export interface RadianceBasis {
  basisId: string;
  kind: "ambient" | "daylight" | "fixture-group";
  texture: Asset;
  uvSet: 1;
  /**
   * @minItems 1
   */
  nodeKeys: [string, ...string[]];
  lightIds: string[];
  referenceIntensity: number;
  tintable: boolean;
}
export interface Asset {
  path: string;
  sha256: Sha256;
  format: "ktx2";
}
export interface ReflectionProbe {
  probeId: string;
  position: Vector3;
  influence: ProbeInfluence;
  /**
   * @minItems 1
   */
  states: [ReflectionState, ...ReflectionState[]];
}
export interface ReflectionState {
  stateId: string;
  texture: Asset;
}
export interface Toolchain {
  blenderVersion: string;
  cyclesVersion: string;
  pipelineVersion: string;
  settingsSha256: Sha256;
}
