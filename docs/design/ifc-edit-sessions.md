# IFC edit sessions (`@teldra/ifc-edit`)

Large IFC models (the 63 MB 21D import) made every edit cost 2.5-3 s: each call re-opened the bytes, parsed every
line with `GetLine` to build an inverse reference map, edited, and saved. Geometry payload lines
(`IfcCartesianPointList3D`, `IfcTriangulatedFaceSet`) were ~2.4 s of that scan alone.

## What changed

- **Inverse reference index** (`session-core.ts`, `SessionIndex`): built lazily once per open model, skipping
  payload types that cannot matter (point lists carry no references; face sets are resolved only if a query targets a
  point list). Referrers are reported in the model's own line order, so write order, new express ids and the saved bytes
  are identical to the previous full-scan implementation.
- **Tracked API**: inside every operation `api` is a proxy; `WriteLine`, `CreateIfcEntity` and `DeleteLine` keep the
  index consistent. Operations take an immutable snapshot of the inverse, matching the old per-operation semantics.
- **Edit session** (`edit-session.ts`): optional handle that keeps the model open and the index built across
  operations on one byte revision.

## Adopting it (Studio / application)

```ts
let session = reuseEditSession(previous, api, currentIfcBytes);   // same bytes object -> same session
const next = session.run((bytes) => duplicateFurniture(api, bytes, guid, newGuid));
// session now represents `next`. Undo = reuseEditSession(session, api, olderBytes) (reopens); close() when done.
```

Rules: revisions are immutable (never mutate bytes passed to a session); one session per `IfcAPI`; a throwing
write discards the open model and the session reopens from the last good revision; after an operation that deletes
lines the model is reopened on the next call (web-ifc keeps deleted ids listed in a live model), so a remove is warm
but the operation after it pays one open. Without a session every exported function behaves as before.

## Measurements (21D, Node, median / p95 ms, 10 runs)

See `packages/ifc-edit/test/profile-21d.perf.test.ts` (opt-in via `TELDRA_PERF_IFC`).

| operation | before (one-shot) | cold now | warm session |
|---|---|---|---|
| duplicate | ~2780 | 553 / 648 | 242 / 258 |
| remove | ~2830 | 529 / 674 | 276 / 388 |
| writeFurniturePose | ~530 | 503 / 524 | 237 / 271 |
| updateWall | ~2760 | 536 / 734 | 234 / 329 |
| entity lookup (pose read) | ~290 | 274 / 287 (open) | 1 / 1 |

Warm cost is now dominated by `SaveModel` (~235 ms), which is web-ifc serialization.
