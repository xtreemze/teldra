import { describe, expect, it } from "vitest";
import { resolveSceneSelection } from "../src/resolve-scene-selection.js";

const refs = [
  { id: "furniture:chair", ifcGlobalId: "abc123" },
  { id: "wall:living", ifcGlobalId: "wall123" },
];
describe("scene selection authoring identity reconciliation", () => {
  it("preserves exact authored IDs and device IDs before IFC fallback", () => {
    expect(resolveSceneSelection({canonicalId:"device:lamp",ifcGlobalId:"abc123"},
      ["device:lamp"], refs)).toBe("device:lamp");
    expect(resolveSceneSelection({canonicalId:"furniture:chair",ifcGlobalId:"wall123"},
      [], refs)).toBe("furniture:chair");
  });
  it("resolves a scene producer label via unambiguous IFC GlobalId", () => {
    expect(resolveSceneSelection({canonicalId:"sh3d:chair",ifcGlobalId:"abc123"},
      [], refs)).toBe("furniture:chair");
  });
  it("retains read-only selection when no unique authored reference exists", () => {
    expect(resolveSceneSelection({canonicalId:"visual:floor"}, [], refs)).toBe("visual:floor");
    expect(resolveSceneSelection({canonicalId:"visual:wall",ifcGlobalId:"abc123"}, [],
      [...refs,{id:"duplicate",ifcGlobalId:"abc123"}])).toBe("visual:wall");
    expect(resolveSceneSelection(null,[],refs)).toBeNull();
  });
});
