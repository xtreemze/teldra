# Babylon.js runtime

The Babylon runtime will own the interactive physical scene: GLB loading, PBR materials, navigation, picking, animation, dynamic light appearance, and compositing precomputed radiance/reflection data.

It consumes projections and must not mutate canonical IFC or twin data directly.
