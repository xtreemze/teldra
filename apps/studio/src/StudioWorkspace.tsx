import { For, Show, createSignal } from "solid-js";
import type { TwinRenderIdentity } from "@teldra/runtime-babylon";
import { ProjectDeviceEditor } from "./ProjectDeviceEditor";
import type { StudioProjectController } from "./StudioProjectController";
import {
  TwinViewport,
  type TwinViewportHandle,
} from "./TwinViewport";
import "./StudioWorkspace.css";

export interface StudioWorkspaceProps {
  readonly controller: StudioProjectController;
  readonly manifest: unknown;
  readonly glbUrl: string;
  readonly onViewportReady?: (handle: TwinViewportHandle) => void;
}

export function StudioWorkspace(props: StudioWorkspaceProps) {
  const [version, setVersion] = createSignal(0);

  const refresh = () => setVersion((value) => value + 1);

  const selectedCanonicalId = () => {
    version();
    return props.controller.selectedCanonicalId;
  };

  const selectedDevice = () => {
    version();
    return props.controller.selectedDevice;
  };

  const devices = () => {
    version();
    return props.controller.devices;
  };

  const dirty = () => {
    version();
    return props.controller.dirty;
  };

  const revision = () => {
    version();
    return props.controller.revision;
  };

  const selectCanonical = (canonicalId: string | null) => {
    props.controller.selectCanonical(canonicalId);
    refresh();
  };

  const handleViewportSelection = (identity: TwinRenderIdentity | null) => {
    selectCanonical(identity?.canonicalId ?? null);
  };

  return (
    <section class="teldra-studio-workspace" aria-label="Teldra Studio workspace">
      <div class="teldra-studio-workspace__viewport">
        <TwinViewport
          manifest={props.manifest}
          glbUrl={props.glbUrl}
          selectedCanonicalId={selectedCanonicalId()}
          onReady={props.onViewportReady}
          onSelect={handleViewportSelection}
        />
      </div>

      <aside
        class="teldra-studio-workspace__inspector"
        aria-label="Project selection and device inspector"
      >
        <header class="teldra-studio-workspace__selection">
          <div>
            <span>Selected canonical ID</span>
            <code data-testid="studio-selected-canonical-id">
              {selectedCanonicalId() ?? "none"}
            </code>
          </div>
          <div class="teldra-studio-workspace__project-state">
            <output data-testid="workspace-dirty-state">
              {dirty() ? "Unsaved changes" : "Saved"}
            </output>
            <span>
              Revision{" "}
              <output data-testid="workspace-revision">{revision()}</output>
            </span>
          </div>
        </header>

        <section
          class="teldra-studio-workspace__devices"
          aria-labelledby="studio-device-list-title"
        >
          <h2 id="studio-device-list-title">Canonical devices</h2>
          <ul>
            <For each={devices()}>
              {(device) => (
                <li>
                  <button
                    type="button"
                    aria-pressed={selectedCanonicalId() === device.id}
                    data-device-id={device.id}
                    onClick={() => selectCanonical(device.id)}
                  >
                    <span>{device.name}</span>
                    <code>{device.id}</code>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>

        <Show
          when={selectedDevice()}
          fallback={
            <Show
              when={selectedCanonicalId()}
              fallback={
                <p
                  class="teldra-studio-workspace__empty"
                  data-testid="studio-selection-kind"
                >
                  No selection
                </p>
              }
            >
              {(selectedId) => (
                <section
                  class="teldra-studio-workspace__scene-selection"
                  aria-labelledby="scene-selection-title"
                >
                  <h2 id="scene-selection-title">Scene object</h2>
                  <p data-testid="studio-selection-kind">
                    This canonical object is selectable in the scene but is not
                    editable as a twin device.
                  </p>
                  <code>{selectedId()}</code>
                </section>
              )}
            </Show>
          }
        >
          {(device) => (
            <ProjectDeviceEditor
              controller={props.controller}
              deviceId={device().id}
              onProjectChange={refresh}
            />
          )}
        </Show>
      </aside>
    </section>
  );
}
