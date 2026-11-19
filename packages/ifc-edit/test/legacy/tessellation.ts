import { IfcAPI, IFCPRODUCT } from "web-ifc";
import type { ElementMesh, ElementMeshPart, ElementTessellator } from "@teldra/projection";

/**
 * Read-side tessellation of selected IFC elements (never mutates IFC bytes).
 *
 * Output is in the canonical IFC world frame: metres, Z up. `web-ifc` itself emits a Y-up frame,
 * (x, y, z)_ifc -> (x, z, -y), with placement transforms applied and `COORDINATE_TO_ORIGIN` off.
 * That is an implicit library convention, so it is undone here explicitly
 * ({@link webIfcToCanonical}, a proper rotation) and pinned by a test. Conversion into a scene
 * frame is the projection layer's explicit `canonicalToScene` step, not done here.
 *
 * Returns `null` for GlobalIds that are not products in the model. Elements are matched by
 * GlobalId, so the result is independent of express ids, which change across IFC edits.
 */
export function tessellateElements(
  api: IfcAPI, bytes: Uint8Array, globalIds: readonly string[],
): Map<string, ElementMesh | null> {
  const wanted = new Set(globalIds);
  const result = new Map<string, ElementMesh | null>(globalIds.map((id) => [id, null]));
  if (wanted.size === 0) return result;
  const modelID = api.OpenModel(bytes);
  try {
    const expressIds: number[] = [];
    const guidByExpress = new Map<number, string>();
    const products = api.GetLineIDsWithType(modelID, IFCPRODUCT, true);
    for (let i = 0; i < products.size(); i++) {
      const expressID = products.get(i);
      const guid = (api.GetLine(modelID, expressID) as { GlobalId?: { value?: unknown } }).GlobalId?.value;
      if (typeof guid === "string" && wanted.has(guid)) { expressIds.push(expressID); guidByExpress.set(expressID, guid); }
    }
    for (const guid of guidByExpress.values()) result.set(guid, { globalId: guid, parts: [] });
    if (expressIds.length === 0) return result;
    api.StreamMeshes(modelID, expressIds, (flat) => {
      const guid = guidByExpress.get(flat.expressID);
      if (guid === undefined) return;
      const parts: ElementMeshPart[] = [];
      for (let g = 0; g < flat.geometries.size(); g++) {
        const placed = flat.geometries.get(g);
        const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
        try {
          const vertexData = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
          const indexData = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
          parts.push(placedPart(vertexData, indexData, placed.flatTransformation,
            [placed.color.x, placed.color.y, placed.color.z, placed.color.w]));
        } finally { geometry.delete(); }
      }
      result.set(guid, { globalId: guid, parts });
    });
    return result;
  } finally { api.CloseModel(modelID); }
}

/** Adapts {@link tessellateElements} to the projection port for one immutable IFC snapshot. */
export function createElementTessellator(api: IfcAPI, bytes: Uint8Array): ElementTessellator {
  const snapshot = bytes.slice();
  return (globalIds) => tessellateElements(api, snapshot, globalIds);
}

/** web-ifc Y-up (x, y, z) -> canonical IFC Z-up (x, -z, y). Determinant +1, so winding is preserved. */
export function webIfcToCanonical(v: readonly [number, number, number]): [number, number, number] {
  return [v[0], -v[2], v[1]];
}

/** web-ifc vertices are interleaved x,y,z,nx,ny,nz in the geometry's local frame; transform is column-major. */
function placedPart(
  vertexData: Float32Array, indexData: Uint32Array, m: readonly number[],
  color: readonly [number, number, number, number],
): ElementMeshPart {
  const count = Math.floor(vertexData.length / 6);
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const o = v * 6, x = vertexData[o]!, y = vertexData[o + 1]!, z = vertexData[o + 2]!;
    positions.set(webIfcToCanonical([
      m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
      m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
      m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]), v * 3);
    const nx = vertexData[o + 3]!, ny = vertexData[o + 4]!, nz = vertexData[o + 5]!;
    const tx = m[0]! * nx + m[4]! * ny + m[8]! * nz, ty = m[1]! * nx + m[5]! * ny + m[9]! * nz, tz = m[2]! * nx + m[6]! * ny + m[10]! * nz;
    const length = Math.hypot(tx, ty, tz) || 1;
    normals.set(webIfcToCanonical([tx / length, ty / length, tz / length]), v * 3);
  }
  return { positions, normals, indices: Uint32Array.from(indexData), color };
}
