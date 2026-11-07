import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { BabylonTwinRuntime, ViewDirection, ViewState } from "@teldra/runtime-babylon";

export function ViewportControls(props: {runtime: BabylonTwinRuntime; canvas: HTMLCanvasElement; selectedId?: string | undefined}) {
  const [view, setView] = createSignal<ViewState | null>(props.runtime.viewState());
  const layerDefinitions = props.runtime.layers();
  const [layers, setLayers] = createSignal(layerDefinitions);
  const directions = ["+x", "-x", "+y", "-y", "+z", "-z"] as const;
  const [appearance, setAppearance] = createSignal(props.runtime.appearance());
  const [message, setMessage] = createSignal("");
  const [mobileViewOpen, setMobileViewOpen] = createSignal(false);
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
    props.canvas.addEventListener("keydown", keydown);
    onCleanup(() => { unsubscribe(); props.canvas.removeEventListener("keydown", keydown); });
  });
  return <div class="teldra-view-controls">
    <div class="teldra-view-controls__bar" role="group" aria-label="Camera controls">
      <button type="button" onClick={() => props.runtime.fitHome()}>Home</button>
      <button type="button" onClick={() => fit()}>Fit scene</button>
      <button type="button" disabled={!props.selectedId} onClick={() => fit(true)}>Fit selection</button>
      <button type="button" onClick={() => props.runtime.resetView()}>Reset view</button>
      <button type="button" aria-label="Zoom in" onClick={() => props.runtime.zoom(0.8)}>+</button>
      <button type="button" aria-label="Zoom out" onClick={() => props.runtime.zoom(1.25)}>-</button>
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
        <button type="button" onClick={() => orient("isometric")}>Isometric</button>
        <button type="button" onClick={() => orient("+y")}>Top</button>
        <button type="button" onClick={() => orient("-z")}>Front</button>
        <button type="button" onClick={() => orient("+x")}>Right</button>
      </div>
      <div role="group" aria-label="Pan controls" class="teldra-view-controls__bar">
        <For each={[[-1, 0, "left"], [1, 0, "right"], [0, 1, "up"], [0, -1, "down"]] as const}>{item =>
          <button type="button" aria-label={`Pan ${item[2]}`} onClick={() => props.runtime.pan(item[0], item[1])}>{item[2]}</button>
        }</For>
      </div>
    </div>
    <details class="teldra-view-controls__panel teldra-view-controls__panel--layers"><summary>Layers</summary><div class="teldra-view-controls__panel-content teldra-view-controls__layers">
      <For each={["category", "level"] as const}>{group => <fieldset><legend>{group === "category" ? "Content" : "Levels"}</legend>
        <For each={layerDefinitions.filter(layer => layer.group === group)}>{layer => <label>
          <input type="checkbox" checked={layers().find(current => current.id === layer.id)?.visible ?? true} onChange={event => {
            props.runtime.setLayerVisible(layer.id, event.currentTarget.checked); setLayers(props.runtime.layers());
          }} />{layer.label} <small>({layer.meshParts})</small>
        </label>}</For>
      </fieldset>}</For>
    </div></details>
    <details class="teldra-view-controls__panel teldra-view-controls__panel--help"><summary>Navigation help</summary><div class="teldra-view-controls__panel-content">
      <p>Blender-style navigation: middle-drag to orbit, Shift+middle-drag to pan, scroll to zoom. Left-drag orbit and right-drag pan remain available. Touch: one finger orbits; two fingers pan and pinch to zoom.</p>
      <p>Focus the 3D canvas: G move, R rotate, S requests scale (currently unavailable for IFC geometry). After G/R, X/Y/Z constrain, type a number, Enter applies, Esc cancels. IFC furniture rotation is upright Z only.</p>
      <p>Numpad 1 front, 3 right, 7 top, 5 projection, 2/4/6/8 orbit, Shift+numpad pan, numpad decimal frames selection, Home fits scene, Shift+Home resets view. Arrows orbit, Shift+arrows pan, +/- zoom, F fits the scene, Shift+F fits selection. Ctrl/Command+S saves; Ctrl/Command+Z undoes, Shift+Ctrl/Command+Z redoes.</p>
    </div></details>
    <details class="teldra-view-controls__panel teldra-view-controls__panel--appearance"><summary>Appearance</summary><div class="teldra-view-controls__panel-content">
      <label><input type="checkbox" checked={appearance().texturesEnabled} onChange={event => {props.runtime.setAppearance({texturesEnabled: event.currentTarget.checked});setAppearance(props.runtime.appearance());}} />Textures and diffuse maps</label>
      <label>Light intensity <input aria-label="Light intensity" type="range" min="0.25" max="2" step="0.05" value={appearance().lightGain} onInput={event => {props.runtime.setAppearance({lightGain: Number(event.currentTarget.value)});setAppearance(props.runtime.appearance());}} /></label>
      <label>Shadow detail <input aria-label="Shadow detail" type="range" min="0" max="100" step="5" value={appearance().shadowDetail} onInput={event => {props.runtime.setAppearance({shadowDetail: Number(event.currentTarget.value)});setAppearance(props.runtime.appearance());}} /><output>{appearance().shadowDetail}%</output></label>
      <button type="button" onClick={() => {props.runtime.setAppearance({texturesEnabled: true,lightGain:1,shadowDetail:0});setAppearance(props.runtime.appearance());}}>Restore source appearance</button>
      <p>{props.runtime.assetSummary().localLightSources} imported lamp/window emitters. Shadow detail recovers dark tones without modifying project materials or light sources; 0 disables grading. Absent texture detail cannot be recreated. Adjustments affect this view only.</p>
    </div></details>
    <div class="teldra-view-controls__mobile">
      <button type="button" aria-expanded={mobileViewOpen()} aria-controls="teldra-mobile-view-settings"
        onClick={() => setMobileViewOpen(!mobileViewOpen())}>View</button>
      <Show when={mobileViewOpen()}>
        <div id="teldra-mobile-view-settings" role="group" aria-label="Mobile view settings" class="teldra-view-controls__mobile-sheet">
          <strong>Camera</strong>
          <div class="teldra-view-controls__mobile-grid">
            <button type="button" onClick={() => fit()}>Fit scene</button>
            <button type="button" disabled={!props.selectedId} onClick={() => fit(true)}>Fit selection</button>
            <button type="button" onClick={() => orient("isometric")}>Isometric</button>
            <button type="button" onClick={() => orient("+y")}>Top</button>
            <button type="button" onClick={() => orient("-z")}>Front</button>
            <button type="button" onClick={() => orient("+x")}>Right</button>
          </div>
          <label>Projection
            <select aria-label="Mobile camera projection" value={view()?.projection ?? "perspective"}
              onChange={event => props.runtime.setProjection(event.currentTarget.value as "perspective" | "orthographic")}>
              <option value="perspective">Perspective</option>
              <option value="orthographic">Orthographic</option>
            </select>
          </label>
          <details>
            <summary>Layers</summary>
            <div class="teldra-view-controls__mobile-layers">
              <For each={layerDefinitions}>{layer => <label>
                <input type="checkbox" checked={layers().find(current => current.id === layer.id)?.visible ?? true}
                  onChange={event => {props.runtime.setLayerVisible(layer.id, event.currentTarget.checked);setLayers(props.runtime.layers());}} />
                {layer.label}
              </label>}</For>
            </div>
          </details>
          <details>
            <summary>Appearance</summary>
            <div class="teldra-view-controls__mobile-layers">
              <label><input type="checkbox" checked={appearance().texturesEnabled}
                onChange={event => {props.runtime.setAppearance({texturesEnabled: event.currentTarget.checked});setAppearance(props.runtime.appearance());}} />Textures</label>
              <label>Light intensity <input aria-label="Mobile light intensity" type="range" min="0.25" max="2" step="0.05"
                value={appearance().lightGain} onInput={event => {props.runtime.setAppearance({lightGain: Number(event.currentTarget.value)});setAppearance(props.runtime.appearance());}} /></label>
              <label>Shadow detail <input aria-label="Mobile shadow detail" type="range" min="0" max="100" step="5"
                value={appearance().shadowDetail} onInput={event => {props.runtime.setAppearance({shadowDetail: Number(event.currentTarget.value)});setAppearance(props.runtime.appearance());}} /><output>{appearance().shadowDetail}%</output></label>
              <button type="button" onClick={() => {props.runtime.setAppearance({texturesEnabled: true,lightGain:1,shadowDetail:0});setAppearance(props.runtime.appearance());}}>Restore source appearance</button>
            </div>
          </details>
          <button type="button" onClick={() => props.runtime.resetView()}>Reset view</button>
        </div>
      </Show>
    </div>
    <output class="teldra-view-controls__announcement" aria-live="polite">{message()}</output>
    <output class="teldra-view-controls__diagnostic" data-testid="camera-state" aria-hidden="true">{JSON.stringify(view())}</output>
  </div>;
}
