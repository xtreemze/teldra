import { ColorCurves } from "@babylonjs/core/Materials/colorCurves";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Studio-only grading for dark SH3D previews. This operates after lighting:
 * no source texture, Phong coefficient, lighting record or canonical data is edited.
 */
export const SH3D_EDITING_SHADOW_DETAIL = 65;

/** 0 restores the ungraded source presentation; 100 is maximum shadow recovery. */
export function applyPreviewShadowDetail(scene: Scene, amount: number): void {
  if (!Number.isFinite(amount) || amount < 0 || amount > 100) {
    throw new Error("Shadow detail must be between 0 and 100.");
  }
  const processing = scene.imageProcessingConfiguration;
  if (amount === 0) {
    processing.colorCurvesEnabled = false;
    return;
  }
  const curves = new ColorCurves();
  curves.shadowsExposure = amount;
  // A smaller midtone lift reveals dark floor grain while keeping white walls stable.
  curves.midtonesExposure = amount * 0.12;
  curves.highlightsExposure = 0;
  processing.colorCurves = curves;
  processing.colorCurvesEnabled = true;
}
