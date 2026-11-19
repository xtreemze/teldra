import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import {
  alignFootprintToCandidate,
  confirmSitePlacement,
  sitePlacementFromAlignment,
  type BoundingBox,
  type BuildingFootprintCandidate,
  type FootprintAlignment,
  type FootprintAlignmentHypothesis,
  type LocalPoint,
} from "@teldra/application";
import type { SitePlacement } from "@teldra/domain";
import {
  DEFAULT_BASEMAPS,
  draftFromPlacement,
  fitMapView,
  ifcFootprintOverlay,
  nudgeDraft,
  placementFromDraft,
  projectToView,
  visibleTiles,
  viewToLonLat,
  type BasemapConfig,
  type MapView,
  type PlacementDraft,
} from "./site-placement-model";
import "./SitePlacementPanel.css";

export interface SiteCandidateLoadResult {
  readonly candidates: readonly BuildingFootprintCandidate[];
  readonly attribution: string;
}

export interface SitePlacementPanelProps {
  /** Canonical placement from the twin, if any. */
  readonly placement: SitePlacement | null;
  /** IFC footprint in building-local metres (read-only evidence from the canonical model). */
  readonly ifcFootprint?: readonly LocalPoint[];
  readonly initialBoundingBox?: BoundingBox;
  readonly loadCandidates: (bbox: BoundingBox) => Promise<SiteCandidateLoadResult>;
  /** Persist through the application command (twin.building.place-site). */
  readonly onSave: (placement: SitePlacement) => void;
  readonly onUndo: () => void;
  readonly canUndo: boolean;
  readonly basemaps?: readonly BasemapConfig[];
  readonly now?: () => string;
}

const MAP: { width: number; height: number } = { width: 640, height: 420 };
const NO_BASEMAP = "none";
const num = (value: string, fallback: number) => (value.trim() === "" || !Number.isFinite(Number(value)) ? fallback : Number(value));
const toPath = (points: readonly (readonly [number, number])[]) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

export function SitePlacementPanel(props: SitePlacementPanelProps) {
  const basemaps = () => props.basemaps ?? DEFAULT_BASEMAPS;
  const now = () => props.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const box = props.initialBoundingBox;

  const [bbox, setBbox] = createSignal({
    south: String(box?.south ?? ""), west: String(box?.west ?? ""), north: String(box?.north ?? ""), east: String(box?.east ?? ""),
  });
  const [candidates, setCandidates] = createSignal<readonly BuildingFootprintCandidate[]>([]);
  const [attribution, setAttribution] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [selectedId, setSelectedId] = createSignal<string | undefined>();
  const [alignment, setAlignment] = createSignal<FootprintAlignment | undefined>();
  const [draft, setDraft] = createSignal<PlacementDraft | undefined>(props.placement ? draftFromPlacement(props.placement) : undefined);
  const [provenance, setProvenance] = createSignal<SitePlacement["provenance"] | undefined>(props.placement?.provenance);
  const [basemapId, setBasemapId] = createSignal<string>(NO_BASEMAP);
  const [view, setView] = createSignal<MapView | undefined>(
    props.placement ? { centerLatitudeDegrees: props.placement.anchor.latitudeDegrees, centerLongitudeDegrees: props.placement.anchor.longitudeDegrees, zoom: 18 } : undefined,
  );
  const [dragging, setDragging] = createSignal<{ x: number; y: number } | undefined>();

  // Canonical placement changed (saved, undone, redone): the draft follows it.
  createEffect(on(() => props.placement, (next) => {
    setDraft(next ? draftFromPlacement(next) : undefined);
    setProvenance(next?.provenance);
  }, { defer: true }));

  const basemap = () => basemaps().find((b) => b.id === basemapId());
  const selected = () => candidates().find((c) => c.id === selectedId());
  const status = () => provenance()?.status ?? "unplaced";
  const dirty = () => {
    const d = draft(), p = props.placement;
    if (!d) return false;
    if (!p) return true;
    const base = draftFromPlacement(p);
    return JSON.stringify(d) !== JSON.stringify(base);
  };

  const overlay = createMemo(() => {
    const d = draft(), footprint = props.ifcFootprint;
    return d && footprint && footprint.length >= 3 ? ifcFootprintOverlay(footprint, d) : undefined;
  });

  const refit = (list: readonly BuildingFootprintCandidate[]) => {
    const points = list.flatMap((c) => c.outer);
    if (points.length > 0) setView(fitMapView(points, MAP, 24, basemap()?.maxZoom ?? 19));
  };

  async function search() {
    setError("");
    const b = bbox();
    const query = { south: Number(b.south), west: Number(b.west), north: Number(b.north), east: Number(b.east) };
    if (![query.south, query.west, query.north, query.east].every((v) => b.south !== "" && Number.isFinite(v))) {
      setError("Enter a numeric south, west, north and east bounding box.");
      return;
    }
    setBusy(true);
    try {
      const result = await props.loadCandidates(query);
      setCandidates(result.candidates);
      setAttribution(result.attribution);
      setSelectedId(undefined);
      setAlignment(undefined);
      refit(result.candidates);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function applyHypothesis(candidate: BuildingFootprintCandidate, hypothesis: FootprintAlignmentHypothesis) {
    const height = draft() ? { metres: draft()!.heightMetres, reference: draft()!.heightReference, ...(draft()!.verticalDatum ? { verticalDatum: draft()!.verticalDatum } : {}), ...(draft()!.geoidSeparationMetres !== undefined ? { geoidSeparationMetres: draft()!.geoidSeparationMetres } : {}) } as SitePlacement["anchor"]["height"] : { metres: 0, reference: "ellipsoidal" as const };
    const placement = sitePlacementFromAlignment({ ...hypothesis, alternatives: [], ambiguous: false }, candidate, height);
    setDraft(draftFromPlacement(placement));
    setProvenance(placement.provenance);
  }

  function select(candidate: BuildingFootprintCandidate) {
    setError("");
    setSelectedId(candidate.id);
    const footprint = props.ifcFootprint;
    if (!footprint || footprint.length < 3) {
      setAlignment(undefined);
      return;
    }
    try {
      const result = alignFootprintToCandidate(footprint, candidate);
      setAlignment(result);
      applyHypothesis(candidate, result);
    } catch (e) {
      setAlignment(undefined);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const patch = (change: Partial<PlacementDraft>) => {
    const current = draft() ?? { latitudeDegrees: 0, longitudeDegrees: 0, bearingDegrees: 0, heightMetres: 0, heightReference: "ellipsoidal" as const, verticalDatum: "" };
    setDraft({ ...current, ...change });
    if (!provenance()) setProvenance({ status: "provisional", source: "manual", dataset: "user-entered", retrievedAt: now() });
  };

  const nudge = (eastMetres: number, northMetres: number, rotateDegrees: number) => {
    const d = draft();
    if (d) setDraft(nudgeDraft(d, { eastMetres, northMetres, rotateDegrees }));
  };

  function save() {
    setError("");
    const d = draft(), p = provenance();
    if (!d || !p) return;
    try {
      const placement = placementFromDraft(d, { ...p, status: "provisional" });
      const { confirmedAt: _drop, ...clean } = placement.provenance;
      props.onSave(confirmSitePlacement({ ...placement, provenance: clean }, now()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const zoomBy = (delta: number) => {
    const v = view();
    if (v) setView({ ...v, zoom: Math.max(1, Math.min(basemap()?.maxZoom ?? 19, v.zoom + delta)) });
  };

  const onPointerDown = (e: PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDragging({ x: e.clientX, y: e.clientY });
  };
  const onPointerMove = (e: PointerEvent) => {
    const start = dragging(), v = view();
    if (!start || !v) return;
    const centre = viewToLonLat(v, MAP, MAP.width / 2 - (e.clientX - start.x), MAP.height / 2 - (e.clientY - start.y));
    setView({ ...v, centerLatitudeDegrees: centre.latitudeDegrees, centerLongitudeDegrees: centre.longitudeDegrees });
    setDragging({ x: e.clientX, y: e.clientY });
  };

  const field = (label: string, value: () => string | number, onInput: (v: string) => void, step = "any") => (
    <label class="teldra-site-placement__field">
      <span>{label}</span>
      <input type="number" step={step} value={value()} onChange={(e) => onInput(e.currentTarget.value)} />
    </label>
  );

  return (
    <section class="teldra-site-placement" aria-labelledby="site-placement-title">
      <header class="teldra-site-placement__header">
        <h2 id="site-placement-title">Site placement</h2>
        <span class="teldra-site-placement__status" data-status={status()}>
          {status() === "user-confirmed" ? (dirty() ? "Confirmed by you (unsaved edits)" : "Confirmed by you") : status() === "provisional" ? "Provisional" : "Not placed"}
        </span>
      </header>
      <p class="teldra-site-placement__note">
        Map data is environmental context. It never changes IFC geometry; saving only records where the building origin sits and how it is rotated.
      </p>

      <fieldset class="teldra-site-placement__search">
        <legend>Search area (WGS84 degrees)</legend>
        {field("South", () => bbox().south, (v) => setBbox({ ...bbox(), south: v }))}
        {field("West", () => bbox().west, (v) => setBbox({ ...bbox(), west: v }))}
        {field("North", () => bbox().north, (v) => setBbox({ ...bbox(), north: v }))}
        {field("East", () => bbox().east, (v) => setBbox({ ...bbox(), east: v }))}
        <button type="button" disabled={busy()} onClick={() => void search()}>{busy() ? "Searching…" : "Find buildings"}</button>
      </fieldset>

      <Show when={error()}><p role="alert" class="teldra-site-placement__error">{error()}</p></Show>

      <div class="teldra-site-placement__body">
        <div class="teldra-site-placement__map-column">
          <div class="teldra-site-placement__map-tools">
            <label>
              Basemap{" "}
              <select value={basemapId()} onChange={(e) => setBasemapId(e.currentTarget.value)}>
                <option value={NO_BASEMAP}>None</option>
                <For each={basemaps()}>{(b) => <option value={b.id}>{b.label}</option>}</For>
              </select>
            </label>
            <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1)}>+</button>
            <button type="button" aria-label="Zoom out" onClick={() => zoomBy(-1)}>−</button>
          </div>
          <div class="teldra-site-placement__map-frame">
            <svg
              class="teldra-site-placement__map"
              viewBox={`0 0 ${MAP.width} ${MAP.height}`}
              role="group"
              aria-label="Candidate buildings map"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => setDragging(undefined)}
              onPointerCancel={() => setDragging(undefined)}
            >
              <Show when={view()} fallback={<text x="16" y="28" class="teldra-site-placement__hint">Search an area to see candidate buildings.</text>}>
                {(v) => (
                  <>
                    <Show when={basemap()}>
                      {(b) => (
                        <For each={visibleTiles(v(), MAP, b().urlTemplate)}>
                          {(tile) => <image href={tile.url} x={tile.left} y={tile.top} width="256" height="256" preserveAspectRatio="none" />}
                        </For>
                      )}
                    </Show>
                    <For each={candidates()}>
                      {(c) => (
                        <polygon
                          class="teldra-site-placement__candidate"
                          classList={{ "is-selected": c.id === selectedId() }}
                          points={toPath(c.outer.map((p) => projectToView(v(), MAP, p)))}
                          role="button"
                          tabindex="0"
                          aria-pressed={c.id === selectedId()}
                          aria-label={`Candidate ${c.id}`}
                          onClick={() => select(c)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(c); } }}
                        />
                      )}
                    </For>
                    <Show when={overlay()}>
                      {(o) => <polygon class="teldra-site-placement__ifc" points={toPath(o().map((p) => projectToView(v(), MAP, p)))} aria-label="IFC footprint under current placement" />}
                    </Show>
                  </>
                )}
              </Show>
            </svg>
            <Show when={basemap()}>
              {(b) => <p class="teldra-site-placement__attribution">{b().attribution}</p>}
            </Show>
          </div>
          <Show when={attribution()}><p class="teldra-site-placement__credit">Footprints: {attribution()}</p></Show>
          <p class="teldra-site-placement__legend">
            <span class="teldra-site-placement__swatch teldra-site-placement__swatch--candidate" /> Candidates
            <span class="teldra-site-placement__swatch teldra-site-placement__swatch--ifc" /> IFC footprint (derived overlay)
          </p>
        </div>

        <div class="teldra-site-placement__side">
          <h3>Candidates</h3>
          <Show when={candidates().length > 0} fallback={<p class="teldra-site-placement__hint">No candidates loaded.</p>}>
            <ul class="teldra-site-placement__list">
              <For each={candidates()}>
                {(c) => (
                  <li>
                    <button type="button" aria-pressed={c.id === selectedId()} onClick={() => select(c)}>
                      <strong>{c.id}</strong>
                      <span>
                        {c.levels !== undefined ? `${c.levels} levels` : "levels unknown"}
                        {c.heightMetres !== undefined ? `, ${c.heightMetres} m` : ""}
                        {` · ${c.centroid.latitudeDegrees.toFixed(5)}, ${c.centroid.longitudeDegrees.toFixed(5)}`}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <Show when={alignment()}>
            {(a) => (
              <div class="teldra-site-placement__suggestion" aria-live="polite">
                <h3>Suggested placement</h3>
                <p>
                  Bearing {a().projectNorthBearingDegrees.toFixed(1)}°, anchor {a().anchor.latitudeDegrees.toFixed(7)}, {a().anchor.longitudeDegrees.toFixed(7)}.
                </p>
                <p>
                  Residual RMS {a().residual.rmsMetres.toFixed(2)} m, max {a().residual.maxMetres.toFixed(2)} m, area ratio {a().residual.areaRatio.toFixed(2)}.
                </p>
                <Show when={a().ambiguous}>
                  <p class="teldra-site-placement__warning">
                    The footprint shape is nearly symmetric, so orientation is ambiguous. Check the overlay or choose an alternative.
                  </p>
                  <For each={a().alternatives}>
                    {(alt) => (
                      <button type="button" onClick={() => selected() && applyHypothesis(selected()!, alt)}>
                        Use bearing {alt.projectNorthBearingDegrees.toFixed(1)}° (RMS {alt.residual.rmsMetres.toFixed(2)} m)
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            )}
          </Show>
          <Show when={!props.ifcFootprint && selected()}>
            <p class="teldra-site-placement__hint">No IFC footprint available for alignment; enter the placement manually.</p>
          </Show>

          <h3>Manual adjustment</h3>
          <div class="teldra-site-placement__form">
            {field("Latitude (°)", () => draft()?.latitudeDegrees ?? "", (v) => patch({ latitudeDegrees: num(v, draft()?.latitudeDegrees ?? 0) }))}
            {field("Longitude (°)", () => draft()?.longitudeDegrees ?? "", (v) => patch({ longitudeDegrees: num(v, draft()?.longitudeDegrees ?? 0) }))}
            {field("Project-north bearing (° clockwise from true north)", () => draft()?.bearingDegrees ?? "", (v) => patch({ bearingDegrees: num(v, draft()?.bearingDegrees ?? 0) }))}
            {field("Elevation (m)", () => draft()?.heightMetres ?? "", (v) => patch({ heightMetres: num(v, draft()?.heightMetres ?? 0) }))}
            <label class="teldra-site-placement__field">
              <span>Height reference</span>
              <select value={draft()?.heightReference ?? "ellipsoidal"} onChange={(e) => patch({ heightReference: e.currentTarget.value as PlacementDraft["heightReference"] })}>
                <option value="ellipsoidal">Ellipsoidal (WGS84)</option>
                <option value="orthometric">Orthometric (sea level)</option>
              </select>
            </label>
            <Show when={draft()?.heightReference === "orthometric"}>
              <label class="teldra-site-placement__field">
                <span>Vertical datum</span>
                <input type="text" value={draft()?.verticalDatum ?? ""} onChange={(e) => patch({ verticalDatum: e.currentTarget.value })} />
              </label>
              {field("Geoid separation (m)", () => draft()?.geoidSeparationMetres ?? "", (v) => patch({ geoidSeparationMetres: v.trim() === "" ? undefined : num(v, 0) }))}
            </Show>
          </div>
          <div class="teldra-site-placement__nudges" role="group" aria-label="Nudge placement">
            <button type="button" onClick={() => nudge(0, 1, 0)}>North 1 m</button>
            <button type="button" onClick={() => nudge(0, -1, 0)}>South 1 m</button>
            <button type="button" onClick={() => nudge(1, 0, 0)}>East 1 m</button>
            <button type="button" onClick={() => nudge(-1, 0, 0)}>West 1 m</button>
            <button type="button" onClick={() => nudge(0, 0, 1)}>Rotate +1°</button>
            <button type="button" onClick={() => nudge(0, 0, -1)}>Rotate −1°</button>
          </div>

          <div class="teldra-site-placement__actions">
            <button type="button" class="is-primary" disabled={!draft() || !dirty()} onClick={save}>Confirm and save</button>
            <button type="button" disabled={!props.canUndo} onClick={() => props.onUndo()}>Undo</button>
          </div>
          <Show when={provenance()}>
            {(p) => (
              <p class="teldra-site-placement__provenance">
                Source: {p().source} / {p().dataset}
                {p().sourceObjectId ? ` / ${p().sourceObjectId}` : ""}, retrieved {p().retrievedAt}.
              </p>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}
