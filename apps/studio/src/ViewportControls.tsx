import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { BabylonTwinRuntime, ViewDirection, ViewState } from "@teldra/runtime-babylon";
import { studioBuildLabel } from "./studio-build";
import { StudioIcon } from "./StudioIcon";

export function ViewportControls(props: {
  runtime: BabylonTwinRuntime;
  canvas: HTMLCanvasElement;
  selectedId?: string | undefined;
  hasHiddenSourceContent?: boolean;
  hiddenSourceVisible?: boolean;
  onHiddenSourceVisibilityChange?: (visible: boolean) => void;
}) {
  const [view, setView] = createSignal<ViewState | null>(props.runtime.viewState());
  const layerDefinitions = props.runtime.layers();
  const [layers, setLayers] = createSignal(layerDefinitions);
  const directions = ["+x", "-x", "+y", "-y", "+z", "-z"] as const;
  const [appearance, setAppearance] = createSignal(props.runtime.appearance());
  const [message, setMessage] = createSignal("");
  const [mobileViewOpen, setMobileViewOpen] = createSignal(false);
  const [probeArmed, setProbeArmed] = createSignal(false);
  const [surfaceProbe, setSurfaceProbe] = createSignal<ReturnType<BabylonTwinRuntime["inspectSurfaceAt"]>>(null);
  const [gpuEvidence, setGpuEvidence] = createSignal<Awaited<ReturnType<BabylonTwinRuntime["inspectGpuAt"]>> | null>(null);
  const [gpuReading, setGpuReading] = createSignal(false);
  const [probeRequest, setProbeRequest] = createSignal(0);
  const armSurfaceProbe = () => {
    setProbeRequest(probeRequest()+1);
    setGpuReading(false);
    setSurfaceProbe(null);
    setProbeArmed(true);
    setGpuEvidence(null);
    setMobileViewOpen(false);
    setMessage("Tap the dark floor once to identify the visible surface.");
  };
  const surfaceProbeDetails = () => {
    const p=surfaceProbe();
    return p ? [
      `CPU-picked object: ${p.canonicalId ?? "(unmapped)"}`,
      `Mesh: ${p.mesh}`,
      `Material: ${p.material ?? "(none)"} (${p.materialType ?? "unknown"})`,
      `Image: ${p.texture ?? "(no texture)"}; ready: ${p.textureReady}`,
      `Sampler: ${p.samplingMode ?? "none"}; anisotropy: ${p.anisotropy ?? "none"}`,
      `UV: ${p.uv?.join(", ") ?? "unavailable"}`,
      `Distance: ${p.distanceMetres} m`,
      `Diffuse: ${p.diffuseRgb?.join(", ") ?? "unavailable"}`,
      `Source Kd: ${p.originalKd?.join(", ") ?? "unavailable"}`,
      `Normal: ${p.worldNormal?.join(", ") ?? "unavailable"}`,
    ].join("\n") : "";
  };
  const gpuProbeDetails = () => {
    const result=gpuEvidence();
    if (!result) return "";
    const rgb=(p:readonly number[]|null)=>p ? p.join(", ") : "unavailable";
    return [
      ...(result.capture ? [
        `Captured ${result.capture.backend} ${result.capture.framebufferFormat}; pixel ${result.capture.pixel.join(", ")}; render ${result.capture.renderSize.join(" × ")}`,
        `Floor sampling: ${result.capture.floorMinification}; unlit: ${result.capture.floorTextureInspection}; light: ${result.capture.lightGain}; shadow detail: ${result.capture.shadowDetail}`,
        `Scene manifest SHA-256: ${result.capture.declaredSceneSha256}`,
        `Source building SHA-256: ${result.capture.declaredBuildingSha256}`,
        `Texture hardware sRGB: ${result.capture.textureSrgbStorage ?? "unknown"}`,
      ] : []),
      `GPU framebuffer RGB: ${rgb(result.framebufferRgb)}`,
      ...(result.framebufferError ? [`Framebuffer readback: ${result.framebufferError}`] : []),
      `GPU floor texture size: ${result.textureSize?.join(" × ") ?? "no texture at picked surface"}`,
      `Mip allocation: ${result.mipAvailability ?? result.mipAvailabilityError ?? "unavailable"}`,
      ...result.mips.map(level =>
        `Mip ${level.level} (${level.size.join(" × ")}; ${level.sampleLocation ?? "reference"} at ${level.coordinates?.join(", ") ?? "unknown"}): RGB ${rgb(level.rgb)}${level.error ? " — " + level.error : ""}`),
      "Mip readings are raw single texels, not filtered screen colors or measured shader LOD. Compare the same surface/UV and capture settings. A black texel or unavailable readback alone does not establish corruption.",
    ].join("\n");
  };
  const copyGpuReport = async () => {
    const result = gpuEvidence();
    if (!result || gpuReading()) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({schemaVersion:1, ...result}, null, 2));
      setMessage("GPU diagnostic report copied");
    } catch { setMessage("Copy unavailable; select the diagnostic text to copy it."); }
  };
  const orient = (direction: ViewDirection) => props.runtime.orient(direction);
  const fit = (selection = false) => setMessage(props.runtime.fit(selection ? props.selectedId : undefined)
    ? (selection ? "Selection framed" : "Visible scene framed") : "No visible geometry to frame");
  onMount(() => {
    const unsubscribe = props.runtime.onViewChanged(setView);
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const arrows: Record<string, [number, number]> = {
        arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, 1], arrowdown: [0, -1],
      };
      const numpad: Record<string, [number, number]> = {
        Numpad4: [-1, 0], Numpad6: [1, 0], Numpad8: [0, 1], Numpad2: [0, -1],
      };
      const direction = arrows[key] ?? numpad[event.code];
      if (direction) {
        const [x, y] = direction;
        if (event.shiftKey) props.runtime.pan(x, y);
        else props.runtime.orbit(x * 0.15, -y * 0.15);
      } else if (key === "+" || key === "=" || event.code === "NumpadAdd") props.runtime.zoom(0.8);
      else if (key === "-" || event.code === "NumpadSubtract") props.runtime.zoom(1.25);
      else if (key === "f") fit(Boolean(event.shiftKey && props.selectedId));
      else if (key === "home") { if (event.shiftKey) props.runtime.resetView(); else fit(); }
      else if (key === "1" || event.code === "Numpad1") orient("-z");
      else if (key === "3" || event.code === "Numpad3") orient("+x");
      else if (key === "7" || event.code === "Numpad7") orient("+y");
      else if (key === "5" || event.code === "Numpad5") props.runtime.setProjection(view()?.projection === "orthographic" ? "perspective" : "orthographic");
      else if (event.code === "NumpadDecimal") fit(Boolean(props.selectedId));
      else return;
      event.preventDefault();
    };
    // Use pointer-up rather than click: mobile browsers may suppress synthetic
    // clicks after canvas gestures. This never changes selection or source data.
    const onProbePointer = (event: PointerEvent) => {
      if (!probeArmed() || !event.isPrimary ||
          (event.pointerType === "mouse" && event.button !== 0)) return;
      const picked = props.runtime.inspectSurfaceAt(event.clientX, event.clientY);
      setSurfaceProbe(picked);
      setProbeArmed(false);
      // Babylon readback is asynchronous on WebGPU. Never gate rendering or
      // source editing on it; display errors explicitly rather than black zeros.
      const request=probeRequest()+1;
      setProbeRequest(request);
      setGpuReading(true);
      void props.runtime.inspectGpuAt(event.clientX,event.clientY).then(result=>{
        if (probeRequest() === request) {
          setGpuEvidence(result);
          if ("surface" in result) setSurfaceProbe(result.surface ?? null);
        }
      }).catch(reason=>{
        if (probeRequest() === request) setGpuEvidence({
          framebufferRgb:null,framebufferError: reason instanceof Error ? reason.message.slice(0,240) : "Readback unavailable",
          textureSize:null,mips:[],
        });
      }).finally(()=>{if(probeRequest()===request)setGpuReading(false);});
      setMessage(picked
        ? `Surface: ${picked.canonicalId ?? picked.mesh}; ${picked.texture ?? "no texture"}; ${picked.distanceMetres} m`
        : "No visible surface at the selected point.");
    };
    props.canvas.addEventListener("keydown", keydown);
    props.canvas.addEventListener("pointerup", onProbePointer, true);
    onCleanup(() => {
      setProbeRequest(probeRequest()+1);
      unsubscribe();
      props.canvas.removeEventListener("keydown", keydown);
      props.canvas.removeEventListener("pointerup", onProbePointer, true);
    });
  });
  return <div class="teldra-view-controls">
    <div class="teldra-view-controls__bar" role="group" aria-label="Camera controls">
      <button type="button" onClick={() => props.runtime.fitHome()}><StudioIcon name="house" /> Home</button>
      <button type="button" onClick={() => fit()}><StudioIcon name="frame" /> Fit scene</button>
      <button type="button" disabled={!props.selectedId} onClick={() => fit(true)}><StudioIcon name="focus" /> Fit selection</button>
      <button type="button" onClick={() => props.runtime.resetView()}><StudioIcon name="reset" /> Reset view</button>
      <button type="button" aria-label="Zoom in" onClick={() => props.runtime.zoom(0.8)}><StudioIcon name="zoomIn" /></button>
      <button type="button" aria-label="Zoom out" onClick={() => props.runtime.zoom(1.25)}><StudioIcon name="zoomOut" /></button>
      <label>Projection <select aria-label="Projection" value={view()?.projection ?? "perspective"} onChange={event =>
        props.runtime.setProjection(event.currentTarget.value as "perspective" | "orthographic")}>
        <option value="perspective">Perspective</option><option value="orthographic">Orthographic</option>
      </select></label>
    </div>
    <div class="teldra-view-controls__navigation">
      <div class="teldra-orientation" role="group" aria-label="3D orientation gizmo">
        <svg viewBox="-60 -60 120 120" aria-hidden="true"><For each={view()?.axes}>{axis =>
          <line x1="0" y1="0" x2={axis.x} y2={axis.y} stroke={axis.direction.endsWith("x") ? "#d44" : axis.direction.endsWith("y") ? "#278431" : "#397ddd"} stroke-width="2" />
        }</For></svg>
        <For each={directions}>{direction => {
          const axis = () => view()?.axes.find(item => item.direction === direction);
          return <button type="button" class="teldra-orientation__axis"
            aria-label={`View from ${axis()?.label ?? direction}`} title={`View from ${axis()?.label ?? direction}`}
            style={{left: `${60 + (axis()?.x ?? 0)}px`, top: `${60 + (axis()?.y ?? 0)}px`, "z-index": (axis()?.depth ?? 0) > 0 ? 2 : 1}}
            onClick={() => orient(direction)}>{axis()?.label}</button>;
        }}</For>
      </div>
      <div role="group" aria-label="Standard views" class="teldra-view-controls__bar">
        <button type="button" onClick={() => orient("isometric")}><StudioIcon name="isometric" /> Isometric</button>
        <button type="button" onClick={() => orient("+y")}><StudioIcon name="top" /> Top</button>
        <button type="button" onClick={() => orient("-z")}><StudioIcon name="front" /> Front</button>
        <button type="button" onClick={() => orient("+x")}><StudioIcon name="right" /> Right</button>
      </div>
      <div role="group" aria-label="Pan controls" class="teldra-view-controls__bar">
        <For each={[[-1, 0, "left"], [1, 0, "right"], [0, 1, "up"], [0, -1, "down"]] as const}>{item =>
          <button type="button" aria-label={`Pan ${item[2]}`} onClick={() => props.runtime.pan(item[0], item[1])}>{item[2]}</button>
        }</For>
      </div>
    </div>
    <details class="teldra-view-controls__panel teldra-view-controls__panel--layers"><summary><StudioIcon name="layers" /> Layers</summary><div class="teldra-view-controls__panel-content teldra-view-controls__layers">
      <For each={["category", "level"] as const}>{group => <fieldset><legend>{group === "category" ? "Content" : "Levels"}</legend>
        <For each={layerDefinitions.filter(layer => layer.group === group)}>{layer => <label>
          <input type="checkbox" checked={layers().find(current => current.id === layer.id)?.visible ?? true} onChange={event => {
            props.runtime.setLayerVisible(layer.id, event.currentTarget.checked); setLayers(props.runtime.layers());
          }} />{layer.label} <small>({layer.meshParts})</small>
        </label>}</For>
      </fieldset>}</For>
    </div></details>
    <details class="teldra-view-controls__panel teldra-view-controls__panel--help"><summary><StudioIcon name="help" /> Navigation help</summary><div class="teldra-view-controls__panel-content">
      <p>Blender-style navigation: middle-drag to orbit, Shift+middle-drag to pan, scroll to zoom. Left-drag orbit and right-drag pan remain available. Touch: one finger orbits; two fingers pan and pinch to zoom.</p>
      <p>Focus the 3D canvas: G move, R rotate, S requests scale only for validated IFC mapped geometry; unsupported scale operations remain disabled. After G/R, X/Y/Z constrain, type a number, Enter applies, Esc cancels. IFC furniture rotation is upright Z only.</p>
      <p>Numpad 1 front, 3 right, 7 top, 5 projection, 2/4/6/8 orbit, Shift+numpad pan, numpad decimal frames selection, Home fits scene, Shift+Home resets view. Arrows orbit, Shift+arrows pan, +/- zoom, F fits the scene, Shift+F fits selection. Ctrl/Command+S saves; Ctrl/Command+Z undoes, Shift+Ctrl/Command+Z redoes.</p>
    </div></details>
    <details class="teldra-view-controls__panel teldra-view-controls__panel--appearance"><summary><StudioIcon name="appearance" /> Appearance</summary><div class="teldra-view-controls__panel-content">
      <label><input type="checkbox" checked={appearance().texturesEnabled} onChange={event => {props.runtime.setAppearance({texturesEnabled: event.currentTarget.checked});setAppearance(props.runtime.appearance());}} />Textures and diffuse maps</label>
      <label><input type="checkbox" aria-label="Inspect floor textures without lighting" disabled={!appearance().texturesEnabled} checked={appearance().floorTextureInspection}
        onChange={event => {props.runtime.setAppearance({floorTextureInspection:event.currentTarget.checked});setAppearance(props.runtime.appearance());}} />Inspect floor textures (unlit)</label>
      <button type="button" aria-label="Identify visible surface" onClick={armSurfaceProbe}>
        {probeArmed() ? "Tap a floor to identify it" : "Identify visible surface"}
      </button>
      <Show when={surfaceProbe()}>
        <output data-testid="surface-probe-desktop" aria-label="Identified surface" style={{"white-space":"pre-wrap","overflow-wrap":"anywhere","font-size":"0.8rem"}}>{surfaceProbeDetails()}</output>
        <Show when={gpuReading()}><small role="status">Reading GPU floor texels…</small></Show>
        <Show when={gpuEvidence()}><output data-testid="gpu-floor-evidence-desktop" style={{"white-space":"pre-wrap","overflow-wrap":"anywhere","font-size":"0.8rem"}}>{gpuProbeDetails()}</output><button type="button" disabled={gpuReading()} onClick={() => void copyGpuReport()}>Copy GPU diagnostic report</button></Show>
      </Show>
      <label>Floor texture minification
        <select aria-label="Floor texture minification" value={appearance().floorMinification} onChange={event=>{
          props.runtime.setAppearance({floorMinification:event.currentTarget.value as "auto"|"source"|"anisotropic"|"base-level"});
          setAppearance(props.runtime.appearance());
        }}>
          <option value="auto">Automatic</option>
          <option value="source">Source trilinear</option>
          <option value="anisotropic">Anisotropic (up to 8×)</option>
          <option value="base-level">Base image only</option>
        </select>
      </label>
      <label>Light intensity <input aria-label="Light intensity" type="range" min="0.25" max="2" step="0.05" value={appearance().lightGain} onInput={event => {props.runtime.setAppearance({lightGain: Number(event.currentTarget.value)});setAppearance(props.runtime.appearance());}} /></label>
      <label>Shadow detail <input aria-label="Shadow detail" type="range" min="0" max="100" step="5" value={appearance().shadowDetail} onInput={event => {props.runtime.setAppearance({shadowDetail: Number(event.currentTarget.value)});setAppearance(props.runtime.appearance());}} /><output>{appearance().shadowDetail}%</output></label>
      <button type="button" onClick={() => {props.runtime.setAppearance({texturesEnabled: true,lightGain:1,shadowDetail:0,floorTextureInspection:false,floorMinification:"auto"});setAppearance(props.runtime.appearance());}}>Restore source appearance</button>
      <small data-testid="studio-build-desktop">Studio build: {studioBuildLabel}</small>
      <p>{props.runtime.assetSummary().localLightSources} imported lamp/window emitters. Automatic uses source mipmapped sampling. Base image only remains a compatibility fallback. Compare at the same camera position: anisotropic sampling retains angled detail; base-image mode bypasses mipmaps and may shimmer or use more GPU bandwidth. Source restores the imported sampler. Floor inspection bypasses lighting. These controls do not modify source project data.</p>
    </div></details>
    <div class="teldra-view-controls__mobile">
      <button type="button" aria-expanded={mobileViewOpen()} aria-controls="teldra-mobile-view-settings"
        onClick={() => setMobileViewOpen(!mobileViewOpen())}><StudioIcon name="appearance" /> View</button>
      <Show when={mobileViewOpen()}>
        <div id="teldra-mobile-view-settings" role="group" aria-label="Mobile view settings" class="teldra-view-controls__mobile-sheet">
          <strong>Camera</strong>
          <div class="teldra-view-controls__mobile-grid">
            <button type="button" onClick={() => fit()}><StudioIcon name="frame" /> Fit scene</button>
            <button type="button" disabled={!props.selectedId} onClick={() => fit(true)}><StudioIcon name="focus" /> Fit selection</button>
            <button type="button" onClick={() => orient("isometric")}><StudioIcon name="isometric" /> Isometric</button>
            <button type="button" onClick={() => orient("+y")}><StudioIcon name="top" /> Top</button>
            <button type="button" onClick={() => orient("-z")}><StudioIcon name="front" /> Front</button>
            <button type="button" onClick={() => orient("+x")}><StudioIcon name="right" /> Right</button>
          </div>
          <label>Projection
            <select aria-label="Mobile camera projection" value={view()?.projection ?? "perspective"}
              onChange={event => props.runtime.setProjection(event.currentTarget.value as "perspective" | "orthographic")}>
              <option value="perspective">Perspective</option>
              <option value="orthographic">Orthographic</option>
            </select>
          </label>
          <details>
            <summary><StudioIcon name="layers" /> Layers</summary>
            <div class="teldra-view-controls__mobile-layers">
              <Show when={props.hasHiddenSourceContent}>
                <label><input type="checkbox" aria-label="Reveal hidden source geometry" checked={props.hiddenSourceVisible ?? false}
                  onChange={event => props.onHiddenSourceVisibilityChange?.(event.currentTarget.checked)} />
                  Show hidden source content
                </label>
              </Show>
              <For each={layerDefinitions}>{layer => <label>
                <input type="checkbox" checked={layers().find(current => current.id === layer.id)?.visible ?? true}
                  onChange={event => {props.runtime.setLayerVisible(layer.id, event.currentTarget.checked);setLayers(props.runtime.layers());}} />
                {layer.label}
              </label>}</For>
            </div>
          </details>
          <details>
            <summary><StudioIcon name="appearance" /> Appearance</summary>
            <div class="teldra-view-controls__mobile-layers">
              <label><input type="checkbox" checked={appearance().texturesEnabled}
                onChange={event => {props.runtime.setAppearance({texturesEnabled: event.currentTarget.checked});setAppearance(props.runtime.appearance());}} />Textures</label>
              <label><input type="checkbox" aria-label="Mobile inspect floor textures without lighting"
                disabled={!appearance().texturesEnabled} checked={appearance().floorTextureInspection} onChange={event => {
                  props.runtime.setAppearance({floorTextureInspection:event.currentTarget.checked});setAppearance(props.runtime.appearance());
                }} />Inspect floor textures (unlit)</label>
              <button type="button" aria-label="Mobile identify visible surface" onClick={armSurfaceProbe}>
                {probeArmed() ? "Tap a floor to identify it" : "Identify visible surface"}
              </button>
              <Show when={surfaceProbe()}>
                <output data-testid="surface-probe-mobile" aria-label="Mobile identified surface" style={{"white-space":"pre-wrap","overflow-wrap":"anywhere","font-size":"0.8rem"}}>{surfaceProbeDetails()}</output>
                <Show when={gpuReading()}><small role="status">Reading GPU floor texels…</small></Show>
                <Show when={gpuEvidence()}><output data-testid="gpu-floor-evidence-mobile" style={{"white-space":"pre-wrap","overflow-wrap":"anywhere","font-size":"0.8rem"}}>{gpuProbeDetails()}</output><button type="button" disabled={gpuReading()} onClick={() => void copyGpuReport()}>Copy GPU diagnostic report</button></Show>
              </Show>
              <label>Floor texture minification
                <select aria-label="Mobile floor texture minification" value={appearance().floorMinification} onChange={event=>{
                  props.runtime.setAppearance({floorMinification:event.currentTarget.value as "auto"|"source"|"anisotropic"|"base-level"});
                  setAppearance(props.runtime.appearance());
                }}>
                  <option value="auto">Automatic</option>
                  <option value="source">Source trilinear</option>
                  <option value="anisotropic">Anisotropic (up to 8×)</option>
                  <option value="base-level">Base image only</option>
                </select>
              </label>
              <label>Light intensity <input aria-label="Mobile light intensity" type="range" min="0.25" max="2" step="0.05"
                value={appearance().lightGain} onInput={event => {props.runtime.setAppearance({lightGain: Number(event.currentTarget.value)});setAppearance(props.runtime.appearance());}} /></label>
              <label>Shadow detail <input aria-label="Mobile shadow detail" type="range" min="0" max="100" step="5"
                value={appearance().shadowDetail} onInput={event => {props.runtime.setAppearance({shadowDetail: Number(event.currentTarget.value)});setAppearance(props.runtime.appearance());}} /><output>{appearance().shadowDetail}%</output></label>
              <button type="button" onClick={() => {props.runtime.setAppearance({texturesEnabled: true,lightGain:1,shadowDetail:0,floorTextureInspection:false,floorMinification:"auto"});setAppearance(props.runtime.appearance());}}>Restore source appearance</button>
              <small data-testid="studio-build-mobile">Studio build: {studioBuildLabel}</small>
            </div>
          </details>
          <button type="button" onClick={() => props.runtime.resetView()}><StudioIcon name="reset" /> Reset view</button>
        </div>
      </Show>
    </div>
    <output class="teldra-view-controls__announcement" aria-live="polite">{message()}</output>
    <output class="teldra-view-controls__diagnostic" data-testid="camera-state" aria-hidden="true">{JSON.stringify(view())}</output>
  </div>;
}
