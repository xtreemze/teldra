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
