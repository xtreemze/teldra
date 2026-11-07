import {it,expect} from "vitest";
import {NullEngine} from "@babylonjs/core/Engines/nullEngine";
import {Scene} from "@babylonjs/core/scene";
import {CreateBox} from "@babylonjs/core/Meshes/Builders/boxBuilder";
import {SelectionOutline} from "../src/selection-outline";
it("shows updated nonpickable selection bounds and clears hidden selection",()=>{
 const engine=new NullEngine(),scene=new Scene(engine);const box=CreateBox("source",{},scene), outline=new SelectionOutline(scene);
 try {outline.update([box]);const lines=scene.getMeshByName("teldra-selection")!;expect(lines.isPickable).toBe(false);expect(lines.isEnabled()).toBe(true);
 box.position.x=5;outline.update([box]);expect(lines.getVerticesData("position")![0]).toBeCloseTo(4.5);
 box.setEnabled(false);outline.update([box]);expect(lines.isEnabled()).toBe(false);
 } finally {outline.dispose();scene.dispose();engine.dispose();}
});
