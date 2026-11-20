import {
  Handle, IFC4, IfcAPI,
  IFCARBITRARYCLOSEDPROFILEDEF, IFCAXIS2PLACEMENT2D, IFCAXIS2PLACEMENT3D, IFCBUILDINGSTOREY, IFCCARTESIANPOINT,
  IFCCARTESIANTRANSFORMATIONOPERATOR3D, IFCCLASSIFICATION, IFCCLASSIFICATIONREFERENCE, IFCDIRECTION, IFCEXTRUDEDAREASOLID,
  IFCFURNITURE, IFCFURNITURETYPE, IFCGEOMETRICREPRESENTATIONSUBCONTEXT, IFCGLOBALLYUNIQUEID, IFCIDENTIFIER, IFCLABEL,
  IFCLENGTHMEASURE, IFCLOCALPLACEMENT, IFCMAPPEDITEM, IFCMATERIAL, IFCMATERIALLIST, IFCPOLYLINE, IFCPOSITIVELENGTHMEASURE,
  IFCPRODUCTDEFINITIONSHAPE, IFCPROPERTYSET, IFCPROPERTYSINGLEVALUE, IFCREAL, IFCRECTANGLEPROFILEDEF, IFCREPRESENTATIONMAP,
  IFCRELASSOCIATESCLASSIFICATION, IFCRELASSOCIATESMATERIAL, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYTYPE,
  IFCROOT, IFCSHAPEREPRESENTATION, IFCTEXT, IFCURIREFERENCE,
} from "web-ifc";
import { validateFurnitureCatalogItem, type FurnitureCatalogItem } from "@teldra/furniture-catalog";
import { chain, model, type FurniturePose, type Line } from "./ifc-session.js";
import { derivedGuid } from "./wall.js";

/** Resolved catalog insertion; structurally identical to `FurnitureInsertRequest` in @teldra/application. */
export interface InsertFurnitureInput {
  /** New canonical IFC GlobalId (22-char compressed). Never derived from the catalog item. */
  readonly ifcGlobalId: string;
  readonly storeyGlobalId: string;
  readonly catalogId: string;
  readonly catalogVersion: string;
  readonly item: FurnitureCatalogItem;
  /** World-frame IFC metres, Z up; yaw about world Z. */
  readonly pose: FurniturePose;
  readonly name?: string;
}

export type FurnitureInsertErrorCode =
  | "invalid-global-id" | "duplicate-global-id" | "invalid-item" | "invalid-pose" | "invalid-name"
  | "storey-not-found" | "storey-containment-unsupported" | "body-context-missing" | "unsupported-placement" | "type-conflict";
/** Explicit, machine-readable refusal. The input bytes are never modified. */
export class FurnitureInsertError extends Error {
  readonly code: FurnitureInsertErrorCode;
  constructor(code: FurnitureInsertErrorCode, message: string) { super(message); this.name = "FurnitureInsertError"; this.code = code; }
}
const fail = (code: FurnitureInsertErrorCode, message: string): never => { throw new FurnitureInsertError(code, message); };

const GUID = /^[0-3][0-9A-Za-z_$]{21}$/;
const PSET_NAME = "Teldra_Catalog";
const clean = (value: number) => (Math.abs(value) < 1e-12 ? 0 : value);
const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const ref = (line: any): number | null => (Number.isInteger(line?.value) ? line.value : null);

/** Identity of a catalog item inside one IFC model: items from a different catalog version get a different type. */
export function furnitureTypeKey(catalogId: string, itemId: string, catalogVersion: string): string {
  return `${catalogId}/${itemId}@${catalogVersion}`;
}

function allGlobalIds(api: IfcAPI, id: number): Set<string> {
  const taken = new Set<string>(); const ids = api.GetLineIDsWithType(id, IFCROOT, true);
  for (let i = 0; i < ids.size(); i++) { const g = (api.GetLine(id, ids.get(i)) as Line).GlobalId?.value; if (typeof g === "string") taken.add(g); }
  return taken;
}
function linesOf(api: IfcAPI, id: number, type: number): Line[] {
  const ids = api.GetLineIDsWithType(id, type); const out: Line[] = [];
  for (let i = 0; i < ids.size(); i++) out.push(api.GetLine(id, ids.get(i)) as Line);
  return out;
}
function propertyMap(api: IfcAPI, id: number, pset: Line): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const handle of pset.HasProperties ?? []) {
    const property = api.GetLine(id, handle.value) as Line;
    if (typeof property.Name?.value === "string") out.set(property.Name.value, property.NominalValue?.value);
  }
  return out;
}
function catalogPset(api: IfcAPI, id: number, type: Line): Map<string, unknown> | null {
  for (const handle of type.HasPropertySets ?? []) {
    const pset = api.GetLine(id, handle.value) as Line;
    if (pset?.type === IFCPROPERTYSET && pset.Name?.value === PSET_NAME) return propertyMap(api, id, pset);
  }
  return null;
}

/**
 * Creates one new IfcFurniture from a catalog item inside an isolated model session and returns new IFC bytes.
 *
 * - The element gets the caller's new GlobalId, its own IfcLocalPlacement (relative to the storey placement,
 *   derived from the requested world pose), its own product shape and mapped item (identity MappingTarget, so
 *   per-instance scaling works), and containment in the storey.
 * - Occurrences of the same catalog item (id + catalog version) share one IfcFurnitureType and one
 *   IfcRepresentationMap; the type carries the IFC predefined type, bSDD/other classification references, material,
 *   and a `Teldra_Catalog` property set with provenance, licence and nominal dimensions.
 * - The map's representation is authored IFC geometry (rectangle or footprint extrusion, local origin at the
 *   bottom centre), never a render asset, so IFC stays self-sufficient and dimensions are exactly nominal.
 */
export function insertFurniture(api: IfcAPI, bytes: Uint8Array, input: InsertFurnitureInput): Uint8Array {
  if (typeof input.ifcGlobalId !== "string" || !GUID.test(input.ifcGlobalId))
    fail("invalid-global-id", "The new furniture needs a 22-character compressed IFC GlobalId.");
  const checked = validateFurnitureCatalogItem(input.item);
  if (!checked.valid) fail("invalid-item", "Invalid catalog item: " + checked.issues.map((i) => `${i.path} ${i.message}`).join("; "));
  const item = input.item;
  const name = input.name ?? item.name;
  if (typeof name !== "string" || !name.trim() || name.length > 256) fail("invalid-name", "Furniture name must contain 1-256 nonblank characters.");
  const { position, yawRadians } = input.pose;
  if (!Array.isArray(position) || position.length !== 3 || ![...position, yawRadians].every(Number.isFinite)) fail("invalid-pose", "Furniture pose must be three finite metres plus a finite yaw.");
  if (typeof input.catalogId !== "string" || !input.catalogId || typeof input.catalogVersion !== "string" || !input.catalogVersion)
    fail("invalid-item", "Catalog id and version are required for provenance.");

  return model(api, bytes, (id) => {
    const taken = allGlobalIds(api, id);
    if (taken.has(input.ifcGlobalId)) fail("duplicate-global-id", `GlobalId ${input.ifcGlobalId} already exists in the IFC model.`);
    const mint = (seed: string) => { const guid = derivedGuid(`${input.ifcGlobalId}:${seed}`, taken); taken.add(guid); return guid; };

    // ---- storey, containment, context (all validated before the first write)
    const storey = linesOf(api, id, IFCBUILDINGSTOREY).find((line) => line.GlobalId?.value === input.storeyGlobalId);
    if (!storey) return fail("storey-not-found", `No IfcBuildingStorey has GlobalId ${input.storeyGlobalId}.`);
    const containments = linesOf(api, id, IFCRELCONTAINEDINSPATIALSTRUCTURE).filter((rel) => ref(rel.RelatingStructure) === storey.expressID);
    if (containments.length > 1) fail("storey-containment-unsupported", "The storey has several IfcRelContainedInSpatialStructure relations.");
    const contexts = linesOf(api, id, IFCGEOMETRICREPRESENTATIONSUBCONTEXT)
      .filter((c) => c.ContextIdentifier?.value === "Body" && c.ContextType?.value === "Model");
    if (contexts.length !== 1) fail("body-context-missing", "A unique IFC Model/Body representation context is required.");
    const contextId = contexts[0]!.expressID;
    let parent: FurniturePose = { position: [0, 0, 0], yawRadians: 0 };
    const storeyPlacement = ref(storey.ObjectPlacement);
    if (storeyPlacement !== null) {
      try { parent = chain(api, id, { value: storeyPlacement }).pose; }
      catch (error) { fail("unsupported-placement", `Storey placement: ${(error as Error).message}`); }
    }

    const len = (v: number) => api.CreateIfcType(id, IFCLENGTHMEASURE, clean(v));
    const real = (v: number) => api.CreateIfcType(id, IFCREAL, clean(v));
    const label = (v: string) => api.CreateIfcType(id, IFCLABEL, v);
    const guidOf = (v: string) => api.CreateIfcType(id, IFCGLOBALLYUNIQUEID, v);
    const write = (entity: any): any => { api.WriteLine(id, entity); return entity; };
    const handle = (entity: { expressID: number }) => new Handle(entity.expressID);
    const point3 = (x: number, y: number, z: number) => api.CreateIfcEntity(id, IFCCARTESIANPOINT, [len(x), len(y), len(z)]);
    const dir = (x: number, y: number, z: number) => api.CreateIfcEntity(id, IFCDIRECTION, [real(x), real(y), real(z)]);

    // ---- shared type (+ map, classification, material) per catalog item version
    const key = furnitureTypeKey(input.catalogId, item.id, input.catalogVersion);
    const [width, depth, height] = [item.dimensions.width, item.dimensions.depth, item.dimensions.height];
    let type = linesOf(api, id, IFCFURNITURETYPE).find((line) => line.Tag?.value === key);
    if (type) {
      const known = catalogPset(api, id, type);
      const dims = [known?.get("NominalWidthMetres"), known?.get("NominalDepthMetres"), known?.get("NominalHeightMetres")];
      if (![width, depth, height].every((v, i) => typeof dims[i] === "number" && same(dims[i] as number, v)))
        fail("type-conflict", `IFC already holds ${key} with different nominal dimensions; bump the catalog version instead of changing an item in place.`);
    } else {
      const ring: [number, number][] = item.representation.kind === "box"
        ? [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]]
        : (item.representation.footprint as [number, number][]);
      const profile = item.representation.kind === "box"
        ? api.CreateIfcEntity(id, IFCRECTANGLEPROFILEDEF, IFC4.IfcProfileTypeEnum.AREA, null,
            api.CreateIfcEntity(id, IFCAXIS2PLACEMENT2D, api.CreateIfcEntity(id, IFCCARTESIANPOINT, [len(0), len(0)]), null), api.CreateIfcType(id, IFCPOSITIVELENGTHMEASURE, width), api.CreateIfcType(id, IFCPOSITIVELENGTHMEASURE, depth))
        : api.CreateIfcEntity(id, IFCARBITRARYCLOSEDPROFILEDEF, IFC4.IfcProfileTypeEnum.AREA, null,
            api.CreateIfcEntity(id, IFCPOLYLINE, [...ring, ring[0]!].map(([x, y]) => api.CreateIfcEntity(id, IFCCARTESIANPOINT, [len(x), len(y)]))));
      const solid = api.CreateIfcEntity(id, IFCEXTRUDEDAREASOLID, profile,
        api.CreateIfcEntity(id, IFCAXIS2PLACEMENT3D, point3(0, 0, 0), dir(0, 0, 1), dir(1, 0, 0)), dir(0, 0, 1), api.CreateIfcType(id, IFCPOSITIVELENGTHMEASURE, height));
      const body = api.CreateIfcEntity(id, IFCSHAPEREPRESENTATION, new Handle(contextId), label("Body"), label("SweptSolid"), [solid]);
      const map = write(api.CreateIfcEntity(id, IFCREPRESENTATIONMAP,
        api.CreateIfcEntity(id, IFCAXIS2PLACEMENT3D, point3(0, 0, 0), dir(0, 0, 1), dir(1, 0, 0)), body));

      const property = (propertyName: string, value: unknown) =>
        api.CreateIfcEntity(id, IFCPROPERTYSINGLEVALUE, label(propertyName), null, value, null);
      const text = (v: string) => api.CreateIfcType(id, IFCTEXT, v);
      const { licence } = item;
      const props = [
        property("CatalogId", label(input.catalogId)), property("CatalogItemId", label(item.id)), property("CatalogVersion", label(input.catalogVersion)),
        property("MountType", label(item.mount.type)),
        ...(item.mount.elevation === undefined ? [] : [property("MountElevationMetres", real(item.mount.elevation))]),
        property("NominalWidthMetres", real(width)), property("NominalDepthMetres", real(depth)), property("NominalHeightMetres", real(height)),
        property("LicenceSpdx", label(licence.spdx)), property("LicenceAuthor", text(licence.author)),
        ...(licence.attribution === undefined ? [] : [property("LicenceAttribution", text(licence.attribution))]),
        ...(licence.sourceUrl === undefined ? [] : [property("LicenceSourceUrl", api.CreateIfcType(id, IFCURIREFERENCE, licence.sourceUrl))]),
        property("Redistribution", label(licence.redistribution)),
      ];
      const pset = write(api.CreateIfcEntity(id, IFCPROPERTYSET, guidOf(mint("pset")), null, label(PSET_NAME), null, props));
      type = write(api.CreateIfcEntity(id, IFCFURNITURETYPE, guidOf(mint("type")), null, label(item.name), null, null, [handle(pset)], [handle(map)],
        label(key), label(item.category), IFC4.IfcAssemblyPlaceEnum.NOTDEFINED, (IFC4.IfcFurnitureTypeEnum as Record<string, any>)[item.ifc.predefinedType])) as Line;

      for (const [index, classification] of (item.ifc.classifications ?? []).entries()) {
        let system = linesOf(api, id, IFCCLASSIFICATION).find((line) => line.Name?.value === classification.system);
        if (!system) system = write(api.CreateIfcEntity(id, IFCCLASSIFICATION, null, null, null, label(classification.system), null, null, null));
        const reference = write(api.CreateIfcEntity(id, IFCCLASSIFICATIONREFERENCE,
          classification.uri === undefined ? null : api.CreateIfcType(id, IFCURIREFERENCE, classification.uri),
          api.CreateIfcType(id, IFCIDENTIFIER, classification.identification), label(classification.name), handle(system!), null, null));
        write(api.CreateIfcEntity(id, IFCRELASSOCIATESCLASSIFICATION, guidOf(mint(`classification:${index}`)), null, null, null, [handle(type!)], handle(reference)));
      }
      const materials = (item.materials ?? []).map((material) => {
        const existing = linesOf(api, id, IFCMATERIAL).find((line) => line.Name?.value === material.name);
        return existing ?? write(api.CreateIfcEntity(id, IFCMATERIAL, label(material.name), null, null));
      });
      if (materials.length > 0) {
        const relating = materials.length === 1 ? materials[0]! : write(api.CreateIfcEntity(id, IFCMATERIALLIST, materials.map(handle)));
        write(api.CreateIfcEntity(id, IFCRELASSOCIATESMATERIAL, guidOf(mint("material")), null, null, null, [handle(type)], handle(relating)));
      }
    }

    // ---- the occurrence
    const c = Math.cos(parent.yawRadians), s = Math.sin(parent.yawRadians);
    const dx = position[0] - parent.position[0], dy = position[1] - parent.position[1], yaw = yawRadians - parent.yawRadians;
    const relative = api.CreateIfcEntity(id, IFCAXIS2PLACEMENT3D, point3(c * dx + s * dy, -s * dx + c * dy, position[2] - parent.position[2]),
      dir(0, 0, 1), dir(Math.cos(yaw), Math.sin(yaw), 0));
    const placement = api.CreateIfcEntity(id, IFCLOCALPLACEMENT, storeyPlacement === null ? null : new Handle(storeyPlacement), relative);
    const target = api.CreateIfcEntity(id, IFCCARTESIANTRANSFORMATIONOPERATOR3D, null, null, point3(0, 0, 0), real(1), null);
    const mapRef = (type.RepresentationMaps ?? [])[0];
    if (!mapRef) fail("type-conflict", `Existing ${key} has no representation map.`);
    const mapped = api.CreateIfcEntity(id, IFCMAPPEDITEM, new Handle(mapRef!.value), target);
    const shape = api.CreateIfcEntity(id, IFCPRODUCTDEFINITIONSHAPE, null, null,
      [api.CreateIfcEntity(id, IFCSHAPEREPRESENTATION, new Handle(contextId), label("Body"), label("MappedRepresentation"), [mapped])]);
    const element = write(api.CreateIfcEntity(id, IFCFURNITURE, guidOf(input.ifcGlobalId), null, label(name), null, null, placement, shape, null, null));

    const containment = containments[0];
    if (containment) { containment.RelatedElements = [...containment.RelatedElements, handle(element)]; api.WriteLine(id, containment); }
    else write(api.CreateIfcEntity(id, IFCRELCONTAINEDINSPATIALSTRUCTURE, guidOf(mint("containment")), null, null, null, [handle(element)], handle(storey)));

    const typeRelation = linesOf(api, id, IFCRELDEFINESBYTYPE).find((rel) => ref(rel.RelatingType) === type!.expressID);
    if (typeRelation) { typeRelation.RelatedObjects = [...typeRelation.RelatedObjects, handle(element)]; api.WriteLine(id, typeRelation); }
    else write(api.CreateIfcEntity(id, IFCRELDEFINESBYTYPE, guidOf(mint("type-occurrence")), null, null, null, [handle(element)], handle(type)));
    return api.SaveModel(id);
  });
}

export interface FurnitureCatalogProvenance {
  readonly catalogId: string;
  readonly catalogVersion: string;
  readonly itemId: string;
  readonly licence: {
    readonly spdx: string; readonly author: string; readonly redistribution: string;
    readonly attribution?: string; readonly sourceUrl?: string;
  };
  readonly mount: { readonly type: string; readonly elevation?: number };
  readonly nominalDimensions: readonly [number, number, number];
}

/**
 * Catalog provenance of an inserted element (via its IfcFurnitureType), or null for furniture that did not
 * come from the catalog. Feeds attribution notices and licence audits; never used for identity.
 */
export function readFurnitureCatalogProvenance(api: IfcAPI, bytes: Uint8Array, guid: string): FurnitureCatalogProvenance | null {
  return model(api, bytes, (id) => {
    const element = linesOf(api, id, IFCFURNITURE).find((line) => line.GlobalId?.value === guid);
    if (!element) throw new Error("Expected one IFC furniture with this GlobalId.");
    const relation = linesOf(api, id, IFCRELDEFINESBYTYPE).find((rel) => rel.RelatedObjects?.some((o: any) => o.value === element.expressID));
    const typeId = ref(relation?.RelatingType);
    if (typeId === null) return null;
    const type = api.GetLine(id, typeId) as Line;
    if (type.type !== IFCFURNITURETYPE) return null;
    const props = catalogPset(api, id, type);
    if (!props) return null;
    const str = (name: string) => { const v = props.get(name); return typeof v === "string" ? v : undefined; };
    const num = (name: string) => { const v = props.get(name); return typeof v === "number" ? v : undefined; };
    const need = (value: string | undefined, name: string): string => { if (value === undefined) throw new Error(`Malformed ${PSET_NAME}: missing ${name}.`); return value; };
    const dims = [num("NominalWidthMetres"), num("NominalDepthMetres"), num("NominalHeightMetres")];
    if (dims.some((v) => v === undefined)) throw new Error(`Malformed ${PSET_NAME}: missing nominal dimensions.`);
    const attribution = str("LicenceAttribution"), sourceUrl = str("LicenceSourceUrl"), elevation = num("MountElevationMetres");
    return {
      catalogId: need(str("CatalogId"), "CatalogId"), catalogVersion: need(str("CatalogVersion"), "CatalogVersion"), itemId: need(str("CatalogItemId"), "CatalogItemId"),
      licence: {
        spdx: need(str("LicenceSpdx"), "LicenceSpdx"), author: need(str("LicenceAuthor"), "LicenceAuthor"), redistribution: need(str("Redistribution"), "Redistribution"),
        ...(attribution === undefined ? {} : { attribution }), ...(sourceUrl === undefined ? {} : { sourceUrl }),
      },
      mount: { type: need(str("MountType"), "MountType"), ...(elevation === undefined ? {} : { elevation }) },
      nominalDimensions: dims as [number, number, number],
    };
  });
}
