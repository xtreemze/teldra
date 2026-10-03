# ADR 0014: Canonical commands, transactions, and undo/redo

Status: accepted

## Context

Teldra will author canonical state from multiple surfaces: SolidJS Studio, Blender/Bonsai integration, CLI tooling, tests, and future automation. If each surface writes IFC or `twin.json` directly, mutation semantics, undo/redo, identity preservation, diagnostics, and save/recovery behavior will diverge.

ADR 0013 classifies only canonical project state and canonical IFC as authoritative project state. This ADR defines the mutation boundary for those two authorities.

## Decision

All user-visible canonical edits are represented as JSON-safe application commands and applied through atomic application transactions.

A command contains:

- stable command ID;
- command kind;
- exactly one canonical authority: `canonical-project` or `canonical-ifc`;
- JSON-safe payload.

Commands are data. UI framework objects, renderer objects, Blender `bpy` values, Home Assistant objects, functions, GPU handles, and filesystem handles are not command payloads.

A transaction contains:

- stable transaction ID;
- one or more ordered commands;
- optional expected application revision for optimistic conflict detection.

The TypeScript reference implementation lives in `@teldra/application` as `CommandProcessor` and `applyCommandTransaction`.

## Handler contract

Command handlers are deterministic application services. Given canonical state plus one command they return:

1. the next canonical state;
2. an inverse command that restores the immediately preceding canonical state.

Handlers must not mutate their input state or perform externally visible side effects during the pure command phase.

IFC-aware implementations may internally delegate to IfcOpenShell/Bonsai/Blender adapters, but the adapter must respect the application transaction boundary. A renderer or Blender scene is never the mutation authority.

## Atomicity and rollback

A transaction publishes state only after every command succeeds.

If command N fails:

- no intermediate transaction state becomes current;
- revision does not advance;
- undo/redo history does not change;
- the failure identifies transaction, command, and command index;
- external adapters must roll back or discard their staged work before reporting failure.

This makes failure rollback explicit without treating UI state as a backup copy.

## Identity

Inverse operations must preserve canonical Teldra IDs and IFC GlobalIds. Undoing deletion/recreation is logically restoration of the same canonical identity, not generation of a replacement identity.

Commands that intentionally change identity require a separately reviewed domain contract.

## Undo and redo

A successfully committed transaction is one undo/redo unit.

Inverse commands are recorded in reverse application order. Undo applies the complete inverse transaction atomically. Redo reapplies the original transaction.

Command history is application recovery/session state from ADR 0013. It is not portable canonical `.teldra` content.

Undo/redo applies only to canonical editing commands. It does not include:

- camera movement;
- selection/focus;
- filtering or visualization;
- renderer state;
- live observations;
- desired physical-device state or Home Assistant service calls;
- adapter connectivity;
- generated caches.

A physical command may use correlation metadata from the same diagnostics system, but it crosses the separate authorization/safety boundary from #33 and is not canonical undo.

## Revisions and conflicts

The command processor maintains a monotonic application revision.

A caller may specify `expectedRevision`. If it does not equal current revision, the transaction is rejected before mutation. This supports deterministic stale-editor detection without defining collaboration or multi-user merge semantics prematurely.

Each execute, undo, and redo state transition advances the revision.

Committed transaction IDs may not be executed a second time through the normal execute path. Redo is an explicit history operation, not replay disguised as a new command.

## Cross-runtime use

The canonical envelope is intentionally JSON-safe so Studio, CLI, tests, and Blender/Bonsai integration can exchange the same semantic command data. Runtime-specific handlers may differ, but they must implement the same command/transaction behavior and tests.

A future serialized command schema may freeze wire compatibility when command persistence or external automation APIs require it. This ADR does not make command logs part of the project format.

## Representative certification

Application tests demonstrate one transaction containing:

- twin device creation;
- IFC element movement;
- twin metadata editing;
- external-system binding.

The same transaction is then undone and redone deterministically. Additional tests cover partial failure, stale revision rejection, duplicate transaction IDs, JSON-unsuitable payloads, and attempts to route camera/live-device commands through canonical history.

## Consequences

- Studio, Blender integration, CLI, and tests share one canonical mutation model.
- #32 can persist committed canonical state and separately recover command/draft state.
- #33 remains the sole place where authority to affect physical devices is granted.
- #35 can attach correlation IDs at transaction/command boundaries without renderer-specific tracing.
