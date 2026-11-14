import {
  parseWallDraftIntent,
  type WallDraftIntent,
} from "./wall-draft-intent.js";
import {
  validateStraightWallDraft,
  type StraightWallDraft,
} from "./architectural-plan-draft.js";

/**
 * A staged architectural proposal is bound to one revision of the open project.
 * This is a human-review contract only. It cannot write IFC or scene geometry.
 */
export interface StagedWallProposal {
  readonly baseRevision: number;
  readonly intent: WallDraftIntent;
}

export class WallProposalConflictError extends Error {
  constructor() {
    super("The project changed since this wall proposal was previewed. Review the proposal again.");
    this.name = "WallProposalConflictError";
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Wall proposal revision must be a nonnegative safe integer.");
  }
}

function copyWall(wall: StraightWallDraft): StraightWallDraft {
  validateStraightWallDraft(wall);
  return {
    start: [wall.start[0], wall.start[1]],
    end: [wall.end[0], wall.end[1]],
    thicknessMetres: wall.thicknessMetres,
    heightMetres: wall.heightMetres,
  };
}

/**
 * Parse untrusted proposal text once at the review boundary and detach the
 * candidate geometry from any external mutable objects.
 */
export function stageWallProposal(input: string, currentRevision: number): StagedWallProposal {
  assertRevision(currentRevision);
  const intent = parseWallDraftIntent(input);
  return {
    baseRevision: currentRevision,
    intent: { ...intent, wall: copyWall(intent.wall) },
  };
}

/**
 * Called ONLY by the user's explicit Accept action. Fails closed on stale
 * review, and returns a detached draft; it deliberately does not invoke any
 * IFC adapter, project writer or command history.
 */
export function acceptWallProposal(
  staged: StagedWallProposal,
  currentRevision: number,
): StraightWallDraft {
  assertRevision(currentRevision);
  assertRevision(staged.baseRevision);
  if (currentRevision !== staged.baseRevision) throw new WallProposalConflictError();
  if (staged.intent.operation !== "CreateWall" ||
      staged.intent.coordinateFrame !== "ifc-world-metres-z-up") {
    throw new Error("Unsupported architectural proposal.");
  }
  return copyWall(staged.intent.wall);
}
