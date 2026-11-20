# ADR 0024: Furniture catalog, asset licensing and IFC insertion

Status: draft (implementation tracked by #122; domain/application/ifc-edit part implemented, Studio UI and asset import pipeline pending)

## Context

Studio can move, scale, duplicate and delete existing IFC furniture. Users also need to add new furniture from a catalog. IFC stays authoritative for architectural identity and geometry; render models (GLB, OBJ) are derived artifacts. Catalog content comes from third parties with very different licences, so provenance must be a hard part of the contract.

## Asset source investigation

| Source | Format and structure | Licence | Bundle in repo/releases? |
| --- | --- | --- | --- |
| Sweet Home 3D 7.6.1 default catalog (`Furniture.jar`, inspected locally) | `DefaultFurnitureCatalog.properties` with 178 items (100 `creator=eTeks`, 78 `creator=Space Mushrooms`); OBJ+MTL models, PNG icons, dimensions in **centimetres**, optional `modelRotation` 3x3 matrix, `doorOrWindow`, `elevation`, `movable`; no IFC class or bSDD data (category is a free string such as "Living room") | Catalog header: `GNU GPL / CC-BY`, copyright Space Mushrooms; CC-BY requires attribution, GPL v2+ terms apply to the program and are ambiguous for model data | Not into this repository by default. Treat as **user-import-only** until a per-item licence review picks CC-BY and an attribution file ships with releases |
| Sweet Home 3D contributed catalog | `ContributedFurnitureCatalog.properties` in 7.6.1 only contains `ignored#N=true` entries (empty). Real contributed libraries (`.sh3f`) are third-party zips with per-library licences, often CC-BY, some "free for non-commercial" or unstated | Varies per library; frequently unstated | **User-import-only**. Never bundle; read licence per file |
| Poly Haven models | glTF/GLB, FBX, Blend; metres | CC0 | Yes (CC0); still record source URL and hash |
| Kenney | GLB/OBJ/FBX; stylised low-poly kits | CC0 | Yes (CC0), but style is game-like |
| Blender bundled Essentials asset library | `.blend` asset library; materials, HDRIs, some models | Blender Foundation assets, CC0 or similar per asset; verify the exact pack at bundling time | Candidate after per-asset verification; `.blend` must be converted to glTF headless |
| Blender Studio / other CC-BY libraries | `.blend`, glTF | CC-BY: attribution required | Yes with attribution; per-item notice in the catalog |
| BlenderKit | Online library through an add-on, per-asset licences (Royalty Free or CC0 depending on asset) | Royalty Free licence permits use in end products but forbids redistributing the assets as an asset library, and downloads are tied to the account | **No** bundling; user-import-only, and only via the user's own account |
| IFC furniture libraries (manufacturer IFC objects, BIMobject-style portals) | IFC with `IfcFurnitureType` + mapped representation | Per-vendor terms, often no redistribution | **User-import-only** |
| bSDD (buildingSMART Data Dictionary) | Classification and property definitions via public API and URIs, e.g. `https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcFurniture` | Data licence is open for referencing; not geometry | Reference URIs/identifiers only; no geometry |

IFC semantics: `IfcFurnitureType` (IFC4) predefined types are BED, CHAIR, DESK, FILECABINET, SHELF, SOFA, TABLE, (TECHNICALCABINET in newer web-ifc builds), USERDEFINED, NOTDEFINED. Items that fit none (a picture frame, a lamp) use USERDEFINED and carry the real meaning as a classification reference. Licences quoted above come from public knowledge and the SH3D files; **each must be re-verified at the moment an asset is actually bundled**, and nothing third-party is bundled in this change.

Rule: a third-party item may be `redistribution: "bundle"` only when its licence allows shipping and its attribution notice is recorded. Anything else is `user-import-only`: the user supplies it at runtime, it is not committed, and it is excluded from release artifacts. The catalog validator rejects bundling of non-commercial licences and requires attribution text for CC-BY/GPL-style licences.

## Decision

### Catalog contract (`schemas/json/furniture-catalog.schema.json`, `@teldra/furniture-catalog`)

An item has: stable slug `id`, `name`, `category`, `tags`; `ifc` (class `IfcFurniture`, `predefinedType`, optional classification references such as bSDD); `dimensions` (explicit metres, local X width / Y depth / Z height, origin at the bottom centre of the bounding box); `mount` (`floor | wall | ceiling`, with a mandatory default elevation for wall/ceiling); `representation` (authored IFC geometry: `box`, or `extrusion` of a footprint); optional `asset` (render model); `materials`; `licence` (SPDX, author, attribution, source URL, redistribution policy). Validation is JSON Schema plus integrity rules (unique ids, footprint inside nominal bounds, simple polygon, attribution and non-commercial rules, safe relative asset path). A catalog is authoring input and never canonical state.

### Asset import pipeline (design, not yet implemented)

For glTF/GLB/OBJ the `asset` block declares what the file does not: `unit` (glTF is metres; OBJ states none, SH3D is cm), `upAxis`, `frontAxis`, `sha256`, and a `dimensionsPolicy`. A converter (a Python tool next to the SH3D importer, headless Blender or trimesh, not in the TypeScript core) normalises to glTF metres Z-up-to-glTF-Y-up via an explicit matrix, measures bounds, and then either verifies them against nominal dimensions (`preserve-source`, fail on mismatch beyond tolerance) or non-uniformly fits to them and records the factors (`fit-nominal`). Output carries provenance (source hash, tool versions, licence) in the existing artifact-provenance schema. SH3D `modelRotation` is applied explicitly. The result is a derived render asset; IFC keeps its own authored geometry, so a broken or missing model never invalidates the building.

### Insertion

`IfcFurnitureEditor.insert(request)` is a canonical command (`ifc.furniture.insert`) on the same processor, snapshot undo and affected-GlobalId log as pose/scale/duplicate/remove. The request carries a validated snapshot of the catalog item (so history replay does not depend on a mutable catalog), the caller's new GlobalId, a world pose in metres, a storey GlobalId and catalog id/version. The ifc-edit adapter `insertFurniture` creates, in one isolated model session, an `IfcFurniture` with its own placement relative to the storey (derived from the world pose), an `IfcProductDefinitionShape` whose `MappedRepresentation` uses an identity `IfcCartesianTransformationOperator3D` (so existing per-instance scaling works), containment in the storey, and `IfcRelDefinesByType` to an `IfcFurnitureType`. The type, its `IfcRepresentationMap`, classification references (`IfcClassificationReference` via `IfcRelAssociatesClassification`), material and a `Teldra_Catalog` property set (catalog id/item/version, mount, licence, nominal dimensions) are created once per catalog item version and shared by occurrences. A same-key type with different nominal dimensions is refused; change the catalog version instead.

### Regeneration (Studio, pending)

Studio's controller wires `insert` into its adapter, builds the request from the selected catalog item plus a placement gesture, and uses the existing affected-GlobalId path: `lastAffectedGlobalIds` names the new element, web-ifc tessellates it from the new IFC bytes (the SweptSolid map is renderable without any asset), and the scene patch adds nodes carrying the IFC GlobalId. When a catalog `asset` is available the derived GLB may replace the tessellated look, always keyed by the same GlobalId. Undo reports the same id, so regeneration removes the instance from the restored bytes.

## Consequences

- Insertion never trusts renderer state or an asset for geometry or identity.
- Catalog licences are machine-checked and surfaced on the type for attribution exports.
- Open work: Studio catalog browser and placement, asset converter, mesh-backed (`IfcTriangulatedFaceSet`) representation for items that must look like their model in IFC viewers, ceiling/wall snapping, a bundled CC0 starter catalog after licence verification.
