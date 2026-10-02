import { describe, expect, it } from "vitest";
import {
  TwinIntegrityError,
  assertTwinIntegrity,
  type TwinProject,
} from "../src/index.js";

function project(): TwinProject {
  return {
    schemaVersion: "0.1.0",
    building: {
      ifcSchema: "IFC4",
      refs: [
        {
          id: "room:living",
          ifcGlobalId: "3ZYNKvi3P3FvKPBGP9UP7n",
          kind: "space",
          name: "Living room",
        },
      ],
    },
    devices: [
      {
        id: "device:floor-lamp",
        name: "Floor lamp",
        buildingRefId: "room:living",
        capabilities: [{ id: "cap:floor-lamp-light", kind: "light" }],
      },
    ],
    bindings: [
      {
        id: "binding:ha-floor-lamp",
        deviceId: "device:floor-lamp",
        adapter: "home-assistant",
        externalId: "light.living_room_floor_lamp",
      },
    ],
  };
}

describe("assertTwinIntegrity", () => {
  it("accepts stable cross-layer references", () => {
    expect(() => assertTwinIntegrity(project())).not.toThrow();
  });

  it("rejects a canonical ID collision across building and device records", () => {
    const candidate = project();
    const invalid: TwinProject = {
      ...candidate,
      devices: [
        {
          ...candidate.devices[0]!,
          id: "room:living",
        },
      ],
    };

    expect(() => assertTwinIntegrity(invalid)).toThrow(/Duplicate canonical identity/);
  });

  it("rejects renderer-independent devices attached to missing BIM identity", () => {
    const candidate = project();
    const invalid: TwinProject = {
      ...candidate,
      devices: [
        {
          ...candidate.devices[0]!,
          buildingRefId: "room:missing",
        },
      ],
    };

    expect(() => assertTwinIntegrity(invalid)).toThrow(TwinIntegrityError);
  });

  it("rejects automation bindings that replace canonical device identity", () => {
    const candidate = project();
    const invalid: TwinProject = {
      ...candidate,
      bindings: [
        {
          ...candidate.bindings[0]!,
          deviceId: "light.living_room_floor_lamp",
        },
      ],
    };

    expect(() => assertTwinIntegrity(invalid)).toThrow(/unknown device/);
  });

  it("rejects adapter mappings for capabilities the device does not own", () => {
    const candidate = project();
    const invalid: TwinProject = {
      ...candidate,
      bindings: [
        {
          ...candidate.bindings[0]!,
          capabilityMap: {
            "cap:missing": "brightness",
          },
        },
      ],
    };

    expect(() => assertTwinIntegrity(invalid)).toThrow(/unknown capability/);
  });
});
