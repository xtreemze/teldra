# ADR 0005: Spatial units, frames, and renderer transforms

Status: accepted

## Problem

Teldra crosses IFC, IfcOpenShell, Blender, glTF, Babylon.js, deck.gl, imported Sweet Home 3D projects, and potentially georeferenced building models. Their coordinate conventions must never be treated as implicitly equivalent.

## Decision

- Architectural placement remains authoritative in IFC.
- Teldra projection-space distances are expressed in metres.
- Teldra projection-space angular values are expressed in radians.
- The canonical local architectural frame is right-handed and Z-up.
- Imported source coordinates and georeferencing/provenance are preserved rather than destructively normalized away.
- Every conversion between canonical/project space and a transport/runtime space is explicit and tested.
- glTF/GLB output follows its transport conventions; the scene manifest records the transform back to canonical coordinates and identity.
- Babylon.js and deck.gl consume explicit projection transforms.
- Floating origins, camera-relative rendering, clipping, level isolation, and geographic visualization are presentation state and never mutate IFC placement.
- Blender uses an explicit adapter; a `.blend` scene is not an alternate architectural authority.

## Precision

Large or georeferenced coordinates must not be fed blindly into GPU-local scenes. Runtime rebasing/local frames may be used for numerical stability, but canonical mapping must remain sufficiently exact for identity, measurement, selection, and persisted edits.

## Required tests before the first renderer slice

1. known IFC placement maps to expected Teldra projection coordinates;
2. derived GLB maps back to the same canonical identity and placement;
3. Babylon picking resolves to the canonical object;
4. deck.gl overlays align to the same canonical space;
5. runtime origin shifts leave canonical coordinates unchanged;
6. SH3D fixtures prove source-to-canonical transforms separately.
