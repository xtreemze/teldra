import { createSignal, onCleanup, Show } from "solid-js";
import {
  openBrowserTeldraProjectWithPicker,
  supportsBrowserTeldraFileAccess,
  type BrowserStudioProject,
} from "./BrowserTeldraProject";
import { ProjectDeviceEditor } from "./ProjectDeviceEditor";
import "./BrowserProjectStudio.css";

export interface BrowserProjectStudioProps {
  readonly openProject?: () => Promise<BrowserStudioProject>;
  readonly fileAccessSupported?: boolean;
}

export function BrowserProjectStudio(props: BrowserProjectStudioProps) {
  const [project, setProject] = createSignal<BrowserStudioProject | null>(null);
  const [opening, setOpening] = createSignal(false);
  const [error, setError] = createSignal("");

  const supported = () =>
    props.fileAccessSupported ??
    (props.openProject !== undefined || supportsBrowserTeldraFileAccess());

  const open = async () => {
    setOpening(true);
    setError("");

    try {
      const current = project();
      if (current !== null) {
        await current.close();
      }

      const next =
        props.openProject === undefined
          ? await openBrowserTeldraProjectWithPicker(
              `studio:${crypto.randomUUID()}`,
            )
          : await props.openProject();

      const firstDevice = next.controller.twin.devices[0];
      next.controller.selectCanonicalId(firstDevice?.id ?? null);
      setProject(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  };

  onCleanup(() => {
    const current = project();
    if (current !== null) {
      void current.close();
    }
  });

  return (
    <main class="teldra-browser-studio">
      <header class="teldra-browser-studio__masthead">
        <div>
          <p class="teldra-browser-studio__eyebrow">Teldra Studio</p>
          <h1>Local smart-home project</h1>
          <p>
            Open, edit, undo, and save a portable <code>.teldra</code> project
            without making renderer or browser state canonical.
          </p>
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
        when={supported()}
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
              <h2>No project open</h2>
              <p>Select a local .teldra file to begin.</p>
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
                </div>
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
