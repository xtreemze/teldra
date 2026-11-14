import { describe, expect, it } from "vitest";
import {
  acceptWallProposal,
  stageWallProposal,
  WallProposalConflictError,
} from "../src/wall-proposal-review.js";
import { serializeWallDraftIntent } from "../src/wall-draft-intent.js";

const wall = {
  start: [1, 2] as const,
  end: [5, 2] as const,
  thicknessMetres: 0.2,
  heightMetres: 2.8,
};

describe("revision-fenced wall proposal review", () => {
  it("accepts only the exact reviewed project revision and returns a detached draft", () => {
    const staged = stageWallProposal(serializeWallDraftIntent(wall), 12);
    const accepted = acceptWallProposal(staged, 12);
    expect(accepted).toEqual(wall);
    expect(accepted).not.toBe(staged.intent.wall);
    expect(accepted.start).not.toBe(staged.intent.wall.start);
  });

  it("rejects changes between preview and approval, including undo and redo", () => {
    const staged = stageWallProposal(serializeWallDraftIntent(wall), 12);
    for (const revision of [11, 13, 14]) {
      expect(() => acceptWallProposal(staged, revision))
        .toThrow(WallProposalConflictError);
    }
    expect(() => acceptWallProposal(staged, 12)).not.toThrow();
  });

  it("fails closed on invalid and imprecise revisions", () => {
    const text = serializeWallDraftIntent(wall);
    for (const revision of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => stageWallProposal(text, revision)).toThrow(/revision/);
    }
    const staged = stageWallProposal(text, 0);
    expect(() => acceptWallProposal(staged, -1)).toThrow(/revision/);
  });

  it("cannot stage untrusted commands as IFC mutations", () => {
    const intent = JSON.parse(serializeWallDraftIntent(wall)) as Record<string, unknown>;
    for (const operation of ["DeleteWall", "UpdateBuilding", "WriteIFC"]) {
      expect(() => stageWallProposal(JSON.stringify({ ...intent, operation }), 2))
        .toThrow(/Unsupported/);
    }
  });
});
