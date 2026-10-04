import type { Meta, StoryObj } from "storybook-solidjs-vite";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import {
  canonicalTwinFingerprint,
} from "@teldra/application";
import {
  assertTwinIntegrity,
  type TwinProject,
} from "@teldra/domain";
import {
  openProjectPersistence,
  type ProjectStorageAdapter,
  type StoredProject,
} from "@teldra/project-format";
import { StudioApp } from "./StudioApp";
import { StudioProjectController } from "./StudioProjectController";

class StoryStorage implements ProjectStorageAdapter<TwinProject> {
  primary: StoredProject<TwinProject>;
  staged: StoredProject<TwinProject> | null = null;
  locked = false;

  constructor(twin: TwinProject) {
    this.primary = {
      revision: 0,
      fingerprint: canonicalTwinFingerprint(twin),
      canonical: structuredClone(twin),
    };
  }

  async acquireWriteLock() {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  async releaseWriteLock() {
    this.locked = false;
  }

  async readPrimary() {
    return structuredClone(this.primary);
  }

  async readBackup() {
    return null;
  }

  async readRecovery() {
    return null;
  }

  async stagePrimary(
    _projectKey: string,
    _ownerId: string,
    project: StoredProject<TwinProject>,
  ) {
    this.staged = structuredClone(project);
    return "stage";
  }

  async commitStaged() {
    if (this.staged === null) {
      throw new Error("Missing story stage.");
    }
    this.primary = structuredClone(this.staged);
    this.staged = null;
  }

  async discardStaged() {
    this.staged = null;
  }

  async writeRecovery() {}

  async clearRecovery() {}
}

async function openGoldenHome() {
  const storage = new StoryStorage(
    structuredClone(goldenTwin) as TwinProject,
  );
  const opened = await openProjectPersistence(
    storage,
    assertTwinIntegrity,
    "golden-home",
    "storybook:studio-shell",
  );

  if (opened.primary === null) {
    throw new Error("Golden Home primary is missing.");
  }

  return {
    controller: new StudioProjectController(
      opened.primary.canonical,
      opened.session,
    ),
    displayName: "golden-home.teldra",
    projectKey: "golden-home",
    close: () => opened.session.close(),
  };
}

const meta = {
  title: "Studio/Application",
  component: StudioApp,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof StudioApp>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {
    browserProjectFilesSupported: true,
    openProject: openGoldenHome,
  },
};

export const UnsupportedBrowser: Story = {
  args: {
    browserProjectFilesSupported: false,
    openProject: openGoldenHome,
  },
};

export const GoldenHome: Story = {
  args: {
    browserProjectFilesSupported: true,
    openProject: openGoldenHome,
  },
};
