# ADR 0018: Smart-home command authorization and safety

Status: accepted

## Context

Teldra may visualize live home state without having authority to operate the physical home. Renderers, embedded surfaces, and Home Assistant panels must never gain ambient device-control authority merely because they can identify or display a device.

Canonical editing commands from ADR 0014 and physical smart-home commands are different authority domains. Undoing a project edit is not equivalent to undoing a physical side effect.

## Decision

All physical smart-home commands cross the application control-policy boundary before an adapter may dispatch them.

The policy evaluates:

1. target: simulation or physical;
2. adapter read/control authority;
3. explicit device control authority;
4. explicit capability control authority;
5. current adapter connectivity;
6. originating surface and session;
7. capability risk;
8. user presence and, for high-risk controls, fresh command-bound confirmation.

A successful physical authorization produces a short-lived logical command lease. The adapter must revalidate that lease immediately before the external side effect.

No renderer or UI component may call Home Assistant service APIs directly.

## Safe defaults

Adapter discovery or binding does not grant physical control.

A newly discovered/mapped device may be visible when adapter read authority exists, but physical control remains denied until both its device and capability scopes explicitly grant control.

Adapter-level `control: true` is necessary but never sufficient.

## Simulation

Simulation/preview does not issue an external side effect.

Simulation requires read authority so a surface cannot use simulation as a way to expose a home it is not permitted to view. It does not require adapter connectivity or physical control grants.

Simulation state remains session/preview state and cannot be confused with observed physical state.

## Risk

The initial conservative capability risk policy is:

- light, media, switch, sensor: low;
- climate: elevated;
- opening: high.

Elevated physical actions require active user presence in the authorized session.

High-risk opening actions require both active presence and a fresh confirmation bound to the exact command ID. Confirmations have explicit issue/expiry timestamps and cannot be reused for another command.

Future capability/action-specific policy may refine this, but may not silently weaken an existing risk level.

## Origin and session boundary

A command identifies both its surface and session.

Supported origin classes are Studio, Lit embed, Home Assistant panel, CLI, and automation. A session explicitly lists which origins may issue physical commands.

Embedding a Lit component, rendering a Babylon/deck.gl object, or selecting a device does not add the corresponding origin to an authorized session.

This prevents render interaction such as click/pick/drag from becoming an implicit physical command.

## Lease revalidation

A lease captures:

- authority revision;
- adapter connection revision;
- command/correlation identity;
- risk;
- issue time.

Immediately before dispatch, the adapter revalidates the lease.

If authority or connection revision changed, dispatch is denied. The caller must request fresh authorization rather than assuming the old decision remains valid.

## Mid-command loss

After an external side effect may already have been dispatched, authority revocation or connectivity loss makes the physical outcome unknown until new observation resolves it.

Teldra must not automatically retry such a command, especially an opening/climate action. The live-state layer continues observing acknowledgements and physical state independently.

## Audit and diagnostics

Authorization decisions use ADR 0017 correlation IDs.

Audit diagnostics may include:

- target;
- adapter kind;
- capability kind;
- risk;
- allow/deny reason;
- command/correlation identity;
- project-private canonical device/capability/session identifiers.

Private identifiers are sensitivity-labelled and pseudonymized in exported support bundles. Credentials are never audit fields.

## Relationship to canonical history

Physical commands:

- are not canonical project mutations;
- are not added to application undo/redo history;
- do not modify IFC or twin configuration;
- may publish desired-state/live envelopes;
- may share correlation IDs with a user workflow.

A UI “undo” action must never be translated into an inverse physical device command unless a future explicit physical-control workflow independently authorizes that new command.

## Consequences

- Home Assistant can be implemented as an adapter behind one deterministic safety contract.
- newly discovered devices are read-only by default;
- renderer and embedded UI interactions cannot bypass application authorization;
- loss of authority/connectivity is deterministic before dispatch and conservative after dispatch;
- #35 diagnostics can correlate authorization, adapter dispatch, acknowledgement, and observation without secrets.
