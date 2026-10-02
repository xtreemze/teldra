import { nextBinaryControlValue } from "@teldra/ui-core";
import { LitElement, css, html } from "lit";

export class TeldraLightControl extends LitElement {
  static properties = {
    label: { type: String },
    on: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: inline-block;
      font-family: var(--teldra-font-body, ui-sans-serif, system-ui, sans-serif);
    }

    button {
      min-block-size: var(--teldra-control-min-size, 2.75rem);
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--teldra-space-4, 1rem);
      padding: var(--teldra-space-2, 0.5rem) var(--teldra-space-3, 0.75rem);
      border: 1px solid var(--teldra-border, currentColor);
      border-radius: var(--teldra-radius-control, 0.625rem);
      background: var(--teldra-surface, Canvas);
      color: var(--teldra-text, CanvasText);
      font: inherit;
      cursor: pointer;
    }

    button[aria-pressed="true"] {
      border-color: var(--teldra-accent, currentColor);
    }

    button:focus-visible {
      outline: 2px solid var(--teldra-accent, currentColor);
      outline-offset: 2px;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .label {
      font-weight: 600;
    }
  `;

  label = "Light";
  on = false;
  disabled = false;

  #activate() {
    const next = nextBinaryControlValue({
      on: this.on,
      disabled: this.disabled,
    });

    if (next === this.on) {
      return;
    }

    this.on = next;
    this.dispatchEvent(
      new CustomEvent<boolean>("teldra-change", {
        detail: next,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    return html`
      <button
        type="button"
        aria-pressed=${String(this.on)}
        ?disabled=${this.disabled}
        @click=${this.#activate}
      >
        <span class="label">${this.label}</span>
        <span aria-hidden="true">${this.on ? "On" : "Off"}</span>
      </button>
    `;
  }
}

if (!customElements.get("teldra-light-control")) {
  customElements.define("teldra-light-control", TeldraLightControl);
}
