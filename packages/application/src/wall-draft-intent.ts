import {
  validateStraightWallDraft,
  type PlanPoint,
  type StraightWallDraft,
} from "./architectural-plan-draft.js";

/**
 * A transportable *proposal*, never permission to change canonical IFC.
 * Strict shape and bounds prevent untrusted agent/file input from becoming
 * implicit scene edits. The user must review and explicitly accept it.
 */
export interface WallDraftIntent {
  readonly format: "teldra-wall-draft-v1";
  readonly operation: "CreateWall";
  readonly coordinateFrame: "ifc-world-metres-z-up";
  readonly wall: StraightWallDraft;
  readonly warning: string;
}

const MAX_INTENT_BYTES = 64 * 1024;
const encoder = new TextEncoder();

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key === "__proto__" || key === "constructor")) {
    throw new Error(`${label} contains unsupported fields.`);
  }
  return record;
}

function point(value: unknown, label: string): PlanPoint {
  if (!Array.isArray(value) || value.length !== 2 ||
      value.some(entry => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new Error(`${label} must contain two finite metre coordinates.`);
  }
  return [value[0] as number, value[1] as number];
}

export function parseWallDraftIntent(input: string): WallDraftIntent {
  if (encoder.encode(input).byteLength > MAX_INTENT_BYTES) {
    throw new Error("Wall draft exceeds the 64 KiB size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new Error("Wall draft must be valid JSON.");
  }
  const intent = object(parsed, "Wall draft");
  if (intent.format !== "teldra-wall-draft-v1" ||
      intent.operation !== "CreateWall" ||
      intent.coordinateFrame !== "ifc-world-metres-z-up") {
    throw new Error("Unsupported wall draft version, operation, or coordinate frame.");
  }
  const wall = object(intent.wall, "Wall geometry");
  if (Object.keys(wall).sort().join(",") !==
      ["end", "heightMetres", "start", "thicknessMetres"].join(",")) {
    throw new Error("Wall geometry contains missing or unsupported fields.");
  }
  const candidate: StraightWallDraft = {
    start: point(wall.start, "Wall start"),
    end: point(wall.end, "Wall end"),
    thicknessMetres: wall.thicknessMetres as number,
    heightMetres: wall.heightMetres as number,
  };
  validateStraightWallDraft(candidate);
  return {
    format: "teldra-wall-draft-v1",
    operation: "CreateWall",
    coordinateFrame: "ifc-world-metres-z-up",
    wall: candidate,
    warning: "Review-only proposal; accepting this draft never changes IFC or project history.",
  };
}

export function serializeWallDraftIntent(wall: StraightWallDraft): string {
  validateStraightWallDraft(wall);
  const intent: WallDraftIntent = {
    format: "teldra-wall-draft-v1",
    operation: "CreateWall",
    coordinateFrame: "ifc-world-metres-z-up",
    wall,
    warning: "Preview-only draft; not an IFC edit. Review and apply through an IFC authoring transaction.",
  };
  return JSON.stringify(intent, null, 2);
}

/**
 * A distinct transport format for an explicitly selected, existing IFC wall.
 * Importers must never infer the edit target from a display name or geometry.
 * This is a draft handoff, not a permission to mutate project state.
 */
export interface ExistingWallEditIntent {
  readonly format: "teldra-wall-edit-v1";
  readonly operation: "EditWall";
  readonly coordinateFrame: "ifc-world-metres-z-up";
  readonly targetIfcGlobalId: string;
  readonly wall: StraightWallDraft;
  readonly warning: string;
}

export function assertIfcGlobalId(guid: string): void {
  if (!/^[0-9A-Za-z_$]{22}$/.test(guid)) {
    throw new Error("Target wall must have a 22-character compressed IFC GlobalId.");
  }
}

export function serializeExistingWallEditIntent(
  wall: StraightWallDraft,
  targetIfcGlobalId: string,
): string {
  validateStraightWallDraft(wall);
  assertIfcGlobalId(targetIfcGlobalId);
  return JSON.stringify({
    format: "teldra-wall-edit-v1",
    operation: "EditWall",
    coordinateFrame: "ifc-world-metres-z-up",
    targetIfcGlobalId,
    wall: {
      start: [wall.start[0], wall.start[1]],
      end: [wall.end[0], wall.end[1]],
      thicknessMetres: wall.thicknessMetres,
      heightMetres: wall.heightMetres,
    },
    warning: "Review-only proposal for one identified IFC wall. Requires separate source hash verification and eligible architecture-only .teldra writer.",
  } satisfies ExistingWallEditIntent, null, 2);
}

/** Strictly parse an EditWall handoff; never accepts CreateWall or DeleteWall. */
export function parseExistingWallEditIntent(input: string): ExistingWallEditIntent {
  if (encoder.encode(input).byteLength > MAX_INTENT_BYTES) {
    throw new Error("Wall edit draft exceeds the 64 KiB size limit.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(input) as unknown; }
  catch { throw new Error("Wall edit draft must be valid JSON."); }
  const record = object(parsed, "Wall edit draft");
  if (record.format !== "teldra-wall-edit-v1" ||
      record.operation !== "EditWall" ||
      record.coordinateFrame !== "ifc-world-metres-z-up") {
    throw new Error("Unsupported wall edit draft version, operation or coordinate frame.");
  }
  if (typeof record.targetIfcGlobalId !== "string") {
    throw new Error("Wall edit draft must identify a target IFC GlobalId.");
  }
  assertIfcGlobalId(record.targetIfcGlobalId);
  const shape = object(record.wall, "Wall edit geometry");
  if (Object.keys(shape).sort().join(",") !==
      ["end", "heightMetres", "start", "thicknessMetres"].join(",")) {
    throw new Error("Wall edit geometry contains missing or unsupported fields.");
  }
  const wall = validateStraightWallDraft({
    start: point(shape.start, "Wall start"),
    end: point(shape.end, "Wall end"),
    thicknessMetres: shape.thicknessMetres as number,
    heightMetres: shape.heightMetres as number,
  });
  return {
    format: "teldra-wall-edit-v1",
    operation: "EditWall",
    coordinateFrame: "ifc-world-metres-z-up",
    targetIfcGlobalId: record.targetIfcGlobalId,
    wall,
    warning: "Review-only proposal. Does not edit canonical IFC or project history.",
  };
}
