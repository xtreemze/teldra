import { describe, expect, it } from "vitest";
import { IfcFurnitureEditor, type FurnitureWorldPose } from "../src/ifc-furniture-editor.js";

const guid = "16W6mYG0DO8hR8U$bz6FSv";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as {
  pose: FurnitureWorldPose;
  scale: [number, number, number];
};
const original = {pose: {position: [1, 2, 3] as const, yawRadians: 0}, scale: [1,1,1] as [number,number,number]};
const adapter = {
  read: (bytes: Uint8Array) => decode(bytes).pose,
  write: (bytes: Uint8Array, _: string, pose: FurnitureWorldPose) => encode({...decode(bytes), pose}),
  readScale: (bytes: Uint8Array) => decode(bytes).scale,
  writeScale: (bytes: Uint8Array, _: string, scale: readonly [number,number,number]) => encode({...decode(bytes), scale}),
};

describe("IFC geometry scale application command", () => {
  it("mutates only canonical IFC and participates in command undo/redo", () => {
    const editor = new IfcFurnitureEditor(encode(original), adapter);
    editor.scale(guid, [2,1.5,0.8]);
    expect(editor.readScale(guid)).toEqual([2,1.5,0.8]);
    expect(editor.read(guid)).toEqual(original.pose);
    editor.place(guid, {position: [5,6,7], yawRadians: 1});
    expect(editor.readScale(guid)).toEqual([2,1.5,0.8]);
    expect(editor.undo()).toBe(true);
    expect(editor.read(guid)).toEqual(original.pose);
    expect(editor.undo()).toBe(true);
    expect(editor.readScale(guid)).toEqual([1,1,1]);
    expect(editor.redo()).toBe(true);
    expect(editor.readScale(guid)).toEqual([2,1.5,0.8]);
  });

  it("rejects nonfinite, zero or negative scales before adapter writes", () => {
    const editor = new IfcFurnitureEditor(encode(original), adapter);
    for (const scale of [[0,1,1],[-1,1,1],[1,NaN,1],[1,Infinity,1]] as const)
      expect(() => editor.scale(guid, scale)).toThrow(/positive/);
    expect(editor.readScale(guid)).toEqual([1,1,1]);
  });
});
