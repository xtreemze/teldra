import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { TwinViewport } from "./TwinViewport";

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
      nodeKey: "ifc:fixture-wall:body",
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

export const IdentityPicking: Story = {
  args: {
    manifest,
    glbUrl: "/fixtures/twin-pick.glb",
  },
};
