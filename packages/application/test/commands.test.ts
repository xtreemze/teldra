import { describe, expect, it } from "vitest";
import {
  CommandConflictError,
  CommandContractError,
  CommandProcessor,
  CommandTransactionError,
  type CanonicalCommand,
  type CommandResolver,
} from "../src/index.js";

interface FixtureState {
  devices: Readonly<Record<string, { readonly name: string }>>;
  placements: Readonly<
    Record<string, { readonly x: number; readonly y: number; readonly z: number }>
  >;
  bindings: Readonly<
    Record<string, { readonly deviceId: string; readonly externalId: string }>
  >;
}

type CreateDevice = CanonicalCommand<
  "twin.device.create",
  { readonly deviceId: string; readonly name: string }
>;
type DeleteDevice = CanonicalCommand<
  "twin.device.delete",
  { readonly deviceId: string }
>;
type EditDevice = CanonicalCommand<
  "twin.device.edit",
  { readonly deviceId: string; readonly name: string }
>;
type MoveIfc = CanonicalCommand<
  "ifc.element.move",
  {
    readonly ifcGlobalId: string;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }
>;
type BindDevice = CanonicalCommand<
  "twin.binding.bind",
  {
    readonly bindingId: string;
    readonly deviceId: string;
    readonly externalId: string;
  }
>;
type UnbindDevice = CanonicalCommand<
  "twin.binding.unbind",
  { readonly bindingId: string }
>;

type FixtureCommand =
  | CreateDevice
  | DeleteDevice
  | EditDevice
  | MoveIfc
  | BindDevice
  | UnbindDevice;

const initialState: FixtureState = {
  devices: {},
  placements: {
    "3vK8JfH0L0Exxxxxxxxxxx": { x: 0, y: 0, z: 0 },
  },
  bindings: {},
};

const resolve: CommandResolver<FixtureState, FixtureCommand> = () =>
  (state, command) => {
    switch (command.kind) {
      case "twin.device.create": {
        if (state.devices[command.payload.deviceId] !== undefined) {
          throw new Error("device already exists");
        }

        return {
          state: {
            ...state,
            devices: {
              ...state.devices,
              [command.payload.deviceId]: { name: command.payload.name },
            },
          },
          inverse: {
            id: `inverse:${command.id}`,
            kind: "twin.device.delete",
            authority: "canonical-project",
            payload: { deviceId: command.payload.deviceId },
          },
        };
      }

      case "twin.device.delete": {
        const existing = state.devices[command.payload.deviceId];
        if (existing === undefined) {
          throw new Error("device does not exist");
        }

        const devices = { ...state.devices };
        delete devices[command.payload.deviceId];

        return {
          state: { ...state, devices },
          inverse: {
            id: `inverse:${command.id}`,
            kind: "twin.device.create",
            authority: "canonical-project",
            payload: {
              deviceId: command.payload.deviceId,
              name: existing.name,
            },
          },
        };
      }

      case "twin.device.edit": {
        const existing = state.devices[command.payload.deviceId];
        if (existing === undefined) {
          throw new Error("device does not exist");
        }

        return {
          state: {
            ...state,
            devices: {
              ...state.devices,
              [command.payload.deviceId]: { name: command.payload.name },
            },
          },
          inverse: {
            id: `inverse:${command.id}`,
            kind: "twin.device.edit",
            authority: "canonical-project",
            payload: {
              deviceId: command.payload.deviceId,
              name: existing.name,
            },
          },
        };
      }

      case "ifc.element.move": {
        const existing = state.placements[command.payload.ifcGlobalId];
        if (existing === undefined) {
          throw new Error("IFC element does not exist");
        }

        return {
          state: {
            ...state,
            placements: {
              ...state.placements,
              [command.payload.ifcGlobalId]: {
                x: command.payload.x,
                y: command.payload.y,
                z: command.payload.z,
              },
            },
          },
          inverse: {
            id: `inverse:${command.id}`,
            kind: "ifc.element.move",
            authority: "canonical-ifc",
            payload: {
              ifcGlobalId: command.payload.ifcGlobalId,
              ...existing,
            },
          },
        };
      }

      case "twin.binding.bind": {
        if (state.bindings[command.payload.bindingId] !== undefined) {
          throw new Error("binding already exists");
        }
        if (state.devices[command.payload.deviceId] === undefined) {
          throw new Error("device does not exist");
        }

        return {
          state: {
            ...state,
            bindings: {
              ...state.bindings,
              [command.payload.bindingId]: {
                deviceId: command.payload.deviceId,
                externalId: command.payload.externalId,
              },
            },
          },
          inverse: {
            id: `inverse:${command.id}`,
            kind: "twin.binding.unbind",
            authority: "canonical-project",
            payload: { bindingId: command.payload.bindingId },
          },
        };
      }

      case "twin.binding.unbind": {
        const existing = state.bindings[command.payload.bindingId];
        if (existing === undefined) {
          throw new Error("binding does not exist");
        }

        const bindings = { ...state.bindings };
        delete bindings[command.payload.bindingId];

        return {
          state: { ...state, bindings },
          inverse: {
            id: `inverse:${command.id}`,
            kind: "twin.binding.bind",
            authority: "canonical-project",
            payload: {
              bindingId: command.payload.bindingId,
              deviceId: existing.deviceId,
              externalId: existing.externalId,
            },
          },
        };
      }
    }
  };

function canonicalTransaction() {
  return {
    id: "transaction:author-home",
    expectedRevision: 0,
    commands: [
      {
        id: "command:create-lamp",
        kind: "twin.device.create",
        authority: "canonical-project",
        payload: { deviceId: "device:lamp", name: "Floor lamp" },
      },
      {
        id: "command:move-wall",
        kind: "ifc.element.move",
        authority: "canonical-ifc",
        payload: {
          ifcGlobalId: "3vK8JfH0L0Exxxxxxxxxxx",
          x: 1.25,
          y: 2.5,
          z: 0,
        },
      },
      {
        id: "command:rename-lamp",
        kind: "twin.device.edit",
        authority: "canonical-project",
        payload: { deviceId: "device:lamp", name: "Reading lamp" },
      },
      {
        id: "command:bind-lamp",
        kind: "twin.binding.bind",
        authority: "canonical-project",
        payload: {
          bindingId: "binding:lamp",
          deviceId: "device:lamp",
          externalId: "light.reading_lamp",
        },
      },
    ],
  } as const;
}

describe("canonical command processor", () => {
  it("applies create, move, edit, and bind operations atomically", () => {
    const processor = new CommandProcessor(initialState, resolve);

    const commit = processor.execute(canonicalTransaction());

    expect(commit.direction).toBe("execute");
    expect(commit.revisionBefore).toBe(0);
    expect(commit.revisionAfter).toBe(1);
    expect(processor.state).toEqual({
      devices: {
        "device:lamp": { name: "Reading lamp" },
      },
      placements: {
        "3vK8JfH0L0Exxxxxxxxxxx": { x: 1.25, y: 2.5, z: 0 },
      },
      bindings: {
        "binding:lamp": {
          deviceId: "device:lamp",
          externalId: "light.reading_lamp",
        },
      },
    });
  });

  it("undoes and redoes the complete transaction deterministically", () => {
    const processor = new CommandProcessor(initialState, resolve);

    processor.execute(canonicalTransaction());
    const authoredState = processor.state;

    const undoCommit = processor.undo();
    expect(undoCommit?.direction).toBe("undo");
    expect(processor.state).toEqual(initialState);
    expect(processor.history).toMatchObject({
      revision: 2,
      canUndo: false,
      canRedo: true,
      undoDepth: 0,
      redoDepth: 1,
    });

    const redoCommit = processor.redo();
    expect(redoCommit?.direction).toBe("redo");
    expect(processor.state).toEqual(authoredState);
    expect(processor.revision).toBe(3);
  });

  it("does not publish partial state when a command fails", () => {
    const processor = new CommandProcessor(initialState, resolve);

    expect(() =>
      processor.execute({
        id: "transaction:fails",
        commands: [
          {
            id: "command:create",
            kind: "twin.device.create",
            authority: "canonical-project",
            payload: { deviceId: "device:temp", name: "Temporary" },
          },
          {
            id: "command:edit-missing",
            kind: "twin.device.edit",
            authority: "canonical-project",
            payload: { deviceId: "device:missing", name: "Missing" },
          },
        ],
      }),
    ).toThrow(CommandTransactionError);

    expect(processor.state).toEqual(initialState);
    expect(processor.revision).toBe(0);
    expect(processor.history.undoDepth).toBe(0);
  });

  it("rejects stale expected revisions before mutation", () => {
    const processor = new CommandProcessor(initialState, resolve);

    expect(() =>
      processor.execute({
        ...canonicalTransaction(),
        expectedRevision: 4,
      }),
    ).toThrow(CommandConflictError);

    expect(processor.revision).toBe(0);
  });

  it("rejects duplicate committed transaction ids", () => {
    const processor = new CommandProcessor(initialState, resolve);

    processor.execute(canonicalTransaction());
    processor.undo();

    expect(() =>
      processor.execute({
        ...canonicalTransaction(),
        expectedRevision: processor.revision,
      }),
    ).toThrow(CommandContractError);
  });

  it("rejects presentation or live-state authority at runtime", () => {
    const processor = new CommandProcessor(initialState, resolve);

    const invalidCameraCommand = {
      id: "command:camera",
      kind: "viewport.camera.move",
      authority: "camera-viewport",
      payload: { x: 10 },
    } as unknown as FixtureCommand;

    expect(() =>
      processor.execute({
        id: "transaction:camera",
        commands: [invalidCameraCommand],
      }),
    ).toThrow(CommandContractError);

    const invalidPhysicalCommand = {
      id: "command:physical-light",
      kind: "device.light.set",
      authority: "live-device",
      payload: { brightness: 0.4 },
    } as unknown as FixtureCommand;

    expect(() =>
      processor.execute({
        id: "transaction:physical",
        commands: [invalidPhysicalCommand],
      }),
    ).toThrow(CommandContractError);
  });

  it("requires JSON-safe command payloads for cross-runtime transport", () => {
    const processor = new CommandProcessor(initialState, resolve);

    const invalid = {
      id: "command:not-json",
      kind: "twin.device.edit",
      authority: "canonical-project",
      payload: { callback: () => undefined },
    } as unknown as FixtureCommand;

    expect(() =>
      processor.execute({
        id: "transaction:not-json",
        commands: [invalid],
      }),
    ).toThrow(CommandContractError);
  });
});
