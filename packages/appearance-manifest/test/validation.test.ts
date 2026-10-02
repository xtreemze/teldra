import { describe, expect, it } from "vitest";
import {
  parseAppearanceManifest,
  validateAppearanceManifest,
  type TeldraAppearanceManifest,
} from "../src/index.js";

function manifest(): TeldraAppearanceManifest {
  return {
    schemaVersion: "0.1.0",
    sceneManifest: {
      path: "scene.manifest.json",
      sha256: "a".repeat(64),
    },
    profile: {
      materialModel: "metallic-roughness",
      primaryUvSet: 0,
      lightmapUvSet: 1,
      baseColorTransfer: "srgb",
      emissiveTransfer: "srgb",
      dataTextureTransfer: "linear",
      metallicRoughnessPacking: "g-roughness-b-metallic",
    },
    materials: [
      {
        materialKey: "living-room-wall",
        nodeKeys: ["ifc:wall:body"],
        textures: [
          {
            semantic: "base-color",
            uvSet: 0,
            assetPath: "textures/wall-base.ktx2",
            assetSha256: "b".repeat(64),
          },
          {
            semantic: "metallic-roughness",
            uvSet: 0,
          },
        ],
      },
    ],
  };
}

describe("appearance manifest validation", () => {
  it("accepts the portable metallic-roughness profile", () => {
    expect(validateAppearanceManifest(manifest()).valid).toBe(true);
  });

  it("rejects duplicate material keys", () => {
    const candidate = manifest();
    candidate.materials.push({ ...candidate.materials[0]! });

    expect(validateAppearanceManifest(candidate)).toMatchObject({
      valid: false,
      issues: [{ source: "integrity", path: "/materials/1/materialKey" }],
    });
  });

  it("requires external texture path and hash together", () => {
    const candidate = manifest();
    const texture = candidate.materials[0]!.textures[0]!;
    const { assetSha256: _removed, ...withoutHash } = texture;
    candidate.materials[0]!.textures[0] = withoutHash;

    expect(validateAppearanceManifest(candidate)).toMatchObject({
      valid: false,
      issues: [{ source: "integrity", path: "/materials/0/textures/0" }],
    });
  });

  it("rejects material textures on the lightmap UV set", () => {
    const candidate = manifest();
    candidate.materials[0]!.textures[0]!.uvSet = 1;

    expect(validateAppearanceManifest(candidate)).toMatchObject({
      valid: false,
      issues: [{ source: "integrity", path: "/materials/0/textures/0/uvSet" }],
    });
  });

  it("throws a typed error for an invalid profile", () => {
    const candidate = {
      ...manifest(),
      profile: {
        ...manifest().profile,
        primaryUvSet: 1,
      },
    };

    expect(() => parseAppearanceManifest(candidate)).toThrow(
      "Invalid Teldra appearance manifest.",
    );
  });
});
