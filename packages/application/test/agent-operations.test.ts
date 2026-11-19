import { describe, expect, it } from "vitest";
import type { TwinProject } from "@teldra/domain";
import {
  AGENT_OPERATION_SCHEMA, AgentOperationError, IfcFurnitureEditor, IfcWallEditor, TwinEditor, createAgentOperationSurface, validateAgentSchema,
  type AgentOperation, type AgentProposal, type IfcFurnitureAdapter, type IfcWallAdapter, type IfcWallChange, type IfcWallGeometry, type IfcWallOperation,
} from "../src/index.js";

const WALL = "0TeldraWallAAAAAAAAAA1", WALL_B = "0TeldraWallBBBBBBBBBB1", CHAIR = "0TeldraChairAAAAAAAA1", SOFA = "0TeldraSofaAAAAAAAAA1";
const twinFixture: TwinProject = {
  schemaVersion: "0.1.0",
  building: { ifcSchema: "IFC4", refs: [
    { id: "storey:1", ifcGlobalId: "0TeldraStoreyAAAAAAAA1", kind: "storey", name: "Ground" },
    { id: "wall:a", ifcGlobalId: WALL, kind: "wall", name: "North" },
    { id: "wall:b", ifcGlobalId: WALL_B, kind: "wall", name: "East" },
    { id: "chair:1", ifcGlobalId: CHAIR, kind: "furniture", name: "Chair" },
    { id: "sofa:1", ifcGlobalId: SOFA, kind: "furniture", name: "Sofa" },
    { id: "space:1", ifcGlobalId: "0TeldraSpaceAAAAAAAA1", kind: "space", name: "Living" },
  ] },
  devices: [{ id: "device:lamp", name: "Lamp", buildingRefId: "chair:1", capabilities: [{ id: "cap:lamp:light", kind: "light", properties: { brightness: 50 } }] }],
  bindings: [{ id: "binding:lamp:ha", deviceId: "device:lamp", adapter: "home-assistant", externalId: "light.secret_entity", capabilityMap: { "cap:lamp:light": "light" } }],
};

const g = (sx: number, sy: number, ex: number, ey: number): IfcWallGeometry => ({ start: [sx, sy], end: [ex, ey], thickness: 0.2, height: 2.5, elevation: 0 });
type Store = { walls: Record<string, IfcWallGeometry>; furniture: Record<string, { p: number[]; y: number; s: number[] | null }> };
const enc = (s: Store) => new TextEncoder().encode(JSON.stringify(s));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as Store;
const initial: Store = {
  walls: { [WALL]: g(0, 0, 4, 0), [WALL_B]: g(4, 0, 4, 3) },
  furniture: { [CHAIR]: { p: [1, 1, 0], y: 0, s: [1, 1, 1] }, [SOFA]: { p: [2, 2, 0], y: 0, s: null } },
};
const wallAdapter: IfcWallAdapter = {
  read: (bytes, id) => { const w = dec(bytes).walls[id]; if (!w) throw new Error("Wall not found in IFC."); return { ...w, connections: id === WALL ? [{ wallGlobalId: WALL_B, end: "end", otherEnd: "start" }] : [] }; },
  plan: (bytes, op: IfcWallOperation): IfcWallChange[] => {
    const s = dec(bytes).walls;
    if (op.kind !== "update") throw new Error("only update");
    const before = s[op.globalId]; if (!before) throw new Error("missing");
    const out: IfcWallChange[] = [{ globalId: op.globalId, kind: "updated", cause: "requested", before, after: op.geometry }];
    if (op.globalId === WALL) out.push({ globalId: WALL_B, kind: "updated", cause: "connected", before: s[WALL_B]!, after: { ...s[WALL_B]!, start: op.geometry.end } });
    return out;
  },
  apply: (bytes, op) => { const s = dec(bytes); for (const c of wallAdapter.plan(bytes, op)) s.walls[c.globalId] = c.after!; return enc(s); },
};
const furnitureAdapter: IfcFurnitureAdapter = {
  read: (bytes, id) => { const f = dec(bytes).furniture[id]; if (!f) throw new Error("Furniture not found."); return { position: f.p as [number, number, number], yawRadians: f.y }; },
  write: (bytes, id, pose) => { const s = dec(bytes); s.furniture[id]!.p = [...pose.position]; s.furniture[id]!.y = pose.yawRadians; return enc(s); },
  readScale: (bytes, id) => { const f = dec(bytes).furniture[id]; if (!f?.s) throw new Error("This IFC representation cannot be scaled safely."); return f.s as [number, number, number]; },
  writeScale: (bytes, id, scale) => { const s = dec(bytes); s.furniture[id]!.s = [...scale]; return enc(s); },
};

function setup() {
  const twin = new TwinEditor(twinFixture);
  const walls = new IfcWallEditor(enc(initial), wallAdapter);
  const furniture = new IfcFurnitureEditor(enc(initial), furnitureAdapter);
  const surface = createAgentOperationSurface({
    twin, walls, furniture, agentId: "agent:test", now: () => "2026-01-01T00:00:00Z",
    storeyOf: (id) => (id === "chair:1" || id === "wall:a" || id === "storey:1" ? "storey:1" : null),
  });
  const call = <T = any>(name: string, input: unknown = {}) => surface.callTool(name, input) as T;
  const propose = (operation: AgentOperation, summary = "because") => call<AgentProposal>("teldra_propose_operation", { summary, operation });
  return { twin, walls, furniture, surface, call, propose };
}
const moveChair = (x: number): Extract<AgentOperation, { kind: "furniture.transform" }> => ({ kind: "furniture.transform", canonicalId: "chair:1", position: [x, 1, 0], yawRadians: 0.5 });

describe("tool contracts", () => {
  const { surface } = setup();
  const expectedNames = ["teldra_inspect_project", "teldra_list_entities", "teldra_get_entity", "teldra_list_capabilities", "teldra_propose_operation", "teldra_list_proposals", "teldra_get_proposal"];
  it("publishes exactly the documented strict tools with object schemas", () => {
    expect(surface.tools.map((t) => t.name)).toEqual(expectedNames);
    for (const tool of surface.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.readOnly).toBe(true);
    }
  });
  it("never exposes human decisions, code execution or device control as tools", () => {
    const text = JSON.stringify(surface.tools.map((t) => [t.name, t.description, t.inputSchema])).toLowerCase();
    const names = surface.tools.map((t) => t.name).join(" ");
    for (const decision of ["approve", "reject", "revert", "apply"]) expect(names.includes(decision), decision).toBe(false);
    for (const forbidden of ["evaluate", "run_script", "javascript", "call_service", "turn_on", "home-assistant", "home assistant", "execute code"]) {
      expect(text.includes(forbidden), forbidden).toBe(false);
    }
    expect(JSON.stringify(AGENT_OPERATION_SCHEMA)).not.toMatch(/capabilit|binding|service/i);
  });
  const valid: Record<string, unknown> = {
    teldra_inspect_project: {}, teldra_list_entities: { entityType: "wall", offset: 0, limit: 10 }, teldra_get_entity: { canonicalId: "wall:a" },
    teldra_list_capabilities: { canonicalId: "chair:1" }, teldra_propose_operation: { summary: "x", operation: moveChair(2) },
    teldra_list_proposals: { status: "pending" }, teldra_get_proposal: { proposalId: "proposal:1" },
  };
  const invalid: Record<string, unknown[]> = {
    teldra_inspect_project: [{ extra: 1 }],
    teldra_list_entities: [{ limit: 101 }, { limit: 0 }, { offset: -1 }, { offset: "0" }, { entityType: "ufo" }, { extra: 1 }],
    teldra_get_entity: [{}, { canonicalId: "" }, { canonicalId: 5 }],
    teldra_list_capabilities: [{}, { canonicalId: "a".repeat(300) }],
    teldra_propose_operation: [{}, { summary: "x" }, { summary: "", operation: moveChair(1) }, { summary: "x", operation: { kind: "shell", cmd: "rm" } },
      { summary: "x", operation: { ...moveChair(1), yawRadians: "1" } }, { summary: "x", operation: { ...moveChair(1), position: [1, 2] } },
      { summary: "x", operation: { ...moveChair(1), extra: true } }, { summary: "x", operation: { kind: "device.rename", canonicalId: "device:lamp", name: "" } }],
    teldra_list_proposals: [{ status: "nope" }], teldra_get_proposal: [{}],
  };
  it.each(expectedNames)("%s accepts valid input and rejects invalid input with a typed error", (name) => {
    expect(validateAgentSchema(surface.tools.find((t) => t.name === name)!.inputSchema, valid[name])).toEqual([]);
    for (const bad of invalid[name]!) {
      expect(() => surface.callTool(name, bad), JSON.stringify(bad)).toThrowError(expect.objectContaining({ code: "invalid-input" }));
    }
  });
  it("tool.execute is schema-guarded too", () => {
    expect(() => surface.tools[1]!.execute({ limit: 1000 })).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });
  it("rejects unknown tools", () => {
    expect(() => surface.callTool("teldra_turn_on_light", {})).toThrowError(expect.objectContaining({ code: "unknown-tool" }));
  });
});

describe("read tools", () => {
  const { call, surface } = setup();
  it("inspects project structure", () => {
    const out = call("teldra_inspect_project");
    expect(out.ifcSchema).toBe("IFC4");
    expect(out.elementCounts).toMatchObject({ wall: 2, furniture: 2, storey: 1 });
    expect(out.structure).toEqual([expect.objectContaining({ canonicalId: "storey:1" })]);
    expect(out.editors).toEqual({ walls: true, furniture: true, twin: true });
  });
  it("lists and filters by type and storey with pagination", () => {
    expect(call("teldra_list_entities", { entityType: "wall" }).total).toBe(2);
    expect(call("teldra_list_entities", { entityType: "device" }).entities).toEqual([expect.objectContaining({ canonicalId: "device:lamp" })]);
    expect(call("teldra_list_entities", { entityType: "furniture", storeyId: "storey:1" }).entities.map((e: any) => e.canonicalId)).toEqual(["chair:1"]);
    expect(call("teldra_list_entities", { limit: 2, offset: 1 }).entities).toHaveLength(2);
    expect(() => call("teldra_list_entities", { storeyId: "wall:a" })).toThrowError(expect.objectContaining({ code: "invalid-input" }));
    expect(() => call("teldra_list_entities", { storeyId: "nope" })).toThrowError(expect.objectContaining({ code: "unknown-entity" }));
  });
  it("reports unsupported storey queries explicitly when containment is unavailable", () => {
    const bare = createAgentOperationSurface({ twin: new TwinEditor(twinFixture), agentId: "a" });
    expect(() => bare.callTool("teldra_list_entities", { storeyId: "storey:1" })).toThrowError(expect.objectContaining({ code: "unsupported-query" }));
  });
  it("reads wall geometry, relations and unavailable materials", () => {
    const wall = call("teldra_get_entity", { canonicalId: "wall:a" });
    expect(wall.geometry).toMatchObject({ start: [0, 0], end: [4, 0], thickness: 0.2, length: 4 });
    expect(wall.relations.connectedWalls).toEqual([{ canonicalId: "wall:b", thisEnd: "end", otherEnd: "start" }]);
    expect(wall.materials.available).toBe(false);
    expect(wall.storeyId).toBe("storey:1");
  });
  it("reads furniture transforms, linked devices and scale support", () => {
    const chair = call("teldra_get_entity", { canonicalId: "chair:1" });
    expect(chair.transform).toMatchObject({ position: [1, 1, 0], yawRadians: 0, scale: [1, 1, 1] });
    expect(chair.linkedDevices).toEqual([{ canonicalId: "device:lamp", name: "Lamp" }]);
    expect(call("teldra_get_entity", { canonicalId: "sofa:1" }).transform.scale).toMatchObject({ available: false });
  });
  it("reads devices without bindings or external entity IDs", () => {
    const device = call("teldra_get_entity", { canonicalId: "device:lamp" });
    expect(device.capabilities).toEqual([{ id: "cap:lamp:light", kind: "light" }]);
    const all = JSON.stringify(surface.tools.map((t) => t.name === "teldra_inspect_project" ? call(t.name) : null)) + JSON.stringify(device);
    expect(all).not.toMatch(/light\.secret_entity|home-assistant|binding:/);
  });
  it("lists capabilities with the same scale detection as Studio", () => {
    expect(call("teldra_list_capabilities", { canonicalId: "chair:1" }).operations).toEqual([{ operation: "furniture.transform", supported: true, scale: { supported: true } }]);
    expect(call("teldra_list_capabilities", { canonicalId: "sofa:1" }).operations[0].scale).toEqual({ supported: false, reason: "This IFC representation cannot be scaled safely." });
    expect(call("teldra_list_capabilities", { canonicalId: "wall:a" }).operations).toEqual([{ operation: "wall.update", supported: true }]);
    expect(call("teldra_list_capabilities", { canonicalId: "device:lamp" }).operations.map((o: any) => o.operation)).toEqual(["device.rename", "device.place"]);
    expect(call("teldra_list_capabilities", { canonicalId: "space:1" }).operations).toEqual([]);
    expect(() => call("teldra_list_capabilities", { canonicalId: "ghost" })).toThrowError(expect.objectContaining({ code: "unknown-entity" }));
  });
  it("reports missing editors as unsupported", () => {
    const bare = createAgentOperationSurface({ twin: new TwinEditor(twinFixture), agentId: "a" });
    expect((bare.callTool("teldra_list_capabilities", { canonicalId: "wall:a" }) as any).operations[0]).toMatchObject({ supported: false });
  });
});

describe("proposal lifecycle", () => {
  it("proposing never mutates canonical state and records attribution and a diff", () => {
    const { propose, walls, furniture, twin } = setup();
    const before = [walls.bytes, furniture.bytes, JSON.stringify(twin.twin)].map(String);
    const proposal = propose(moveChair(3));
    expect(proposal).toMatchObject({ status: "pending", agentId: "agent:test", stale: false, id: "proposal:1" });
    expect(proposal.diff).toEqual([{ target: "chair:1", cause: "requested", properties: [
      { property: "position", before: [1, 1, 0], after: [3, 1, 0] }, { property: "yawRadians", before: 0, after: 0.5 }] }]);
    expect([walls.bytes, furniture.bytes, JSON.stringify(twin.twin)].map(String)).toEqual(before);
    expect(walls.history.revision + furniture.history.revision + twin.revision).toBe(0);
  });
  it("a tool input cannot spoof the agent identity", () => {
    const { call } = setup();
    expect(() => call("teldra_propose_operation", { summary: "x", agentId: "admin", operation: moveChair(1) })).toThrowError(expect.objectContaining({ code: "invalid-input" }));
  });
  it("previews wall edits including connected-wall propagation", () => {
    const { propose } = setup();
    const proposal = propose({ kind: "wall.update", canonicalId: "wall:a", geometry: g(0, 0, 5, 0) });
    expect(proposal.diff.map((d) => [d.target, d.cause])).toEqual([["wall:a", "requested"], ["wall:b", "connected"]]);
    expect(proposal.diff[0]!.properties).toEqual([{ property: "end", before: [4, 0], after: [5, 0] }]);
  });
  it("approve applies through the editor as one undo unit, and revert restores exact bytes", () => {
    const { propose, surface, walls } = setup();
    const original = [...walls.bytes];
    const p = propose({ kind: "wall.update", canonicalId: "wall:a", geometry: g(0, 0, 5, 0) });
    const applied = surface.review.approve(p.id);
    expect(applied.status).toBe("applied");
    expect(walls.read(WALL_B).start).toEqual([5, 0]);
    expect(walls.history.undoDepth).toBe(1);
    expect(surface.review.revert(p.id).status).toBe("reverted");
    expect([...walls.bytes]).toEqual(original);
  });
  it("applies furniture (with and without scale) and device changes", () => {
    const { propose, surface, furniture, twin } = setup();
    surface.review.approve(propose(moveChair(3)).id);
    expect(furniture.read(CHAIR)).toEqual({ position: [3, 1, 0], yawRadians: 0.5 });
    const scaled = propose({ ...moveChair(4), scale: [2, 2, 2] });
    expect(scaled.diff[0]!.properties.map((x) => x.property)).toContain("scale");
    surface.review.approve(scaled.id);
    expect(furniture.readScale(CHAIR)).toEqual([2, 2, 2]);
    surface.review.approve(propose({ kind: "device.rename", canonicalId: "device:lamp", name: "Reading lamp" }).id);
    expect(twin.twin.devices[0]!.name).toBe("Reading lamp");
    expect(twin.history.undoDepth).toBe(1);
    const place = propose({ kind: "device.place", canonicalId: "device:lamp", placement: { frame: "ifc-world-metres-z-up", position: [1, 2, 3], rotationQuaternion: [0, 0, 0, 1] } });
    surface.review.approve(place.id);
    expect(twin.twin.devices[0]!.placement?.position).toEqual([1, 2, 3]);
    // Canonical identity is untouched.
    expect(twin.twin.bindings).toEqual(twinFixture.bindings);
  });
  it("supports approve without apply, then apply; and rejects", () => {
    const { propose, surface, furniture } = setup();
    const a = propose(moveChair(3));
    expect(surface.review.approve(a.id, { apply: false }).status).toBe("approved");
    expect(furniture.history.revision).toBe(0);
    expect(surface.review.apply(a.id).status).toBe("applied");
    const b = propose(moveChair(9));
    expect(surface.review.reject(b.id).status).toBe("rejected");
    expect(() => surface.review.approve(b.id)).toThrowError(expect.objectContaining({ code: "invalid-status" }));
    expect(() => surface.review.revert(b.id)).toThrowError(expect.objectContaining({ code: "invalid-status" }));
    expect(() => surface.review.apply(b.id)).toThrowError(expect.objectContaining({ code: "invalid-status" }));
    expect(surface.review.list("rejected")).toHaveLength(1);
  });
  it("detects a stale canonical revision and refuses to apply", () => {
    const { propose, surface, furniture, call } = setup();
    const a = propose(moveChair(3));
    const b = propose(moveChair(7));
    surface.review.approve(a.id);
    expect(surface.review.get(b.id).stale).toBe(true);
    expect(call<AgentProposal>("teldra_get_proposal", { proposalId: b.id }).stale).toBe(true);
    expect(() => surface.review.approve(b.id)).toThrowError(expect.objectContaining({ code: "stale-revision" }));
    expect(surface.review.get(b.id).status).toBe("pending");
    expect(furniture.read(CHAIR).position).toEqual([3, 1, 0]);
    // Manual edits through the editor also invalidate pending proposals.
    const c = propose(moveChair(8));
    furniture.place(CHAIR, { position: [0, 0, 0], yawRadians: 0 });
    expect(() => surface.review.approve(c.id)).toThrowError(expect.objectContaining({ code: "stale-revision" }));
    expect(surface.review.reject(c.id).status).toBe("rejected");
  });
  it("refuses to revert when later edits exist", () => {
    const { propose, surface, furniture } = setup();
    const a = propose(moveChair(3));
    surface.review.approve(a.id);
    furniture.place(CHAIR, { position: [5, 5, 0], yawRadians: 0 });
    expect(() => surface.review.revert(a.id)).toThrowError(expect.objectContaining({ code: "revert-conflict" }));
    expect(surface.review.get(a.id).status).toBe("applied");
  });
  it("fails explicitly for unsupported, unknown and invalid operations at proposal time", () => {
    const { propose } = setup();
    const code = (op: AgentOperation) => { try { propose(op); } catch (e) { return (e as AgentOperationError).code; } return "none"; };
    expect(code({ ...moveChair(1), canonicalId: "sofa:1", scale: [2, 2, 2] })).toBe("unsupported-operation");
    expect(code({ ...moveChair(1), canonicalId: "wall:a" })).toBe("unsupported-operation");
    expect(code({ ...moveChair(1), canonicalId: "ghost" })).toBe("unknown-entity");
    expect(code({ kind: "wall.update", canonicalId: "wall:a", geometry: g(1, 1, 1, 1) })).toBe("invalid-operation");
    expect(code({ kind: "device.place", canonicalId: "device:lamp", placement: { frame: "ifc-world-metres-z-up", position: [0, 0, 0], rotationQuaternion: [0, 0, 0, 2] } })).toBe("invalid-operation");
    expect(code({ kind: "device.rename", canonicalId: "device:lamp", name: "   " })).toBe("invalid-operation");
    expect(code({ kind: "device.rename", canonicalId: "chair:1", name: "x" })).toBe("unsupported-operation");
  });
  it("reports apply failures as typed errors and leaves state unchanged", () => {
    const { propose, surface, walls } = setup();
    const p = propose({ kind: "wall.update", canonicalId: "wall:a", geometry: g(0, 0, 5, 0) });
    const original = [...walls.bytes];
    const apply = walls.apply.bind(walls);
    (walls as any).apply = () => { throw new Error("IFC write refused"); };
    expect(() => surface.review.approve(p.id)).toThrowError(expect.objectContaining({ code: "apply-failed" }));
    expect(surface.review.get(p.id).status).toBe("approved");
    (walls as any).apply = apply;
    expect([...walls.bytes]).toEqual(original);
  });
  it("bounds pending proposals and notifies subscribers", () => {
    const { propose, surface } = setup();
    let events = 0;
    const off = surface.review.subscribe(() => events++);
    for (let i = 0; i < 50; i++) propose(moveChair(i));
    expect(() => propose(moveChair(99))).toThrowError(expect.objectContaining({ code: "too-many-pending" }));
    expect(events).toBe(50);
    off();
    surface.review.reject("proposal:1");
    expect(events).toBe(50);
    expect(() => surface.review.get("proposal:999")).toThrowError(expect.objectContaining({ code: "unknown-proposal" }));
  });
});
