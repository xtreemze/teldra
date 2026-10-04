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
