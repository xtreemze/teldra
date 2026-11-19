// @ts-nocheck
// Opt-in performance profile. Skipped unless TELDRA_PERF_IFC points at a building.ifc (e.g. extracted from
// examples/21d-sweethome3d/21D-demo.teldra); TELDRA_PERF_RUNS sets samples per row (default 10):
//   TELDRA_PERF_IFC=/path/building.ifc pnpm --filter @teldra/ifc-edit exec vitest run test/profile-21d.perf.test.ts --silent=false
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { IfcAPI, IFCFURNITURE, IFCWALL, IFCWALLSTANDARDCASE } from "web-ifc";
import * as edit from "../src/index.js";
import { SessionIndex } from "../src/session-core.js";

const path = process.env.TELDRA_PERF_IFC;
const RUNS = Number(process.env.TELDRA_PERF_RUNS ?? 10);
const now = () => performance.now();
const stat = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; return `${q(0.5).toFixed(0).padStart(5)} / ${q(0.95).toFixed(0).padStart(5)}`; };

describe.skipIf(!path)("21D profile", () => {
  it("profiles", async () => {
    const api = new IfcAPI(); await api.Init();
    const bytes = new Uint8Array(readFileSync(path));
    // Phase accumulators: serialization (SaveModel), open (OpenModel), index preparation (inverse snapshot).
    const acc = { save: 0, open: 0, prep: 0 };
    const patch = (obj, key, field) => { const original = obj[key]; obj[key] = function (...a) { const t = now(); try { return original.apply(this, a); } finally { acc[field] += now() - t; } }; };
    patch(api, "SaveModel", "save"); patch(api, "OpenModel", "open"); patch(SessionIndex.prototype, "snapshot", "prep");

    const id = api.OpenModel(bytes);
    const furn = []; const ids = api.GetLineIDsWithType(id, IFCFURNITURE); for (let i = 0; i < ids.size(); i++) furn.push(api.GetLine(id, ids.get(i)).GlobalId.value);
    const walls = []; for (const ty of [IFCWALL, IFCWALLSTANDARDCASE]) { const w = api.GetLineIDsWithType(id, ty); for (let i = 0; i < w.size(); i++) walls.push(api.GetLine(id, w.get(i)).GlobalId.value); }
    api.CloseModel(id);
    const guidFor = (n) => { const base = "2gEfmKcdn6c9fX3LLRJBkX"; return base.slice(0, 18) + String(1000 + n).padStart(4, "0"); };
    const g = furn.find(f => { try { edit.duplicateFurniture(api, bytes, f, guidFor(0)); return true; } catch { return false; } });
    const w = walls.find(x => { try { const r = edit.readWall(api, bytes, x); edit.updateWall(api, bytes, x, { ...r, thickness: r.thickness + 0.01 }); return true; } catch { return false; } });
    const rec = edit.readWall(api, bytes, w);
    const pose = (k) => ({ position: [1 + k * 0.01, 1, 0], yawRadians: 0.3 });

    const rows = [];
    // total/lookup/prep/mutation/save in ms for one op; mutation = total - open - prep - save.
    const sample = (label, fn) => {
      acc.save = acc.open = acc.prep = 0;
      const t = now(); fn(); const total = now() - t;
      return { total, open: acc.open, prep: acc.prep, save: acc.save, mutation: total - acc.open - acc.prep - acc.save };
    };
    const report = (label, samples) => {
      const col = (k) => stat(samples.map(s => s[k]));
      rows.push(`${label.padEnd(40)} total ${col("total")} | open ${col("open")} | prep ${col("prep")} | mutate+lookup ${col("mutation")} | save ${col("save")}`);
    };
    const bench = (label, make) => { const out = []; for (let i = 0; i < RUNS; i++) out.push(make(i)); report(label, out); };

    // Cold: every sample opens the model and builds the index from scratch (fresh one-shot call).
    bench("cold  duplicate", i => sample("", () => edit.duplicateFurniture(api, bytes, g, guidFor(i), { offset: [0.5, 0, 0] })));
    bench("cold  remove", i => sample("", () => edit.removeFurniture(api, bytes, g)));
    bench("cold  writeFurniturePose", i => sample("", () => edit.writeFurniturePose(api, bytes, g, pose(i))));
    bench("cold  updateWall", i => sample("", () => edit.updateWall(api, bytes, w, { ...rec, thickness: rec.thickness + 0.01 + i * 0.001 })));
    bench("cold  readFurniturePose (lookup)", i => sample("", () => edit.readFurniturePose(api, bytes, g)));

    // Warm: one session; the model is already open for the sampled operation.
    let s = edit.openEditSession(api, bytes);
    s.run(b => edit.readFurniturePose(api, b, g));
    bench("warm  readFurniturePose (lookup)", i => sample("", () => s.run(b => edit.readFurniturePose(api, b, g))));
    s.run(b => edit.duplicateFurniture(api, b, g, guidFor(50)));               // builds the index
    bench("warm  duplicate", i => sample("", () => s.run(b => edit.duplicateFurniture(api, b, g, guidFor(100 + i), { offset: [0.1 * i, 0, 0] }))));
    bench("warm  writeFurniturePose", i => sample("", () => s.run(b => edit.writeFurniturePose(api, b, g, pose(i)))));
    bench("warm  updateWall", i => sample("", () => s.run(b => edit.updateWall(api, b, w, { ...rec, thickness: rec.thickness + 0.01 + i * 0.001 }))));
    // remove: pair with a duplicate so each remove runs on an open model with the index built.
    const removeSamples = [], reopenSamples = [];
    for (let i = 0; i < RUNS; i++) {
      reopenSamples.push(sample("", () => s.run(b => edit.duplicateFurniture(api, b, g, guidFor(200 + i)))));  // first op after the previous remove: reopens
      removeSamples.push(sample("", () => s.run(b => edit.removeFurniture(api, b, guidFor(200 + i)))));
    }
    report("warm  remove", removeSamples);
    report("after-remove duplicate (reopen+index)", reopenSamples);
    s.close();
    console.log("\nmedian / p95 in ms over " + RUNS + " runs, 21D (" + (bytes.length / 1e6).toFixed(1) + " MB)\n" + rows.join("\n"));
  }, 900000);
});
