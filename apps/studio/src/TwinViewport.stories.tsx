import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import blenderReferenceManifest from "./fixtures/blender-reference.scene.manifest.json";
import {
  TwinViewport,
  type TwinViewportClientPoint,
} from "./TwinViewport";

const fixtureNodeKey = "ifc:fixture-wall:body";
const blenderReferenceNodeKey =
  blenderReferenceManifest.nodes[0]?.nodeKey ??
  "ifc:1234567890123456789012:body";

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

interface IdentityPickingHarnessProps {
  readonly manifest: unknown;
  readonly glbUrl: string;
  readonly nodeKey: string;
}

function IdentityPickingHarness(props: IdentityPickingHarnessProps) {
  const [projected, setProjected] =
    createSignal<TwinViewportClientPoint | null>(null);
  const [roundTripId, setRoundTripId] = createSignal<string>("pending");

  return (
    <>
      <TwinViewport
        manifest={props.manifest}
        glbUrl={props.glbUrl}
        onReady={(handle) => {
          const point = handle.projectNode(props.nodeKey);
          setProjected(point);
          if (point !== null) {
            setRoundTripId(
              handle.pick(point.clientX, point.clientY)?.canonicalId ?? "none",
            );
          }
        }}
      />
      <output hidden aria-label="Projected fixture client position">
        <span data-testid="projected-client-x">
          {projected()?.clientX ?? "pending"}
        </span>
        <span data-testid="projected-client-y">
          {projected()?.clientY ?? "pending"}
        </span>
        <span data-testid="projected-roundtrip-id">{roundTripId()}</span>
      </output>
    </>
  );
}

export const IdentityPicking: Story = {
  args: {
    manifest,
    glbUrl: "/fixtures/twin-pick.glb",
  },
  render: () => (
    <IdentityPickingHarness
      manifest={manifest}
      glbUrl="/fixtures/twin-pick.glb"
      nodeKey={fixtureNodeKey}
    />
  ),
};

export const BlenderReferenceParity: Story = {
  args: {
    manifest: blenderReferenceManifest,
    glbUrl: "/fixtures/blender-reference.glb",
  },
  render: () => (
    <IdentityPickingHarness
      manifest={blenderReferenceManifest}
      glbUrl="/fixtures/blender-reference.glb"
      nodeKey={blenderReferenceNodeKey}
    />
  ),
};
