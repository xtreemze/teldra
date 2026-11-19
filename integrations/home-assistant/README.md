# Home Assistant integration

Home Assistant is Teldra's first automation-platform adapter.

The adapter maps platform entities onto renderer-neutral Teldra capabilities. For example, `light.kitchen` is an external binding for a canonical Teldra device; it is never the canonical device ID.

## Implemented read path

`@teldra/home-assistant` implements the first runtime adapter slice:

- authenticated Home Assistant WebSocket handshake;
- initial `get_states` snapshot;
- `subscribe_events` for `state_changed`;
- explicit `adapter: "home-assistant"` binding resolution;
- light power/brightness/RGB normalization into Teldra live observations;
- online/unavailable/unknown availability envelopes;
- adapter-local stream ordering;
- privacy-classified diagnostics;
- no physical service-call surface.

The host supplies the WebSocket object and access token at runtime. Credentials are not retained in canonical project data, live envelopes, diagnostics, or support bundles.

## Physical command boundary

The adapter may observe live state whenever read authority permits it, but it must not dispatch a physical service call directly from renderer or UI interaction.

Every future physical command must arrive with an application-issued control lease from `@teldra/control-policy`, and that lease must be revalidated immediately before the Home Assistant side effect. A newly discovered device is read-only until adapter, device, and capability control grants are all explicit.

If authority or connectivity changes after a command may already have been sent, the outcome is treated as unknown and is not automatically retried. Credentials remain host-secure runtime data and never enter project files, audit events, or support bundles.

## Discovery, operating modes and sync

`createHomeAssistantSyncSession` is the adapter-side sync foundation. No renderer or Studio component talks to Home Assistant directly; they receive `HaSessionEvent`s.

- **Discovery** reads `config/area_registry/list`, `config/device_registry/list`, `config/entity_registry/list` and `get_states`, then normalizes a light inventory: areas, lights (entity area overrides device area), light groups (lights exposing an `entity_id` attribute), and scenes as a read-only list. Discovery never grants control (ADR 0018).
- **Capabilities** per light come from `supported_color_modes`, `color_mode`, `min/max_color_temp_kelvin`, `effect_list`, brightness and `supported_features` (transition). `validateLightRequest` clamps out-of-range values, rejects unsupported features and unknown effects, and drops transition when unsupported.
- **Modes**: `simulation` (default; in-memory `SimulatedHomeAssistant`, no transport is ever created), `live-monitor` (read-only: the client guard refuses `call_service` and any non-read message type, and `sendLightCommand` throws), `live-control` (requires an adapter control grant at construction and an ADR 0018 lease per command, revalidated when the call is actually transmitted).
- **Reconnect** uses exponential backoff with jitter and a full registry and state reconciliation on every (re)connect. A rejected token is never retried. A command whose outcome became unknown on disconnect is never retried; commands waiting in the throttle lane are dropped.
- **Echo suppression**: context ids returned by Teldra service calls are remembered; matching `state_changed` events are labeled `teldra-echo`, others `external`. Events that race ahead of the call result are held until it arrives. State older than what is held (by HA `last_updated`) is ignored.
- **Throttling**: per-entity minimum spacing; bursts coalesce to the latest command.
- **Adaptive Lighting**: `switch.adaptive_lighting_*` main switches are detected read-only; lights they cover report `adaptiveLighting.mayBeOverridden`.

Tests use `test/support/fake-home-assistant-server.ts`, a deterministic in-memory fake WebSocket server with synthetic entity ids only.
