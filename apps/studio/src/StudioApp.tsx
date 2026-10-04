import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  openBrowserStudioProject,
  supportsBrowserProjectFiles,
  type OpenedBrowserStudioProject,
} from "./BrowserTeldraProject";
import { ProjectDeviceEditor } from "./ProjectDeviceEditor";
import "./StudioApp.css";

export interface StudioAppProps {
  readonly openProject?: () => Promise<OpenedBrowserStudioProject | null>;
  readonly browserProjectFilesSupported?: boolean;
}

export function StudioApp(props: StudioAppProps) {
  const [opened, setOpened] =
    createSignal<OpenedBrowserStudioProject | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] =
    createSignal<string | null>(null);
  const [status, setStatus] =
    createSignal<"idle" | "opening" | "error">("idle");
  const [message, setMessage] = createSignal("");

  const supported = () =>
    props.browserProjectFilesSupported ??
    supportsBrowserProjectFiles();

  const currentDeviceId = createMemo(() => {
    const project = opened();
    if (project === null) return null;

    const selected = selectedDeviceId();
    if (
      selected !== null &&
      project.controller.twin.devices.some(
        (device) => device.id === selected,
      )
    ) {
      return selected;
    }

    return project.controller.twin.devices[0]?.id ?? null;
  });

  const openProject = async () => {
    if (!supported()) {
      setMessage(
        "Writable local .teldra files require a current Chromium-based browser with the File System Access API.",
      );
      setStatus("error");
      return;
    }

    setStatus("opening");
    setMessage("");

    try {
      const next = await (
        props.openProject ?? openBrowserStudioProject
      )();

      if (next === null) {
        setStatus("idle");
        return;
      }

      const previous = opened();
      if (previous !== null) {
        await previous.close();
      }

      setOpened(next);
      setSelectedDeviceId(
        next.controller.twin.devices[0]?.id ?? null,
      );
      setStatus("idle");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : String(error),
      );
      setStatus("error");
    }
  };

  onCleanup(() => {
    const project = opened();
    if (project !== null) {
      void project.close();
    }
  });

  return (
    <main class="teldra-studio-shell">
      <header class="teldra-studio-shell__topbar">
        <div>
          <p class="teldra-studio-shell__eyebrow">Teldra</p>
          <h1>Studio</h1>
        </div>

        <button
          type="button"
          onClick={() => void openProject()}
          disabled={status() === "opening"}
          data-testid="open-project"
        >
          {status() === "opening"
            ? "Opening…"
            : opened() === null
              ? "Open .teldra"
              : "Open another"}
        </button>
      </header>

      <Show
        when={supported()}
        fallback={
          <section
            class="teldra-studio-shell__notice"
            role="status"
          >
            <h2>Local project access unavailable</h2>
            <p>
              Teldra will not upload or rewrite your project through an
              unsupported fallback. Open Studio in a current Chromium-based
              browser to edit a local <code>.teldra</code> file.
            </p>
          </section>
        }
      >
        <Show
          when={opened()}
          fallback={
            <section class="teldra-studio-shell__empty">
              <h2>Open a portable home project</h2>
              <p>
                Select a <code>.teldra</code> file from your computer.
                Studio validates the project manifest and canonical artifact
                hashes before exposing it for editing.
              </p>
            </section>
          }
        >
          {(project) => (
            <section class="teldra-studio-shell__workspace">
              <aside class="teldra-studio-shell__sidebar">
                <div>
                  <span>Project</span>
                  <strong data-testid="project-name">
                    {project().displayName}
                  </strong>
                </div>

                <label for="studio-device">Device</label>
                <select
                  id="studio-device"
                  value={currentDeviceId() ?? ""}
                  onInput={(event) =>
                    setSelectedDeviceId(event.currentTarget.value)
                  }
                >
                  <For each={project().controller.twin.devices}>
                    {(device) => (
                      <option value={device.id}>
                        {device.name}
                      </option>
                    )}
                  </For>
                </select>

                <dl>
                  <div>
                    <dt>Devices</dt>
                    <dd>
                      {project().controller.twin.devices.length}
                    </dd>
                  </div>
                  <div>
                    <dt>Bindings</dt>
                    <dd>
                      {project().controller.twin.bindings.length}
                    </dd>
                  </div>
                </dl>
              </aside>

              <section class="teldra-studio-shell__editor">
                <Show
                  when={currentDeviceId()}
                  fallback={
                    <p>
                      This project contains no editable smart-home devices.
                    </p>
                  }
                >
                  {(deviceId) => (
                    <ProjectDeviceEditor
                      controller={project().controller}
                      deviceId={deviceId()}
                    />
                  )}
                </Show>
              </section>
            </section>
          )}
        </Show>
      </Show>

      <p
        class="teldra-studio-shell__message"
        role={message() === "" ? undefined : "alert"}
      >
        {message()}
      </p>
    </main>
  );
}
