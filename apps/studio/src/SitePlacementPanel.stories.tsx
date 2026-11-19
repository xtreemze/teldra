import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import overpassFixture from "../../../fixtures/osm/overpass-buildings-bbox.json";
import {
  TwinEditor,
  ecefToEnu,
  geodeticToEcef,
  type BoundingBox,
  type LocalPoint,
} from "@teldra/application";
import type { SitePlacement, TwinProject } from "@teldra/domain";
import { parseOverpassBuildings } from "@teldra/osm-overpass";
import { SitePlacementPanel } from "./SitePlacementPanel";

// Synthetic Overpass-shaped response (no real-world data; ODbL not applicable).
const bbox: BoundingBox = { south: 0.4999, west: 0.4999, north: 0.5008, east: 0.5031 };
const parsed = parseOverpassBuildings(overpassFixture, { retrievedAt: "2026-11-19T14:26:00Z" });
const loadCandidates = async () => ({ candidates: parsed.candidates, attribution: parsed.attribution });

/** Synthetic IFC footprint: one candidate's outline expressed in a rotated local frame with an offset origin. */
function syntheticFootprint(): LocalPoint[] {
  const source = parsed.candidates.find((c) => c.id === "osm:way/1000003")!;
  const frame = source.centroid;
  const yaw = (25 * Math.PI) / 180;
  return source.outer.map((p) => {
    const [e, n] = ecefToEnu(
      { latitudeDegrees: frame.latitudeDegrees, longitudeDegrees: frame.longitudeDegrees, ellipsoidalHeightMetres: 0, clockwiseYawRadians: 0 },
      geodeticToEcef(p.latitudeDegrees, p.longitudeDegrees, 0),
    );
    // inverse of the clockwise site rotation, plus a 40 m origin offset
    return [Math.cos(yaw) * e - Math.sin(yaw) * n + 40, Math.sin(yaw) * e + Math.cos(yaw) * n + 40] as LocalPoint;
  });
}

const provisional: SitePlacement = {
  anchor: { crs: "EPSG:4326", latitudeDegrees: 0.5003, longitudeDegrees: 0.5025, height: { metres: 0, reference: "ellipsoidal" } },
  orientation: { northReference: "geographic-north", projectNorthBearingDegrees: 25 },
  provenance: { status: "provisional", source: "osm-overpass", dataset: "OpenStreetMap", sourceObjectId: "osm:way/1000003", retrievedAt: "2026-11-19T14:26:00Z" },
};

function Harness(props: { initial: SitePlacement | null; withFootprint: boolean }) {
  const editor = new TwinEditor(structuredClone(goldenTwin) as unknown as TwinProject);
  if (props.initial) editor.placeBuildingSite(props.initial);
  const [placement, setPlacement] = createSignal<SitePlacement | null>(editor.twin.building.sitePlacement ?? null);
  const [canUndo, setCanUndo] = createSignal(editor.history.canUndo);
  const sync = () => { setPlacement(editor.twin.building.sitePlacement ?? null); setCanUndo(editor.history.canUndo); };
  return (
    <SitePlacementPanel
      placement={placement()}
      {...(props.withFootprint ? { ifcFootprint: syntheticFootprint() } : {})}
      initialBoundingBox={bbox}
      loadCandidates={loadCandidates}
      canUndo={canUndo()}
      onSave={(next) => { editor.placeBuildingSite(next); sync(); }}
      onUndo={() => { editor.undo(); sync(); }}
      now={() => "2026-11-19T15:00:00Z"}
    />
  );
}

const meta = {
  title: "Studio/SitePlacementPanel",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SuggestFromCandidate: Story = { render: () => <Harness initial={null} withFootprint /> };
export const ProvisionalPlacement: Story = { render: () => <Harness initial={provisional} withFootprint /> };
export const ManualEntryWithoutFootprint: Story = { render: () => <Harness initial={null} withFootprint={false} /> };
