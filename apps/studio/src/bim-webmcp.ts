import type { StudioProjectController } from "./StudioProjectController.js";

/**
 * First WebMCP integration is deliberately read-only and opt-in. Tool output
 * describes Teldra's existing authored twin references, NOT inferred geometry.
 * The renderer and project model remain authoritative at their existing layers.
 */
interface ReadTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: true; untrustedContentHint: true };
  execute(args: Record<string, unknown>): string;
}
interface ModelContextRegistration {
  registerTool(tool: ReadTool, options: { signal: AbortSignal }): Promise<unknown> | unknown;
}
interface WebMcpDocument {
  modelContext?: ModelContextRegistration;
}
const MAX_RESULTS = 100;

export function makeBimReadTools(controller: StudioProjectController): ReadTool[] {
  return [
    {
      name: "teldra_project_summary",
      description: "Summarize the currently open Teldra BIM-backed project. Counts are semantic references, not mesh counts.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => JSON.stringify({
        ifcSchema: controller.twin.building.ifcSchema,
        buildingReferences: controller.twin.building.refs.length,
        devices: controller.twin.devices.length,
        selectedCanonicalId: controller.selectedCanonicalId,
        revision: controller.revision,
      }),
    },
    {
      name: "teldra_list_bim_objects",
      description: "Read a bounded page of authored IFC building references, optionally filtering by IFC element category; returns canonical IDs and stable IFC GlobalIds. This is not a list of all IFC entities or GLB meshes.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", description: "Optional IFC object category, such as wall, space or furniture" },
          offset: { type: "integer", minimum: 0, description: "Zero-based pagination offset" },
          limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, description: "Number of objects, maximum 100" },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (args) => {
        if (args.kind !== undefined && typeof args.kind !== "string")
          throw new Error("kind must be a string.");
        const offset = args.offset ?? 0, limit = args.limit ?? 50;
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
            typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS)
          throw new Error("Invalid object pagination.");
        const refs = controller.twin.building.refs.filter(ref => args.kind === undefined || ref.kind === args.kind);
        return JSON.stringify({
          total: refs.length,
          offset,
          objects: refs.slice(offset, offset + limit)
            .map(ref => ({ canonicalId: ref.id, ifcGlobalId: ref.ifcGlobalId, kind: ref.kind, name: ref.name ?? null })),
        });
      },
    },
    {
      name: "teldra_inspect_bim_object",
      description: "Inspect one authored building reference by exact canonical ID; returns IFC GlobalId and known twin-linked devices. Does not infer IFC geometry, hosted openings or materials not present in the twin.",
      inputSchema: {
        type: "object",
        properties: { canonicalId: { type: "string", description: "Exact authored building reference canonical ID" } },
        required: ["canonicalId"],
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: ({ canonicalId }) => {
        if (typeof canonicalId !== "string" || canonicalId.length > 256 || canonicalId.trim() !== canonicalId)
          throw new Error("A valid canonicalId is required.");
        const ref = controller.twin.building.refs.find(item => item.id === canonicalId);
        if (!ref) throw new Error("Unknown authored building reference.");
        return JSON.stringify({
          canonicalId: ref.id, ifcGlobalId: ref.ifcGlobalId,
          kind: ref.kind, name: ref.name ?? null,
          linkedDevices: controller.twin.devices.filter(device => device.buildingRefId === ref.id)
            .map(device => ({ canonicalId: device.id, name: device.name })),
          geometry: "not exposed by this read-only twin adapter",
          materials: "not exposed by this read-only twin adapter",
          ifcRelations: "not exposed by this read-only twin adapter",
        });
      },
    },
  ];
}

/** Returns an unregister callback. WebMCP is optional and never polyfilled. */
export async function registerBimWebMcpReadTools(
  doc: WebMcpDocument,
  controller: StudioProjectController,
): Promise<() => void> {
  const registry = doc.modelContext;
  if (!registry) return () => {};
  const lifecycle = new AbortController();
  try {
    for (const tool of makeBimReadTools(controller)) {
      await registry.registerTool(tool, { signal: lifecycle.signal });
    }
  } catch (error) {
    lifecycle.abort();
    throw error;
  }
  return () => lifecycle.abort();
}
