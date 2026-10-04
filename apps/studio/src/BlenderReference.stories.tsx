import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  TwinViewport,
  type TwinViewportClientPoint,
} from "./TwinViewport";

const nodeKey = "reference:blender-cube:body";
const canonicalId = "fixture:blender-reference-cube";

const manifest = {
  schemaVersion: "0.1.0",
  coordinateSystem: {
    unit: "metre",
    handedness: "right",
    upAxis: "Z",
  },
  source: {
    buildingPath: "reference.blend",
    buildingSha256: "a".repeat(64),
  },
  scene: {
    assetPath: "/fixtures/blender-reference.glb",
    assetSha256: "b".repeat(64),
    format: "glb",
    canonicalToScene: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ],
  },
  nodes: [
    {
      nodeKey,
      canonicalId,
      kind: "device",
      renderPart: "body",
    },
  ],
};

const meta = {
  title: "Certification/BlenderReference",
  component: TwinViewport,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof TwinViewport>;

export default meta;
type Story = StoryObj<typeof meta>;

function GeneratedReferenceHarness() {
  const [projected, setProjected] =
    createSignal<TwinViewportClientPoint | null>(null);
  const [roundTripId, setRoundTripId] = createSignal("pending");

  return (
    <>
      <TwinViewport
        manifest={manifest}
        glbUrl="/fixtures/blender-reference.glb"
        onReady={(handle) => {
          const point = handle.projectNode(nodeKey);
          setProjected(point);
          if (point !== null) {
            setRoundTripId(
              handle.pick(point.clientX, point.clientY)?.canonicalId ?? "none",
            );
          }
        }}
      />
      <output hidden aria-label="Blender reference certification">
        <span data-testid="blender-reference-x">
          {projected()?.clientX ?? "pending"}
        </span>
        <span data-testid="blender-reference-y">
          {projected()?.clientY ?? "pending"}
        </span>
        <span data-testid="blender-reference-roundtrip">
          {roundTripId()}
        </span>
      </output>
    </>
  );
}

export const Generated: Story = {
  args: {
    manifest,
    glbUrl: "/fixtures/blender-reference.glb",
  },
  render: () => <GeneratedReferenceHarness />,
};
