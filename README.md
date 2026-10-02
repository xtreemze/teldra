# Teldra

Teldra is an open architecture for authoring and operating a BIM-backed smart-home digital twin.

The product combines:

- IFC as the canonical building model.
- A renderer-neutral twin model for devices, capabilities, bindings, and live state.
- Blender/Bonsai for BIM authoring and offline rendering.
- Babylon.js for the interactive physical twin.
- deck.gl for analytical and spatial overlays.
- Home Assistant as the first automation-platform adapter.

Development is starting on a dedicated bootstrap branch. The architecture is intentionally projection-based: canonical building and twin data must not depend on a renderer, UI framework, or automation platform.
