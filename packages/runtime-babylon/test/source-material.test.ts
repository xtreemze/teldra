import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Scene } from "@babylonjs/core/scene";
import { sourceMaterialProjection } from "../src/source-material";

describe("SH3D source appearance", () => {
  it("retains Phong color, shininess, transparency and source metadata", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const transport = new PBRMaterial("wood", scene);
      transport.metadata = {gltf: {extras: {teldraSourceMaterial: {
        format: "wavefront-mtl", Kd: [0.2, 0.4, 0.6], Ka: [0.1, 0.2, 0.3],
        Ks: [2, 1.65, 0.96], Ns: [60], d: [0.4], Ni: [1.5],
      }}}};
      const projected = sourceMaterialProjection(transport, scene) as StandardMaterial;
      expect(projected).toBeInstanceOf(StandardMaterial);
      expect(projected.diffuseColor.asArray()).toEqual([0.2, 0.4, 0.6]);
      expect(projected.ambientColor.asArray()).toEqual([0.1, 0.2, 0.3]);
      expect(projected.specularPower).toBe(60);
      expect(projected.specularColor.asArray()).toEqual([2, 1.65, 0.96]);
      expect(projected.alpha).toBe(0.4);
      expect(projected.metadata).toBe(transport.metadata);
      expect(transport.alpha).toBe(1);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("leaves ordinary PBR assets alone and rejects malformed source values", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const material = new PBRMaterial("pbr", scene);
      expect(sourceMaterialProjection(material, scene)).toBe(material);
      material.metadata = {gltf: {extras: {teldraSourceMaterial: {
        format: "wavefront-mtl", d: [2],
      }}}};
      expect(() => sourceMaterialProjection(material, scene)).toThrow("Invalid SH3D");
    } finally { scene.dispose(); engine.dispose(); }
  });
});
