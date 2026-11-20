# Renderer maturity and execution plan

Status: incremental execution; no commercial-parity or whole-device certification claim.
Updated: 2026-11-20. Delivery parent: #80. Browser certification: #72 and PR #174.

## Outcome and authority

The renderer must open source projects faithfully, keep navigation and edits responsive,
and survive resource/lifecycle changes without losing identity or changing canonical data.
IFC and application commands remain authoritative. Babylon meshes, GPU resources,
frame state, lighting previews and diagnostics remain disposable projections (ADRs
0001, 0002, 0009, 0011 and 0013). Retain the current adapter rather than start a rewrite.

The black-floor incident established an important boundary: valid source images and
ready material bindings do not prove populated GPU mip levels. PR #115 fixed a
warm-up render submitted after its swapchain texture expired. Its evidence is a
reproduced GPU validation failure, direct before/after mip reads and rendered pixels,
not exposure adjustment. Desktop NVIDIA WebGPU evidence does not certify Android.

## Ordered work and acceptance

| Phase | Work and owner boundary | Acceptance and dependency |
| --- | --- | --- |
| 1. Resource correctness | Runtime adapter owns frame submission, load/stop/dispose, GPU captures and reconstruction. First slice: submesh/UV-aware diagnostics, resize/recreation regression and a WebGPU-required execution command. | Actual mip contents and validation errors checked through load/resize/recreation; missing adapters fail the required tier. Next: #178 deterministic initialization/context/device-failure fixtures before choosing recovery/fallback behavior. No GPU objects survive reconstruction. |
| 2. Material fidelity | Source producer plus source-material/texture adapter; #123 and #135. Keep tagged legacy Phong and ordinary glTF PBR contracts distinct. | Authored fixtures cover sRGB color/emission, linear normal/roughness/metallic data, alpha/vertex colors, shared texture lifetime, UV sets/transforms, repeat/NPOT, mipmaps and anisotropy on WebGL2 and WebGPU. Portable radiance remains linear-sRGB per ADR 0009. |
| 3. Grounded illumination | Lighting projection and derived lighting producer; #123 and #134. | Establish fixed exposure/color references, occlusion and open/closed-window fixtures, then implement bounded daylight/environment and shadow behavior. Existing directional/ambient preview and shadow-detail curves are not indirect-light or photometric-parity evidence. New derived lighting inputs carry provenance and invalidate affected caches. |
| 4. Editing and visible identity | Shared selection/gizmo projection and IFC command owners; #82, #88, #90 and #127. | Controlled overlapping/culling/transparency and batched/submesh fixtures; numeric/gizmo/touch changes commit through IFC commands with cancel, undo and reopen invariants. CPU picks are labeled separately from rasterized fragments. Consider raster ID picking only after measuring the unresolved mismatch and cost. |
| 5. Release quality | Quality/reference-harness owners; #72, #73, #74 and #80. | Source-bound, browser/device/backend-specific reports, reference-home performance and usability evidence, and explicit passed/failed/not-tested results. Integrate execution evidence with PR #174's report contract; do not duplicate its release gate. |

Phases overlap only on disjoint files and stable contracts. Phase 1 correctness is a
prerequisite for interpreting material, lighting or performance results. Schema,
producer and shared runtime integration have one owner per PR.

## Immediate task packets

1. **Probe accuracy (Terra execution, renderer maintainer integration):** resolve the
   selected submesh's material and its explicit UV set through shared helpers used
   by both the CPU description and GPU capture. Reject invalid faces, absent UVs
   and unsupported mapping; label a center reference instead of inventing a hit UV.
   Regression: two submaterials with differing UV0/UV1 and invalid face/submesh cases.
2. **GPU execution evidence (Luna execution):** preserve a portable test suite with
   explicit skips and provide a separate required-WebGPU command whose missing
   adapter is a failure. Exercise resizing during/after load and fresh renderer
   creation; record actual texture allocation, mip contents and validation errors.
   This certifies those scenarios, not forced device loss or in-place project swaps.
3. **Integration (coordinator):** use the same material/UV resolver in the runtime,
   run typechecks/unit/browser tests, and validate the final PR head. Keep PR #174's
   source-bound release report and this test runner separate. No synthetic test
   result may be promoted to a physical-device certification row.

## Evidence and budget contract

`quality/budgets.json` owns numeric targets: desktop/mobile frame time 16.7/33.3 ms,
selection and camera input p95 50 ms, cached/cold desktop startup 2/5 seconds and
cached mobile startup 4 seconds. The reference scale is 10,000 render nodes; asset
limits include a 25 MiB reference GLB, 64 MiB compressed textures and 4096-pixel
single-texture dimensions. Measure the named fixture, device, viewport, source
commit and source hashes before enforcing a threshold. Record an exceeded budget
rather than silently increasing it or treating a CPU-frame statistic as GPU time.

A mature release needs all of:

- Deterministic authored fixtures and failure cases, plus real project visual checks.
- A WebGPU-required run and WebGL2 fallback evidence; skipped tests are not passes.
- Reference-workload p50/p95 measurements with a declared measurement method.
- Real Android and Safari/device execution, separate from desktop Chromium signals.
- Source-bound certification and retained evidence under #72 / PR #174.
- Canonical identity, project hashes and undo/persistence invariants across recovery.

Issue #100 is currently closed in GitHub; its historical comments do not themselves
supply Android certification. Track remaining platform evidence under #72 and #80.
No UX score or commercial-standard claim follows solely from a green build.

## Next bounded PRs

After the first slice, implement #178 initialization failure and context/device recovery
as a renderer-state contract with deterministic failure injection. Preserve canonical
selection/edit state while rebuilding resources or explicitly reporting failure.
Then certify the material matrix before adding environment/window transport. Keep
performance instrumentation in #73 and actual platform execution in #72, with each
result linked to the source-bound report rather than a parallel checklist.

## Running the required-WebGPU slice

Build Studio Storybook, then run:

```powershell
$env:TELDRA_BROWSER_EXECUTABLE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
pnpm --filter @teldra/studio renderer:webgpu:certify
```

The executable override is optional when the bundled Chromium has a usable adapter.
The command runs report-validator tests, builds a fresh isolated Storybook bundle,
and starts an owned server on a temporary port. It sets `TELDRA_REQUIRE_WEBGPU=1`,
so WebGL fallback is a failed assertion,
not a skip. The portable Storybook suite continues to label unavailable WebGPU
explicitly. This slice checks GPU mips, bounded probe correspondence and renderer
resize/recreation; it is not whole-device release certification.

The Playwright JSON report is written to
`apps/studio/test-results/renderer-webgpu-certification.json`. Metadata names the
synthetic-regression scope, required backend, source commit and whether the worktree
was dirty, and whether the bundle was freshly built. An old report is removed
before execution. Zero-test, skipped, flaky and expected-failure results fail the
execution validator even if the browser test process exits successfully. Use the attached mip/capture
reports as execution evidence; do not copy a dirty-worktree synthetic pass into a
physical-device row in PR #174's release report. An owned hardware runner and its
required CI/release integration remain work under #72.
