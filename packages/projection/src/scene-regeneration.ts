import type { TeldraSceneManifest } from "@teldra/scene-manifest";

/**
 * Renderer-independent regeneration of *derived* scene meshes for changed IFC elements.
 *
 * IFC remains authoritative. A {@link SceneMeshUpdate} is a disposable projection of
 * re-tessellated IFC elements into the scene frame declared by the scene manifest
 * (`scene.canonicalToScene`). It never carries canonical placement, only render parts whose
 * stable node keys resolve back to canonical identity and IFC GlobalId.
 */

/** Column-major 4x4 matrix, the representation used by `scene.canonicalToScene`. */
export type Matrix4 = readonly number[];
export type SceneNodeRecord = TeldraSceneManifest["nodes"][number];

/** One triangulated, single-colour part in the canonical IFC frame (metres, Z up). */
export interface ElementMeshPart {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly color: readonly [red: number, green: number, blue: number, alpha: number];
}
export interface ElementMesh {
  readonly globalId: string;
  readonly parts: readonly ElementMeshPart[];
}
/**
 * Synchronous read-side tessellation port (implemented over web-ifc in `@teldra/ifc-edit`).
 * `null` means the element no longer exists in the IFC; an element with zero parts exists
 * but produced no geometry.
 */
export type ElementTessellator = (globalIds: readonly string[]) => ReadonlyMap<string, ElementMesh | null>;

export interface ScenePart extends ElementMeshPart {
  /** Stable manifest node (`ifc:<GlobalId>:body[:n]`) this part will render as. */
  readonly node: SceneNodeRecord;
}
export interface SceneElementMesh {
  readonly globalId: string;
  readonly canonicalId: string;
  readonly parts: readonly ScenePart[];
  /** Node keys the element had before this update (empty for additions). */
  readonly previousNodeKeys: readonly string[];
  /** For additions: a rendered element whose material the renderer should reuse (e.g. the source of a duplicate). */
  readonly materialSourceGlobalId?: string;
}
export interface SceneElementRemoval {
  readonly globalId: string;
  readonly canonicalId: string;
  readonly nodeKeys: readonly string[];
}
/** Positions/normals are in the scene frame; only listed elements may change. */
export interface SceneMeshUpdate {
  readonly replace: readonly SceneElementMesh[];
  readonly add: readonly SceneElementMesh[];
  readonly remove: readonly SceneElementRemoval[];
}

export type RebuildReason =
  | "too-many-elements"
  | "tessellation-failed"
  | "unresolved-identity"
  | "empty-geometry"
  | "invalid-geometry"
  | "invalid-frame";
export type SceneRegenerationPlan =
  | { readonly kind: "noop" }
  | { readonly kind: "patch"; readonly update: SceneMeshUpdate }
  | { readonly kind: "rebuild"; readonly reason: RebuildReason; readonly detail: string };

export interface SceneRegenerationInput {
  readonly nodes: readonly SceneNodeRecord[];
  readonly canonicalToScene: Matrix4;
  readonly changedGlobalIds: readonly string[];
  readonly tessellate: ElementTessellator;
  /** Canonical identity for GlobalIds the manifest does not know yet (e.g. a newly created wall). */
  readonly resolveCanonicalId?: (globalId: string) => string | undefined;
  /** For GlobalIds the scene does not render yet: an already rendered GlobalId whose material a new element reuses. */
  readonly resolveMaterialSource?: (globalId: string) => string | undefined;
  /** Above this many changed elements a patch is not worth its risk; default 64. */
  readonly maxPatchElements?: number;
}

class Rebuild extends Error {
  constructor(readonly reason: RebuildReason, detail: string) { super(detail); }
}

export function nodeKeyFor(globalId: string, partIndex: number, partCount: number): string {
  return partCount === 1 ? `ifc:${globalId}:body` : `ifc:${globalId}:body:${partIndex}`;
}

/**
 * Plans a minimal scene patch for changed IFC elements. Pure: no renderer, no I/O besides the
 * injected tessellator. Any condition that cannot preserve identity yields an explicit
 * `rebuild` outcome instead of a partial or guessed patch.
 */
export function planSceneRegeneration(input: SceneRegenerationInput): SceneRegenerationPlan {
  const ids = [...new Set(input.changedGlobalIds)];
  if (ids.length === 0) return { kind: "noop" };
  try {
    if (ids.length > (input.maxPatchElements ?? 64))
      throw new Rebuild("too-many-elements", `${ids.length} changed elements exceed the patch limit.`);
    const existing = new Map<string, SceneNodeRecord[]>();
    for (const node of input.nodes) {
      if (node.kind !== "building" || node.ifcGlobalId === undefined) continue;
      const list = existing.get(node.ifcGlobalId) ?? [];
      list.push(node);
      existing.set(node.ifcGlobalId, list);
    }
    let meshes: ReadonlyMap<string, ElementMesh | null>;
    try { meshes = input.tessellate(ids); }
    catch (error) { throw new Rebuild("tessellation-failed", error instanceof Error ? error.message : String(error)); }

    const replace: SceneElementMesh[] = [], add: SceneElementMesh[] = [], remove: SceneElementRemoval[] = [];
    for (const globalId of ids) {
      const nodes = existing.get(globalId) ?? [];
      const canonicalIds = new Set(nodes.map((node) => node.canonicalId));
      if (canonicalIds.size > 1) throw new Rebuild("unresolved-identity", `${globalId} maps to several canonical ids.`);
      const canonicalId = nodes[0]?.canonicalId ?? input.resolveCanonicalId?.(globalId);
      const mesh = meshes.get(globalId);
      if (mesh === undefined) throw new Rebuild("tessellation-failed", `No tessellation result for ${globalId}.`);
      if (mesh === null) {
        // Removed from IFC: only meaningful if the scene currently renders it.
        if (nodes.length) remove.push({ globalId, canonicalId: canonicalId!, nodeKeys: nodes.map((node) => node.nodeKey) });
        continue;
      }
      if (canonicalId === undefined) throw new Rebuild("unresolved-identity", `No canonical identity for ${globalId}.`);
      if (mesh.parts.length === 0) throw new Rebuild("empty-geometry", `${globalId} produced no triangles.`);
      const parts = mesh.parts.map((part, index): ScenePart => ({
        ...toSceneFrame(globalId, part, input.canonicalToScene),
        node: {
          nodeKey: nodeKeyFor(globalId, index, mesh.parts.length), canonicalId, ifcGlobalId: globalId, kind: "building",
          renderPart: mesh.parts.length === 1 ? "body" : `body:${index}`,
        },
      }));
      const materialSource = nodes.length ? undefined : input.resolveMaterialSource?.(globalId);
      const element: SceneElementMesh = { globalId, canonicalId, parts, previousNodeKeys: nodes.map((node) => node.nodeKey),
        ...(materialSource === undefined ? {} : { materialSourceGlobalId: materialSource }) };
      (nodes.length ? replace : add).push(element);
    }
    if (!replace.length && !add.length && !remove.length) return { kind: "noop" };
    return { kind: "patch", update: { replace, add, remove } };
  } catch (error) {
    if (error instanceof Rebuild) return { kind: "rebuild", reason: error.reason, detail: error.message };
    throw error;
  }
}

/**
 * Applies the explicit canonical->scene transform (column-major). Normals use the rotation part
 * (rigid/uniform frames); a mirroring frame flips triangle winding so faces stay outward.
 * Throws a `Rebuild`-tagged error for malformed data; callers go through {@link planSceneRegeneration}.
 */
export function toSceneFrame(globalId: string, part: ElementMeshPart, canonicalToScene: Matrix4): ElementMeshPart {
  if (canonicalToScene.length !== 16 || !canonicalToScene.every(Number.isFinite))
    throw new Rebuild("invalid-frame", "canonicalToScene must be 16 finite numbers.");
  const m = canonicalToScene as readonly number[];
  const det = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  if (Math.abs(det) < 1e-12) throw new Rebuild("invalid-frame", "canonicalToScene is singular.");
  const flip = det < 0;
  const { positions, normals, indices } = part;
  const vertices = positions.length / 3;
  if (positions.length === 0 || positions.length % 3 || normals.length !== positions.length ||
      indices.length === 0 || indices.length % 3 ||
      !positions.every(Number.isFinite) || !normals.every(Number.isFinite) ||
      indices.some((index) => index >= vertices) || part.color.length !== 4 || !part.color.every(Number.isFinite))
    throw new Rebuild("invalid-geometry", `${globalId} has malformed triangle data.`);
  const outPositions = new Float32Array(positions.length), outNormals = new Float32Array(normals.length);
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v]!, y = positions[v + 1]!, z = positions[v + 2]!;
    outPositions[v] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    outPositions[v + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    outPositions[v + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    const nx = normals[v]!, ny = normals[v + 1]!, nz = normals[v + 2]!;
    let tx = m[0]! * nx + m[4]! * ny + m[8]! * nz, ty = m[1]! * nx + m[5]! * ny + m[9]! * nz, tz = m[2]! * nx + m[6]! * ny + m[10]! * nz;
    const length = Math.hypot(tx, ty, tz);
    if (length > 0) { tx /= length; ty /= length; tz /= length; }
    if (flip) { tx = -tx; ty = -ty; tz = -tz; }
    outNormals[v] = tx; outNormals[v + 1] = ty; outNormals[v + 2] = tz;
  }
  const outIndices = Uint32Array.from(indices);
  if (flip) for (let t = 0; t < outIndices.length; t += 3) { const tmp = outIndices[t + 1]!; outIndices[t + 1] = outIndices[t + 2]!; outIndices[t + 2] = tmp; }
  return { positions: outPositions, normals: outNormals, indices: outIndices, color: part.color };
}
