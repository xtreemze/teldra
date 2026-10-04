import { describe, expect, it } from "vitest";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import type { TwinProject } from "@teldra/domain";
import {
  encodeStoredZip,
  openTeldraArchive,
  sha256Bytes,
  type TeldraArchiveEntry,
} from "@teldra/project-format";
import {
  openBrowserTeldraProject,
  supportsBrowserTeldraFileAccess,
  type BrowserTeldraFileHandle,
  type BrowserWritableFile,
} from "./BrowserTeldraProject";

class MemoryFileHandle implements BrowserTeldraFileHandle {
  readonly name = "golden-home.teldra";
  #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes.slice();
  }

  async getFile(): Promise<Blob> {
    return new Blob([this.#bytes]);
  }

  async createWritable(): Promise<BrowserWritableFile> {
    let staged: Uint8Array | null = null;
    return {
      write: async (data) => {
        staged = data.slice();
      },
      close: async () => {
        if (staged === null) throw new Error("Nothing written.");
        this.#bytes = staged;
      },
      abort: async () => {
        staged = null;
      },
    };
  }

  bytes(): Uint8Array {
    return this.#bytes.slice();
  }
}

async function makeGoldenArchive(): Promise<{
  readonly handle: MemoryFileHandle;
  readonly buildingBytes: Uint8Array;
}> {
  const encoder = new TextEncoder();
  const twinBytes = encoder.encode(
    `${JSON.stringify(goldenTwin, null, 2)}\n`,
  );
  const buildingBytes = encoder.encode(
    "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
  );

  const manifest = {
    formatVersion: "0.1.0",
    building: {
      path: "building.ifc",
      sha256: await sha256Bytes(buildingBytes),
    },
    twin: {
      path: "twin.json",
      sha256: await sha256Bytes(twinBytes),
    },
    derived: [],
  };
  const projectBytes = encoder.encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const entries: TeldraArchiveEntry[] = [
    { path: "project.json", bytes: projectBytes },
    { path: "building.ifc", bytes: buildingBytes },
    { path: "twin.json", bytes: twinBytes },
  ];

  return {
    handle: new MemoryFileHandle(encodeStoredZip(entries)),
    buildingBytes,
  };
}

describe("browser .teldra project workflow", () => {
  it("opens, edits, saves, and reopens while preserving IFC bytes and canonical identity", async () => {
    const { handle, buildingBytes } = await makeGoldenArchive();
    const first = await openBrowserTeldraProject(handle, "test:first");
    const deviceId = "device:living-room-floor-lamp";

    expect(first.controller.twin.devices[0]?.id).toBe(deviceId);
    first.controller.renameDevice(deviceId, "Reading lamp");
    expect(first.controller.dirty).toBe(true);
    expect(first.controller.undo()).toBe(true);
    expect(first.controller.redo()).toBe(true);
    await first.controller.save();
    expect(first.controller.dirty).toBe(false);
    await first.close();

    const reopenedArchive = await openTeldraArchive(handle.bytes());
    expect(
      reopenedArchive.entries.find((entry) => entry.path === "building.ifc")?.bytes,
    ).toEqual(buildingBytes);

    const second = await openBrowserTeldraProject(handle, "test:second");
    expect(second.controller.twin.devices[0]?.id).toBe(deviceId);
    expect(second.controller.twin.devices[0]?.name).toBe("Reading lamp");
    expect(
      second.controller.twin.bindings[0]?.externalId,
    ).toBe("light.living_room_floor_lamp");
    await second.close();
  });

  it("reports direct file access capability without mutating project state", () => {
    expect(
      supportsBrowserTeldraFileAccess({
        showOpenFilePicker: async () => [],
      }),
    ).toBe(true);
    expect(supportsBrowserTeldraFileAccess({})).toBe(false);
    expect(supportsBrowserTeldraFileAccess(null)).toBe(false);
  });
});
