# ADR 0010: Live twin state, commands, and time

Status: accepted

## Decision

Persistent twin configuration and live runtime state are separate authorities.

`twin.json` defines devices, capabilities, and external bindings. Live observations, availability, desired state, and command acknowledgements use the versioned Teldra live-envelope contract and are not persisted into the project model by default.

Home Assistant, Matter, MQTT, KNX, and future integrations translate their native state/events into these platform-neutral envelopes.

## Four distinct concepts

### Observed state

An observation is a source-reported fact about one canonical capability at a source time.

It includes:

- canonical device and capability IDs;
- adapter/stream identity;
- optional persistent binding identity;
- source observation time;
- Teldra receive time;
- optional source sequence;
- normalized values.

Only observations update observed capability values.

### Desired state

Desired state records what the application/user is asking a capability to become. It is associated with a command ID and may be presented optimistically.

Desired state never silently overwrites observed state.

An optimistic UI may display desired values while a command is pending, but must preserve enough state to distinguish them from observed values and reconcile on observation, rejection, failure, or timeout.

### Command acknowledgement

An acknowledgement describes adapter/transport lifecycle:

- accepted;
- rejected;
- completed;
- failed.

A completed acknowledgement does not itself prove that the physical device reached the requested state. Observed truth still comes from a subsequent observation unless an adapter can produce an authoritative observation separately.

### Availability

Availability is separate from capability values:

- `online`: source/device reports reachable;
- `offline`: source/device reports disconnected;
- `unavailable`: the target exists but its current value cannot be supplied;
- `unknown`: no stronger claim is available.

`stale` is not serialized as availability. Staleness is derived from the age of the last accepted observation and a capability/application freshness policy.

## Time and ordering

`observedAt` is the source event time.

`receivedAt` is when Teldra accepted the envelope from the adapter boundary.

Adapters should provide monotonically increasing `sequence` values when their source protocol exposes a suitable ordering signal. Sequence ordering applies only inside the same `streamId`.

For two observations of the same capability from the same stream:

1. higher sequence wins when both have a sequence;
2. otherwise later `observedAt` wins;
3. `receivedAt` is a deterministic final tie-breaker.

An older/out-of-order envelope may remain useful for history but must not replace newer current state.

`eventId` is the deduplication identity. Replaying the same event ID must not apply the state transition twice.

## Normalized values

Live values are typed transport values rather than Home Assistant attributes:

- boolean;
- number, optionally carrying an explicit unit;
- text;
- normalized linear RGB triplet in the range 0..1.

Capability-specific field names and units are defined by Teldra capability semantics, not by external adapter attribute names.

Examples:

- light: `power`, `brightness` (ratio), `color` (RGB);
- opening: `position` (ratio);
- environmental sensor: `temperature` (explicit unit), `humidity` (ratio);
- media: `playback` (text state), `volume` (ratio).

Adapters are responsible for converting external values into the canonical unit/value form before emitting observations.

## History boundary

The live envelope is suitable as an event/history record, but the in-memory current-state reducer and a future history store are separate concerns.

History storage may retain out-of-order and superseded observations. Current state uses ordering rules to choose the latest accepted observation.

## Lighting integration

The baked-lighting runtime consumes canonical light capability state. For example, a normalized brightness/color observation may drive the corresponding fixture-group radiance contribution.

The lighting manifest never contains Home Assistant entity IDs and live-state envelopes never contain Babylon material/texture objects.
