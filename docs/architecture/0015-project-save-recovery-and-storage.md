# ADR 0015: Project save, recovery, and local-storage semantics

Status: accepted

## Context

Teldra combines authoritative IFC, authoritative twin configuration, authored assets, and disposable derived artifacts inside a portable project. Studio, Blender/Bonsai integration, CLI tools, and future native/browser shells must not invent incompatible save and crash-recovery behavior.

ADR 0013 defines which state is authoritative. ADR 0014 defines canonical command transactions. This ADR defines when that canonical state becomes durable.

## Authority and storage classes

A portable `.teldra` project has three storage classes:

1. **Authoritative project data** — project manifest, IFC, twin document, and authored source assets.
2. **Derived cache** — GLB, scene manifests, baked lighting, reflection probes, thumbnails, and similar outputs. These are disposable and may be absent.
3. **Host-local recovery/session data** — autosave snapshots, editor drafts, command-history recovery, window/session state, and filesystem-handle metadata. These are not portable project authority.

Browser IndexedDB/local storage or native application storage may hold class 2 or 3 data. They must not become the only location of class 1 data for a user-selected project.

## Manual save protocol

A manual save is a staged atomic replacement:

```text
current primary
      │
      ├── serialize canonical snapshot
      ├── validate canonical content
      ├── write complete temporary candidate
      ├── flush candidate as required by host
      └── atomic replace
              │
              ├── new primary
              └── previous primary -> backup
```

The storage adapter contract requires `commitStaged()` to have all-or-nothing visibility. If it reports failure, the previously committed primary and backup remain unchanged.

A candidate is not canonical merely because it exists in temporary storage.

## Dirty state

Dirty state is based on the canonical content fingerprint, not only command revision.

A command revision remains useful for stale-editor detection, diagnostics, and ordering, but undo may return content to the exact saved fingerprint at a newer revision. In that case the project is clean.

A save candidate must match both the application revision and canonical fingerprint captured for the current state. Saving an older candidate is rejected rather than overwriting newer edits.

## Autosave and crash recovery

Autosave writes a separate recovery slot. It does not replace the primary and does not clear dirty state.

On open:

- a valid primary opens normally;
- a newer/different valid recovery snapshot is reported as recovery available;
- recovery is never applied silently;
- an invalid recovery snapshot is ignored as authority and may be cleaned later;
- if the primary is corrupt, open fails explicitly and reports any independently valid backup/recovery sources.

Restoration is an explicit action. A selected valid backup or recovery candidate is written through the same staged atomic replacement path as a normal save.

## Corruption

Canonical validation happens independently from derived-cache validation.

Missing or corrupt cache must not make a valid project unrecoverable; the cache can be discarded and rebuilt.

If authoritative canonical data fails validation, Teldra does not attempt to infer or patch it silently. The caller receives a corruption error and may explicitly restore a validated backup/recovery candidate.

Migration failure follows the same rule: do not replace the previous valid primary until migration, validation, serialization, and staged commit all succeed.

## Concurrency

One project has at most one write owner at a time.

- read-write open acquires an exclusive project lock;
- another read-write open fails deterministically;
- read-only inspection may coexist;
- closing or failed open releases the write lock;
- stale-lock recovery is a host concern and must require evidence that the owning process/session is no longer active.

This is local concurrency control, not a collaboration protocol.

## Backup policy

The atomic storage adapter keeps the immediately previous successfully committed primary as a backup.

A host may retain additional versioned backups, but retention policy is outside the canonical project format. Backups containing private home data receive the same protection as the primary project.

## Browser and filesystem responsibilities

The canonical domain never stores browser handles, absolute filesystem paths, IndexedDB keys, window IDs, or platform lock primitives.

Those values belong to host/application persistence adapters.

A browser implementation may use the File System Access API when available and a download/import workflow otherwise. A native implementation may use filesystem rename/replace primitives. Both must implement the same staged-commit semantics.

## State machine

```text
open clean
   │ edit / canonical fingerprint changes
   ▼
 dirty ── autosave ──► dirty + recovery slot
   │
   ├── save begin ──► saving
   │                    │
   │                    ├── atomic commit succeeds ──► clean
   │                    │                              (or dirty if edits
   │                    │                               advanced meanwhile)
   │                    │
   │                    └── failure ──► save-failed / dirty
   │
   └── close with dirty state ──► caller decides discard / save / preserve recovery

corrupt primary ──► explicit failure
                       │
                       └── explicit validated backup/recovery restore
                               │
                               └── atomic replacement
```

## Executable contract

`@teldra/project-format` exposes:

- `ProjectStorageAdapter` for host-specific locks and atomic storage;
- `openProjectPersistence()` for validation/recovery discovery;
- `ProjectPersistenceSession` for dirty/autosave/save lifecycle;
- `restoreProjectFrom()` for explicit backup/recovery restoration.

The reference tests use a fault-injectable in-memory adapter to prove interrupted writes do not replace the primary.

## Consequences

- Studio, native shells, Blender integration, and CLI storage adapters share one save state machine.
- command history and editor drafts may be recoverable without contaminating portable project authority;
- cache loss is a performance event, not data loss;
- #30 can add producer/toolchain provenance to derived cache validity without changing canonical save semantics;
- future migrations have an atomic commit boundary and cannot silently half-upgrade a project.
