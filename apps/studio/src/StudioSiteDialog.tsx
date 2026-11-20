import { Show, createEffect, createSignal } from "solid-js";
import type { LocalPoint } from "@teldra/application";
import { StudioIcon } from "./StudioIcon";
import { StudioSitePanel } from "./StudioSitePanel";
import type { StudioProjectController } from "./StudioProjectController";
import "./StudioSiteDialog.css";

export interface StudioSiteDialogProps {
  readonly controller: StudioProjectController;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly readFootprint?: () => Promise<readonly LocalPoint[] | undefined>;
}

/**
 * Modal host for the site placement panel. Modal on purpose: the 3D viewport underneath stays mounted
 * and untouched, and the panel gets the whole screen in compact layouts. It is created on first open so
 * nothing is read or requested until the user asks for the Site panel.
 */
export function StudioSiteDialog(props: StudioSiteDialogProps) {
  let dialog: HTMLDialogElement | undefined;
  const [opened, setOpened] = createSignal(false);
  const [opens, setOpens] = createSignal(0);

  createEffect(() => {
    const wanted = props.open;
    if (wanted) { setOpened(true); setOpens((n) => n + 1); }
    queueMicrotask(() => {
      if (!dialog) return;
      if (wanted && !dialog.open) dialog.showModal();
      else if (!wanted && dialog.open) dialog.close();
    });
  });

  return (
    <dialog
      ref={(element) => { dialog = element; }}
      class="teldra-site-dialog"
      aria-label="Site placement"
      onClose={() => props.onClose()}
      onCancel={() => props.onClose()}
    >
      <div class="teldra-site-dialog__bar">
        <button type="button" class="teldra-site-dialog__close" onClick={() => props.onClose()}>
          <StudioIcon name="cancel" /> Close
        </button>
      </div>
      <Show when={opened()}>
        <StudioSitePanel
          controller={props.controller}
          version={opens}
          {...(props.readFootprint ? { readFootprint: props.readFootprint } : {})}
        />
      </Show>
    </dialog>
  );
}
