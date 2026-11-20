import { describe, expect, it } from "vitest";
import synthetic from "../../../fixtures/furniture-catalog/synthetic-boxes.catalog.json" with { type: "json" };
import {
  findFurnitureCatalogItem,
  parseFurnitureCatalog,
  validateFurnitureCatalog,
  validateFurnitureCatalogItem,
} from "../src/index.js";

const clone = <T>(value: T): T => structuredClone(value);
const issuesOf = (value: unknown) => {
  const result = validateFurnitureCatalog(value);
  return result.valid ? [] : result.issues.map((i) => `${i.source}:${i.path}:${i.message}`);
};

describe("furniture catalog contract", () => {
  it("accepts the synthetic CC0 fixture and resolves items by id", () => {
    const catalog = parseFurnitureCatalog(synthetic);
    expect(catalog.items.map((i) => i.id)).toEqual(["box-chair", "l-shelf", "wall-picture"]);
    expect(findFurnitureCatalogItem(catalog, "l-shelf")?.ifc.predefinedType).toBe("SHELF");
    expect(findFurnitureCatalogItem(catalog, "missing")).toBeUndefined();
  });

  it("fixture licences are all bundle-safe CC0", () => {
    for (const item of parseFurnitureCatalog(synthetic).items) {
      expect(item.licence.spdx).toBe("CC0-1.0");
      expect(item.licence.redistribution).toBe("bundle");
    }
  });

  it("rejects schema violations: unknown class, bad unit, non-positive size, unknown keys", () => {
    const bad = clone(synthetic) as any;
    bad.items[0].ifc.class = "IfcWall";
    bad.items[1].dimensions.unit = "cm";
    bad.items[2].dimensions.width = 0;
    bad.items[2].surprise = true;
    const issues = issuesOf(bad);
    expect(issues.some((i) => i.includes("/items/0/ifc/class"))).toBe(true);
    expect(issues.some((i) => i.includes("/items/1/dimensions/unit"))).toBe(true);
    expect(issues.some((i) => i.includes("/items/2/dimensions/width"))).toBe(true);
    expect(issues.some((i) => i.includes("surprise"))).toBe(true);
  });

  it("requires an explicit elevation for wall- and ceiling-mounted items", () => {
    const bad = clone(synthetic) as any;
    delete bad.items[2].mount.elevation;
    expect(issuesOf(bad).some((i) => i.includes("/items/2/mount"))).toBe(true);
  });

  it("rejects duplicate item ids", () => {
    const bad = clone(synthetic) as any;
    bad.items[1].id = bad.items[0].id;
    expect(issuesOf(bad)).toContain("integrity:/items/1/id:Duplicate catalog item id box-chair.");
  });

  it("rejects an extrusion footprint outside nominal dimensions, degenerate, or self-intersecting", () => {
    const outside = clone(synthetic) as any;
    outside.items[1].representation.footprint[1] = [0.9, -0.25];
    expect(issuesOf(outside).some((i) => i.includes("outside the nominal"))).toBe(true);

    const degenerate = clone(synthetic) as any;
    degenerate.items[1].representation.footprint = [[0, 0], [0.5, 0], [0.25, 0]];
    expect(issuesOf(degenerate).some((i) => i.includes("zero area"))).toBe(true);

    const bowtie = clone(synthetic) as any;
    bowtie.items[1].representation.footprint = [[-0.5, -0.25], [0.5, -0.25], [-0.5, 0.25], [0.3, 0.25]];
    expect(issuesOf(bowtie).some((i) => i.includes("self-intersect"))).toBe(true);
  });

  it("requires attribution for attribution licences and forbids bundling non-commercial terms", () => {
    const noAttribution = clone(synthetic) as any;
    noAttribution.items[0].licence = { spdx: "CC-BY-4.0", author: "A. Author", redistribution: "bundle" };
    expect(issuesOf(noAttribution).some((i) => i.includes("attribution"))).toBe(true);

    const attributed = clone(noAttribution) as any;
    attributed.items[0].licence.attribution = "Chair by A. Author, CC BY 4.0";
    expect(issuesOf(attributed)).toEqual([]);

    const nonCommercial = clone(synthetic) as any;
    nonCommercial.items[0].licence = { spdx: "CC-BY-NC-4.0", author: "A. Author", attribution: "x", redistribution: "bundle" };
    expect(issuesOf(nonCommercial).some((i) => i.includes("non-commercial"))).toBe(true);
    nonCommercial.items[0].licence.redistribution = "user-import-only";
    expect(issuesOf(nonCommercial)).toEqual([]);
  });

  it("validates asset conventions: relative path, sha256, no traversal", () => {
    const withAsset = clone(synthetic) as any;
    withAsset.items[0].asset = {
      path: "models/chair.glb", mediaType: "model/gltf-binary", sha256: "a".repeat(64),
      unit: "m", upAxis: "+Y", frontAxis: "+Z", dimensionsPolicy: "preserve-source",
    };
    expect(issuesOf(withAsset)).toEqual([]);
    withAsset.items[0].asset.path = "../escape.glb";
    expect(issuesOf(withAsset).some((i) => i.includes("relative"))).toBe(true);
    withAsset.items[0].asset.path = "/abs/chair.glb";
    expect(issuesOf(withAsset).some((i) => i.includes("relative"))).toBe(true);
    withAsset.items[0].asset.path = "models/chair.glb";
    withAsset.items[0].asset.sha256 = "xyz";
    expect(issuesOf(withAsset).some((i) => i.includes("sha256"))).toBe(true);
  });

  it("validates a single item for insertion callers", () => {
    const item = (synthetic as any).items[0];
    expect(validateFurnitureCatalogItem(item).valid).toBe(true);
    expect(validateFurnitureCatalogItem({ ...item, id: "Bad Id" }).valid).toBe(false);
  });

  it("parse throws an error that names the issues", () => {
    expect(() => parseFurnitureCatalog({})).toThrow(/Invalid Teldra furniture catalog/);
  });
});
