import { describe, expect, it } from "vitest";
import type { TeldraSceneManifest } from "@teldra/scene-manifest";
import {
  BabylonIdentityError,
  indexSceneManifest,
  resolveTwinIdentity,
  type MetadataCarrier,
} from "../src/index.js";

const identity = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
] as const;

function manifest(): TeldraSceneManifest {
  return {
    schemaVersion: "0.1.0",
    coordinateSystem: {
      unit: "metre",
      handedness: "right",
      upAxis: "Z",
    },
    source: {
      buildingPath: "building.ifc",
      buildingSha256: "a".repeat(64),
    },
    scene: {
      assetPath: "scene.glb",
      assetSha256: "b".repeat(64),
      format: "glb",
      canonicalToScene: [...identity],
    },
    nodes: [
      {
        nodeKey: "ifc:wall-guid:body",
        canonicalId: "wall:living",
        ifcGlobalId: "1234567890123456789012",
        kind: "building",
        renderPart: "body",
      },
    ],
  };
}

function carrier(
  teldra: Record<string, unknown>,
  parent: MetadataCarrier | null = null,
): MetadataCarrier {
  return {
    metadata: {
      gltf: {
        extras: {
          teldra,
        },
      },
    },
    parent,
  };
}

describe("Babylon glTF identity resolution", () => {
  it("resolves glTF extras through the scene manifest", () => {
    const indexed = indexSceneManifest(manifest());
    const node = carrier({
      nodeKey: "ifc:wall-guid:body",
      canonicalId: "wall:living",
      ifcGlobalId: "1234567890123456789012",
    });

    expect(resolveTwinIdentity(node, indexed)).toEqual({
      nodeKey: "ifc:wall-guid:body",
      canonicalId: "wall:living",
      ifcGlobalId: "1234567890123456789012",
    });
  });

  it("walks to a parent glTF node when the picked mesh is a generated child", () => {
    const indexed = indexSceneManifest(manifest());
    const gltfNode = carrier({
      nodeKey: "ifc:wall-guid:body",
      canonicalId: "wall:living",
      ifcGlobalId: "1234567890123456789012",
    });
    const pickedChild: MetadataCarrier = {
      parent: gltfNode,
    };

    expect(resolveTwinIdentity(pickedChild, indexed)?.canonicalId).toBe(
      "wall:living",
    );
  });

  it("returns null for presentation nodes without Teldra metadata", () => {
    expect(resolveTwinIdentity({ metadata: {} }, indexSceneManifest(manifest()))).toBeNull();
  });

  it("rejects stale or tampered canonical identity", () => {
    const indexed = indexSceneManifest(manifest());
    const node = carrier({
      nodeKey: "ifc:wall-guid:body",
      canonicalId: "wall:other",
      ifcGlobalId: "1234567890123456789012",
    });

    expect(() => resolveTwinIdentity(node, indexed)).toThrow(BabylonIdentityError);
  });

  it("rejects unknown render node keys", () => {
    const node = carrier({
      nodeKey: "ifc:missing:body",
      canonicalId: "wall:living",
    });

    expect(() => resolveTwinIdentity(node, indexSceneManifest(manifest()))).toThrow(
      /unknown scene node key/,
    );
  });
});
