import { describe, expect, it } from "vitest";
import { numericFurniturePose, numericFurnitureScale, transformShortcut, type TransformModal } from "./transform-shortcuts";

const original = {position: [1, -1, 0] as const, yawRadians: 0};

function enter(...keys: string[]): TransformModal {
  let state: TransformModal | null = null;
  for (const key of keys) {
    const result = transformShortcut(state, {key});
    expect(result.handled).toBe(true);
    state = result.state;
  }
  if (!state) throw new Error("Expected active modal transform.");
  return state;
}

describe("Blender-style IFC-safe transform shortcuts", () => {
  it("moves numerically on the constrained canonical axis without changing the baseline", () => {
    const modal = enter("g", "x", "2", ".", "5");
    expect(modal).toEqual({mode: "translate", axis: "x", numeric: "2.5"});
    expect(numericFurniturePose(original, modal)).toEqual({
      position: [3.5, -1, 0], yawRadians: 0,
    });
    expect(original.position).toEqual([1, -1, 0]);
  });

  it("supports negative and fractional values and backspace", () => {
    const state = enter("g", "z", "-", ".", "5");
    expect(numericFurniturePose(original, state)?.position).toEqual([1, -1, -0.5]);
    const corrected = transformShortcut(state, {key: "Backspace"}).state!;
    expect(corrected.numeric).toBe("-.");
    expect(numericFurniturePose(original, corrected)).toBeNull();
  });

  it("restricts upright IFC rotation to Z and interprets numeric angles in degrees", () => {
    let modal = enter("r");
    const denied = transformShortcut(modal, {key: "x"});
    expect(denied.message).toMatch(/world Z/);
    expect(denied.state).toEqual(modal);
    modal = enter("r", "z", "9", "0");
    expect(numericFurniturePose(original, modal)?.yawRadians).toBeCloseTo(Math.PI / 2);
  });

  it("reserves S for IFC-backed geometry rather than inventing a mesh-only scale", () => {
    const result = transformShortcut(null, {key: "s"});
    expect(result.intent).toBe("unsupported");
    expect(result.state).toBeNull();
    expect(result.message).toMatch(/IFC/);
  });

  it("cancels with Escape, commits with Enter and does not take browser shortcuts", () => {
    const modal = enter("g", "y", "1");
    expect(transformShortcut(modal, {key: "Escape"})).toMatchObject({handled: true, intent: "cancel", state: null});
    expect(transformShortcut(modal, {key: "Enter"})).toMatchObject({handled: true, intent: "confirm", state: null});
    expect(transformShortcut(modal, {key: "s", ctrlKey: true}).handled).toBe(false);
    expect(transformShortcut(null, {key: "Tab"}).handled).toBe(false);
  });

  it("requires a constrained axis for numeric translation", () => {
    const modal = enter("g", "2");
    expect(numericFurniturePose(original, modal)).toBeNull();
    expect(transformShortcut(modal, {key: "Enter"}).message).toMatch(/Choose X, Y or Z/);
  });
  it("enables S only for validated IFC representations, with uniform and per-axis positive factors", () => {
    const result = transformShortcut(null, {key: "s"}, true);
    expect(result).toMatchObject({handled:true,intent:"begin",state:{mode:"scale",axis:null,numeric:""}});
    const start = result.state!;
    const uniform = transformShortcut(start, {key:"2"}).state!;
    expect(numericFurnitureScale([1,1.5,2],uniform)).toEqual([2,3,4]);
    const axisX = transformShortcut(start,{key:"x"}).state!;
    const factor = transformShortcut(axisX,{key:"2"}).state!;
    expect(numericFurnitureScale([1,1.5,2],factor)).toEqual([2,1.5,2]);
    const bad = transformShortcut(factor,{key:"-"}).state!;
    expect(numericFurnitureScale([1,1.5,2],bad)).toBeNull();
    expect(transformShortcut(bad,{key:"Enter"}).intent).toBe("message");
  });

});
