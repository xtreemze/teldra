import { describe, expect, it } from "vitest";
import type { TwinProject } from "@teldra/domain";
import { createTwinProjection } from "../src/index.js";

describe("createTwinProjection", () => {
  it("preserves canonical and IFC identity without leaking adapter identity", () => {
    const project: TwinProject = {
      schemaVersion: "0.1.0",
      building: {
        ifcSchema: "IFC4",
        refs: [
          {
            id: "room:kitchen",
            ifcGlobalId: "0ufYQjmwP0Ah$QRRxVbqR3",
            kind: "space",
          },
        ],
      },
      devices: [
        {
          id: "device:kitchen-light",
          name: "Kitchen light",
          buildingRefId: "room:kitchen",
          capabilities: [{ id: "cap:kitchen-light", kind: "light" }],
        },
      ],
      bindings: [
        {
          id: "binding:kitchen-light-ha",
          deviceId: "device:kitchen-light",
          adapter: "home-assistant",
          externalId: "light.kitchen",
        },
      ],
    };

    const projection = createTwinProjection(project);

    expect(projection.objects).toEqual([
      {
        canonicalId: "room:kitchen",
        source: {
          kind: "building",
          ifcGlobalId: "0ufYQjmwP0Ah$QRRxVbqR3",
          elementKind: "space",
        },
      },
      {
        canonicalId: "device:kitchen-light",
        source: {
          kind: "device",
          buildingRefId: "room:kitchen",
          capabilities: ["light"],
        },
      },
    ]);

    expect(JSON.stringify(projection)).not.toContain("light.kitchen");
  });
});
