# ADR 0013: Runtime state ownership and lifecycle

Status: accepted

## Context

Teldra spans canonical BIM, twin configuration, live smart-home observations, deterministic projections, browser sessions, editor drafts, GPU resources, caches, and adapter connections. Those state classes have different authorities and lifetimes.

Treating them as one application store would make SolidJS an accidental database, allow renderer/session state to leak into portable projects, and make undo, persistence, recovery, and cross-window behavior ambiguous.

## Decision

State is classified by ownership before it is exposed to a UI or renderer. The executable registry lives in `@teldra/application` as `STATE_OWNERSHIP`.

| State kind | Owner | Lifetime | Undo/redo | Reconstructible | Cross-window | SolidJS boundary | Project serialization |
|---|---|---|---|---:|---|---|---|
| canonical project | application canonical twin services | project | participates | no | single writer | read model only | authoritative |
| canonical IFC | IFC-aware application service | source artifact | participates | no | single writer | read model only | authoritative |
| live device | live-state reducer / adapter boundary | runtime | no | yes | coordinated runtime | read model only | forbidden |
| projection | deterministic projection services | runtime | no | yes | window local | read model only | derived cache only |
| session | application session | session | no | yes | window local | session store | forbidden |
| selection/focus | interaction session | session | no | yes | window local | session store | forbidden |
| camera/viewport | viewport session | session | no | yes | window local | session store | forbidden |
| editor draft | editor draft service | recovery | no | no | window local | draft store | forbidden |
| command history | application command processor | recovery | records history | no | single writer | read model only | forbidden |
| renderer resource | renderer adapter | runtime | no | yes | window local | read model only | forbidden |
| cache/build | artifact/cache pipeline | cache | no | yes | content addressed | read model only | derived cache only |
| connection/adapter | integration adapter runtime | runtime | no | yes | coordinated runtime | status store | forbidden |

## Canonical serialization boundary

Only `canonical-project` and `canonical-ifc` are authoritative project state.

A `.teldra` container may carry derived scene, lighting, reflection, or other cache artifacts, but their presence never changes their authority. They remain disposable and must be validated by source hashes and producer/toolchain provenance before reuse.

Live Home Assistant or other adapter state, selection, camera position, renderer objects, GPU buffers, connection state, command history, and editor drafts are not portable canonical project data.

The application package exposes `selectAuthoritativeProjectState()` so persistence work has an executable boundary rather than relying on UI convention.

## Mutation and undo

Canonical project and IFC changes enter through application commands and participate in the command transaction/history model defined by the follow-on command ADR.

Everything else is outside canonical undo/redo:

- camera and selection changes are interaction state;
- live observations describe external reality;
- desired physical-device state belongs to the smart-home command flow and is not a reversible canonical edit;
- projections and renderer resources are recomputed;
- editor drafts become canonical only when committed through an application command;
- cache builds are replaced by regeneration.

The command history records canonical undo/redo but is not itself canonical project content.

## Cross-window and concurrent access

Canonical project and IFC state use a single-writer policy. Persistence/locking semantics define how ownership is acquired and recovered.

Live and connection state may be coordinated by a shared adapter/runtime service. Their coordination does not grant project mutation authority.

Selection, focus, camera, renderer resources, and ordinary session state are window-local. They must not synchronize by writing canonical state.

Content-addressed cache artifacts may be shared across windows/processes only when their inputs and producer provenance match.

## SolidJS integration

SolidJS may own view/session stores for selection, camera, panels, and editor drafts. It may subscribe to canonical, live, projection, history, and adapter read models.

SolidJS signals/stores are never the persistence authority for canonical project state, IFC, live device truth, command history, renderer resources, or connections. Application services remain authoritative and UI stores are projections or workflow-local state.

## Recovery boundary

Editor drafts and command history may participate in local crash-recovery mechanisms without becoming canonical `.teldra` content. Recovery data must be separately identifiable, replaceable, and committed through normal application commands before it becomes project authority.

The persistence ADR defines the exact recovery journal, atomic write, dirty-state, and locking mechanics.

## Consequences

- #31 can define commands and undo/redo against only the two canonical state classes.
- #32 can define project persistence without discovering state ownership implicitly.
- #33 can keep physical-device authority separate from canonical mutation authority.
- renderer and SolidJS implementation details remain replaceable.
- tests can reject state leakage at the application boundary before filesystem code exists.
