# ADR 0011: Supported platforms and product quality budgets

Status: accepted

## Decision

Teldra uses a rolling modern-browser support policy. Release certification targets current browser channels rather than permanently pinning a browser major in architecture documentation. CI and release manifests pin concrete versions for reproducibility.

Babylon.js is WebGPU-preferred with WebGL2 fallback. Babylon maintains both engines side by side, so WebGPU capability is an enhancement rather than a project-file compatibility boundary.

deck.gl remains WebGL2 in the production baseline while deck.gl itself classifies its v9 WebGPU path as experimental. A future ADR may promote deck.gl WebGPU after its upstream production-readiness contract changes and Teldra has parity tests.

The machine-readable authority for numeric targets is `quality/budgets.json`.

## Browser support

Release certification covers:

- Chrome: current and previous stable major on desktop.
- Edge: current Stable and current Extended Stable where applicable.
- Firefox: current stable.
- Safari: current major on macOS and current iOS/iPadOS.
- Chrome for Android: current stable.

A browser may use Babylon WebGL2 fallback when WebGPU is unavailable or fails capability checks. A project must not serialize different canonical meaning based on graphics backend.

Playwright Chromium is the minimum PR browser gate. Firefox and WebKit are planned CI signals, but WebKit automation is not treated as equivalent to real Safari release certification.

## Accessibility

The application target is WCAG 2.2 AA.

Critical operations exposed through the 3D viewport require a keyboard-accessible equivalent. Pointer targets must not fall below 24 CSS px; 44 CSS px is the preferred touch target where density permits. Reduced-motion behavior is required for non-essential movement and transitions.

The 3D scene is not an excuse for inaccessible application controls: selection, object inspection, device operation, layer control, and navigation must have semantic UI pathways.

## Performance philosophy

Budgets are defined around a reference smart home rather than empty-scene microbenchmarks.

A release must remain usable as model complexity, live capabilities, and analytical data increase. Performance work must preserve canonical identity, spatial correctness, and accessible alternatives; dropping semantics to hit frame rate is not an acceptable optimization.

The target interactive cadence is approximately 60 Hz on reference desktop hardware and 30 Hz on reference mobile hardware. Frame-time budgets and p95 input/state latency are recorded in the machine-readable policy.

## Asset budgets

Application shell, renderer chunks, GLB, compressed textures, and maximum texture dimensions have separate budgets. This deliberately prevents a photorealistic asset pipeline from hiding unlimited download or GPU-memory growth behind application bundle metrics.

Derived assets may be quality-scaled for a device profile, but every variant must resolve to the same canonical identities.

## Enforcement stages

Budget enforcement is progressive:

1. policy shape is a hard CI gate immediately;
2. asset limits become hard when build metrics are emitted deterministically;
3. interaction/startup limits become hard when the reference browser harness exists;
4. large-home scale is a release-certification gate.

A threshold may only be relaxed with measured evidence and an architecture/performance review; normal feature work should not silently raise budgets.

## Reference environment

Reference hardware profiles and exact browser versions belong in release/test manifests rather than this ADR. This keeps the architectural policy stable while allowing hardware to evolve.

A release report should record at minimum:

- browser and graphics backend;
- OS and hardware class;
- viewport/device-pixel ratio;
- project/asset hashes;
- renderer versions;
- median and p95 frame/input/startup results;
- peak measured memory where the platform exposes a reliable metric.


## Executable browser/device certification

`quality/browser-certification.json` is the versioned, deliberately untested matrix template.
Its rows derive from the rolling release tiers in `quality/budgets.json`; a change to
those tiers requires regenerating the baseline. The two result columns are the
Babylon.js WebGL2 and WebGPU paths, not deck.gl WebGPU support.

Run the following from the immutable release checkout:

```sh
node tools/quality/check-browser-certification.mjs --template > /tmp/teldra-browser-report.json
pnpm browser:certification
TELDRA_BROWSER_CERTIFICATION_REPORT=/tmp/teldra-browser-report.json pnpm browser:certification --release
TELDRA_BROWSER_CERTIFICATION_REPORT=/tmp/teldra-browser-report.json pnpm release:check --release
```

Keep completed reports and their referenced traces/screenshots with the release
evidence outside the source checkout; committing evidence back to the tested
release commit would change its identity. The gate checks the report against the
checkout's exact Git SHA. Normal quality CI validates the report shape and
reports blockers without pretending that untested devices passed. Release mode
rejects stale, incomplete, failed or malformed certification.

For every browser/channel/platform row, exercise WebGL2 and WebGPU on reference
hardware. Record the real browser and OS versions, device class/model and GPU,
renderer version, viewport and DPR, test timestamp, reference project SHA-256,
and a reference to the retained evidence. A result may be `not-tested`,
`pass`, `fail` or (WebGPU only) `unavailable` with a documented capability
probe. Do not report WebGPU initialization regressions as unavailability.
A WebGPU waiver does not waive the WebGL2 fallback result.

The evidence checks are reviewer attestations, not inferred from the user agent.
Use `kind: "real-browser"` only for testing in the actual release browser on
appropriate reference hardware; Playwright Chromium, WebKit, device emulation
and synthesized input are useful regression signals, but are not device
certification. Record navigation, canonical editing (including save/reopen),
accessibility and performance check outcomes. Android, iOS and iPadOS additionally
require physical touch, visual/haptic/audio feedback and PWA scenarios. In
particular verify long press, multi-contact cancellation, orientation and
safe areas, software keyboard and sheet behavior, reduced motion, screen
reader operation, and optional feedback disabled/unavailable paths. An
unsupported vibration API is not a failure if the visual alternative works.

For passing results, record metrics in milliseconds except interactive FPS:
`frameMedianMs`, `frameP95Ms`, `selectionP95Ms`, `cameraInputP95Ms`,
`liveStateToVisualP95Ms`, `cachedStartupMs`, `interactiveFps`, and
`coldStartupMs` on desktop. Frame median is compared with the frame-time
target; p95 is retained for tail-latency review. The gate compares measured
values to the existing budgets, including the minimum interactive FPS.
Retain the workload and measurement method (including cache conditions and
sample counts) in the referenced evidence so results can be independently reviewed.

This contract validates submitted evidence metadata and budget results; it
does not collect physical-device measurements, authenticate the underlying
traces, or replace human accessibility review. Cross-engine automated CI,
the reference workload measurement harness and actual device execution remain
separate certification work.
