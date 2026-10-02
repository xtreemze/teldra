import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  TwinViewport,
  type TwinViewportClientPoint,
} from "./TwinViewport";

const fixtureNodeKey = "ifc:fixture-wall:body";

const manifest = {
  schemaVersion: "0.1.0",
  coordinateSystem: {
    unit: "metre",
    handedness: "right",
    upAxis: "Z",
  },
  source: {
    buildingPath: "fixture.ifc",
    buildingSha256: "a".repeat(64),
  },
  scene: {
    assetPath: "/fixtures/twin-pick.glb",
    assetSha256: "b".repeat(64),
    format: "glb",
    canonicalToScene: [
      1, 0, 0, 0,
      0, 0, -1, 0,
      0, 1, 0, 0,
      0, 0, 0, 1,
    ],
  },
  nodes: [
    {
      nodeKey: fixtureNodeKey,
      canonicalId: "wall:fixture",
      ifcGlobalId: "1234567890123456789012",
      kind: "building",
      renderPart: "body",
    },
  ],
};

const meta = {
  title: "Studio/TwinViewport",
  component: TwinViewport,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof TwinViewport>;

export default meta;
type Story = StoryObj<typeof meta>;

function IdentityPickingHarness() {
  const [projected, setProjected] =
    createSignal<TwinViewportClientPoint | null>(null);

  return (
    <>
      <TwinViewport
        manifest={manifest}
        glbUrl="/fixtures/twin-pick.glb"
        onReady={(handle) => {
          setProjected(handle.projectNode(fixtureNodeKey));
        }}
      />
      <output hidden aria-label="Projected fixture client position">
        <span data-testid="projected-client-x">
          {projected()?.clientX ?? "pending"}
        </span>
        <span data-testid="projected-client-y">
          {projected()?.clientY ?? "pending"}
        </span>
      </output>
    </>
  );
}

export const IdentityPicking: Story = {
  args: {
    manifest,
    glbUrl: "/fixtures/twin-pick.glb",
  },
  render: () => <IdentityPickingHarness />,
};
