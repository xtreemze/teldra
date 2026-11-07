import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  nominalDimensionsForScale, scaleForNominalDimensions,
  type FurnitureGeometryScale, type FurnitureSourceDimensions,
  type FurnitureWorldPose,
} from "@teldra/application";
import type { StudioProjectController } from "./StudioProjectController";
import { IfcFurnitureEdit } from "./IfcFurnitureEdit";

const source: FurnitureSourceDimensions = [0.5, 0.5, 1];
const original: FurnitureGeometryScale = [1,1,1];
const pose: FurnitureWorldPose = { position: [1,-1,0], yawRadians: 0 };

/** This Storybook controller is in-memory only; real IFC commits have separate tests. */
function SizeHarness(props: {sourceProvenance?: boolean}) {
  const [committed, setCommitted] = createSignal<FurnitureGeometryScale>(original);
  const [preview, setPreview] = createSignal<FurnitureGeometryScale | null>(null);
  const controller = {
    prepareFurnitureEditing: async () => pose,
    furniturePose: () => pose,
    furnitureScaleStatus: () => ({supported: true, scale: committed()}),
    furnitureDimensionStatus: (_id: string, scale?: FurnitureGeometryScale) =>
      props.sourceProvenance !== false
        ? {supported: true, source, current: nominalDimensionsForScale(source, original, scale ?? committed())}
        : {supported: false, reason: "No SH3D source dimensions"},
    furnitureScaleForDimensions: (_id: string, desired: FurnitureSourceDimensions) =>
      scaleForNominalDimensions(source, original, desired),
    transformFurniture: (_id: string, _pose: FurnitureWorldPose, scale: FurnitureGeometryScale) => {
      setCommitted(scale);
    },
    placeFurniture: () => {},
  } as unknown as StudioProjectController;
  return <div style={{width:"390px",padding:"1rem",background:"#19242b",color:"#f2f6f9"}}>
    <output data-testid="committed-scale">{committed().join(",")}</output>
    <output data-testid="preview-scale">{preview()?.join(",") ?? "none"}</output>
    <IfcFurnitureEdit
      controller={controller} canonicalId="chair"
      onScalePreview={setPreview} />
  </div>;
}

const meta = {
  title: "Studio/IfcFurnitureDimensions",
  component: SizeHarness,
  args: { sourceProvenance: true },
} satisfies Meta<typeof SizeHarness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EditableSh3dNominalSize: Story = {};
export const MissingSourceProvenance: Story = {args:{sourceProvenance:false}};
