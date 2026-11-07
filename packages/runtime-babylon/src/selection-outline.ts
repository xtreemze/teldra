import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateLineSystem } from "@babylonjs/core/Meshes/Builders/linesBuilder";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";

/** Disposable selection presentation. Never participates in canonical picking. */
export class SelectionOutline {
  private outline: LinesMesh | undefined;
  private previous = "";
  constructor(private readonly scene: Scene) {}
  update(parts: readonly AbstractMesh[]): void {
    const visible = parts.filter(mesh => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0 && mesh.getTotalVertices() > 0);
    if (!visible.length) { this.outline?.setEnabled(false); this.previous = ""; return; }
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const mesh of visible) { mesh.computeWorldMatrix(true); const box = mesh.getBoundingInfo().boundingBox; min.minimizeInPlace(box.minimumWorld); max.maximizeInPlace(box.maximumWorld); }
    const key = [...min.asArray(), ...max.asArray()].join(",");
    if (this.previous === key) {this.outline?.setEnabled(true); return;}
    this.previous = key;
    const corners = Array.from({length:8}, (_, i) => new Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z));
    const lines: Vector3[][] = [];
    for(let i=0;i<8;i++) for(const bit of [1,2,4]) if(!(i & bit)) lines.push([corners[i]!, corners[i | bit]!]);
    this.outline = CreateLineSystem("teldra-selection", {lines, updatable:true, ...(this.outline ? {instance:this.outline} : {})}, this.scene);
    this.outline.color = Color3.FromHexString("#79d8cb");
    this.outline.isPickable = false;
    this.outline.renderingGroupId = 1;
    this.outline.setEnabled(true);
  }
  dispose():void {this.outline?.dispose();}
}
