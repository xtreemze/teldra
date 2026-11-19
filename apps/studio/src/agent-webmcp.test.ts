import { describe, expect, it } from "vitest";
import type { TwinProject } from "@teldra/domain";
import { TwinEditor, createAgentOperationSurface } from "@teldra/application";
import { registerAgentWebMcpTools, makeAgentWebMcpTools } from "./agent-webmcp.js";

const twin: TwinProject = {
  schemaVersion: "0.1.0",
  building: { ifcSchema: "IFC4", refs: [{ id: "space:1", ifcGlobalId: "0TeldraSpaceAAAAAAAA1", kind: "space", name: "Living" }] },
  devices: [{ id: "device:lamp", name: "Lamp", capabilities: [{ id: "cap:1", kind: "light" }] }],
  bindings: [{ id: "binding:1", deviceId: "device:lamp", adapter: "home-assistant", externalId: "light.x" }],
};
const surface = () => createAgentOperationSurface({ twin: new TwinEditor(twin), agentId: "webmcp:test" });

function mockDocument() {
  const registered: { name: string; signal: AbortSignal; tool: any }[] = [];
  return { registered, doc: { modelContext: { registerTool: (tool: any, o: { signal: AbortSignal }) => { registered.push({ name: tool.name, signal: o.signal, tool }); } } } };
}

describe("agent WebMCP adapter", () => {
  it("registers nothing unless the user explicitly opted in", async () => {
    const { doc, registered } = mockDocument();
    for (const optIn of [false, undefined, "true", 1] as unknown[]) {
      const off = await registerAgentWebMcpTools(doc, surface(), { optIn: optIn as boolean });
      off();
    }
    expect(registered).toHaveLength(0);
  });
  it("is feature-detected and never polyfills navigator.modelContext", async () => {
    const off = await registerAgentWebMcpTools({}, surface(), { optIn: true });
    expect(off).toBeTypeOf("function");
    expect(() => off()).not.toThrow();
  });
  it("registers every surface tool when opted in, and unregisters all on opt-out", async () => {
    const { doc, registered } = mockDocument();
    const s = surface();
    const off = await registerAgentWebMcpTools(doc, s, { optIn: true });
    expect(registered.map((r) => r.name)).toEqual(s.tools.map((t) => t.name));
    expect(registered.every((r) => !r.signal.aborted)).toBe(true);
    off();
    expect(registered.every((r) => r.signal.aborted)).toBe(true);
  });
  it("aborts partial registrations when the browser denies one", async () => {
    const signals: AbortSignal[] = [];
    let n = 0;
    const doc = { modelContext: { registerTool: (_t: unknown, o: { signal: AbortSignal }) => { signals.push(o.signal); if (++n === 3) throw new Error("denied"); } } };
    await expect(registerAgentWebMcpTools(doc, surface(), { optIn: true })).rejects.toThrow(/denied/);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
  it("exposes only schema'd tools whose names carry no device control or decision verbs", () => {
    const tools = makeAgentWebMcpTools(surface());
    for (const tool of tools) {
      expect(tool.name).toMatch(/^teldra_(inspect|list|get|propose)_/);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations.untrustedContentHint).toBe(true);
    }
    expect(tools.find((t) => t.name === "teldra_propose_operation")!.annotations.readOnlyHint).toBe(false);
    expect(tools.filter((t) => t.annotations.readOnlyHint)).toHaveLength(tools.length - 1);
  });
  it("returns JSON text and converts typed errors into structured error results", () => {
    const tools = makeAgentWebMcpTools(surface());
    const get = tools.find((t) => t.name === "teldra_get_entity")!;
    expect(JSON.parse(get.execute({ canonicalId: "device:lamp" }) as string).name).toBe("Lamp");
    expect(JSON.parse(get.execute({ canonicalId: "ghost" }) as string)).toEqual({ error: { code: "unknown-entity", message: expect.any(String) } });
    expect(JSON.parse(get.execute({}) as string).error.code).toBe("invalid-input");
    expect(JSON.stringify(tools.map((t) => t.execute({ canonicalId: "device:lamp" })))).not.toMatch(/light\.x|binding:1/);
  });
  it("propose through WebMCP only files a pending proposal; the human review API applies it", () => {
    const s = surface();
    const propose = makeAgentWebMcpTools(s).find((t) => t.name === "teldra_propose_operation")!;
    const result = JSON.parse(propose.execute({ summary: "rename", operation: { kind: "device.rename", canonicalId: "device:lamp", name: "Desk lamp" } }) as string);
    expect(result).toMatchObject({ status: "pending", agentId: "webmcp:test" });
    expect(s.review.list("pending")).toHaveLength(1);
    expect(s.review.approve(result.id).status).toBe("applied");
  });
});
