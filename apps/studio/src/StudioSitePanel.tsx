import { createMemo, createResource, createSignal } from "solid-js";
import type { BoundingBox, LocalPoint } from "@teldra/application";
import type { SitePlacement } from "@teldra/domain";
import { OverpassBuildingSource } from "@teldra/osm-overpass";
import { SitePlacementPanel, type SiteCandidateLoadResult } from "./SitePlacementPanel";
import type { StudioProjectController } from "./StudioProjectController";

export interface StudioSitePanelProps {
  readonly controller: StudioProjectController;
  /** Read-only footprint derived from the canonical IFC; resolves `undefined` when none is available. */
  readonly readFootprint?: () => Promise<readonly LocalPoint[] | undefined>;
  /** Candidate source. Nothing is requested until the user presses "Find buildings". */
  readonly loadCandidates?: (bbox: BoundingBox) => Promise<SiteCandidateLoadResult>;
  /** Bumps whenever the host knows the canonical twin changed outside this panel (undo/redo elsewhere). */
  readonly version?: () => number;
  readonly now?: () => string;
}

/** About 60 m around an existing placement, so an explicit search starts near the confirmed site. */
const SEARCH_RADIUS_DEGREES = 0.0005;

function searchBoxAround(placement: SitePlacement | null): BoundingBox | undefined {
  if (!placement) return undefined;
  const { latitudeDegrees: lat, longitudeDegrees: lon } = placement.anchor;
  return { south: lat - SEARCH_RADIUS_DEGREES, west: lon - SEARCH_RADIUS_DEGREES, north: lat + SEARCH_RADIUS_DEGREES, east: lon + SEARCH_RADIUS_DEGREES };
}

/**
 * Studio mount for the site placement panel. It adapts the project controller (shared twin history,
 * save and reopen) to the headless panel and never touches IFC geometry.
 */
export function StudioSitePanel(props: StudioSitePanelProps) {
  const [local, setLocal] = createSignal(0);
  const refresh = () => setLocal((n) => n + 1);
  const stamp = () => local() + (props.version?.() ?? 0);
  const placement = createMemo(() => { stamp(); return props.controller.twin.building.sitePlacement ?? null; });
  const history = createMemo(() => { stamp(); return props.controller.history; });
  const dirty = createMemo(() => { stamp(); return props.controller.dirty; });
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal("");
  const [footprint] = createResource(() => props.readFootprint?.() ?? Promise.resolve(undefined));
  // One shared source: its cache, in-flight de-duplication and minimum interval protect the public service.
  const source = new OverpassBuildingSource();
  const loadCandidates = props.loadCandidates ?? (async (bbox: BoundingBox) => {
    const result = await source.fetchBuildings(bbox);
    return { candidates: result.candidates, attribution: result.attribution };
  });
  const initialBox = searchBoxAround(props.controller.twin.building.sitePlacement ?? null);

  const saveProject = async () => {
    setSaving(true);
    setSaveError("");
    try { await props.controller.save(); }
    catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); refresh(); }
  };

  return (
    <>
      <SitePlacementPanel
        placement={placement()}
        ifcFootprint={footprint() ?? undefined}
        {...(initialBox ? { initialBoundingBox: initialBox } : {})}
        loadCandidates={loadCandidates}
        canUndo={history().canUndo}
        canRedo={history().canRedo}
        projectDirty={dirty()}
        projectSaving={saving()}
        onSave={(next) => { props.controller.placeBuildingSite(next); refresh(); }}
        onUndo={() => { props.controller.undo(); refresh(); }}
        onRedo={() => { props.controller.redo(); refresh(); }}
        onSaveProject={() => void saveProject()}
        {...(props.now ? { now: props.now } : {})}
      />
      {saveError() ? <p role="alert">{saveError()}</p> : null}
    </>
  );
}
