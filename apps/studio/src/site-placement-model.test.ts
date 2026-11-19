import { describe, expect, it } from "vitest";
import type { SitePlacement } from "@teldra/domain";
import {
  DEFAULT_BASEMAPS,
  assertBasemap,
  draftFromPlacement,
  fitMapView,
  ifcFootprintOverlay,
  lonLatToWorldPixel,
  nudgeDraft,
  placementFromDraft,
  projectToView,
  visibleTiles,
  worldPixelToLonLat,
} from "./site-placement-model";

const base: SitePlacement = {
  anchor: { crs: "EPSG:4326", latitudeDegrees: 55.613, longitudeDegrees: 12.976, height: { metres: 40, reference: "ellipsoidal" } },
  orientation: { northReference: "geographic-north", projectNorthBearingDegrees: 90 },
  provenance: { status: "provisional", source: "osm-overpass", dataset: "OpenStreetMap", sourceObjectId: "osm:way/1", retrievedAt: "2026-01-02T03:04:05Z", attribution: "© OpenStreetMap contributors" },
};

describe("web mercator helpers", () => {
  it("roundtrips lon/lat through world pixels at every zoom", () => {
    for (const z of [3, 12, 19]) {
      const [x, y] = lonLatToWorldPixel(12.976, 55.613, z);
      const back = worldPixelToLonLat(x, y, z);
      expect(back.longitudeDegrees).toBeCloseTo(12.976, 9);
      expect(back.latitudeDegrees).toBeCloseTo(55.613, 9);
    }
    expect(lonLatToWorldPixel(0, 0, 0)).toEqual([128, 128]);
  });

  it("fits all points inside the viewport at an integer zoom", () => {
    const points = [{ latitudeDegrees: 55.6127, longitudeDegrees: 12.9745 }, { latitudeDegrees: 55.6134, longitudeDegrees: 12.9793 }];
    const size = { width: 600, height: 400 };
    const view = fitMapView(points, size, 24);
    expect(Number.isInteger(view.zoom)).toBe(true);
    for (const p of points) {
      const [x, y] = projectToView(view, size, p);
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(size.width);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(size.height);
    }
    // One zoom level tighter would not fit.
    const tighter = { ...view, zoom: view.zoom + 1 };
    const xs = points.map((p) => projectToView(tighter, size, p)[0]);
    const ys = points.map((p) => projectToView(tighter, size, p)[1]);
    expect(Math.min(...xs) < 24 || Math.max(...xs) > size.width - 24 || Math.min(...ys) < 24 || Math.max(...ys) > size.height - 24).toBe(true);
  });

  it("covers the viewport with tiles positioned at integer-pixel offsets", () => {
    const size = { width: 512, height: 300 };
    const view = { centerLatitudeDegrees: 55.613, centerLongitudeDegrees: 12.976, zoom: 17 };
    const tiles = visibleTiles(view, size, "https://tiles.example/{z}/{x}/{y}.png");
    expect(tiles.length).toBeGreaterThanOrEqual(4);
    expect(tiles.every((t) => t.url === `https://tiles.example/17/${t.x}/${t.y}.png`)).toBe(true);
    expect(Math.min(...tiles.map((t) => t.left))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.left + 256))).toBeGreaterThanOrEqual(size.width);
    expect(Math.min(...tiles.map((t) => t.top))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.top + 256))).toBeGreaterThanOrEqual(size.height);
  });
});

describe("basemaps", () => {
  it("only ships a basemap with attribution and a licence statement", () => {
    expect(DEFAULT_BASEMAPS.length).toBeGreaterThan(0);
    for (const b of DEFAULT_BASEMAPS) expect(() => assertBasemap(b)).not.toThrow();
    expect(DEFAULT_BASEMAPS.find((b) => b.id === "osm-standard")?.attribution).toContain("OpenStreetMap contributors");
  });

  it("rejects basemaps lacking attribution or tile placeholders", () => {
    expect(() => assertBasemap({ id: "x", label: "x", urlTemplate: "https://t/{z}/{x}/{y}.png", attribution: "", license: "l", maxZoom: 19 })).toThrow(/attribution/);
    expect(() => assertBasemap({ id: "x", label: "x", urlTemplate: "https://t/tile.png", attribution: "a", license: "l", maxZoom: 19 })).toThrow(/placeholders/);
  });
});

describe("placement drafts", () => {
  it("roundtrips a placement through the editable draft and keeps provenance until saved", () => {
    const draft = draftFromPlacement(base);
    expect(draft).toMatchObject({ latitudeDegrees: 55.613, longitudeDegrees: 12.976, bearingDegrees: 90, heightMetres: 40, heightReference: "ellipsoidal" });
    expect(placementFromDraft(draft, base.provenance)).toEqual(base);
  });

  it("normalises bearings into [0, 360) and requires a datum for orthometric heights", () => {
    const draft = { ...draftFromPlacement(base), bearingDegrees: -10 };
    expect(placementFromDraft(draft, base.provenance).orientation.projectNorthBearingDegrees).toBe(350);
    const ortho = { ...draftFromPlacement(base), heightReference: "orthometric" as const, verticalDatum: "RH2000", geoidSeparationMetres: 36 };
    expect(placementFromDraft(ortho, base.provenance).anchor.height).toEqual({ metres: 40, reference: "orthometric", verticalDatum: "RH2000", geoidSeparationMetres: 36 });
    expect(() => placementFromDraft({ ...ortho, verticalDatum: "" }, base.provenance)).toThrow(/vertical datum/);
  });

  it("nudges east/north in geographic metres and rotates without touching other fields", () => {
    const draft = draftFromPlacement(base);
    const moved = nudgeDraft(draft, { eastMetres: 10, northMetres: 0, rotateDegrees: 0 });
    expect(moved.longitudeDegrees).toBeGreaterThan(draft.longitudeDegrees);
    expect(Math.abs(moved.latitudeDegrees - draft.latitudeDegrees)).toBeLessThan(1e-7);
    // ~10 m east at 55.6 N is about 1.59e-4 degrees of longitude.
    expect(moved.longitudeDegrees - draft.longitudeDegrees).toBeGreaterThan(1.5e-4);
    expect(moved.longitudeDegrees - draft.longitudeDegrees).toBeLessThan(1.7e-4);
    const turned = nudgeDraft(draft, { eastMetres: 0, northMetres: 0, rotateDegrees: 300 });
    expect(turned.bearingDegrees).toBe(30);
    expect(turned.heightMetres).toBe(40);
  });

  it("projects the IFC footprint overlay from the draft without altering the footprint", () => {
    const footprint = [[0, 0], [10, 0], [10, 5], [0, 5]] as const;
    const copy = structuredClone(footprint);
    const overlay = ifcFootprintOverlay(footprint, draftFromPlacement(base));
    expect(footprint).toEqual(copy);
    expect(overlay).toHaveLength(4);
    // Bearing 90: local +Y points east, local +X points south.
    expect(overlay[0]!.latitudeDegrees).toBeCloseTo(55.613, 7);
    expect(overlay[1]!.latitudeDegrees).toBeLessThan(overlay[0]!.latitudeDegrees);
    expect(overlay[3]!.longitudeDegrees).toBeGreaterThan(overlay[0]!.longitudeDegrees);
  });
});
