import { describe, expect, it } from "vitest";
import type { StudioProjectController } from "../src/StudioProjectController.js";
import { makeBimReadTools, registerBimWebMcpReadTools } from "../src/bim-webmcp.js";

const fixture = () => ({
  twin: {
    building: { ifcSchema: "IFC4", refs: [
      { id: "wall:1", ifcGlobalId: "abc", kind: "wall", name: "East wall" },
      { id: "chair:1", ifcGlobalId: "def", kind: "furniture", name: "Chair" },
    ] },
    devices: [{ id: "device:1", name: "Lamp", buildingRefId: "wall:1" }],
  },
  selectedCanonicalId: "chair:1",
  revision: 2,
}) as unknown as StudioProjectController;

describe("opt-in read-only BIM WebMCP", () => {
  it("provides bounded semantic summaries, IFC identities and linked devices", () => {
    const tools = makeBimReadTools(fixture());
    expect(tools).toHaveLength(3);
    expect(tools.every(tool => tool.annotations.readOnlyHint)).toBe(true);
    expect(JSON.parse(tools[0]!.execute({})).buildingReferences).toBe(2);
    const list = JSON.parse(tools[1]!.execute({ kind: "wall", limit: 1 }));
    expect(list.total).toBe(1);
    expect(list.objects[0]).toEqual({ canonicalId: "wall:1", ifcGlobalId: "abc", kind: "wall", name: "East wall" });
    const detail = JSON.parse(tools[2]!.execute({ canonicalId: "wall:1" }));
    expect(detail.linkedDevices).toEqual([{ canonicalId: "device:1", name: "Lamp" }]);
    expect(detail.ifcRelations).toMatch(/not exposed/);
  });

  it("rejects invalid pagination and unknown identities", () => {
    const tools = makeBimReadTools(fixture());
    expect(() => tools[1]!.execute({offset: -1})).toThrow(/pagination/);
    expect(() => tools[1]!.execute({limit: 1000})).toThrow(/pagination/);
    expect(() => tools[1]!.execute({offset: "0"})).toThrow(/pagination/);
    expect(() => tools[2]!.execute({canonicalId: "missing"})).toThrow(/Unknown/);
  });

  it("registers only with browser support and aborts all tools on opt-out", async () => {
    const signals: AbortSignal[] = [];
    const documentMock = { modelContext: {
      registerTool: (_tool: unknown, options: {signal: AbortSignal}) => { signals.push(options.signal); },
    } };
    const cleanup = await registerBimWebMcpReadTools(documentMock, fixture());
    expect(signals).toHaveLength(3);
    expect(signals.every(signal => !signal.aborted)).toBe(true);
    cleanup();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    const absent = await registerBimWebMcpReadTools({}, fixture());
    absent();
  });

  it("aborts partially registered tools if registration throws", async () => {
    let firstSignal: AbortSignal | undefined;
    let count = 0;
    const documentMock = {modelContext: {
      registerTool: (_tool: unknown, options: {signal: AbortSignal}) => {
        if (++count === 2) throw new Error("Tools permissions denied");
        firstSignal = options.signal;
      },
    }};
    await expect(registerBimWebMcpReadTools(documentMock, fixture())).rejects.toThrow(/denied/);
    expect(firstSignal?.aborted).toBe(true);
  });
});
