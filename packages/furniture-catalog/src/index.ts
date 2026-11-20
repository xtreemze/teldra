import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import catalogSchema from "@teldra/schemas/furniture-catalog" with { type: "json" };
import type { Item, TeldraFurnitureCatalog } from "@teldra/schemas/types/furniture-catalog";

export type FurnitureCatalog = TeldraFurnitureCatalog;
export type FurnitureCatalogItem = Item;
export type FurnitureIfcPredefinedType = Item["ifc"]["predefinedType"];

export interface FurnitureCatalogIssue {
  readonly source: "schema" | "integrity";
  readonly path: string;
  readonly message: string;
}
export type FurnitureCatalogValidation =
  | { readonly valid: true; readonly value: FurnitureCatalog; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly FurnitureCatalogIssue[] };
export type FurnitureCatalogItemValidation =
  | { readonly valid: true; readonly value: FurnitureCatalogItem; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly FurnitureCatalogIssue[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateStructure: ValidateFunction<FurnitureCatalog> = ajv.compile<FurnitureCatalog>(catalogSchema);
const validateItemStructure: ValidateFunction<FurnitureCatalogItem> = ajv.compile<FurnitureCatalogItem>({
  $ref: `${catalogSchema.$id}#/$defs/item`,
});

const schemaIssues = (errors: readonly ErrorObject[] | null | undefined, prefix = ""): FurnitureCatalogIssue[] =>
  (errors ?? []).map((e) => ({ source: "schema", path: prefix + e.instancePath, message: `${e.keyword}: ${e.message ?? "invalid"}${typeof e.params.additionalProperty === "string" ? ` (${e.params.additionalProperty})` : ""}` }));

const FOOTPRINT_EPSILON = 1e-9;
/** Licence ids that need a notice to travel with every redistributed copy. */
const NEEDS_ATTRIBUTION = /(^|[^A-Za-z])(CC-BY|GPL|LGPL|AGPL|ODbL|OFL)/i;
const NON_COMMERCIAL = /(^|-)NC(-|$)/;

type Point = readonly [number, number];
const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSegment = (p: Point, q: Point, r: Point) =>
    Math.min(p[0], q[0]) - FOOTPRINT_EPSILON <= r[0] && r[0] <= Math.max(p[0], q[0]) + FOOTPRINT_EPSILON &&
    Math.min(p[1], q[1]) - FOOTPRINT_EPSILON <= r[1] && r[1] <= Math.max(p[1], q[1]) + FOOTPRINT_EPSILON;
  return (Math.abs(d1) < FOOTPRINT_EPSILON && onSegment(c, d, a)) || (Math.abs(d2) < FOOTPRINT_EPSILON && onSegment(c, d, b)) ||
    (Math.abs(d3) < FOOTPRINT_EPSILON && onSegment(a, b, c)) || (Math.abs(d4) < FOOTPRINT_EPSILON && onSegment(a, b, d));
}

function validateItemIntegrity(item: FurnitureCatalogItem, path: string): FurnitureCatalogIssue[] {
  const issues: FurnitureCatalogIssue[] = [];
  const add = (suffix: string, message: string) => issues.push({ source: "integrity", path: path + suffix, message });

  if (item.representation.kind === "extrusion") {
    const ring = item.representation.footprint as readonly Point[];
    const halfW = item.dimensions.width / 2, halfD = item.dimensions.depth / 2;
    if (ring.some(([x, y]) => Math.abs(x) > halfW + FOOTPRINT_EPSILON || Math.abs(y) > halfD + FOOTPRINT_EPSILON))
      add("/representation/footprint", "Extrusion footprint lies outside the nominal width x depth rectangle centred on the origin.");
    let area2 = 0;
    for (let i = 0; i < ring.length; i++) { const p = ring[i]!, q = ring[(i + 1) % ring.length]!; area2 += p[0] * q[1] - q[0] * p[1]; }
    if (Math.abs(area2) < FOOTPRINT_EPSILON) add("/representation/footprint", "Extrusion footprint has zero area.");
    else {
      let crosses = false;
      for (let i = 0; i < ring.length && !crosses; i++) for (let j = i + 1; j < ring.length && !crosses; j++) {
        const adjacent = j === i + 1 || (i === 0 && j === ring.length - 1);
        if (adjacent) continue;
        crosses = segmentsCross(ring[i]!, ring[(i + 1) % ring.length]!, ring[j]!, ring[(j + 1) % ring.length]!);
      }
      if (crosses) add("/representation/footprint", "Extrusion footprint edges self-intersect.");
    }
  }

  const { licence, asset } = item;
  if (NEEDS_ATTRIBUTION.test(licence.spdx) && !licence.attribution)
    add("/licence/attribution", `Licence ${licence.spdx} requires an attribution notice.`);
  if (NON_COMMERCIAL.test(licence.spdx) && licence.redistribution === "bundle")
    add("/licence/redistribution", `Licence ${licence.spdx} is non-commercial and cannot be bundled; use user-import-only.`);
  if (asset) {
    const segments = asset.path.split("/");
    if (asset.path.startsWith("/") || /^[A-Za-z]:/.test(asset.path) || asset.path.includes("\\") || segments.some((s) => s === ".." || s === "." || s === ""))
      add("/asset/path", "Asset path must be a relative POSIX path without empty, '.' or '..' segments.");
  }
  return issues;
}

function integrity(catalog: FurnitureCatalog): FurnitureCatalogIssue[] {
  const issues: FurnitureCatalogIssue[] = [];
  const seen = new Set<string>();
  catalog.items.forEach((item, index) => {
    if (seen.has(item.id)) issues.push({ source: "integrity", path: `/items/${index}/id`, message: `Duplicate catalog item id ${item.id}.` });
    seen.add(item.id);
    issues.push(...validateItemIntegrity(item, `/items/${index}`));
  });
  return issues;
}

export function validateFurnitureCatalog(value: unknown): FurnitureCatalogValidation {
  if (!validateStructure(value)) return { valid: false, issues: schemaIssues(validateStructure.errors) };
  const issues = integrity(value);
  return issues.length > 0 ? { valid: false, issues } : { valid: true, value, issues: [] };
}

/** Validates one item, e.g. the resolved payload of an insert command, with the same rules as a whole catalog. */
export function validateFurnitureCatalogItem(value: unknown): FurnitureCatalogItemValidation {
  if (!validateItemStructure(value)) return { valid: false, issues: schemaIssues(validateItemStructure.errors) };
  const issues = validateItemIntegrity(value, "");
  return issues.length > 0 ? { valid: false, issues } : { valid: true, value, issues: [] };
}

export class FurnitureCatalogError extends Error {
  readonly issues: readonly FurnitureCatalogIssue[];
  constructor(message: string, issues: readonly FurnitureCatalogIssue[]) {
    super(`${message} ${issues.map((i) => `${i.path || "/"} ${i.message}`).join("; ")}`);
    this.name = "FurnitureCatalogError";
    this.issues = issues;
  }
}

export function parseFurnitureCatalog(value: unknown): FurnitureCatalog {
  const result = validateFurnitureCatalog(value);
  if (!result.valid) throw new FurnitureCatalogError("Invalid Teldra furniture catalog.", result.issues);
  return result.value;
}

export function findFurnitureCatalogItem(catalog: FurnitureCatalog, itemId: string): FurnitureCatalogItem | undefined {
  return catalog.items.find((item) => item.id === itemId);
}
