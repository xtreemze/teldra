import { describe, expect, it } from "vitest";
import {
  ArchitecturalDependencyError,
  ArchitecturalDependencyIndex,
} from "../src/architectural-dependencies.js";

const fixture = () => new ArchitecturalDependencyIndex([
  { globalId: "door", dependsOn: ["opening"] },
  { globalId: "space", dependsOn: ["wall-b", "wall-a"] },
  { globalId: "opening", dependsOn: ["wall-a"] },
  { globalId: "wall-b", dependsOn: [] },
  { globalId: "wall-a", dependsOn: [] },
  { globalId: "light", dependsOn: [] },
]);

describe("architectural IFC dependency index", () => {
  it("computes stable transitive invalidation without rebuilding unrelated entities", () => {
    const index = fixture();
    expect(index.affectedBy(["wall-a"])).toEqual(["wall-a", "opening", "door", "space"]);
    expect(index.affectedBy(["wall-b", "wall-a", "wall-a"])).toEqual([
      "wall-a", "opening", "door", "wall-b", "space",
    ]);
    expect(index.affectedBy(["light"])).toEqual(["light"]);
    expect(index.affectedBy([])).toEqual([]);
    expect(index.has("wall-a")).toBe(true);
    expect(index.has("missing")).toBe(false);
  });

  it("rejects missing or duplicate entities and unsupported dangling references", () => {
    expect(() => new ArchitecturalDependencyIndex([
      { globalId: "a", dependsOn: [] }, { globalId: "a", dependsOn: [] },
    ])).toThrow(/Duplicate architectural GlobalId/);
    expect(() => new ArchitecturalDependencyIndex([
      { globalId: "door", dependsOn: ["unknown"] },
    ])).toThrow(/Missing architectural dependency/);
    expect(() => new ArchitecturalDependencyIndex([
      { globalId: "wall", dependsOn: ["wall", "wall"] },
    ])).toThrow(/Duplicate dependency/);
    expect(() => fixture().affectedBy(["unknown"])).toThrow(ArchitecturalDependencyError);
  });

  it("rejects self and multi-entity cycles before creating a usable rebuild plan", () => {
    expect(() => new ArchitecturalDependencyIndex([
      { globalId: "a", dependsOn: ["a"] },
    ])).toThrow(/cycle/);
    expect(() => new ArchitecturalDependencyIndex([
      { globalId: "a", dependsOn: ["b"] },
      { globalId: "b", dependsOn: ["c"] },
      { globalId: "c", dependsOn: ["a"] },
    ])).toThrow(/cycle/);
  });

  it("does not mutate input arrays or expose mutable internal collections", () => {
    const dependencies = ["wall-b", "wall-a"];
    const nodes = [{ globalId: "space", dependsOn: dependencies },
      { globalId: "wall-a", dependsOn: [] }, { globalId: "wall-b", dependsOn: [] }];
    const index = new ArchitecturalDependencyIndex(nodes);
    dependencies.splice(0, 2);
    nodes.splice(0, 3);
    expect(index.affectedBy(["wall-a"])).toEqual(["wall-a", "space"]);
  });
});
