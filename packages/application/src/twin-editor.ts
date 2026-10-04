import {
  assertTwinIntegrity,
  type TwinProject,
} from "@teldra/domain";
import {
  CommandProcessor,
  type CanonicalCommand,
  type CommandCommit,
  type CommandHistoryStatus,
  type CommandResolver,
} from "./commands.js";

export type RenameTwinDeviceCommand = CanonicalCommand<
  "twin.device.rename",
  {
    readonly deviceId: string;
    readonly name: string;
  }
>;

export type TwinEditorCommand = RenameTwinDeviceCommand;

const resolveTwinEditorCommand: CommandResolver<TwinProject, TwinEditorCommand> =
  () => (state, command) => {
    switch (command.kind) {
      case "twin.device.rename": {
        const deviceIndex = state.devices.findIndex(
          (device) => device.id === command.payload.deviceId,
        );

        if (deviceIndex < 0) {
          throw new Error(
            `Cannot rename unknown device "${command.payload.deviceId}".`,
          );
        }

        if (command.payload.name.trim().length === 0) {
          throw new Error("Device name must not be empty.");
        }

        const previous = state.devices[deviceIndex];
        if (previous === undefined) {
          throw new Error(
            `Cannot resolve device "${command.payload.deviceId}".`,
          );
        }

        const devices = state.devices.map((device, index) =>
          index === deviceIndex
            ? { ...device, name: command.payload.name }
            : device,
        );

        const next: TwinProject = { ...state, devices };
        assertTwinIntegrity(next);

        return {
          state: next,
          inverse: {
            id: `inverse:${command.id}`,
            kind: "twin.device.rename",
            authority: "canonical-project",
            payload: {
              deviceId: previous.id,
              name: previous.name,
            },
            ...(command.correlationId === undefined
              ? {}
              : { correlationId: command.correlationId }),
          },
        };
      }
    }
  };

export class TwinEditor {
  readonly #processor: CommandProcessor<TwinProject, TwinEditorCommand>;
  #sequence = 0;

  constructor(initialTwin: TwinProject, initialRevision = 0) {
    assertTwinIntegrity(initialTwin);
    this.#processor = new CommandProcessor(
      structuredClone(initialTwin),
      resolveTwinEditorCommand,
      initialRevision,
    );
  }

  get twin(): Readonly<TwinProject> {
    return this.#processor.state;
  }

  get revision(): number {
    return this.#processor.revision;
  }

  get history(): CommandHistoryStatus {
    return this.#processor.history;
  }

  renameDevice(
    deviceId: string,
    name: string,
    correlationId?: string,
  ): CommandCommit<TwinProject, TwinEditorCommand> {
    this.#sequence += 1;

    return this.#processor.execute({
      id: `transaction:twin-device-rename:${this.#sequence}`,
      expectedRevision: this.#processor.revision,
      ...(correlationId === undefined ? {} : { correlationId }),
      commands: [
        {
          id: `command:twin-device-rename:${this.#sequence}`,
          kind: "twin.device.rename",
          authority: "canonical-project",
          payload: { deviceId, name },
          ...(correlationId === undefined ? {} : { correlationId }),
        },
      ],
    });
  }

  undo(): CommandCommit<TwinProject, TwinEditorCommand> | null {
    return this.#processor.undo();
  }

  redo(): CommandCommit<TwinProject, TwinEditorCommand> | null {
    return this.#processor.redo();
  }
}

export function canonicalTwinFingerprint(twin: TwinProject): string {
  assertTwinIntegrity(twin);
  return `canonical-json:${stableJson(twin)}`;
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }

  throw new Error(
    `Canonical twin contains unsupported value type "${typeof value}".`,
  );
}
