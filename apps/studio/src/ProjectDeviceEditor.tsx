import { createEffect, createSignal, Show } from "solid-js";
import type { StudioProjectController } from "./StudioProjectController";
import "./ProjectDeviceEditor.css";

export interface ProjectDeviceEditorProps {
  readonly controller: StudioProjectController;
  readonly deviceId: string;
  readonly hideProjectActions?: boolean;
  readonly externalVersion?: number;
  readonly onChange?: () => void;
}

export function ProjectDeviceEditor(props: ProjectDeviceEditorProps) {
  let nameInput!: HTMLInputElement;
  const [version, setVersion] = createSignal(0);
  const [saveState, setSaveState] =
    createSignal<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = createSignal("");

  const refresh = () => { setVersion((value) => value + 1); props.onChange?.(); };

  const dirty = () => {
    version();
    return props.controller.dirty;
  };

  const history = () => {
    version();
    return props.controller.history;
  };

  const revision = () => {
    version();
    return props.controller.revision;
  };

  const device = () => {
    version();
    return props.controller.twin.devices.find(
      (candidate) => candidate.id === props.deviceId,
    );
  };

  const requireDevice = () => {
    const current = device();
    if (current === undefined) {
      throw new Error(
        `Studio editor cannot find device "${props.deviceId}".`,
      );
    }
    return current;
  };

  const syncInput = () => {
    nameInput.value = requireDevice().name;
  };
  createEffect(() => {
    props.externalVersion;
    if (nameInput) syncInput();
  });

  const applyRename = (event: SubmitEvent) => {
    event.preventDefault();
    setMessage("");

    const nextName = nameInput.value;
    const current = requireDevice();

    if (nextName.trim().length === 0) {
      setMessage("Device name must not be empty.");
      return;
    }

    if (nextName === current.name) {
      return;
    }

    try {
      props.controller.renameDevice(
        props.deviceId,
        nextName,
        `studio:rename:${props.deviceId}`,
      );
      refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      syncInput();
    }
  };

  const undo = () => {
    if (props.controller.undo()) {
      refresh();
      syncInput();
      setMessage("");
    }
  };

  const redo = () => {
    if (props.controller.redo()) {
      refresh();
      syncInput();
      setMessage("");
    }
  };

  const save = async () => {
    setSaveState("saving");
    setMessage("");

    try {
      await props.controller.save();
      setSaveState("idle");
      refresh();
    } catch (error) {
      setSaveState("error");
      setMessage(error instanceof Error ? error.message : String(error));
      refresh();
    }
  };

  return (
    <section class="teldra-project-device-editor" aria-labelledby="device-editor-title">
      <header class="teldra-project-device-editor__header">
        <div>
          <h2 id="device-editor-title">Device</h2>
          <p class="teldra-project-device-editor__identity">
            <span>Canonical ID</span>
            <code data-testid="device-canonical-id">{props.deviceId}</code>
          </p>
        </div>
        <Show when={!props.hideProjectActions}><output
          class="teldra-project-device-editor__dirty"
          data-dirty={dirty()}
          data-testid="project-dirty-state"
          aria-live="polite"
        >
          {dirty() ? "Unsaved changes" : "Saved"}
        </output></Show>
      </header>

      <form class="teldra-project-device-editor__form" onSubmit={applyRename}>
        <label for="device-name">Device name</label>
        <div class="teldra-project-device-editor__field-row">
          <input
            ref={nameInput}
            id="device-name"
            name="device-name"
            value={requireDevice().name}
            autocomplete="off"
          />
          <button type="submit">Apply name</button>
        </div>
      </form>

      <Show when={!props.hideProjectActions}><div class="teldra-project-device-editor__actions" aria-label="Edit history and save">
        <button
          type="button"
          onClick={undo}
          disabled={!history().canUndo}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!history().canRedo}
        >
          Redo
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty() || saveState() === "saving"}
        >
          {saveState() === "saving" ? "Saving…" : "Save project"}
        </button>
      </div></Show>

      <dl class="teldra-project-device-editor__status">
        <div>
          <dt>Revision</dt>
          <dd data-testid="project-revision">{revision()}</dd>
        </div>
        <div>
          <dt>Device name</dt>
          <dd data-testid="canonical-device-name">{requireDevice().name}</dd>
        </div>
      </dl>

      <p
        class="teldra-project-device-editor__message"
        role={message() === "" ? undefined : "alert"}
      >
        {message()}
      </p>
    </section>
  );
}
