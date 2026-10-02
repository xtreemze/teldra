# Application layer

The application layer will own use cases and mutations over canonical IFC and twin state.

It may depend on domain contracts, but it must remain independent of Babylon.js, deck.gl, React, Blender, Bonsai, and Home Assistant APIs. Renderer interaction enters through commands and projections rather than direct canonical mutation.
