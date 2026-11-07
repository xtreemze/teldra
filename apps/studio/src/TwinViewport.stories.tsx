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
  const [roundTripId, setRoundTripId] = createSignal<string>("pending");

  return (
    <>
      <TwinViewport
        manifest={manifest}
        glbUrl="/fixtures/twin-pick.glb"
        onReady={(handle) => {
          const point = handle.projectNode(fixtureNodeKey);
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
  render: () => <IdentityPickingHarness />,
};

function MobileGestureHarness() {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [intent, setIntent] = createSignal("none");
  const [point, setPoint] = createSignal<TwinViewportClientPoint | null>(null);
  const [disabled, setDisabled] = createSignal(false);

  return <div style={{position: "relative"}}>
    <TwinViewport manifest={manifest} glbUrl="/fixtures/twin-pick.glb"
      selectedCanonicalId={selectedId()} gesturesDisabled={disabled()}
      onReady={handle => setPoint(handle.projectNode(fixtureNodeKey))}
      onSelect={identity => setSelectedId(identity?.canonicalId ?? null)}
      onTouchGesture={(kind, identity) =>
        setIntent(kind + (identity ? ":" + identity.canonicalId : ""))} />
    <output data-testid="touch-intent">{intent()}</output>
    <output data-testid="touch-selected-id">{selectedId() ?? "none"}</output>
    <output data-testid="touch-projected-x">{point()?.clientX ?? "pending"}</output>
    <output data-testid="touch-projected-y">{point()?.clientY ?? "pending"}</output>
    <button type="button" onClick={() => setDisabled(!disabled())}
      aria-pressed={disabled()}>Disable canvas gestures</button>
  </div>;
}

export const TouchGestureArbitration: Story = {
  render: () => <MobileGestureHarness />,
};
