/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */

export interface SerializedProjectManifest {
  formatVersion: "0.1.0";
  building: Artifact;
  twin: Artifact;
  derived?: Artifact[];
}
export interface Artifact {
  path: string;
  sha256: string;
}
