/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: canonical Teldra JSON Schema.
 * Run: pnpm schema:generate
 */

export type Slug = string;
export type Length = number;
/**
 * Authored IFC body geometry written into the IfcRepresentationMap of the item's IfcFurnitureType. Parametrised from nominal dimensions so the IFC source never depends on a render asset.
 */
export type Representation =
  | {
      kind: "box";
    }
  | {
      kind: "extrusion";
      /**
       * Polygon ring in local XY metres (no repeated closing vertex), extruded along local +Z by dimensions.height. Must lie inside the dimensions footprint.
       *
       * @minItems 3
       * @maxItems 256
       */
      footprint: [[number, number], [number, number], [number, number], ...[number, number][]];
    };
export type Sha256 = string;

/**
 * Renderer-independent catalog of insertable furniture. Items carry IFC semantics, nominal metric dimensions, an authored IFC representation, optional render-asset references, and mandatory licence provenance. Catalogs are authoring input; inserting an item creates canonical IFC entities and never makes the catalog or its assets canonical.
 */
export interface TeldraFurnitureCatalog {
  schemaVersion: "0.1.0";
  id: Slug;
  name: string;
  version: string;
  provider?: string;
  items: Item[];
}
export interface Item {
  id: Slug;
  name: string;
  category: string;
  tags?: string[];
  ifc: Ifc;
  dimensions: Dimensions;
  mount: Mount;
  representation: Representation;
  asset?: Asset;
  materials?: Material[];
  licence: Licence;
}
export interface Ifc {
  class: "IfcFurniture";
  /**
   * IfcFurnitureTypeEnum (IFC4). Occurrences are typed by an IfcFurnitureType carrying this value.
   */
  predefinedType:
    | "BED"
    | "CHAIR"
    | "DESK"
    | "FILECABINET"
    | "SHELF"
    | "SOFA"
    | "TABLE"
    | "USERDEFINED"
    | "NOTDEFINED";
  classifications?: Classification[];
}
export interface Classification {
  /**
   * Classification system name, e.g. bSDD, Uniclass 2015, OmniClass.
   */
  system: string;
  identification: string;
  name: string;
  uri?: string;
}
/**
 * Nominal overall size in metres along the item's local X (width), Y (depth) and Z (height). The local origin is the centre of the bottom face of the bounding box.
 */
export interface Dimensions {
  unit: "m";
  origin: "bbox-bottom-center";
  width: Length;
  depth: Length;
  height: Length;
}
export interface Mount {
  type: "floor" | "wall" | "ceiling";
  /**
   * Default height of the item's origin above the storey floor in metres. Wall- and ceiling-mounted items must state it.
   */
  elevation?: number;
}
/**
 * Optional render/visual model. A derived artifact: its conventions are explicit so a converter never guesses, and it is hash-pinned so bytes are verifiable.
 */
export interface Asset {
  path: string;
  mediaType: "model/gltf-binary" | "model/gltf+json" | "model/obj";
  sha256: Sha256;
  /**
   * Unit of the file's coordinates. glTF is metres by specification; OBJ declares none, so it must be stated.
   */
  unit: "m" | "cm" | "mm" | "in";
  upAxis: "+Y" | "+Z";
  /**
   * Axis the item's front faces in the source file.
   */
  frontAxis: "-Z" | "+Z" | "-Y" | "+Y" | "+X" | "-X";
  /**
   * preserve-source: converted bounds must equal nominal dimensions within tolerance, else import fails. fit-nominal: the importer scales the model non-uniformly to the nominal dimensions and records the factors.
   */
  dimensionsPolicy: "preserve-source" | "fit-nominal";
}
export interface Material {
  name: string;
  /**
   * Linear RGB.
   *
   * @minItems 3
   * @maxItems 3
   */
  baseColor?: [number, number, number];
}
export interface Licence {
  /**
   * SPDX expression, or LicenseRef-* for terms with no SPDX id.
   */
  spdx: string;
  author: string;
  /**
   * Notice that must accompany redistribution. Required whenever the licence needs attribution (CC-BY*, GPL*).
   */
  attribution?: string;
  sourceUrl?: string;
  /**
   * bundle: may ship in Teldra releases. user-import-only: only entered by the user at runtime and kept out of the repository and releases.
   */
  redistribution: "bundle" | "user-import-only";
}
