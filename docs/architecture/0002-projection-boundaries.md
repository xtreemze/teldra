# ADR 0002: Renderer-neutral projections

Status: accepted

## Decision

Canonical domain and application code must not depend on rendering libraries.

The first released visualization architecture has three downstream surfaces:

- Babylon.js: physical building presentation, PBR materials, navigation, picking, animation, and interactive lighting.
- deck.gl: analytical layers such as temperature, air quality, RF coverage, energy, occupancy, topology, and historical spatial data.
- Blender/Cycles: offline reference rendering, light baking, and reflection-probe generation.

A renderer-neutral TwinProjection and LightingProjection are the contracts between application state and these surfaces.

## Initial composition strategy

Babylon.js and deck.gl synchronize camera and picking through an application-level compositor. They do not initially share GPU devices or render passes. This keeps deck.gl WebGPU evolution isolated from the physical renderer.

## Prohibited dependencies

The domain, application, and projection packages may not import Babylon.js, deck.gl, React, Blender bpy, Bonsai, or Home Assistant APIs.
