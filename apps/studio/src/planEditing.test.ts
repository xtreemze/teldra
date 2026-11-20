import { beforeAll, describe, expect, it } from "vitest";
import { IfcAPI } from "web-ifc";
import { IfcWallEditor } from "@teldra/application";
import { createIfcWallAdapter, readPlanSource } from "@teldra/ifc-edit";
import { frameStoreyPlan, overlayWallChanges, projectStoreyPlan } from "@teldra/projection";
import {
  explainRefusal, moveEndpoint, newIfcGlobalId, resizeWallLength, snapPlanPoint, translateWall, tryApply, tryPreview, updateOp, wallEndpoints,
} from "./planEditing";

import connectedIfc from "../../../fixtures/ifc/connected-walls/building.ifc?raw";
import goldenIfc from "../../../fixtures/projects/golden-home/building.ifc?raw";
const connected = new TextEncoder().encode(connectedIfc);
const golden = new TextEncoder().encode(goldenIfc);
const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1", C = "0TeldraWallCCCCCCCCCC1", D = "0TeldraWallDDDDDDDDDD1";
const STOREY = "0TeldraStoreyAAAAAAAA1", NEW = "0TeldraNewWallAAAAAAA1";
let api: IfcAPI;
beforeAll(async () => { api = new IfcAPI(); await api.Init(); });
const newEditor = (bytes = connected) => new IfcWallEditor(bytes, createIfcWallAdapter(api));
const planOf = (editor: IfcWallEditor) => {
  const source = readPlanSource(api, editor.bytes);
  return projectStoreyPlan(source, STOREY, frameStoreyPlan(source, STOREY, { width: 640, height: 400 }));
};

describe("snapPlanPoint", () => {
  const base = { gridEnabled: true, angleStepDegrees: 0, endpoints: [], endpointRadiusMetres: 0.3 };
  it("snaps to the grid, to endpoints (priority) and to axis angles with a grid-snapped length", () => {
    expect(snapPlanPoint([1.13, 2.4], base)).toEqual({ point: [1.25, 2.5], kind: "grid" });
    expect(snapPlanPoint([1.13, 2.4], { ...base, gridEnabled: false })).toEqual({ point: [1.13, 2.4], kind: "none" });
    expect(snapPlanPoint([3.9, 0.1], { ...base, endpoints: [[4, 0]] })).toEqual({ point: [4, 0], kind: "endpoint" });
    const angle = snapPlanPoint([3.1, 0.9], { ...base, angleStepDegrees: 45, anchor: [0, 0] });
    expect(angle.kind).toBe("angle");
    expect(angle.point[1]).toBeCloseTo(0, 9);
    expect(angle.point[0]).toBeCloseTo(3.25, 9);
    const exact = snapPlanPoint([2.0, 2.1], { ...base, angleStepDegrees: 45, anchor: [0, 0] });
    expect(exact.point[0]).toBeCloseTo(exact.point[1], 6);
    expect(Math.hypot(...exact.point) / 0.25).toBeCloseTo(Math.round(Math.hypot(...exact.point) / 0.25), 6);
  });
  it("excludes the dragged wall and coincident joined endpoints from snap candidates", () => {
    const plan = planOf(newEditor());
    const points = wallEndpoints(plan.walls, new Set([A]), [[4, 0]]);
    expect(points).toEqual([[4, 3], [10, 0], [12, 0], [0, 5], [3, 5]]);
  });
});

describe("plan edits on the shared IfcWallEditor (connected-walls)", () => {
  it("dragging a joined endpoint previews the connected wall following, then applies and undoes as one unit", () => {
    const editor = newEditor();
    const wallA = planOf(editor).walls.find((w) => w.ifcGlobalId === A)!;
    const op = updateOp(A, moveEndpoint(wallA, "end", [4, 1]));
    const preview = tryPreview(editor, op);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.changes.map((c) => [c.globalId, c.cause])).toEqual([[A, "requested"], [B, "connected"]]);
    const overlaid = overlayWallChanges(planOf(editor), preview.changes);
    expect(overlaid.walls.find((w) => w.ifcGlobalId === B)).toMatchObject({ preview: true });
    expect(overlaid.walls.find((w) => w.ifcGlobalId === B)!.start[1]).toBeCloseTo(1);
    expect(editor.history.canUndo).toBe(false); // preview never touches history
    expect(tryApply(editor, op).ok).toBe(true);
    expect(editor.history.undoDepth).toBe(1);
    expect(planOf(editor).walls.find((w) => w.ifcGlobalId === B)!.start[1]).toBeCloseTo(1);
    editor.undo();
    expect([...editor.bytes]).toEqual([...connected]);
  });
  it("translates a whole wall, resizes length and changes thickness/height numerically", () => {
    const editor = newEditor();
    const wallC = planOf(editor).walls.find((w) => w.ifcGlobalId === C)!;
    expect(tryApply(editor, updateOp(C, translateWall(wallC, [10, 2]))).ok).toBe(true);
    let now = planOf(editor).walls.find((w) => w.ifcGlobalId === C)!;
    expect(now.start).toEqual([10, 2]); expect(now.end).toEqual([12, 2]);
    expect(tryApply(editor, updateOp(C, resizeWallLength(now, 3.5))).ok).toBe(true);
    now = planOf(editor).walls.find((w) => w.ifcGlobalId === C)!;
    expect(now.length).toBeCloseTo(3.5);
    expect(tryApply(editor, updateOp(C, { ...resizeWallLength(now, 3.5), thickness: 0.3, height: 2.8 })).ok).toBe(true);
    now = planOf(editor).walls.find((w) => w.ifcGlobalId === C)!;
    expect(now).toMatchObject({ thickness: 0.3, height: 2.8 });
    expect(editor.history.undoDepth).toBe(3);
  });
  it("draws a new wall into the active storey with a fresh GlobalId and removes it again", () => {
    const editor = newEditor();
    const taken = new Set(planOf(editor).walls.map((w) => w.ifcGlobalId));
    const id = newIfcGlobalId(taken);
    expect(id).toMatch(/^[0-3][0-9A-Za-z_$]{21}$/);
    const geometry = { start: [0, 8] as [number, number], end: [5, 8] as [number, number], thickness: 0.2, height: 2.5, elevation: 0 };
    expect(tryApply(editor, { kind: "create", globalId: id, storeyGlobalId: STOREY, name: "Wall 5", geometry }).ok).toBe(true);
    expect(planOf(editor).walls.map((w) => w.ifcGlobalId)).toContain(id);
    expect(tryApply(editor, { kind: "remove", globalId: id }).ok).toBe(true);
    expect(planOf(editor).walls.map((w) => w.ifcGlobalId)).not.toContain(id);
  });
  it("refuses a wall hosting an opening with an explicit message and leaves bytes and history untouched", () => {
    const editor = newEditor();
    const wallD = planOf(editor).walls.find((w) => w.ifcGlobalId === D)!;
    expect(wallD.hostsOpenings).toBe(true);
    for (const outcome of [tryPreview(editor, updateOp(D, moveEndpoint(wallD, "end", [3, 6]))), tryApply(editor, { kind: "remove", globalId: D })]) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) { expect(outcome.code).toBe("hosted-opening"); expect(outcome.message).toMatch(/hosts a door or window opening/); }
    }
    expect([...editor.bytes]).toEqual([...connected]);
    expect(editor.history).toMatchObject({ revision: 0, canUndo: false });
  });
  it("refuses deleting a wall that is joined to another, and invalid geometry", () => {
    const editor = newEditor();
    const removal = tryApply(editor, { kind: "remove", globalId: A });
    expect(removal.ok).toBe(false);
    const wallC = planOf(editor).walls.find((w) => w.ifcGlobalId === C)!;
    const bad = tryApply(editor, updateOp(C, moveEndpoint(wallC, "end", wallC.start)));
    expect(bad).toMatchObject({ ok: false });
    expect(editor.history.canUndo).toBe(false);
  });
  it("explains unknown refusals verbatim", () => {
    expect(explainRefusal(new Error("boom"))).toEqual({ code: "refused", message: "Refused: boom" });
  });
});

describe("plan editing over golden-home", () => {
  it("hosted-opening wall0 is refused while a free wall edits normally", () => {
    const editor = newEditor(golden);
    const source = readPlanSource(api, golden);
    const storey = source.storeys[0]!.globalId;
    const plan = projectStoreyPlan(source, storey, frameStoreyPlan(source, storey, { width: 640, height: 400 }));
    const hosted = plan.walls.find((w) => w.hostsOpenings)!;
    const refused = tryPreview(editor, updateOp(hosted.ifcGlobalId, moveEndpoint(hosted, "end", [hosted.end[0] + 0.5, hosted.end[1]])));
    expect(refused).toMatchObject({ ok: false, code: "hosted-opening" });
    const free = plan.walls.find((w) => !w.hostsOpenings && w.connections.length === 0);
    if (free) expect(tryPreview(editor, updateOp(free.ifcGlobalId, translateWall(free, [free.start[0] + 0.25, free.start[1]]))).ok).toBe(true);
  });
});
