# Home Assistant integration

Home Assistant is Teldra's first automation-platform adapter.

The adapter maps platform entities onto renderer-neutral Teldra capabilities. For example, `light.kitchen` is an external binding for a canonical Teldra device; it is never the canonical device ID.

The integration will eventually provide live state, commands, discovery assistance, and a Home Assistant panel/viewer while keeping Home Assistant APIs outside the domain layer.

## Physical command boundary

The adapter may observe live state whenever read authority permits it, but it must not dispatch a physical service call directly from renderer or UI interaction.

Every physical command must arrive with an application-issued control lease from `@teldra/control-policy`, and that lease must be revalidated immediately before the Home Assistant side effect. A newly discovered device is read-only until adapter, device, and capability control grants are all explicit.

If authority or connectivity changes after a command may already have been sent, the outcome is treated as unknown and is not automatically retried. Credentials remain host-secure runtime data and never enter project files, audit events, or support bundles.
