# ADR 0001: Canonical authority layers

Status: accepted

## Decision

Teldra has two persistent authority layers:

1. IFC owns architectural geometry, spatial relationships, and architectural identity.
2. The Teldra twin document owns smart-home device identity, capabilities, external-system bindings, and runtime semantics.

A project manifest binds these authorities together and hashes their serialized artifacts.

## Consequences

Blender files, glTF/GLB exports, lightmaps, reflection probes, Babylon scene objects, deck.gl layers, GPU buffers, camera state, and Home Assistant state snapshots are derived. They may be cached but must be reproducible or replaceable.

The initial IFC authoring baseline is IFC4. Support for newer IFC schemas may be added through explicit compatibility and migration work.

External platform IDs never replace Teldra canonical IDs or IFC GlobalIds.
