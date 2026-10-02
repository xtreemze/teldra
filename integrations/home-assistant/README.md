# Home Assistant integration

Home Assistant is Teldra's first automation-platform adapter.

The adapter maps platform entities onto renderer-neutral Teldra capabilities. For example, `light.kitchen` is an external binding for a canonical Teldra device; it is never the canonical device ID.

The integration will eventually provide live state, commands, discovery assistance, and a Home Assistant panel/viewer while keeping Home Assistant APIs outside the domain layer.
