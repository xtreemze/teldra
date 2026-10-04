# ADR 0017: Diagnostics, structured logging, and support bundles

Status: accepted

## Context

Teldra crosses browser UI, application commands, IFC/import/export, Babylon.js, deck.gl, Blender/Cycles, and smart-home adapters. Failures may cross several runtimes before surfacing to the user.

Diagnostics must make those paths traceable without turning logs or support bundles into an alternate copy of a private home, credentials, or canonical project state.

## Event contract

All structured diagnostics use the versioned diagnostic-event schema.

Each event has:

- stable event ID;
- RFC3339 timestamp;
- level: debug, info, warn, or error;
- subsystem;
- stable machine-readable code;
- correlation ID;
- optional operation ID;
- optional safe user-facing message;
- optional diagnostic detail;
- explicitly classified structured fields.

Subsystem identifiers are fixed for the first contract: application, project-format, IFC, SH3D import, projection, scene export, Babylon, deck.gl, Blender, bake, Home Assistant, live state, persistence, security, and unknown.

## Correlation

A correlation ID follows one logical operation across subsystem boundaries.

Examples:

- Studio canonical command -> IFC application -> projection -> Babylon redraw;
- SH3D import -> IFC creation -> scene export -> GLB load;
- user device action -> authorization -> Home Assistant adapter -> desired state -> acknowledgement -> observed state.

Operation IDs may identify one step within the larger correlation.

Raw IDs are not exported in support bundles. Correlation IDs and operation IDs are deterministically pseudonymized per bundle so related events remain joinable.

## User-facing errors versus diagnostic detail

`userMessage` is suitable for direct display and must not contain credentials, external platform identifiers, full filesystem paths, precise addresses, or unrelated personal information.

`detail` is for engineering diagnosis but must obey the same rule: sensitive values belong in structured fields so redaction is deterministic.

User messages describe what failed and the next meaningful action. Structured fields carry technical state.

## Sensitivity model

Every diagnostic field declares exactly one sensitivity:

- **public** — product/runtime facts safe to export, such as subsystem, capability kind, browser family, renderer backend;
- **project-private** — home/project identity, canonical IDs, external entity IDs, local paths, coordinates, room/device names, hashes that identify a private project;
- **secret** — access tokens, refresh tokens, passwords, private keys, cookies, authorization headers, API keys.

Support-bundle export:

- preserves public field values;
- replaces project-private values with deterministic salted pseudonyms;
- replaces secret values with `<redacted>`.

Secret-like field names are rejected unless classified `secret`. This is a defensive check, not permission to place secrets in free-form messages.

## Support bundle

A support bundle is diagnostic evidence, not a project backup. It contains:

- application version and source commit;
- toolchain-manifest SHA-256;
- runtime/browser/OS summary;
- renderer backend;
- pseudonymized project fingerprint and format version;
- adapter kind/status and non-secret capability summary;
- sanitized structured diagnostic events.

It does not contain:

- IFC;
- `twin.json`;
- Home Assistant tokens or cookies;
- raw canonical or external IDs;
- raw project fingerprints;
- arbitrary user files;
- camera history or unrelated browsing/system history.

The pseudonymization salt is generated per exported bundle and is not itself required in the bundle. The purpose is correlation inside one support artifact, not stable cross-bundle tracking.

## Logging levels

Logging level changes diagnostic volume only. It must never change canonical behavior, adapter command behavior, timing semantics required for correctness, or project persistence.

- error: failed operations requiring attention;
- warn: degraded behavior or recoverable fallback;
- info: lifecycle milestones and state transitions;
- debug: bounded technical detail useful for reproduction.

Debug mode must not disable redaction.

## Runtime hooks

Each runtime exposes diagnostics through a small adapter/hook rather than importing UI state:

- application commands: transaction/correlation/command identifiers and revision outcome;
- IFC/import/export: source/output hashes, operation stage, validation outcome;
- Babylon/deck.gl: backend, projection identity, picking/render failures, device-loss/fallback state;
- Blender/bake: exact producer/toolchain versions, bake-settings hash, artifact provenance;
- Home Assistant: adapter status, capability kind, normalized command/ack state; never token or raw credential material.

## Consequences

- #33 can reuse correlation IDs and sanitized diagnostics at the physical-command authorization boundary.
- support requests can correlate import, projection, renderer, and adapter failures without receiving a user's canonical home model.
- debug logging becomes safer because field sensitivity is explicit and tested.
- diagnostics remain application/runtime evidence rather than a new source of truth.
