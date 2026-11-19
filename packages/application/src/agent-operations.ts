import type { BuildingElementKind, TwinProject } from "@teldra/domain";
import { validateAgentSchema, type AgentJsonSchema } from "./agent-schema.js";
import type { IfcFurnitureEditor } from "./ifc-furniture-editor.js";
import type { IfcWallChange, IfcWallEditor, IfcWallGeometry, IfcWallOperation } from "./ifc-wall-editor.js";
import type { TwinEditor } from "./twin-editor.js";

/**
 * Provider-independent agent operation surface (issues #132/#133).
 *
 * Agents get typed, JSON-schema'd READ tools and one WRITE-ish tool that only files a reviewable
 * proposal. Nothing an agent can call mutates canonical data: approve/apply/reject/revert live on
 * {@link AgentProposalReview}, which only trusted human UI is given. Applying goes through the same
 * editor `apply()`/command path Studio uses (one undo unit). There is no code execution, and no
 * device control: Home Assistant bindings and live device state are never exposed here.
 */
export type AgentErrorCode =
  | "invalid-input" | "unknown-tool" | "unknown-entity" | "unknown-proposal"
  | "unsupported-operation" | "unsupported-query" | "invalid-operation"
  | "invalid-status" | "stale-revision" | "revert-conflict" | "apply-failed" | "too-many-pending";

export class AgentOperationError extends Error {
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string) { super(message); this.name = "AgentOperationError"; this.code = code; }
}

export type AgentProposalStatus = "pending" | "approved" | "rejected" | "applied" | "reverted";

export type AgentOperation =
  | { readonly kind: "wall.update"; readonly canonicalId: string; readonly geometry: IfcWallGeometry }
  | { readonly kind: "furniture.transform"; readonly canonicalId: string; readonly position: readonly [number, number, number]; readonly yawRadians: number; readonly scale?: readonly [number, number, number] }
  | { readonly kind: "device.rename"; readonly canonicalId: string; readonly name: string }
  | { readonly kind: "device.place"; readonly canonicalId: string; readonly placement: { readonly frame: "ifc-world-metres-z-up"; readonly position: readonly [number, number, number]; readonly rotationQuaternion: readonly [number, number, number, number] } };

export interface AgentPropertyDiff { readonly property: string; readonly before: unknown; readonly after: unknown }
export interface AgentDiffEntry {
  /** Canonical id when resolvable, else the IFC GlobalId. */
  readonly target: string;
  readonly cause: "requested" | "connected";
  readonly properties: readonly AgentPropertyDiff[];
}
export interface AgentProposal {
  readonly id: string;
  /** Set by the host at session creation; agents cannot choose or spoof it. */
  readonly agentId: string;
  readonly summary: string;
  readonly operation: AgentOperation;
  readonly status: AgentProposalStatus;
  readonly baseRevision: string;
  readonly createdAt: string;
  readonly decidedAt?: string;
  readonly appliedRevision?: string;
  readonly diff: readonly AgentDiffEntry[];
  /** True when canonical state changed since the proposal was made; it can then no longer be applied. */
  readonly stale: boolean;
}

export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: AgentJsonSchema;
  /** Every agent tool is non-mutating on canonical data; propose only appends a pending proposal. */
  readonly readOnly: true;
  execute(input: unknown): unknown;
}

/** Human-facing review API. Deliberately NOT part of {@link AgentTool}s. */
export interface AgentProposalReview {
  list(status?: AgentProposalStatus): readonly AgentProposal[];
  get(id: string): AgentProposal;
  /** Approve; applies immediately unless `{ apply: false }`. */
  approve(id: string, options?: { readonly apply?: boolean }): AgentProposal;
  apply(id: string): AgentProposal;
  reject(id: string): AgentProposal;
  /** Undo exactly this proposal's unit; only while nothing else changed canonical state since. */
  revert(id: string): AgentProposal;
  subscribe(listener: () => void): () => void;
}

export interface AgentOperationOptions {
  readonly twin: TwinEditor;
  readonly walls?: Pick<IfcWallEditor, "read" | "preview" | "apply" | "undo" | "history">;
  readonly furniture?: Pick<IfcFurnitureEditor, "read" | "readScale" | "place" | "transform" | "undo" | "history">;
  /** Attribution for every proposal made through this surface. */
  readonly agentId: string;
  readonly now?: () => string;
  /** Optional spatial-containment lookup (IFC owns the storey structure). Without it storey queries fail explicitly. */
  readonly storeyOf?: (canonicalId: string) => string | null;
  /** Optional IFC material lookup; without it materials are reported unavailable. */
  readonly materialsOf?: (ifcGlobalId: string) => readonly string[];
}

export const AGENT_MAX_PAGE = 100;
export const AGENT_MAX_PENDING = 50;
const KINDS = ["site", "building", "storey", "space", "wall", "slab", "roof", "door", "window", "furniture", "fixture", "distribution-element", "other"] as const satisfies readonly BuildingElementKind[];

const id = { type: "string", minLength: 1, maxLength: 256 } as const satisfies AgentJsonSchema;
const num = { type: "number" } as const satisfies AgentJsonSchema;
const vec = (n: number): AgentJsonSchema => ({ type: "array", items: num, minItems: n, maxItems: n });
const obj = (properties: Record<string, AgentJsonSchema>, required: string[] = []): AgentJsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false });

const WALL_GEOMETRY = obj({
  start: vec(2), end: vec(2), thickness: { type: "number", minimum: 0.001, maximum: 100 },
  height: { type: "number", minimum: 0.001, maximum: 100 }, elevation: { type: "number", minimum: -10000, maximum: 10000 },
}, ["start", "end", "thickness", "height", "elevation"]);

export const AGENT_OPERATION_SCHEMA: AgentJsonSchema = {
  oneOf: [
    obj({ kind: { type: "string", const: "wall.update" }, canonicalId: id, geometry: WALL_GEOMETRY }, ["kind", "canonicalId", "geometry"]),
    obj({ kind: { type: "string", const: "furniture.transform" }, canonicalId: id, position: vec(3), yawRadians: num, scale: vec(3) }, ["kind", "canonicalId", "position", "yawRadians"]),
    obj({ kind: { type: "string", const: "device.rename" }, canonicalId: id, name: { type: "string", minLength: 1, maxLength: 256 } }, ["kind", "canonicalId", "name"]),
    obj({
      kind: { type: "string", const: "device.place" }, canonicalId: id,
      placement: obj({ frame: { type: "string", const: "ifc-world-metres-z-up" }, position: vec(3), rotationQuaternion: vec(4) }, ["frame", "position", "rotationQuaternion"]),
    }, ["kind", "canonicalId", "placement"]),
  ],
};

const pageSchema = {
  offset: { type: "integer", minimum: 0, description: "Zero-based pagination offset." },
  limit: { type: "integer", minimum: 1, maximum: AGENT_MAX_PAGE, description: `Page size, at most ${AGENT_MAX_PAGE}.` },
} as const satisfies Record<string, AgentJsonSchema>;
const STATUSES = ["pending", "approved", "rejected", "applied", "reverted"] as const;

type Resolved =
  | { readonly type: "ref"; readonly ref: TwinProject["building"]["refs"][number] }
  | { readonly type: "device"; readonly device: TwinProject["devices"][number] };

export function createAgentOperationSurface(options: AgentOperationOptions): { readonly tools: readonly AgentTool[]; readonly review: AgentProposalReview; callTool(name: string, input: unknown): unknown } {
  const now = options.now ?? (() => new Date().toISOString());
  const proposals = new Map<string, AgentProposal>();
  const listeners = new Set<() => void>();
  let sequence = 0;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const revision = () => `t${options.twin.revision}.w${options.walls?.history.revision ?? 0}.f${options.furniture?.history.revision ?? 0}`;
  const twin = () => options.twin.twin;

  const resolve = (canonicalId: string): Resolved => {
    const ref = twin().building.refs.find((item) => item.id === canonicalId);
    if (ref) return { type: "ref", ref };
    const device = twin().devices.find((item) => item.id === canonicalId);
    if (device) return { type: "device", device };
    throw new AgentOperationError("unknown-entity", `No building reference or device has canonical ID "${canonicalId}".`);
  };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const canonicalOf = (globalId: string) => twin().building.refs.find((ref) => ref.ifcGlobalId === globalId)?.id ?? globalId;

  type Capability = { readonly operation: AgentOperation["kind"]; readonly supported: boolean; readonly reason?: string; readonly scale?: { readonly supported: boolean; readonly reason?: string } };
  const capabilities = (resolved: Resolved): Capability[] => {
    if (resolved.type === "device") return [{ operation: "device.rename", supported: true }, { operation: "device.place", supported: true }];
    const { ref } = resolved;
    if (ref.kind === "wall") {
      if (!options.walls) return [{ operation: "wall.update", supported: false, reason: "No IFC wall editor is open for this project." }];
      try { options.walls.read(ref.ifcGlobalId); return [{ operation: "wall.update", supported: true }]; }
      catch (error) { return [{ operation: "wall.update", supported: false, reason: message(error) }]; }
    }
    if (ref.kind === "furniture") {
      if (!options.furniture) return [{ operation: "furniture.transform", supported: false, reason: "No IFC furniture editor is open for this project." }];
      try { options.furniture.read(ref.ifcGlobalId); } catch (error) { return [{ operation: "furniture.transform", supported: false, reason: message(error) }]; }
      // Same detection Studio uses (furnitureScaleStatus): scale is supported only if the mapped geometry scale can be read.
      let scale: { supported: boolean; reason?: string };
      try { options.furniture.readScale(ref.ifcGlobalId); scale = { supported: true }; }
      catch (error) { scale = { supported: false, reason: message(error) }; }
      return [{ operation: "furniture.transform", supported: true, scale }];
    }
    return [];
  };

  const geometryDiff = (before: IfcWallGeometry | null, after: IfcWallGeometry | null): AgentPropertyDiff[] => {
    const out: AgentPropertyDiff[] = [];
    for (const key of ["start", "end", "thickness", "height", "elevation"] as const)
      if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) out.push({ property: key, before: before?.[key] ?? null, after: after?.[key] ?? null });
    return out;
  };
  const wallChangesToDiff = (changes: readonly IfcWallChange[]): AgentDiffEntry[] =>
    changes.map((change) => ({ target: canonicalOf(change.globalId), cause: change.cause, properties: geometryDiff(change.before, change.after) }));

  const wallOperation = (op: Extract<AgentOperation, { kind: "wall.update" }>, ref: { ifcGlobalId: string }): IfcWallOperation =>
    ({ kind: "update", globalId: ref.ifcGlobalId, geometry: op.geometry });

  const preview = (op: AgentOperation): AgentDiffEntry[] => {
    const resolved = resolve(op.canonicalId);
    const cap = capabilities(resolved).find((item) => item.operation === op.kind);
    if (!cap) throw new AgentOperationError("unsupported-operation", `Operation "${op.kind}" does not apply to "${op.canonicalId}".`);
    if (!cap.supported) throw new AgentOperationError("unsupported-operation", cap.reason ?? "Operation is unsupported for this entity.");
    try {
      switch (op.kind) {
        case "wall.update": {
          if (resolved.type !== "ref") throw new Error("unreachable");
          return wallChangesToDiff(options.walls!.preview(wallOperation(op, resolved.ref)).changes);
        }
        case "furniture.transform": {
          if (resolved.type !== "ref") throw new Error("unreachable");
          const pose = options.furniture!.read(resolved.ref.ifcGlobalId);
          if (![...op.position, op.yawRadians, ...(op.scale ?? [])].every(Number.isFinite) || op.scale?.some((value) => value <= 0 || value > 1000))
            throw new Error("Furniture transform requires finite values and positive scale factors (<= 1000).");
          const props: AgentPropertyDiff[] = [
            { property: "position", before: [...pose.position], after: [...op.position] },
            { property: "yawRadians", before: pose.yawRadians, after: op.yawRadians },
          ];
          if (op.scale) {
            if (!cap.scale?.supported) throw new AgentOperationError("unsupported-operation", cap.scale?.reason ?? "Geometry scaling is unsupported for this object.");
            props.push({ property: "scale", before: [...options.furniture!.readScale(resolved.ref.ifcGlobalId)], after: [...op.scale] });
          }
          return [{ target: op.canonicalId, cause: "requested", properties: props.filter((p) => JSON.stringify(p.before) !== JSON.stringify(p.after)) }];
        }
        case "device.rename": {
          if (resolved.type !== "device") throw new Error("unreachable");
          if (!op.name.trim()) throw new Error("Device name must not be empty.");
          return [{ target: op.canonicalId, cause: "requested", properties: [{ property: "name", before: resolved.device.name, after: op.name }] }];
        }
        case "device.place": {
          if (resolved.type !== "device") throw new Error("unreachable");
          const q = op.placement.rotationQuaternion;
          if (![...op.placement.position, ...q].every(Number.isFinite) || Math.abs(Math.hypot(...q) - 1) > 1e-6)
            throw new Error("Device placement requires finite coordinates and a unit quaternion.");
          return [{ target: op.canonicalId, cause: "requested", properties: [{ property: "placement", before: resolved.device.placement ?? null, after: op.placement }] }];
        }
      }
    } catch (error) {
      if (error instanceof AgentOperationError) throw error;
      throw new AgentOperationError("invalid-operation", message(error));
    }
  };

  const applyOperation = (op: AgentOperation): void => {
    const resolved = resolve(op.canonicalId);
    switch (op.kind) {
      case "wall.update": if (resolved.type === "ref") options.walls!.apply(wallOperation(op, resolved.ref)); return;
      case "furniture.transform":
        if (resolved.type !== "ref") return;
        if (op.scale) options.furniture!.transform(resolved.ref.ifcGlobalId, { position: op.position, yawRadians: op.yawRadians }, op.scale);
        else options.furniture!.place(resolved.ref.ifcGlobalId, { position: op.position, yawRadians: op.yawRadians });
        return;
      case "device.rename": options.twin.renameDevice(op.canonicalId, op.name, `agent:${options.agentId}`); return;
      case "device.place": options.twin.placeDevice(op.canonicalId, { frame: op.placement.frame, position: [...op.placement.position], rotationQuaternion: [...op.placement.rotationQuaternion] }, `agent:${options.agentId}`);
    }
  };
  const undoOperation = (op: AgentOperation): boolean =>
    op.kind === "wall.update" ? options.walls!.undo()
      : op.kind === "furniture.transform" ? options.furniture!.undo()
        : options.twin.undo() !== null;

  const view = (proposal: AgentProposal): AgentProposal =>
    ({ ...proposal, stale: (proposal.status === "pending" || proposal.status === "approved") && proposal.baseRevision !== revision() });
  const need = (idValue: string): AgentProposal => {
    const proposal = proposals.get(idValue);
    if (!proposal) throw new AgentOperationError("unknown-proposal", `Unknown proposal "${idValue}".`);
    return proposal;
  };
  const set = (proposal: AgentProposal, patch: Partial<AgentProposal>): AgentProposal => {
    const next = { ...proposal, ...patch };
    proposals.set(next.id, next);
    notify();
    return view(next);
  };
  const assertFresh = (proposal: AgentProposal) => {
    if (proposal.baseRevision !== revision())
      throw new AgentOperationError("stale-revision", "The project changed since this proposal was made. Reject it and ask the agent to propose again.");
  };

  const review: AgentProposalReview = {
    list: (status) => [...proposals.values()].filter((p) => status === undefined || p.status === status).map(view),
    get: (idValue) => view(need(idValue)),
    approve(idValue, opts) {
      const proposal = need(idValue);
      if (proposal.status !== "pending") throw new AgentOperationError("invalid-status", `Only pending proposals can be approved (status is ${proposal.status}).`);
      assertFresh(proposal);
      const approved = set(proposal, { status: "approved", decidedAt: now() });
      return opts?.apply === false ? approved : review.apply(idValue);
    },
    apply(idValue) {
      const proposal = need(idValue);
      if (proposal.status !== "approved") throw new AgentOperationError("invalid-status", `Only approved proposals can be applied (status is ${proposal.status}).`);
      assertFresh(proposal);
      try { applyOperation(proposal.operation); }
      catch (error) { throw new AgentOperationError("apply-failed", message(error)); }
      return set(proposal, { status: "applied", appliedRevision: revision() });
    },
    reject(idValue) {
      const proposal = need(idValue);
      if (proposal.status !== "pending" && proposal.status !== "approved")
        throw new AgentOperationError("invalid-status", `Only pending or approved proposals can be rejected (status is ${proposal.status}).`);
      return set(proposal, { status: "rejected", decidedAt: now() });
    },
    revert(idValue) {
      const proposal = need(idValue);
      if (proposal.status !== "applied") throw new AgentOperationError("invalid-status", `Only applied proposals can be reverted (status is ${proposal.status}).`);
      if (proposal.appliedRevision !== revision())
        throw new AgentOperationError("revert-conflict", "Other edits were made after this proposal was applied; undo them first so only this change is reverted.");
      if (!undoOperation(proposal.operation)) throw new AgentOperationError("apply-failed", "Nothing to undo.");
      return set(proposal, { status: "reverted" });
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };

  const page = (input: { offset?: number; limit?: number }) => ({ offset: input.offset ?? 0, limit: input.limit ?? 50 });
  const refSummary = (ref: TwinProject["building"]["refs"][number]) => ({ canonicalId: ref.id, entityType: ref.kind, name: ref.name ?? null, ifcGlobalId: ref.ifcGlobalId });

  const tools: AgentTool[] = [
    {
      name: "teldra_inspect_project",
      description: "Summarize the open Teldra project: IFC schema, element counts per type, devices, the spatial structure (site/building/storeys), current canonical revision, and which editors are available.",
      inputSchema: obj({}), readOnly: true,
      execute: () => {
        const counts: Record<string, number> = {};
        for (const ref of twin().building.refs) counts[ref.kind] = (counts[ref.kind] ?? 0) + 1;
        return {
          ifcSchema: twin().building.ifcSchema, revision: revision(), elementCounts: counts, deviceCount: twin().devices.length,
          structure: twin().building.refs.filter((r) => r.kind === "site" || r.kind === "building" || r.kind === "storey").map(refSummary),
          editors: { walls: !!options.walls, furniture: !!options.furniture, twin: true },
          proposals: Object.fromEntries(STATUSES.map((s) => [s, review.list(s).length])),
        };
      },
    },
    {
      name: "teldra_list_entities",
      description: "List one bounded page of canonical building references and/or devices, filtered by entity type and optionally by storey canonical ID.",
      inputSchema: obj({ entityType: { type: "string", enum: [...KINDS, "device"], description: "Building element kind, or \"device\"." }, storeyId: id, ...pageSchema }),
      readOnly: true,
      execute: (raw) => {
        const input = raw as { entityType?: string; storeyId?: string; offset?: number; limit?: number };
        if (input.storeyId !== undefined) {
          if (!options.storeyOf) throw new AgentOperationError("unsupported-query", "Storey containment is not available for this project, so storey filtering is unsupported.");
          const storey = resolve(input.storeyId);
          if (storey.type !== "ref" || storey.ref.kind !== "storey") throw new AgentOperationError("invalid-input", `"${input.storeyId}" is not a storey.`);
        }
        const inStorey = (canonicalId: string) => input.storeyId === undefined || options.storeyOf!(canonicalId) === input.storeyId;
        const rows = [
          ...(input.entityType === "device" ? [] : twin().building.refs.filter((r) => (input.entityType === undefined || r.kind === input.entityType) && inStorey(r.id)).map(refSummary)),
          ...(input.entityType === undefined || input.entityType === "device"
            ? twin().devices.filter((d) => inStorey(d.id)).map((d) => ({ canonicalId: d.id, entityType: "device", name: d.name, ifcGlobalId: null })) : []),
        ];
        const { offset, limit } = page(input);
        return { total: rows.length, offset, entities: rows.slice(offset, offset + limit) };
      },
    },
    {
      name: "teldra_get_entity",
      description: "Read one entity by canonical ID: identity, geometry/dimensions/transform when an editor can read it, relations (connected walls, linked devices, storey), and materials when available. Geometry is IFC world metres, Z up.",
      inputSchema: obj({ canonicalId: id }, ["canonicalId"]), readOnly: true,
      execute: (raw) => {
        const resolved = resolve((raw as { canonicalId: string }).canonicalId);
        if (resolved.type === "device") {
          const d = resolved.device;
          return {
            canonicalId: d.id, entityType: "device", name: d.name, buildingRefId: d.buildingRefId ?? null,
            placement: d.placement ?? null, capabilities: d.capabilities.map((c) => ({ id: c.id, kind: c.kind })),
          };
        }
        const { ref } = resolved;
        const base = {
          ...refSummary(ref),
          storeyId: options.storeyOf ? options.storeyOf(ref.id) : null,
          linkedDevices: twin().devices.filter((d) => d.buildingRefId === ref.id).map((d) => ({ canonicalId: d.id, name: d.name })),
          materials: options.materialsOf ? { available: true, names: [...options.materialsOf(ref.ifcGlobalId)] } : { available: false, reason: "No IFC material reader is attached." },
        };
        if (ref.kind === "wall" && options.walls) {
          try {
            const wall = options.walls.read(ref.ifcGlobalId);
            const { connections, ...geometry } = wall;
            return { ...base, geometry: { ...geometry, length: Math.hypot(geometry.end[0] - geometry.start[0], geometry.end[1] - geometry.start[1]) },
              relations: { connectedWalls: connections.map((c) => ({ canonicalId: canonicalOf(c.wallGlobalId), thisEnd: c.end, otherEnd: c.otherEnd })) } };
          } catch (error) { return { ...base, geometry: { available: false, reason: message(error) } }; }
        }
        if (ref.kind === "furniture" && options.furniture) {
          try {
            const pose = options.furniture.read(ref.ifcGlobalId);
            let scale: unknown = { available: false };
            try { scale = [...options.furniture.readScale(ref.ifcGlobalId)]; } catch (error) { scale = { available: false, reason: message(error) }; }
            return { ...base, transform: { position: [...pose.position], yawRadians: pose.yawRadians, scale } };
          } catch (error) { return { ...base, transform: { available: false, reason: message(error) } }; }
        }
        return { ...base, geometry: { available: false, reason: "No editor exposes geometry for this element type." } };
      },
    },
    {
      name: "teldra_list_capabilities",
      description: "List which edit operations can be proposed for an entity, using the same capability detection Studio uses (including whether geometry scaling is supported).",
      inputSchema: obj({ canonicalId: id }, ["canonicalId"]), readOnly: true,
      execute: (raw) => {
        const canonicalId = (raw as { canonicalId: string }).canonicalId;
        return { canonicalId, operations: capabilities(resolve(canonicalId)) };
      },
    },
    {
      name: "teldra_propose_operation",
      description: "File a change PROPOSAL for human review. Nothing is applied: the user must approve it in Studio. Returns the proposal with a before/after diff. Fails explicitly for unsupported or invalid operations.",
      inputSchema: obj({ summary: { type: "string", minLength: 1, maxLength: 500, description: "Why this change is proposed." }, operation: AGENT_OPERATION_SCHEMA }, ["summary", "operation"]),
      readOnly: true,
      execute: (raw) => {
        const input = raw as { summary: string; operation: AgentOperation };
        if (review.list("pending").length >= AGENT_MAX_PENDING) throw new AgentOperationError("too-many-pending", "Too many pending proposals; the user must review some first.");
        const diff = preview(input.operation);
        sequence += 1;
        const proposal: AgentProposal = {
          id: `proposal:${sequence}`, agentId: options.agentId, summary: input.summary, operation: structuredClone(input.operation),
          status: "pending", baseRevision: revision(), createdAt: now(), diff, stale: false,
        };
        proposals.set(proposal.id, proposal);
        notify();
        return view(proposal);
      },
    },
    {
      name: "teldra_list_proposals",
      description: "List proposals (including their status) made in this session.",
      inputSchema: obj({ status: { type: "string", enum: [...STATUSES] } }), readOnly: true,
      execute: (raw) => ({ proposals: review.list((raw as { status?: AgentProposalStatus }).status) }),
    },
    {
      name: "teldra_get_proposal",
      description: "Read one proposal by ID, including its diff and current status.",
      inputSchema: obj({ proposalId: id }, ["proposalId"]), readOnly: true,
      execute: (raw) => review.get((raw as { proposalId: string }).proposalId),
    },
  ];

  const callTool = (name: string, input: unknown): unknown => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new AgentOperationError("unknown-tool", `Unknown tool "${name}".`);
    const errors = validateAgentSchema(tool.inputSchema, input ?? {});
    if (errors.length) throw new AgentOperationError("invalid-input", errors.join(" "));
    return tool.execute(input ?? {});
  };
  // Tools validate through callTool so a direct execute cannot bypass the published schema.
  const guarded: AgentTool[] = tools.map((tool) => ({ ...tool, execute: (input: unknown) => callTool(tool.name, input) }));
  const callGuarded = (name: string, input: unknown): unknown => callTool(name, input);
  return { tools: guarded, review, callTool: callGuarded };
}
