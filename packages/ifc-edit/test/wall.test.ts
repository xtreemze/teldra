import { beforeAll, describe, expect, it } from "vitest";
import fixture from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import { IfcAPI, IFCWALL } from "web-ifc";
import {
  WallEditError, createWall, planWallCreate, planWallRemove, planWallUpdate,
  readWall, removeWall, updateWall, type WallGeometry,
} from "../src/index.js";

const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1", C = "0TeldraWallCCCCCCCCCC1", D = "0TeldraWallDDDDDDDDDD1";
const STOREY = "0TeldraStoreyAAAAAAAA1";
const bytes = new TextEncoder().encode(fixture);
const enc = (text: string) => new TextEncoder().encode(text);
let api: IfcAPI;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); });

function wallGuids(data: Uint8Array): string[] {
  const id = api.OpenModel(data);
  try {
    const ids = api.GetLineIDsWithType(id, IFCWALL);
    const out: string[] = [];
    for (let i = 0; i < ids.size(); i++) out.push((api.GetLine(id, ids.get(i)) as any).GlobalId.value);
    return out.sort();
  } finally { api.CloseModel(id); }
}
function near(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
}
function code(run: () => unknown): string {
  try { run(); } catch (e) { if (e instanceof WallEditError) return e.code; throw e; }
  throw new Error("expected WallEditError");
}
const geom = (g: Partial<WallGeometry> & Pick<WallGeometry, "start" | "end">): WallGeometry =>
  ({ thickness: 0.2, height: 2.5, elevation: 0, ...g });

describe("readWall", () => {
  it("reads axis endpoints, thickness, height and elevation in world metres", () => {
    const a = readWall(api, bytes, A);
    near(a.start, [0, 0]); near(a.end, [4, 0]);
    expect(a.thickness).toBeCloseTo(0.2); expect(a.height).toBeCloseTo(2.5); expect(a.elevation).toBe(0);
    const b = readWall(api, bytes, B);
    near(b.start, [4, 0]); near(b.end, [4, 3]);
  });
  it("reports encoded path connectivity", () => {
    expect(readWall(api, bytes, A).connections).toEqual([{ wallGlobalId: B, end: "end", otherEnd: "start" }]);
    expect(readWall(api, bytes, B).connections).toEqual([{ wallGlobalId: A, end: "start", otherEnd: "end" }]);
    expect(readWall(api, bytes, C).connections).toEqual([]);
  });
  it("rejects unknown GlobalIds explicitly", () => {
    expect(code(() => readWall(api, bytes, "0TeldraNoSuchWallAAAA1"))).toBe("wall-not-found");
  });
});

describe("updateWall", () => {
  it("moves a connected endpoint, keeps the neighbour joined, and preserves GlobalIds", () => {
    const before = [...bytes];
    const target = geom({ start: [0, 0], end: [4, 1] });
    const plan = planWallUpdate(api, bytes, A, target);
    expect(plan.map(c => [c.globalId, c.kind, c.cause])).toEqual([[A, "updated", "requested"], [B, "updated", "connected"]]);
    const result = updateWall(api, bytes, A, target);
    expect(wallGuids(result)).toEqual(wallGuids(bytes));
    near(readWall(api, result, A).end, [4, 1]);
    const b = readWall(api, result, B);
    near(b.start, [4, 1]); near(b.end, [4, 3]);
    expect(b.thickness).toBeCloseTo(0.2);
    near(readWall(api, result, C).start, [10, 0]);
    expect(readWall(api, result, A).connections).toEqual([{ wallGlobalId: B, end: "end", otherEnd: "start" }]);
    expect([...bytes]).toEqual(before);
  });
  it("propagates from the neighbour's side as well", () => {
    const result = updateWall(api, bytes, B, geom({ start: [5, 0], end: [5, 3] }));
    near(readWall(api, result, A).end, [5, 0]);
    near(readWall(api, result, A).start, [0, 0]);
  });
  it("changes thickness, height and elevation without touching neighbours", () => {
    const target = geom({ start: [0, 0], end: [4, 0], thickness: 0.3, height: 3, elevation: 0.5 });
    expect(planWallUpdate(api, bytes, A, target).map(c => c.globalId)).toEqual([A]);
    const result = updateWall(api, bytes, A, target);
    const a = readWall(api, result, A);
    expect(a.thickness).toBeCloseTo(0.3); expect(a.height).toBeCloseTo(3); expect(a.elevation).toBeCloseTo(0.5);
    near(readWall(api, result, B).start, [4, 0]);
  });
  it("rewrites a standalone wall and is deterministic", () => {
    const target = geom({ start: [10, 1], end: [10, 4], thickness: 0.15, height: 2.4 });
    const one = updateWall(api, bytes, C, target), two = updateWall(api, bytes, C, target);
    expect([...one]).toEqual([...two]);
    near(readWall(api, one, C).end, [10, 4]);
  });
  it("is reversible by writing the original geometry back (semantically)", () => {
    const original = readWall(api, bytes, A);
    const moved = updateWall(api, bytes, A, geom({ start: [0, 0], end: [4, 1] }));
    const back = updateWall(api, moved, A, { start: original.start, end: original.end, thickness: original.thickness, height: original.height, elevation: original.elevation });
    for (const guid of [A, B, C, D]) {
      const x = readWall(api, back, guid), y = readWall(api, bytes, guid);
      near(x.start, y.start); near(x.end, y.end); expect(x.height).toBeCloseTo(y.height);
    }
  });
  it.each([
    ["non-finite coordinate", geom({ start: [NaN, 0], end: [4, 0] })],
    ["zero length", geom({ start: [1, 1], end: [1, 1] })],
    ["non-positive thickness", geom({ start: [0, 0], end: [4, 0], thickness: 0 })],
    ["excessive height", geom({ start: [0, 0], end: [4, 0], height: 101 })],
    ["non-finite elevation", geom({ start: [0, 0], end: [4, 0], elevation: Infinity })],
  ])("rejects %s with invalid-geometry and leaves bytes unchanged", (_label, target) => {
    const before = [...bytes];
    expect(code(() => updateWall(api, bytes, A, target))).toBe("invalid-geometry");
    expect([...bytes]).toEqual(before);
  });
  it("rejects an edit that would collapse a connected neighbour, naming it", () => {
    try { updateWall(api, bytes, A, geom({ start: [0, 0], end: [4, 3] })); } catch (e) {
      expect(e).toBeInstanceOf(WallEditError);
      expect((e as WallEditError).code).toBe("invalid-geometry");
      expect((e as WallEditError).message).toContain(B);
      return;
    }
    throw new Error("expected failure");
  });
  it("rejects walls hosting an opening (openings are not re-hosted)", () => {
    expect(code(() => updateWall(api, bytes, D, geom({ start: [0, 5], end: [3, 6] })))).toBe("hosted-opening");
  });
  it("rejects T-junction (path) connections when the axis changes", () => {
    const tee = enc(fixture.replace(".ATSTART.,.ATEND.", ".ATSTART.,.ATPATH."));
    expect(code(() => updateWall(api, tee, A, geom({ start: [0, 0], end: [4, 1] })))).toBe("unsupported-connection");
    // Dimension-only changes do not move the junction and stay allowed.
    expect(() => updateWall(api, tee, A, geom({ start: [0, 0], end: [4, 0], height: 3 }))).not.toThrow();
  });
  it("rejects non-rectangular representations", () => {
    const odd = enc(fixture.replace("(4.0,0.2),(4.0,0.),(0.,0.)))", "(4.0,0.2),(4.0,0.)))"));
    expect(code(() => updateWall(api, odd, A, geom({ start: [0, 0], end: [4, 1] })))).toBe("unsupported-representation");
  });
});

describe("createWall / removeWall", () => {
  const fresh = "0TeldraNewWallAAAAAAA1";
  const input = { globalId: fresh, storeyGlobalId: STOREY, name: "New wall", geometry: geom({ start: [0, 8], end: [5, 8] }) };
  it("creates a contained wall with the supplied GlobalId", () => {
    const result = createWall(api, bytes, input);
    expect(wallGuids(result)).toEqual([A, B, C, D, fresh].sort());
    const w = readWall(api, result, fresh);
    near(w.start, [0, 8]); near(w.end, [5, 8]); expect(w.connections).toEqual([]);
    near(readWall(api, result, A).end, [4, 0]);
    expect(planWallCreate(api, bytes, input).map(c => [c.globalId, c.kind])).toEqual([[fresh, "created"]]);
    expect(createWall(api, bytes, input)).toEqual(result);
  });
  it("round-trips new geometry through update", () => {
    const result = updateWall(api, createWall(api, bytes, input), fresh, geom({ start: [0, 8], end: [5, 9] }));
    near(readWall(api, result, fresh).end, [5, 9]);
  });
  it("rejects duplicate GlobalIds, malformed GlobalIds, unknown storeys and bad geometry", () => {
    expect(code(() => createWall(api, bytes, { ...input, globalId: A }))).toBe("duplicate-global-id");
    expect(code(() => createWall(api, bytes, { ...input, globalId: "short" }))).toBe("invalid-global-id");
    expect(code(() => createWall(api, bytes, { ...input, storeyGlobalId: "0TeldraNoStoreyAAAAAA1" }))).toBe("storey-not-found");
    expect(code(() => createWall(api, bytes, { ...input, geometry: geom({ start: [0, 0], end: [0, 0] }) }))).toBe("invalid-geometry");
  });
  it("removes a standalone wall and keeps the others", () => {
    expect(planWallRemove(api, bytes, C).map(c => [c.globalId, c.kind])).toEqual([[C, "removed"]]);
    const result = removeWall(api, bytes, C);
    expect(wallGuids(result)).toEqual([A, B, D].sort());
    expect(code(() => readWall(api, result, C))).toBe("wall-not-found");
    near(readWall(api, result, B).end, [4, 3]);
  });
  it("creates then removes without leaving the wall behind", () => {
    const removed = removeWall(api, createWall(api, bytes, input), fresh);
    expect(wallGuids(removed)).toEqual([A, B, C, D]);
    expect(code(() => readWall(api, removed, fresh))).toBe("wall-not-found");
  });
  it("refuses to remove connected or opening-hosting walls", () => {
    expect(code(() => removeWall(api, bytes, A))).toBe("wall-referenced");
    expect(code(() => removeWall(api, bytes, D))).toBe("hosted-opening");
  });
});
