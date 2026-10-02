import { nextBinaryControlValue } from "@teldra/ui-core";

export interface LightControlProps {
  readonly label: string;
  readonly on: boolean;
  readonly disabled?: boolean;
  readonly onChange?: (next: boolean) => void;
}

export function LightControl(props: LightControlProps) {
  const activate = () => {
    const next = nextBinaryControlValue({
      on: props.on,
      ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
    });

    if (next !== props.on) {
      props.onChange?.(next);
    }
  };

  return (
    <button
      type="button"
      class="teldra-light-control"
      aria-pressed={props.on}
      disabled={props.disabled}
      onClick={activate}
    >
      <span class="teldra-light-control__label">{props.label}</span>
      <span aria-hidden="true">{props.on ? "On" : "Off"}</span>
    </button>
  );
}
