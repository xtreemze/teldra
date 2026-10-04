import type { Meta, StoryObj } from "storybook-solidjs-vite";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import {
  encodeStoredZip,
  sha256Bytes,
  type TeldraArchiveEntry,
} from "@teldra/project-format";
import {
  openBrowserTeldraProject,
  type BrowserTeldraFileHandle,
  type BrowserWritableFile,
} from "./BrowserTeldraProject";
import { BrowserProjectStudio } from "./BrowserProjectStudio";

class StoryFileHandle implements BrowserTeldraFileHandle {
  readonly name = "golden-home.teldra";
  #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes.slice();
  }

  async getFile(): Promise<Blob> {
    const copy = this.#bytes.slice();
    return new Blob([copy.buffer]);
  }

  async createWritable(): Promise<BrowserWritableFile> {
    let staged: Uint8Array | null = null;
    return {
      write: async (data) => {
        staged = data.slice();
      },
      close: async () => {
        if (staged === null) {
          throw new Error("Story file handle received no bytes.");
        }
        this.#bytes = staged;
      },
      abort: async () => {
        staged = null;
      },
    };
  }
}

async function createStoryProject() {
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
  const entries: TeldraArchiveEntry[] = [
    {
      path: "project.json",
      bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
    },
    { path: "building.ifc", bytes: buildingBytes },
    { path: "twin.json", bytes: twinBytes },
  ];
  const handle = new StoryFileHandle(encodeStoredZip(entries));

  return openBrowserTeldraProject(handle, "storybook:browser-project");
}

const meta = {
  title: "Studio/BrowserProjectStudio",
  component: BrowserProjectStudio,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof BrowserProjectStudio>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GoldenHome: Story = {
  args: {
    fileAccessSupported: true,
    openProject: createStoryProject,
  },
};

export const UnsupportedBrowser: Story = {
  args: {
    fileAccessSupported: false,
  },
};
