# Application layer

The application layer owns use cases and mutations over canonical IFC and twin state.

It may depend on domain contracts, but it must remain independent of Babylon.js, deck.gl, SolidJS, Lit, Blender, Bonsai, and Home Assistant APIs. Renderer interaction enters through commands and projections rather than direct canonical mutation.

## State ownership

`STATE_OWNERSHIP` is the executable lifecycle taxonomy for canonical, live, derived, session, draft, history, renderer, cache, and adapter state.

Only canonical project and canonical IFC state are authoritative for project serialization. Derived caches are explicitly disposable; live, UI/session, draft, renderer, command-history, and connection state are prohibited from canonical serialization.

SolidJS may own view/session and draft stores, but it consumes canonical and live state as read models rather than becoming their authority.

## Canonical commands

`CommandProcessor` is the framework-neutral reference mutation path for canonical project and IFC changes. Commands and transactions are JSON-safe data, transaction application is atomic, inverse commands drive undo/redo, and expected revisions reject stale editors before mutation.

Presentation/session state and physical smart-home commands are rejected from canonical command history by authority classification.
