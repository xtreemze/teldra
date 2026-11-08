import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  openBrowserTeldraProjectWithPicker,
  supportsBrowserTeldraFileAccess,
  type BrowserStudioProject,
} from "./BrowserTeldraProject";
import { ProjectDeviceEditor } from "./ProjectDeviceEditor";
import { openLaunchedProject } from "./PortableProject";
import { PwaControls } from "./PwaControls";
import { StudioSelectionWorkspace } from "./StudioSelectionWorkspace";
import type { TwinViewportHandle } from "./TwinViewport";
import "./BrowserProjectStudio.css";

export interface BrowserProjectStudioProps {
  readonly autoOpenDemo?: boolean;
  readonly downloadProgress?: string;
  readonly openProject?: () => Promise<BrowserStudioProject>;
  readonly openDemoProject?: () => Promise<BrowserStudioProject>;
  readonly fileAccessSupported?: boolean;
  readonly launchedFile?: FileSystemFileHandle | null;
  readonly onLaunchHandled?: () => void;
  readonly onViewportReady?: (handle: TwinViewportHandle) => void;
}

export function BrowserProjectStudio(props: BrowserProjectStudioProps) {
  const [project, setProject] = createSignal<BrowserStudioProject | null>(null);
  const [opening, setOpening] = createSignal(false);
  const [error, setError] = createSignal("");

  const supported = () =>
    props.fileAccessSupported ??
    (props.openProject !== undefined || supportsBrowserTeldraFileAccess());

  const open = async (demo = false, launchedFile?: FileSystemFileHandle) => {
    setOpening(true);
    setError("");

    try {
      const next = launchedFile !== undefined
          ? await openLaunchedProject(launchedFile)
          : demo && props.openDemoProject !== undefined
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

  const exportRebakedCopy = async (): Promise<void> => {
    const current = project();
    if (!current?.rebakeSavedSceneCopy) throw new Error("This scene cannot be regenerated in the browser.");
    if (current.controller.dirty) throw new Error("Save project changes before exporting a rebaked copy.");
    const bytes = await current.rebakeSavedSceneCopy();
    // Download is a separate artifact; the opened project's lock, scene and
    // history remain unchanged. No source file is overwritten.
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const url = URL.createObjectURL(new Blob([buffer], {type:"application/octet-stream"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = (current.fileName.replace(/\.teldra$/i,"") || "teldra") + "-rebaked.teldra";
    document.body.append(link);
    try { link.click(); }
    finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  };

  createEffect(() => {
    const launchedFile = props.launchedFile;
    if (launchedFile !== undefined && launchedFile !== null) {
      props.onLaunchHandled?.();
      void open(false, launchedFile);
    }
  });

  const protectUnsavedChanges = (event: BeforeUnloadEvent) => {
    if (project()?.controller.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  onMount(() => {
    window.addEventListener("beforeunload", protectUnsavedChanges);
    if (props.autoOpenDemo && props.openDemoProject && !props.launchedFile) void open(true);
  });
  onCleanup(() => {
    window.removeEventListener("beforeunload", protectUnsavedChanges);
    const current = project();
    if (current !== null) {
      void current.close();
    }
  });

  return (
    <main class="teldra-browser-studio">
      <header class="teldra-browser-studio__masthead" classList={{"teldra-browser-studio__masthead--loaded": project() !== null}}>
        <div class="teldra-browser-studio__identity">
          <p class="teldra-browser-studio__eyebrow">Teldra <span>Studio</span></p>
          <h1 title={project()?.fileName ?? "Studio"}>
            <span class="teldra-browser-studio__desktop-title">{project() === null ? "Your space, in context." : "Project workspace"}</span>
            <span class="teldra-browser-studio__mobile-title">{project()?.fileName ?? "Studio"}</span>
          </h1>
          <p>Explore your building and manage its connected devices in one place.</p>
        </div>
        <div class="teldra-browser-studio__masthead-actions">
        <PwaControls hasUnsavedChanges={() => project()?.controller.dirty ?? false} />
        <button class="teldra-browser-studio__open"
          classList={{"teldra-browser-studio__open--project": project() !== null}}
          type="button"
          onClick={() => void open()}
          disabled={!supported() || opening()}
          aria-label={project() === null ? "Open .teldra" : "Open another"}
          title={project() === null ? "Open a project" : "Open another project"}
        >
          <svg class="teldra-browser-studio__open-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 13h6m-3-3v6"/></svg>
          <span class="teldra-browser-studio__open-label">{opening() ? "Opening…" : project() === null ? "Open .teldra" : "Open another"}</span>
        </button>
        </div>
      </header>

      <Show when={opening()}><div class="teldra-browser-studio__loading" role="status" aria-live="polite"><strong>Opening 3D workspace</strong><span>{props.downloadProgress || "Verifying project and preparing scene..."}</span></div></Show>
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
                      saveMode={ready().saveMode}
                      {...(ready().rebakeSavedSceneCopy ? {onExportRebakedScene: exportRebakedCopy} : {})}
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
