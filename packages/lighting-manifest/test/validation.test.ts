import { describe, expect, it } from "vitest";
import {
  parseLightingManifest,
  validateLightingManifest,
  type TeldraLightingManifest,
} from "../src/index.js";

function asset(path: string, hash: string) {
  return {
    path,
    sha256: hash.repeat(64),
    format: "ktx2" as const,
  };
}

function manifest(): TeldraLightingManifest {
  return {
    schemaVersion: "0.1.0",
    source: {
      sceneManifestPath: "scene.manifest.json",
      sceneManifestSha256: "a".repeat(64),
      appearanceManifestPath: "appearance.manifest.json",
      appearanceManifestSha256: "b".repeat(64),
      bakeSettingsSha256: "c".repeat(64),
    },
    radianceSpace: "linear-srgb",
    composition: "additive-linear",
    radianceBases: [
      {
        basisId: "ambient",
        kind: "ambient",
        texture: asset("lighting/ambient.ktx2", "d"),
        uvSet: 1,
        nodeKeys: ["ifc:wall:body"],
        lightIds: [],
        referenceIntensity: 1,
        tintable: false,
      },
      {
        basisId: "floor-lamp",
        kind: "fixture-group",
        texture: asset("lighting/floor-lamp.ktx2", "e"),
        uvSet: 1,
        nodeKeys: ["ifc:wall:body"],
        lightIds: ["device:living-room-floor-lamp"],
        referenceIntensity: 1,
        tintable: true,
      },
    ],
    reflectionProbes: [
      {
        probeId: "living-room",
        position: [0, 0, 1.5],
        influence: {
          shape: "box",
          halfExtents: [3, 2, 1.5],
        },
        states: [
          {
            stateId: "daylight",
            texture: asset("reflections/living-room-day.ktx2", "f"),
          },
          {
            stateId: "evening",
            texture: asset("reflections/living-room-evening.ktx2", "1"),
          },
        ],
      },
    ],
    toolchain: {
      blenderVersion: "5.0.0",
      cyclesVersion: "5.0.0",
      pipelineVersion: "0.1.0",
      settingsSha256: "2".repeat(64),
    },
  };
}

describe("lighting manifest validation", () => {
  it("accepts additive radiance bases and reflection states", () => {
    expect(validateLightingManifest(manifest()).valid).toBe(true);
  });

  it("rejects duplicate fixture assignment across bases", () => {
    const candidate = manifest();
    candidate.radianceBases.push({
      ...candidate.radianceBases[1]!,
      basisId: "duplicate-fixture",
    });

    expect(validateLightingManifest(candidate)).toMatchObject({
      valid: false,
      issues: [
        {
          source: "integrity",
          path: "/radianceBases/2/lightIds/0",
        },
      ],
    });
  });

  it("rejects canonical fixture IDs on ambient bases", () => {
    const candidate = manifest();
    candidate.radianceBases[0]!.lightIds = ["device:unexpected"];

    expect(validateLightingManifest(candidate)).toMatchObject({
      valid: false,
      issues: [
        {
          source: "integrity",
          path: "/radianceBases/0/lightIds",
        },
      ],
    });
  });

  it("rejects duplicate reflection states within a probe", () => {
    const candidate = manifest();
    candidate.reflectionProbes[0]!.states.push({
      ...candidate.reflectionProbes[0]!.states[0]!,
    });

    expect(validateLightingManifest(candidate)).toMatchObject({
      valid: false,
      issues: [
        {
          source: "integrity",
          path: "/reflectionProbes/0/states/2/stateId",
        },
      ],
    });
  });

  it("throws a typed error for nonlinear radiance composition", () => {
    const candidate = {
      ...manifest(),
      composition: "screen",
    };

    expect(() => parseLightingManifest(candidate)).toThrow(
      "Invalid Teldra lighting manifest.",
    );
  });
});
