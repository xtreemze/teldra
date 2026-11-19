import { IfcAPI, IFCCARTESIANPOINTLIST3D, IFCTRIANGULATEDFACESET, IFCPROJECT, IFCSIUNIT } from "web-ifc";
import type { Line } from "./ifc-session.js";

/**
 * Edit-session engine (internal): one open web-ifc model bound to one immutable byte revision,
 * plus an inverse-reference index kept consistent across writes. See `edit-session.ts` for the public handle.
 */

const refsOf = (value: any, out: number[] = []): number[] => {
  if (Array.isArray(value)) for (const item of value) refsOf(item, out);
  else if (value && value.type === 5 && Number.isInteger(value.value)) out.push(value.value);
  return out;
};
const lineReferences = (line: Line): number[] => {
  const out: number[] = [];
  for (const key of Object.keys(line)) if (key !== "expressID" && key !== "type") refsOf(line[key], out);
  return out;
};

/** Read-only inverse view captured at one instant: `get(target)` = ascending express ids of lines referencing it. */
export interface InverseSnapshot { get(target: number): readonly number[] | undefined }

/**
 * Per-open-model inverse reference index (target -> referrers), built lazily once and kept consistent
 * with every WriteLine / CreateIfcEntity / DeleteLine routed through the session's tracked API.
 * IfcCartesianPointList3D carries no references and IfcTriangulatedFaceSet only its Coordinates, so on
 * large geometry models those payload lines are not parsed unless a query targets a point list.
 */
export class SessionIndex {
  private forward: Map<number, number[]> | null = null;
  private inverse = new Map<number, Set<number>>();
  private facesetsResolved = false;
  /** Position of each line in the model's own line order: referrers are reported in this order, like a full scan would. */
  private position = new Map<number, number>();
  constructor(private readonly api: IfcAPI, private readonly id: number) {}

  private link(from: number, refs: number[]): void {
    this.unlink(from);
    this.forward!.set(from, refs);
    for (const target of refs) { let set = this.inverse.get(target); if (!set) this.inverse.set(target, set = new Set()); set.add(from); }
  }
  private unlink(from: number): void {
    const old = this.forward!.get(from);
    if (!old) return;
    for (const target of old) { const set = this.inverse.get(target); if (set) { set.delete(from); if (!set.size) this.inverse.delete(target); } }
    this.forward!.delete(from);
  }
  private build(): void {
    this.forward = new Map();
    const all = this.api.GetAllLines(this.id);
    for (let i = 0; i < all.size(); i++) this.position.set(all.get(i), i);
    for (let i = 0; i < all.size(); i++) {
      const e = all.get(i), type = this.api.GetLineType(this.id, e);
      if (type === IFCCARTESIANPOINTLIST3D || type === IFCTRIANGULATEDFACESET) continue;
      let line: Line; try { line = this.api.GetLine(this.id, e) as Line; } catch { continue; }
      this.link(e, lineReferences(line));
    }
  }
  private resolveFacesets(): void {
    if (this.facesetsResolved) return;
    this.facesetsResolved = true;
    const ids = this.api.GetLineIDsWithType(this.id, IFCTRIANGULATEDFACESET);
    for (let i = 0; i < ids.size(); i++) {
      const e = ids.get(i); if (this.forward!.has(e)) continue;
      try { this.link(e, lineReferences(this.api.GetLine(this.id, e) as Line)); } catch { /* unreadable line */ }
    }
  }
  private rank(e: number): number { return this.position.get(e) ?? Number.MAX_SAFE_INTEGER; }
  /** Copy of the inverse as of now: later writes do not change it (matches the legacy per-operation scan). */
  snapshot(): InverseSnapshot {
    if (!this.forward) this.build();
    const copy = (): Map<number, number[]> => new Map([...this.inverse].map(([k, v]) => [k, [...v].sort((a, b) => this.rank(a) - this.rank(b))]));
    let view = copy(), resolved = this.facesetsResolved;
    return { get: (target) => {
      if (!resolved && target > 0 && this.api.GetLineType(this.id, target) === IFCCARTESIANPOINTLIST3D) { this.resolveFacesets(); view = copy(); resolved = true; }
      return view.get(target);
    } };
  }
  /** Tracked-API hook after a write. A no-op until the index has been built. */
  written(expressID: number, line: Line | null, refs?: number[]): void {
    if (!this.forward || !Number.isInteger(expressID) || expressID < 0) return;
    if (!this.position.has(expressID)) this.position.set(expressID, this.position.size);
    this.link(expressID, refs ?? (line ? lineReferences(line) : []));
  }
  deleted(expressID: number): void { if (this.forward) this.unlink(expressID); }
}

const indexes = new WeakMap<object, SessionIndex>();
/** The reference index belonging to an API handle passed into a `model()` callback. */
export function indexOf(api: IfcAPI): SessionIndex {
  const found = indexes.get(api);
  if (!found) throw new Error("No IFC edit session is open for this API handle.");
  return found;
}

/** Cheap guard against a caller mutating a revision's bytes in place (unsupported; revisions are immutable). */
const fingerprint = (bytes: Uint8Array): string => {
  let h = bytes.length | 0;
  const step = Math.max(1, Math.floor(bytes.length / 257));
  for (let i = 0; i < bytes.length; i += step) h = (Math.imul(h, 31) + bytes[i]!) | 0;
  return `${bytes.length}:${h}`;
};

let activeCore: SessionCore | null = null;

export class SessionCore {
  private id: number | null = null;
  private tracked: IfcAPI | null = null;
  private dirty = false;
  private deleted = false;
  private revision: Uint8Array;
  private guard: string;
  constructor(readonly api: IfcAPI, bytes: Uint8Array) { this.revision = bytes; this.guard = fingerprint(bytes); }
  /** The byte revision the open model currently equals (advances to each saved result). */
  get bytes(): Uint8Array { return this.revision; }
  get isOpen(): boolean { return this.id !== null; }
  matches(api: IfcAPI, bytes: Uint8Array): boolean { return api === this.api && bytes === this.revision; }

  private open(): void {
    if (fingerprint(this.revision) !== this.guard) throw new Error("IFC bytes were mutated after the edit session adopted them; treat bytes as immutable.");
    const api = this.api, id = api.OpenModel(this.revision);
    try {
      if (api.GetModelSchema(id) !== "IFC4") throw new Error("Only IFC4 furniture placement is supported.");
      const projects = api.GetLineIDsWithType(id, IFCPROJECT);
      if (projects.size() !== 1) throw new Error("Expected exactly one IFC project.");
      const project = api.GetLine(id, projects.get(0), true) as Line;
      const units = project.UnitsInContext?.Units;
      const lengths = Array.isArray(units) ? units.filter((unit: Line) => unit.UnitType?.value === "LENGTHUNIT") : [];
      if (lengths.length !== 1 || lengths[0].Name?.value !== "METRE" || lengths[0].Prefix !== null || lengths[0].type !== IFCSIUNIT) throw new Error("Only unprefixed metre IFC length units are supported.");
    } catch (error) { api.CloseModel(id); throw error; }
    this.id = id;
    const index = new SessionIndex(api, id);
    const mark = () => { this.dirty = true; };
    const wrapped: Record<string, (...args: any[]) => any> = {
      WriteLine: (modelID: number, line: Line) => { mark(); const r = api.WriteLine(modelID, line); index.written(line.expressID, line); return r; },
      DeleteLine: (modelID: number, e: number) => { mark(); this.deleted = true; const r = api.DeleteLine(modelID, e); index.deleted(e); return r; },
      CreateIfcEntity: (modelID: number, type: number, ...args: any[]) => {
        mark(); const handle = (api.CreateIfcEntity as (...a: any[]) => any)(modelID, type, ...args);
        index.written(handle?.value, null, refsOf(args)); return handle;
      },
    };
    this.tracked = new Proxy(api, { get: (target, key, receiver) => (typeof key === "string" && wrapped[key]) ? wrapped[key] : Reflect.get(target, key, receiver) });
    indexes.set(this.tracked, index);
  }
  private discard(): void {
    if (this.tracked) indexes.delete(this.tracked);
    if (this.id !== null) { try { this.api.CloseModel(this.id); } catch { /* already closed */ } }
    this.id = null; this.tracked = null; this.dirty = false; this.deleted = false;
  }
  execute<T>(run: (id: number, api: IfcAPI) => T): T {
    if (this.id === null) this.open();
    this.dirty = false; this.deleted = false;
    let result: T;
    try { result = run(this.id!, this.tracked!); }
    catch (error) { if (this.dirty) this.discard(); throw error; }
    if (this.dirty) {
      // A write that did not serialise leaves the model ahead of its revision: drop it rather than risk drift.
      if (result instanceof Uint8Array) {
        this.revision = result; this.guard = fingerprint(result); this.dirty = false;
        // web-ifc keeps deleted lines listed by type queries in the live model; only a fresh open of the saved bytes is exact.
        if (this.deleted) this.discard();
      } else this.discard();
    }
    return result;
  }
  /** Make this core the one `model()` reuses for the duration of `fn`. */
  scope<T>(fn: () => T): T {
    const previous = activeCore; activeCore = this;
    try { return fn(); } finally { activeCore = previous; }
  }
  close(): void { this.discard(); }
}

/** Run against an open, validated model; reuses the scoped session when it already holds exactly `bytes`. */
export function model<T>(api: IfcAPI, bytes: Uint8Array, run: (id: number, api: IfcAPI) => T): T {
  const scoped = activeCore;
  if (scoped && scoped.matches(api, bytes)) return scoped.execute(run);
  const core = new SessionCore(api, bytes);
  try { return core.execute(run); } finally { core.close(); }
}
