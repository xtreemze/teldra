import { beforeAll, describe, expect, it } from "vitest";
import golden from "../../../fixtures/projects/golden-home/building.ifc?raw";
import walls from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import { Handle, IfcAPI, IFCLOCALPLACEMENT, IFCWALL } from "web-ifc";
import {
  createWall, duplicateFurniture, openEditSession, readFurniturePose, readWall, removeFurniture, removeWall,
  reuseEditSession, updateWall, writeFurniturePose, FurnitureLifecycleError, type WallGeometry,
} from "../src/index.js";
import { model } from "../src/ifc-session.js";
import { indexOf } from "../src/session-core.js";

const enc = (text: string) => new TextEncoder().encode(text);
let api: IfcAPI;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); });

const same = (a: Uint8Array, b: Uint8Array) => { expect(a.length).toBe(b.length); expect(a.every((v, i) => v === b[i])).toBe(true); };
const g1 = "2gEfmKcdn6c9fX3LLRJBkX", g2 = "1gEfmKcdn6c9fX3LLRJBkY", g3 = "0gEfmKcdn6c9fX3LLRJBkZ";
const chair = (() => {
  const m = golden.match(/^#\d+=IFCFURNITURE\('([^']+)',\$,'Chair'/m);
  if (!m) throw new Error("golden-home fixture no longer has a Chair.");
  return m[1]!;
})();

/** Full-scan inverse, exactly what the legacy implementation rebuilt for every operation. */
function legacyInverse(a: IfcAPI, id: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const all = a.GetAllLines(id);
  const walk = (value: any, from: number) => {
    if (Array.isArray(value)) value.forEach((item) => walk(item, from));
    else if (value && value.type === 5 && Number.isInteger(value.value)) { const l = out.get(value.value); if (l) { if (!l.includes(from)) l.push(from); } else out.set(value.value, [from]); }
  };
  for (let i = 0; i < all.size(); i++) {
    const e = all.get(i); let line: any; try { line = a.GetLine(id, e); } catch { continue; }
    for (const key of Object.keys(line)) if (key !== "expressID" && key !== "type") walk(line[key], e);
  }
  return out;
}
function expectIndexMatchesFullScan(bytes: Uint8Array) {
  // Expected = full scan of a *fresh* open of the saved bytes (what the legacy code did each operation).
  const fresh = api.OpenModel(bytes);
  let expected: Map<number, number[]>;
  try { expected = legacyInverse(api, fresh); } finally { api.CloseModel(fresh); }
  model(api, bytes, (_id, tracked) => {
    const snapshot = indexOf(tracked).snapshot();
    for (const [target, referrers] of expected) expect(snapshot.get(target)).toEqual(referrers);
  });
}

/** Runs the chain with fresh one-shot calls and again inside one session; every step must be byte-identical. */
function chainEquivalence(start: Uint8Array, steps: Array<(b: Uint8Array) => Uint8Array>) {
  let oneShot = start; const expected: Uint8Array[] = [];
  for (const step of steps) { oneShot = step(oneShot); expected.push(oneShot); }
  const session = openEditSession(api, start);
  try {
    steps.forEach((step, i) => {
      const before = session.bytes;
      const out = session.run(step);
      same(out, expected[i]!);
      expect(session.bytes).toBe(out);          // session advanced to the saved revision
      expect(before).not.toBe(out);
      expectIndexMatchesFullScan(out);          // index agrees with a full scan of the saved bytes
    });
  } finally { session.close(); }
  return expected;
}

describe("edit session equivalence on golden-home", () => {
  const start = enc(golden);
  it("duplicate/pose/remove chains are byte-identical to one-shot calls", () => {
    chainEquivalence(start, [
      (b) => duplicateFurniture(api, b, chair, g1, { offset: [0.5, 0, 0], name: "Chair copy" }),
      (b) => writeFurniturePose(api, b, g1, { position: [2, 1, 0], yawRadians: 0.4 }),
      (b) => duplicateFurniture(api, b, g1, g2),
      (b) => removeFurniture(api, b, g1),
      (b) => duplicateFurniture(api, b, chair, g3, { offset: [0, 1, 0] }),
      (b) => removeFurniture(api, b, g2),
      (b) => removeFurniture(api, b, g3),
    ]);
  });
  it("does not mutate caller bytes and leaves the revision reusable after a refusal", () => {
    const original = start.slice();
    const session = openEditSession(api, start);
    try {
      const out = session.run((b) => duplicateFurniture(api, b, chair, g1));
      expect(() => session.run((b) => duplicateFurniture(api, b, chair, g1))).toThrow(FurnitureLifecycleError);
      expect(() => session.run((b) => removeFurniture(api, b, "0000000000000000000000"))).toThrow(FurnitureLifecycleError);
      expect(session.bytes).toBe(out);
      same(session.run((b) => removeFurniture(api, b, g1)), removeFurniture(api, out, g1));
      expect(readFurniturePose(api, out, g1).position).toHaveLength(3);
    } finally { session.close(); }
    same(start, original);
  });
  it("reuses the session only for the same revision object", () => {
    const first = reuseEditSession(null, api, start);
    expect(reuseEditSession(first, api, start)).toBe(first);
    const next = first.run((b) => duplicateFurniture(api, b, chair, g1));
    expect(reuseEditSession(first, api, next)).toBe(first);
    const other = reuseEditSession(first, api, start.slice());
    expect(other).not.toBe(first);
    other.close();
  });
  it("rejects in-place mutation of an adopted revision", () => {
    const bytes = start.slice();
    const session = openEditSession(api, bytes);
    try {
      bytes.fill(32, 0, bytes.length);
      expect(() => session.run((b) => readFurniturePose(api, b, chair))).toThrow(/mutated/);
    } finally { session.close(); }
  });
});

describe("edit session equivalence on connected-walls", () => {
  const start = enc(walls);
  const geom = (overrides: Partial<WallGeometry> = {}): WallGeometry => ({ start: [0, 0], end: [5, 0], thickness: 0.2, height: 2.8, elevation: 0, ...overrides });
  const wallGuids = (data: Uint8Array): string[] => {
    const id = api.OpenModel(data);
    try { const ids = api.GetLineIDsWithType(id, IFCWALL); const out: string[] = []; for (let i = 0; i < ids.size(); i++) out.push((api.GetLine(id, ids.get(i)) as any).GlobalId.value); return out.sort(); }
    finally { api.CloseModel(id); }
  };
  it("update/create/remove chains are byte-identical to one-shot calls", () => {
    const [first] = wallGuids(start);
    const storey = walls.match(/IFCBUILDINGSTOREY\('([^']+)'/)![1]!;
    const fresh = "0TeldraWallEEEEEEEEEE1";
    const record = readWall(api, start, first!);
    chainEquivalence(start, [
      (b) => updateWall(api, b, first!, { ...record, end: [record.end[0] + 0.5, record.end[1]], thickness: record.thickness }),
      (b) => createWall(api, b, { globalId: fresh, storeyGlobalId: storey, name: "Session wall", geometry: geom({ start: [0, 9], end: [4, 9] }) }),
      (b) => updateWall(api, b, fresh, geom({ start: [0, 9], end: [4, 10], thickness: 0.3 })),
      (b) => removeWall(api, b, fresh),
    ]);
  });
  it("read-only operations keep the revision and the open model", () => {
    const session = openEditSession(api, start);
    try {
      const [first] = wallGuids(start);
      const a = session.run((b) => readWall(api, b, first!));
      expect(session.isOpen).toBe(true);
      expect(session.run((b) => readWall(api, b, first!))).toEqual(a);
      expect(session.bytes).toBe(start);
    } finally { session.close(); }
    expect(session.isOpen).toBe(false);
  });
});

describe("index invalidation", () => {
  const start = enc(golden);
  const check = (session: ReturnType<typeof openEditSession>) => session.run((b) => expectIndexMatchesFullScan(b));
  it("follows add, remove, undo (byte restore), redo and model replacement", () => {
    let session = openEditSession(api, start);
    try {
      check(session);                                                                   // index built on revision 0
      const added = session.run((b) => duplicateFurniture(api, b, chair, g1));          // add
      check(session);
      const removed = session.run((b) => removeFurniture(api, b, g1));                  // remove (model reopens)
      check(session);
      same(removed, removeFurniture(api, added, g1));
      session = reuseEditSession(session, api, added);                                  // undo: restore earlier bytes
      expect(session.bytes).toBe(added);
      check(session);
      session.run((b) => removeFurniture(api, b, g1));                                  // redo from the restored revision
      same(session.bytes, removed);
      check(session);
      session = reuseEditSession(session, api, enc(walls));                             // model replacement: unrelated bytes
      check(session);
      expect(() => session.run((b) => readFurniturePose(api, b, chair))).toThrow();     // golden furniture is gone
    } finally { session.close(); }
  });
  it("does not reflect a failed (rolled back) transaction", () => {
    const session = openEditSession(api, start);
    try {
      check(session);
      const axis = Number(golden.match(/^#(\d+)=IFCAXIS2PLACEMENT3D\(/m)![1]);
      const before = session.bytes;
      expect(() => session.run((b) => model(api, b, (id, tracked) => {
        indexOf(tracked).snapshot();
        tracked.CreateIfcEntity(id, IFCLOCALPLACEMENT, null, new Handle(axis));   // a new referrer of `axis`
        throw new Error("abort after write");
      }))).toThrow("abort after write");
      expect(session.bytes).toBe(before);
      check(session);                                                              // index == fresh scan of the untouched bytes
      const out = session.run((b) => duplicateFurniture(api, b, chair, g1));
      same(out, duplicateFurniture(api, start, chair, g1));                          // later ops unaffected by the aborted write
    } finally { session.close(); }
  });
});
