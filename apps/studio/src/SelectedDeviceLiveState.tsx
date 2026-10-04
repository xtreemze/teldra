import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { TwinDevice } from "@teldra/domain";
import type {
  CapabilityRuntimeSnapshot,
  StateValue,
} from "@teldra/live-state";
import type { StudioLiveStateController } from "./StudioLiveStateController";
import "./SelectedDeviceLiveState.css";

export interface SelectedDeviceLiveStateProps {
  readonly controller: StudioLiveStateController;
  readonly device: TwinDevice;
}

export function SelectedDeviceLiveState(
  props: SelectedDeviceLiveStateProps,
) {
  const [version, setVersion] = createSignal(props.controller.revision);

  onMount(() => {
    const unsubscribe = props.controller.subscribe(() => {
      setVersion(props.controller.revision);
    });
    onCleanup(unsubscribe);
  });

  const snapshot = (capabilityId: string): CapabilityRuntimeSnapshot => {
    version();
    return props.controller.getCapability(props.device.id, capabilityId);
  };

  return (
    <section
      class="teldra-selected-device-live"
      aria-labelledby="selected-device-live-title"
    >
      <header>
        <h2 id="selected-device-live-title">Live state</h2>
        <p>Observed runtime state. Not saved to the project.</p>
      </header>

      <div class="teldra-selected-device-live__capabilities">
        <For each={props.device.capabilities}>
          {(capability) => {
            const current = () => snapshot(capability.id);
            const availability = () =>
              current().availability?.status ?? "unknown";
            const observed = () => current().observed;

            return (
              <article
                class="teldra-selected-device-live__capability"
                data-capability-id={capability.id}
              >
                <header>
                  <h3>{capability.kind}</h3>
                  <output
                    data-testid={`live-availability-${capability.id}`}
                    data-status={availability()}
                    aria-label={`${capability.kind} availability`}
                  >
                    {availability()}
                  </output>
                </header>

                <Show
                  when={observed()}
                  fallback={
                    <p data-testid={`live-observed-${capability.id}`}>
                      No observation
                    </p>
                  }
                >
                  {(observation) => (
                    <>
                      <dl
                        class="teldra-selected-device-live__values"
                        data-testid={`live-observed-${capability.id}`}
                      >
                        <For each={Object.entries(observation().values)}>
                          {([name, value]) => (
                            <div>
                              <dt>{name}</dt>
                              <dd data-testid={`live-value-${name}`}>
                                {formatStateValue(value)}
                              </dd>
                            </div>
                          )}
                        </For>
                      </dl>
                      <p class="teldra-selected-device-live__timestamp">
                        Observed{" "}
                        <time dateTime={observation().observedAt}>
                          {observation().observedAt}
                        </time>
                      </p>
                    </>
                  )}
                </Show>
              </article>
            );
          }}
        </For>
      </div>
    </section>
  );
}

function formatStateValue(value: StateValue): string {
  switch (value.kind) {
    case "boolean":
      return value.value ? "on" : "off";
    case "number":
      return value.unit === undefined
        ? String(value.value)
        : `${value.value} ${value.unit}`;
    case "text":
      return value.value;
    case "rgb":
      return value.value.join(", ");
  }
}
