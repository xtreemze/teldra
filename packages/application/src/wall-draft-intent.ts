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
