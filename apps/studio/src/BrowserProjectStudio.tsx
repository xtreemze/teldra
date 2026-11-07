import { createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  openBrowserTeldraProjectWithPicker,
  supportsBrowserTeldraFileAccess,
  type BrowserStudioProject,
} from "./BrowserTeldraProject";
import { ProjectDeviceEditor } from "./ProjectDeviceEditor";
import { StudioSelectionWorkspace } from "./StudioSelectionWorkspace";
import type { TwinViewportHandle } from "./TwinViewport";
import "./BrowserProjectStudio.css";

export interface BrowserProjectStudioProps {
  readonly openProject?: () => Promise<BrowserStudioProject>;
  readonly openDemoProject?: () => Promise<BrowserStudioProject>;
  readonly fileAccessSupported?: boolean;
  readonly onViewportReady?: (handle: TwinViewportHandle) => void;
}

export function BrowserProjectStudio(props: BrowserProjectStudioProps) {
  const [project, setProject] = createSignal<BrowserStudioProject | null>(null);
  const [opening, setOpening] = createSignal(false);
  const [error, setError] = createSignal("");

  const supported = () =>
    props.fileAccessSupported ??
    (props.openProject !== undefined || supportsBrowserTeldraFileAccess());

  const open = async (demo = false) => {
    setOpening(true);
    setError("");

    try {
      const next =
        demo && props.openDemoProject !== undefined
          ? await props.openDemoProject()
          : props.openProject === undefined
          ? await openBrowserTeldraProjectWithPicker(
              `studio:${crypto.randomUUID()}`,
            )
          : await props.openProject();

      const firstDevice = next.controller.twin.devices[0];
      next.controller.selectCanonicalId(firstDevice?.id ?? null);
      const current = project();
      if (current?.controller.dirty && !window.confirm("This project has unsaved changes. Open another project and discard them?")) {
        await next.close();
        return;
      }
      setProject(next);
      if (current !== null) await current.close();
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setOpening(false);
    }
  };

  const protectUnsavedChanges = (event: BeforeUnloadEvent) => {
    if (project()?.controller.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  onMount(() => window.addEventListener("beforeunload", protectUnsavedChanges));
  onCleanup(() => {
    window.removeEventListener("beforeunload", protectUnsavedChanges);
    const current = project();
    if (current !== null) {
      void current.close();
    }
  });

  return (
    <main class="teldra-browser-studio">
      <header class="teldra-browser-studio__masthead">
        <div>
          <p class="teldra-browser-studio__eyebrow">Teldra <span>Studio</span></p>
          <h1>{project() === null ? "Your space, in context." : "Project workspace"}</h1>
          <p>Explore your building and manage its connected devices in one place.</p>
        </div>
        <button
          type="button"
          onClick={() => void open()}
          disabled={!supported() || opening()}
        >
          {opening() ? "Opening…" : project() === null ? "Open .teldra" : "Open another"}
        </button>
      </header>

      <Show
        when={supported() || props.openDemoProject !== undefined || project() !== null}
        fallback={
          <section class="teldra-browser-studio__notice" role="status">
            <h2>Direct local editing unavailable</h2>
            <p>
              This browser does not expose the File System Access API. No project
              data has been changed. Use a supported Chromium-based browser for
              direct local save.
            </p>
          </section>
        }
      >
        <Show
          when={project()}
          fallback={
            <section class="teldra-browser-studio__empty">
              <p class="teldra-browser-studio__eyebrow">GET STARTED</p>
              <h2>Open a project</h2>
              <p>Choose a local <code>.teldra</code> file to explore its 3D scene and edit devices. Changes are saved back to your project.</p>
              <Show when={props.openDemoProject}>
                <button type="button" class="teldra-browser-studio__secondary" onClick={() => void open(true)} disabled={opening()}>Try demo</button>
              </Show>
              <Show when={!supported()}><p class="teldra-browser-studio__hint">Opening local files is unavailable in this browser.</p></Show>
              <p class="teldra-browser-studio__hint">Once open, drag to orbit, scroll to zoom, and select a device to inspect it.</p>
            </section>
          }
        >
          {(ready) => {
            const firstDevice = () => ready().controller.twin.devices[0];
            return (
              <section class="teldra-browser-studio__workspace">
                <div class="teldra-browser-studio__file">
                  <span>Project</span>
                  <strong data-testid="browser-project-file">{ready().fileName}</strong>
                  <Show when={ready().saveMode === "download"}><span class="teldra-browser-studio__save-mode">Save downloads a copy</span></Show>
                </div>
                <Show
                  when={ready().scene}
                  fallback={
                    <Show
                      when={firstDevice()}
                      fallback={<p>This project has no editable smart-home devices.</p>}
                    >
                      {(device) => (
                        <ProjectDeviceEditor
                          controller={ready().controller}
                          deviceId={device().id}
                        />
                      )}
                    </Show>
                  }
                >
                  {(scene) => (
                    <StudioSelectionWorkspace
                      controller={ready().controller}
                      manifest={scene().manifest}
                      glbUrl={scene().glbUrl}
                      {...(props.onViewportReady === undefined
                        ? {}
                        : { onViewportReady: props.onViewportReady })}
                    />
                  )}
                </Show>
              </section>
            );
          }}
        </Show>
      </Show>

      <p
        class="teldra-browser-studio__error"
        role={error() === "" ? undefined : "alert"}
      >
        {error()}
      </p>
    </main>
  );
}
