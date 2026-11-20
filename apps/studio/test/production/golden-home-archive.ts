import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { encodeStoredZip, sha256Bytes, type TeldraArchiveEntry } from "@teldra/project-format";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export const overpassFixtureBody = (): string => readFileSync(resolve(root, "fixtures/osm/overpass-buildings-bbox.json"), "utf8");

/**
 * Portable `.teldra` built from the synthetic golden-home fixtures (IFC + twin, no 3D scene), so
 * production tests never depend on a private model.
 */
export async function goldenHomeArchive(): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const building = new Uint8Array(readFileSync(resolve(root, "fixtures/projects/golden-home/building.ifc")));
  const twin = new Uint8Array(readFileSync(resolve(root, "fixtures/projects/golden-home/twin.json")));
  const manifest = {
    formatVersion: "0.1.0",
    building: { path: "building.ifc", sha256: await sha256Bytes(building) },
    twin: { path: "twin.json", sha256: await sha256Bytes(twin) },
    derived: [],
  };
  const entries: TeldraArchiveEntry[] = [
    { path: "project.json", bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    { path: "building.ifc", bytes: building },
    { path: "twin.json", bytes: twin },
  ];
  return encodeStoredZip(entries);
}
