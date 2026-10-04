import { createSignal } from "solid-js";
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
import type { TwinViewportClientPoint } from "./TwinViewport";

const fixtureNodeKey = "ifc:fixture-wall:body";

class StoryFileHandle implements BrowserTeldraFileHandle {
  readonly name = "golden-home.teldra";
  #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes.slice();
  }

  async getFile(): Promise<Blob> {
    const buffer = new ArrayBuffer(this.#bytes.byteLength);
    new Uint8Array(buffer).set(this.#bytes);
    return new Blob([buffer]);
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
  const glbResponse = await fetch("/fixtures/twin-pick.glb");
  if (!glbResponse.ok) {
    throw new Error("Could not load the certified browser GLB fixture.");
  }
  const glbBytes = new Uint8Array(await glbResponse.arrayBuffer());
  const buildingSha256 = await sha256Bytes(buildingBytes);

  const sceneManifest = {
    schemaVersion: "0.1.0",
    coordinateSystem: {
      unit: "metre",
      handedness: "right",
      upAxis: "Z",
    },
    source: {
      buildingPath: "building.ifc",
      buildingSha256,
    },
    scene: {
      assetPath: "cache/scene.glb",
      assetSha256: await sha256Bytes(glbBytes),
      format: "glb",
      canonicalToScene: [
        1, 0, 0, 0,
        0, 0, -1, 0,
        0, 1, 0, 0,
        0, 0, 0, 1,
      ],
    },
    nodes: [
      {
        nodeKey: fixtureNodeKey,
        canonicalId: "wall:fixture",
        ifcGlobalId: "1234567890123456789012",
        kind: "building",
        renderPart: "body",
      },
    ],
  };
  const sceneBytes = encoder.encode(
    `${JSON.stringify(sceneManifest, null, 2)}\n`,
  );

  const manifest = {
    formatVersion: "0.1.0",
    building: {
      path: "building.ifc",
      sha256: buildingSha256,
    },
    twin: {
      path: "twin.json",
      sha256: await sha256Bytes(twinBytes),
    },
    derived: [
      {
        path: "scene.manifest.json",
        sha256: await sha256Bytes(sceneBytes),
      },
    ],
  };

  const entries: TeldraArchiveEntry[] = [
    {
      path: "project.json",
      bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
    },
    { path: "building.ifc", bytes: buildingBytes },
    { path: "twin.json", bytes: twinBytes },
    { path: "scene.manifest.json", bytes: sceneBytes },
    { path: "cache/scene.glb", bytes: glbBytes },
  ];

  return openBrowserTeldraProject(
    new StoryFileHandle(encodeStoredZip(entries)),
    "storybook:browser-project",
  );
}

function GoldenHomeBrowserHarness() {
  const [projected, setProjected] =
    createSignal<TwinViewportClientPoint | null>(null);

  return (
    <>
      <BrowserProjectStudio
        fileAccessSupported
        openProject={createStoryProject}
        onViewportReady={(handle) => {
          setProjected(handle.projectNode(fixtureNodeKey));
        }}
      />
      <output hidden aria-label="Browser project fixture pick position">
        <span data-testid="browser-project-projected-x">
          {projected()?.clientX ?? "pending"}
        </span>
        <span data-testid="browser-project-projected-y">
          {projected()?.clientY ?? "pending"}
        </span>
      </output>
    </>
  );
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
  render: () => <GoldenHomeBrowserHarness />,
};

export const UnsupportedBrowser: Story = {
  args: {
    fileAccessSupported: false,
  },
};
