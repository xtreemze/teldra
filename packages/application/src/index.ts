export type StateLifetime =
  | "project"
  | "source-artifact"
  | "runtime"
  | "session"
  | "recovery"
  | "cache";

export type UndoRedoParticipation =
  | "participates"
  | "does-not-participate"
  | "records-history";

export type ProjectSerializationDisposition =
  | "authoritative"
  | "derived-cache"
  | "forbidden";

export type CrossWindowPolicy =
  | "single-writer"
  | "coordinated-runtime"
  | "window-local"
  | "content-addressed";

export type SolidIntegrationBoundary =
  | "read-model-only"
  | "session-store"
  | "draft-store"
  | "status-store";

export interface StateOwnershipPolicy {
  owner: string;
  lifetime: StateLifetime;
  mutationAuthority: string;
  undoRedo: UndoRedoParticipation;
  reconstructible: boolean;
  crossWindow: CrossWindowPolicy;
  solidBoundary: SolidIntegrationBoundary;
  projectSerialization: ProjectSerializationDisposition;
}

/**
 * Application-level ownership taxonomy for state that exists around a Teldra project.
 *
 * This registry is intentionally framework-neutral. It describes authority and lifecycle;
 * it is not itself an application store.
 */
export const STATE_OWNERSHIP = {
  "canonical-project": {
    owner: "application canonical twin services",
    lifetime: "project",
    mutationAuthority: "application commands",
    undoRedo: "participates",
    reconstructible: false,
    crossWindow: "single-writer",
    solidBoundary: "read-model-only",
    projectSerialization: "authoritative",
  },
  "canonical-ifc": {
    owner: "IFC-aware application service",
    lifetime: "source-artifact",
    mutationAuthority: "IFC-aware application commands",
    undoRedo: "participates",
    reconstructible: false,
    crossWindow: "single-writer",
    solidBoundary: "read-model-only",
    projectSerialization: "authoritative",
  },
  "live-device": {
    owner: "live-state reducer and adapter boundary",
    lifetime: "runtime",
    mutationAuthority: "adapter observations and desired-state command flow",
    undoRedo: "does-not-participate",
    reconstructible: true,
    crossWindow: "coordinated-runtime",
    solidBoundary: "read-model-only",
    projectSerialization: "forbidden",
  },
  projection: {
    owner: "deterministic projection services",
    lifetime: "runtime",
    mutationAuthority: "recompute from authoritative and live inputs",
    undoRedo: "does-not-participate",
    reconstructible: true,
    crossWindow: "window-local",
    solidBoundary: "read-model-only",
    projectSerialization: "derived-cache",
  },
  session: {
    owner: "application session",
    lifetime: "session",
    mutationAuthority: "application session services",
    undoRedo: "does-not-participate",
    reconstructible: true,
    crossWindow: "window-local",
    solidBoundary: "session-store",
    projectSerialization: "forbidden",
  },
  "selection-focus": {
    owner: "interaction session",
    lifetime: "session",
    mutationAuthority: "interaction controller",
    undoRedo: "does-not-participate",
    reconstructible: true,
    crossWindow: "window-local",
    solidBoundary: "session-store",
    projectSerialization: "forbidden",
  },
  "camera-viewport": {
    owner: "viewport session",
    lifetime: "session",
    mutationAuthority: "viewport controller",
    undoRedo: "does-not-participate",
    reconstructible: true,
    crossWindow: "window-local",
    solidBoundary: "session-store",
    projectSerialization: "forbidden",
  },
  "editor-draft": {
    owner: "editor draft service",
    lifetime: "recovery",
    mutationAuthority: "editor workflow until committed as an application command",
    undoRedo: "does-not-participate",
    reconstructible: false,
    crossWindow: "window-local",
    solidBoundary: "draft-store",
    projectSerialization: "forbidden",
  },
  "command-history": {
    owner: "application command processor",
    lifetime: "recovery",
    mutationAuthority: "application command processor",
    undoRedo: "records-history",
    reconstructible: false,
    crossWindow: "single-writer",
    solidBoundary: "read-model-only",
    projectSerialization: "forbidden",
  },
  "renderer-resource": {
    owner: "renderer adapter",
    lifetime: "runtime",
    mutationAuthority: "renderer adapter",
    undoRedo: "does-not-participate",
    reconstructible: true,
    crossWindow: "window-local",
    solidBoundary: "read-model-only",
    projectSerialization: "forbidden",
  },
  "cache-build": {
    owner: "artifact/cache pipeline",
    lifetime: "cache",
    mutationAuthority: "content-addressed build pipeline",
    undoRedo: "does-not-participate",
    reconstructible: true,
    crossWindow: "content-addressed",
    solidBoundary: "read-model-only",
    projectSerialization: "derived-cache",
  },
  "connection-adapter": {
    owner: "integration adapter runtime",
    lifetime: "runtime",
    mutationAuthority: "integration lifecycle",
    undoRedo: "does-not-participate",
    reconstructible: true,
    crossWindow: "coordinated-runtime",
    solidBoundary: "status-store",
    projectSerialization: "forbidden",
  },
} as const satisfies Record<string, StateOwnershipPolicy>;

export type RuntimeStateKind = keyof typeof STATE_OWNERSHIP;

export type AuthoritativeProjectStateKind = {
  [K in RuntimeStateKind]: (typeof STATE_OWNERSHIP)[K]["projectSerialization"] extends "authoritative"
    ? K
    : never;
}[RuntimeStateKind];

export const AUTHORITATIVE_PROJECT_STATE_KINDS = [
  "canonical-project",
  "canonical-ifc",
] as const satisfies readonly AuthoritativeProjectStateKind[];

export type RuntimeStateSnapshot = Partial<Record<RuntimeStateKind, unknown>>;
export type AuthoritativeProjectStateSnapshot = Partial<
  Record<AuthoritativeProjectStateKind, unknown>
>;

export function projectSerializationDisposition(
  kind: RuntimeStateKind,
): ProjectSerializationDisposition {
  return STATE_OWNERSHIP[kind].projectSerialization;
}

export function isAuthoritativeProjectStateKind(
  kind: RuntimeStateKind,
): kind is AuthoritativeProjectStateKind {
  return projectSerializationDisposition(kind) === "authoritative";
}

/**
 * Selects only authoritative state for canonical project serialization.
 *
 * Derived caches are handled by the artifact/cache pipeline and must be written
 * as explicitly disposable data. Runtime, session, draft, renderer, live, and
 * connection state cannot enter canonical project serialization through this API.
 */
export function selectAuthoritativeProjectState(
  snapshot: RuntimeStateSnapshot,
): AuthoritativeProjectStateSnapshot {
  const result: AuthoritativeProjectStateSnapshot = {};

  for (const kind of AUTHORITATIVE_PROJECT_STATE_KINDS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, kind)) {
      result[kind] = snapshot[kind];
    }
  }

  return result;
}
