import { describe, expect, it } from "vitest";
import {
  parseSceneManifest,
  validateSceneManifest,
  type TeldraSceneManifest,
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
      assetPath: "cache/scene.glb",
      assetSha256: "b".repeat(64),
      format: "glb",
      canonicalToScene: [...identity],
    },
    nodes: [
      {
        nodeKey: "ifc:3ZYNKvi3P3FvKPBGP9UP7n:body",
        canonicalId: "space:living-room",
        ifcGlobalId: "3ZYNKvi3P3FvKPBGP9UP7n",
        kind: "building",
        renderPart: "body",
        canonicalToNode: [...identity],
      },
      {
        nodeKey: "ifc:3ZYNKvi3P3FvKPBGP9UP7n:label-anchor",
        canonicalId: "space:living-room",
        ifcGlobalId: "3ZYNKvi3P3FvKPBGP9UP7n",
        kind: "building",
        renderPart: "label-anchor",
      },
      {
        nodeKey: "device:living-room-floor-lamp",
        canonicalId: "device:living-room-floor-lamp",
        kind: "device",
      },
    ],
  };
}

describe("scene manifest validation", () => {
  it("accepts one-to-many render nodes for one canonical object", () => {
    const result = validateSceneManifest(manifest());

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.nodes.filter((node) => node.canonicalId === "space:living-room")).toHaveLength(2);
    }
  });

  it("rejects duplicate render node keys", () => {
    const candidate = manifest();
    candidate.nodes[1] = {
      ...candidate.nodes[1]!,
      nodeKey: candidate.nodes[0]!.nodeKey,
    };

    const result = validateSceneManifest(candidate);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        source: "integrity",
        path: "/nodes/1/nodeKey",
        message: 'Duplicate scene node key "ifc:3ZYNKvi3P3FvKPBGP9UP7n:body".',
      });
    }
  });

  it("requires IFC identity on building nodes", () => {
    const candidate = manifest();
    const { ifcGlobalId: _removed, ...withoutIfcIdentity } = candidate.nodes[0]!;
    candidate.nodes[0] = withoutIfcIdentity;

    expect(validateSceneManifest(candidate)).toMatchObject({
      valid: false,
      issues: [
        {
          source: "integrity",
          path: "/nodes/0/ifcGlobalId",
        },
      ],
    });
  });

  it("rejects IFC identity on non-building nodes", () => {
    const candidate = manifest();
    candidate.nodes[2] = {
      ...candidate.nodes[2]!,
      ifcGlobalId: "0ufYQjmwP0Ah$QRRxVbqR3",
    };

    expect(validateSceneManifest(candidate)).toMatchObject({
      valid: false,
      issues: [
        {
          source: "integrity",
          path: "/nodes/2/ifcGlobalId",
        },
      ],
    });
  });

  it("throws a typed error for malformed transport metadata", () => {
    const candidate = {
      ...manifest(),
      coordinateSystem: {
        unit: "centimetre",
        handedness: "right",
        upAxis: "Z",
      },
    };

    expect(() => parseSceneManifest(candidate)).toThrow("Invalid Teldra scene manifest.");
  });
});
