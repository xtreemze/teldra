import {describe, expect, it} from "vitest";
import {CanvasGestureArbiter} from "./viewport-touch-gestures";

const pointer = (pointerId: number, x: number, y: number, time: number) =>
  ({pointerId, x, y, time});

describe("canvas gesture arbitration", () => {
  it("does not intercept ordinary one-finger orbit movement", () => {
    const g = new CanvasGestureArbiter();
    g.down(pointer(1, 100, 100, 0));
    expect(g.move(pointer(1, 142, 125, 30))).toEqual({blockCamera: false, cancelHold: true});
    expect(g.hold(600)).toBeNull();
    expect(g.up(pointer(1, 142, 125, 80))).toBeNull();
  });

  it("does not replace two-finger pan/pinch navigation with history", () => {
    const g = new CanvasGestureArbiter();
    g.down(pointer(1, 10, 40, 0)); g.down(pointer(2, 100, 40, 25));
    expect(g.move(pointer(1, 0, 40, 35)).blockCamera).toBe(false);
    expect(g.move(pointer(2, 140, 40, 50)).blockCamera).toBe(false);
    expect(g.up(pointer(1, 0, 40, 70))).toBeNull();
    expect(g.up(pointer(2, 140, 40, 85))).toBeNull();
    expect(g.suppressClick(90)).toBe(true);
  });

  it("recognizes a coordinated left swipe as undo once, after release", () => {
    const g = new CanvasGestureArbiter();
    g.down(pointer(1, 140, 110, 0));
    g.down(pointer(2, 200, 110, 20));
    g.down(pointer(3, 260, 110, 35));
    expect(g.move(pointer(1, 38, 109, 70)).blockCamera).toBe(true);
    expect(g.move(pointer(2, 98, 109, 75)).blockCamera).toBe(true);
    expect(g.move(pointer(3, 158, 109, 80)).blockCamera).toBe(true);
    expect(g.up(pointer(2, 98, 109, 110))).toEqual({type: "undo"});
    expect(g.up(pointer(1, 38, 109, 120))).toBeNull();
    expect(g.up(pointer(3, 158, 109, 130))).toBeNull();
    expect(g.suppressClick(140)).toBe(true);
  });

  it("rechecks movement on release so a reversed swipe never commits stale history", () => {
    const g = new CanvasGestureArbiter();
    for (let i = 1; i <= 3; i++) g.down(pointer(i, i * 70, 100, i * 10));
    for (let i = 1; i <= 3; i++) g.move(pointer(i, i * 70 - 110, 100, 100));
    // The fingers return near their starting positions before release.
    for (let i = 1; i <= 3; i++) g.move(pointer(i, i * 70 - 8, 100, 150));
    expect(g.up(pointer(1, 62, 100, 170))).toBeNull();
  });

  it("recognizes a coordinated right swipe as redo", () => {
    const g = new CanvasGestureArbiter();
    for (let i = 1; i <= 3; i++) g.down(pointer(i, i * 60, 100, i * 10));
    for (let i = 1; i <= 3; i++) g.move(pointer(i, i * 60 + 110, 108, 100 + i));
    expect(g.up(pointer(1, 170, 108, 150))).toEqual({type: "redo"});
  });

  it("rejects vertical motion, asymmetric pinches, slow third-finger entry, and a fourth pointer", () => {
    const vertical = new CanvasGestureArbiter();
    for (let i = 1; i <= 3; i++) vertical.down(pointer(i, i * 70, 80, 15 * i));
    for (let i = 1; i <= 3; i++) vertical.move(pointer(i, i * 70 + 80, 190, 100));
    expect(vertical.up(pointer(1, 150, 190, 125))).toBeNull();

    const pinch = new CanvasGestureArbiter();
    for (let i = 1; i <= 3; i++) pinch.down(pointer(i, i * 80, 80, i * 10));
    pinch.move(pointer(1, -60, 80, 80));
    pinch.move(pointer(2, 160, 80, 80));
    pinch.move(pointer(3, 340, 80, 80));
    expect(pinch.up(pointer(1, -60, 80, 100))).toBeNull();

    const late = new CanvasGestureArbiter();
    late.down(pointer(1, 70, 80, 0));
    late.down(pointer(2, 130, 80, 25));
    late.down(pointer(3, 190, 80, 800));
    expect(late.move(pointer(1, -70, 80, 830)).blockCamera).toBe(true);
    expect(late.up(pointer(1, -70, 80, 840))).toBeNull();

    const crowded = new CanvasGestureArbiter();
    for (let i = 1; i <= 4; i++) crowded.down(pointer(i, i * 80, 80, i * 10));
    for (let i = 1; i <= 4; i++) crowded.move(pointer(i, i * 80 + 100, 80, 90));
    expect(crowded.up(pointer(1, 180, 80, 110))).toBeNull();
  });

  it("recognizes a stationary long press but not a drift, second touch, or cancellation", () => {
    const g = new CanvasGestureArbiter();
    g.down(pointer(1, 40, 100, 0));
    expect(g.hold(479)).toBeNull();
    expect(g.hold(480)).toEqual({type: "longpress", x: 40, y: 100});
    expect(g.hold(550)).toBeNull();
    expect(g.up(pointer(1, 40, 100, 570))).toBeNull();
    expect(g.suppressClick(590)).toBe(true);

    const multi = new CanvasGestureArbiter();
    multi.down(pointer(1, 40, 100, 0)); multi.down(pointer(2, 120, 100, 100));
    expect(multi.hold(600)).toBeNull();

    const aborted = new CanvasGestureArbiter();
    aborted.down(pointer(1, 40, 100, 0)); aborted.abort(200);
    expect(aborted.hold(600)).toBeNull();
  });

  it("recognizes a spatially and temporally bounded double tap only", () => {
    const g = new CanvasGestureArbiter();
    g.down(pointer(1, 75, 110, 0));
    expect(g.up(pointer(1, 75, 110, 40))).toBeNull();
    g.down(pointer(2, 85, 115, 180));
    expect(g.up(pointer(2, 85, 115, 215))).toEqual({type: "doubletap", x: 85, y: 115});
    expect(g.suppressClick(230)).toBe(true);

    const far = new CanvasGestureArbiter();
    far.down(pointer(1, 30, 20, 0)); far.up(pointer(1, 30, 20, 10));
    far.down(pointer(2, 200, 20, 80));
    expect(far.up(pointer(2, 200, 20, 100))).toBeNull();

    const late = new CanvasGestureArbiter();
    late.down(pointer(1, 30, 20, 0)); late.up(pointer(1, 30, 20, 10));
    late.down(pointer(2, 30, 20, 500));
    expect(late.up(pointer(2, 30, 20, 510))).toBeNull();
  });

  it("cancels every active contact on pointer cancellation and never replays history", () => {
    const g = new CanvasGestureArbiter();
    for (let i = 1; i <= 3; i++) g.down(pointer(i, i * 90, 100, i * 10));
    for (let i = 1; i <= 3; i++) g.move(pointer(i, i * 90 - 100, 100, 100));
    g.abort(105);
    expect(g.activeContacts).toBe(0);
    expect(g.up(pointer(1, -10, 100, 110))).toBeNull();
    expect(g.suppressClick(120)).toBe(true);
  });
});
