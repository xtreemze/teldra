import { AgentOperationError, type AgentJsonSchema, type createAgentOperationSurface } from "@teldra/application";

/**
 * WebMCP adapter for the provider-independent agent operation surface (@teldra/application).
 *
 * INTEGRATION POINT (for the Studio project controller owner): construct
 *   `createAgentOperationSurface({ twin: TwinEditor, walls?: IfcWallEditor, furniture?: IfcFurnitureEditor, agentId })`
 * from the editors the project already owns, then
 *   - call `registerAgentWebMcpTools(document, surface, { optIn })` where `optIn` is the user's explicit toggle, and
 *   - give `surface.review` to `<AgentProposalsPanel />` (see `connectAgentProposals`).
 * Registration is feature-detected, never polyfilled, and registers NOTHING unless `optIn === true`.
 * The human review API (approve/reject/revert) is intentionally not registered as a tool.
 */
type Surface = ReturnType<typeof createAgentOperationSurface>;

export interface AgentWebMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: AgentJsonSchema;
  readonly annotations: { readonly readOnlyHint: boolean; readonly untrustedContentHint: true };
  execute(args: Record<string, unknown>): string;
}
interface ModelContextRegistration {
  registerTool(tool: AgentWebMcpTool, options: { signal: AbortSignal }): Promise<unknown> | unknown;
}
interface WebMcpDocument { modelContext?: ModelContextRegistration }

export function makeAgentWebMcpTools(surface: Surface): AgentWebMcpTool[] {
  return surface.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    // Proposing appends a pending proposal (session state, not canonical data), so it is the one non-read-only tool.
    annotations: { readOnlyHint: tool.name !== "teldra_propose_operation", untrustedContentHint: true },
    execute: (args) => {
      try { return JSON.stringify(tool.execute(args)); }
      catch (error) {
        if (error instanceof AgentOperationError) return JSON.stringify({ error: { code: error.code, message: error.message } });
        throw error;
      }
    },
  }));
}

/** Returns an unregister callback. Requires the user's explicit opt-in; absent WebMCP is a silent no-op. */
export async function registerAgentWebMcpTools(doc: WebMcpDocument, surface: Surface, options: { readonly optIn: boolean }): Promise<() => void> {
  if (options.optIn !== true) return () => {};
  const registry = doc.modelContext;
  if (!registry) return () => {};
  const lifecycle = new AbortController();
  try {
    for (const tool of makeAgentWebMcpTools(surface)) await registry.registerTool(tool, { signal: lifecycle.signal });
  } catch (error) {
    lifecycle.abort();
    throw error;
  }
  return () => lifecycle.abort();
}
