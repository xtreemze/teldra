import { beforeAll, describe, expect, it } from "vitest";
import golden from "../../../fixtures/projects/golden-home/building.ifc?raw";
import connected from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import { IfcAPI, IFCWALL } from "web-ifc";
import { IfcWallEditor } from "@teldra/application";
import {
  WallEditError, createIfcWallAdapter, createWall, readWall, updateWall, type WallGeometry,
} from "../src/index.js";

/**
 * Imported (SH3D -> IFC) walls carry Body + Axis (Plan/Curve2D) and a single-layer
 * IfcMaterialLayerSetUsage whose layer set is shared between walls of equal thickness.
 * Convention matches python/packages/teldra-ifc bim.py: Axis = (0,0)->(L,0) in wall-local
 * XY; layer thickness = wall thickness; usage AXIS2 / POSITIVE / offset 0.
 */
const W0 = "1G3q5a3qrLx9E$4vW3RhiT", W1 = "3fKtdOSSbHj8Eku_ezDpte", W2 = "0UvRJz38fTBRsJt0WI2Y4_", W3 = "23V$SZvT1GEwY89MqjdR2N";
const STOREY = "3alYBHMR1G5AaThtWNzo_l", NEW = "0TeldraNewWallAAAAAAA1";
const bytes = new TextEncoder().encode(golden);
let api: IfcAPI;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); });

function wallGuids(data: Uint8Array): string[] {
  const id = api.OpenModel(data);
  try {
    const ids = api.GetLineIDsWithType(id, IFCWALL);
    return Array.from({ length: ids.size() }, (_, i) => (api.GetLine(id, ids.get(i)) as any).GlobalId.value).sort();
  } finally { api.CloseModel(id); }
}
interface Inspect { axis: number[][] | null; layers: number[]; layerSetId: number | null; layerSetName: string | null; usage: string | null }
function inspect(data: Uint8Array, guid: string): Inspect {
  const id = api.OpenModel(data);
  try {
    const ids = api.GetLineIDsWithType(id, IFCWALL);
    let wall: any;
    for (let i = 0; i < ids.size(); i++) { const l = api.GetLine(id, ids.get(i)) as any; if (l.GlobalId.value === guid) wall = l; }
    const get = (r: any) => api.GetLine(id, r.value) as any;
    let axis: number[][] | null = null;
    for (const r of get(wall.Representation).Representations) {
      const rep = get(r);
      if (rep.RepresentationIdentifier.value !== "Axis") continue;
      const curve = get(rep.Items[0]);
      axis = Array.isArray(curve.Points)
        ? curve.Points.map((p: any) => get(p).Coordinates.map((v: any) => v.value))
        : get(curve.Points).CoordList.map((p: any[]) => p.map((v) => v.value));
    }
    let layers: number[] = [], layerSetId: number | null = null, layerSetName: string | null = null, usage: string | null = null;
    const all = api.GetAllLines(id);
    for (let i = 0; i < all.size(); i++) {
      let l: any; try { l = api.GetLine(id, all.get(i)); } catch { continue; }
      if (!l.RelatedObjects || !l.RelatingMaterial) continue;
      if (!l.RelatedObjects.some((o: any) => o.value === wall.expressID)) continue;
      const u = get(l.RelatingMaterial);
      if (u.ForLayerSet === undefined) continue;
      usage = `${u.LayerSetDirection?.value}/${u.DirectionSense?.value}/${u.OffsetFromReferenceLine?.value}`;
      const set = get(u.ForLayerSet);
      layerSetId = set.expressID; layerSetName = set.LayerSetName?.value ?? null;
      layers = set.MaterialLayers.map((m: any) => get(m).LayerThickness.value);
    }
    return { axis, layers, layerSetId, layerSetName, usage };
  } finally { api.CloseModel(id); }
}
const geom = (g: Partial<WallGeometry> & Pick<WallGeometry, "start" | "end">): WallGeometry => ({ thickness: 0.075, height: 2.5, elevation: 0, ...g });
function code(run: () => unknown): string {
  try { run(); } catch (e) { if (e instanceof WallEditError) return e.code; throw e; }
  throw new Error("expected WallEditError");
}
const near = (a: readonly number[], b: readonly number[]) => { expect(a).toHaveLength(b.length); a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9)); };

describe("walls with Body + Axis + layer-set usage (SH3D import shape)", () => {
  it("reads an imported wall", () => {
    const w = readWall(api, bytes, W2);
    expect(w.thickness).toBeCloseTo(0.075);
    expect(w.connections.map((c) => c.wallGlobalId).sort()).toEqual([W1, W3].sort());
  });

  it("moves an endpoint: Body, Axis endpoints and connected walls follow; GlobalIds stable", () => {
    const before = readWall(api, bytes, W2);
    const target = geom({ start: [before.start[0], before.start[1]], end: [before.end[0] + 0.5, before.end[1] + 0.25] });
    const out = updateWall(api, bytes, W2, target);
    const after = readWall(api, out, W2);
    near(after.end, target.end);
    const length = Math.hypot(target.end[0] - target.start[0], target.end[1] - target.start[1]);
    const axis = inspect(out, W2).axis!;
    near(axis[0]!, [0, 0]);
    near(axis[1]!, [length, 0]);
    // connected wall W3 start moved with W2's end and its own Axis stayed consistent with its Body
    const w3 = readWall(api, out, W3);
    near(w3.start, target.end);
    const w3len = Math.hypot(w3.end[0] - w3.start[0], w3.end[1] - w3.start[1]);
    near(inspect(out, W3).axis![1]!, [w3len, 0]);
    expect(wallGuids(out)).toEqual(wallGuids(bytes));
  });

  it("changing thickness on a shared layer set clones it and leaves other walls untouched", () => {
    const base = readWall(api, bytes, W2);
    const sharedBefore = inspect(bytes, W3);
    const out = updateWall(api, bytes, W2, geom({ start: base.start, end: base.end, thickness: 0.2 }));
    const edited = inspect(out, W2);
    expect(edited.layers).toEqual([0.2]);
    expect(edited.layerSetId).not.toBe(inspect(bytes, W2).layerSetId);
    expect(edited.usage).toBe("AXIS2/POSITIVE/0");
    expect(inspect(out, W3)).toEqual(sharedBefore);
    expect(inspect(out, W3).layers).toEqual([0.075]);
    expect(readWall(api, out, W2).thickness).toBeCloseTo(0.2);
  });

  it("changing thickness on a solely owned layer set edits the layer in place", () => {
    const once = updateWall(api, bytes, W2, geom({ start: readWall(api, bytes, W2).start, end: readWall(api, bytes, W2).end, thickness: 0.2 }));
    const w = readWall(api, once, W2);
    const twice = updateWall(api, once, W2, geom({ start: w.start, end: w.end, thickness: 0.3 }));
    expect(inspect(twice, W2).layers).toEqual([0.3]);
    expect(inspect(twice, W2).layerSetId).toBe(inspect(once, W2).layerSetId);
  });

  it("undo is byte-identical and redo reapplies through the application editor", () => {
    const editor = new IfcWallEditor(bytes, createIfcWallAdapter(api));
    const w = readWall(api, bytes, W2);
    editor.apply({ kind: "update", globalId: W2, geometry: geom({ start: w.start, end: [w.end[0] + 0.5, w.end[1]], thickness: 0.15 }) });
    const edited = [...editor.bytes];
    expect(edited).not.toEqual([...bytes]);
    expect(editor.undo()).toBe(true);
    expect([...editor.bytes]).toEqual([...bytes]);
    expect(editor.redo()).toBe(true);
    expect([...editor.bytes]).toEqual(edited);
  });

  it("still refuses walls hosting openings", () => {
    const w = readWall(api, bytes, W0);
    expect(code(() => updateWall(api, bytes, W0, geom({ start: w.start, end: [w.end[0] + 1, w.end[1]] })))).toBe("hosted-opening");
  });
});

describe("walls with unusual Axis or material", () => {
  const swap = (from: string, to: string) => { expect(golden).toContain(from); return new TextEncoder().encode(golden.replace(from, to)); };
  it("refuses a thickness change when the layer-set usage is shared by several walls", () => {
    // Re-point wall3's association onto wall2's usage so one usage serves two walls.
    const shared = swap("#171=IFCRELASSOCIATESMATERIAL('1B38CPOljT2PEV9GIvFU3G',$,$,$,(#141),#170);",
      "#171=IFCRELASSOCIATESMATERIAL('1B38CPOljT2PEV9GIvFU3G',$,$,$,(#141,#172),#170);");
    const w = readWall(api, shared, W2);
    expect(code(() => updateWall(api, shared, W2, geom({ start: w.start, end: w.end, thickness: 0.2 })))).toBe("shared-material");
    // moving the axis only is fine
    expect(() => updateWall(api, shared, W2, geom({ start: w.start, end: [w.end[0] + 0.1, w.end[1]] }))).not.toThrow();
  });
  it("refuses a thickness change for a multi-layer set", () => {
    const multi = swap("#106=IFCMATERIALLAYERSET((#107),'Wall 75 mm',$);", "#106=IFCMATERIALLAYERSET((#107,#107),'Wall 75 mm',$);");
    const w = readWall(api, multi, W2);
    expect(code(() => updateWall(api, multi, W2, geom({ start: w.start, end: w.end, thickness: 0.2 })))).toBe("unsupported-material");
  });
  it("refuses two Body representations", () => {
    const twoBodies = swap("#101=IFCPRODUCTDEFINITIONSHAPE($,$,(#95,#104));", "#101=IFCPRODUCTDEFINITIONSHAPE($,$,(#95,#95));");
    expect(code(() => readWall(api, twoBodies, W0))).toBe("unsupported-representation");
  });
});

describe("createWall", () => {
  it("emits Axis and a layer-set usage matching the Python convention when the model has an Axis context", () => {
    const out = createWall(api, bytes, { globalId: NEW, storeyGlobalId: STOREY, name: "New", geometry: geom({ start: [1, 1], end: [4, 5], thickness: 0.075 }) });
    const info = inspect(out, NEW);
    near(info.axis![0]!, [0, 0]);
    near(info.axis![1]!, [5, 0]);
    expect(info.layers).toEqual([0.075]);
    expect(info.usage).toBe("AXIS2/POSITIVE/0");
    expect(info.layerSetName).toBe("Wall 75 mm");
    // an equal-thickness set is shared, not duplicated
    expect(info.layerSetId).toBe(inspect(bytes, W3).layerSetId);
    const read = readWall(api, out, NEW);
    near(read.start, [1, 1]); near(read.end, [4, 5]);
    const moved = updateWall(api, out, NEW, geom({ start: [1, 1], end: [4, 9], thickness: 0.075 }));
    near(inspect(moved, NEW).axis![1]!, [Math.hypot(3, 8), 0]);
  });
  it("creates a distinct layer set for a new thickness reusing the shared material", () => {
    const out = createWall(api, bytes, { globalId: NEW, storeyGlobalId: STOREY, name: "New", geometry: geom({ start: [0, 0], end: [2, 0], thickness: 0.3 }) });
    const info = inspect(out, NEW);
    expect(info.layers).toEqual([0.3]);
    expect(info.layerSetName).toBe("Wall 300 mm");
    expect(info.layerSetId).not.toBe(inspect(bytes, W3).layerSetId);
  });
  it("emits Body only when the model has no Plan/Axis context", () => {
    const plain = new TextEncoder().encode(connected);
    const out = createWall(api, plain, { globalId: NEW, storeyGlobalId: "0TeldraStoreyAAAAAAAA1", name: "New", geometry: geom({ start: [0, 8], end: [5, 8], thickness: 0.2 }) });
    expect(inspect(out, NEW).axis).toBeNull();
    expect(readWall(api, out, NEW).thickness).toBeCloseTo(0.2);
  });
});
