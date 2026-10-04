import { createSignal, onMount, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import { canonicalTwinFingerprint } from "@teldra/application";
import {
  assertTwinIntegrity,
  type TwinProject,
} from "@teldra/domain";
import {
  openProjectPersistence,
  type ProjectStorageAdapter,
  type StoredProject,
} from "@teldra/project-format";
import { StudioProjectController } from "./StudioProjectController";
import {
  StudioSelectionWorkspace,
} from "./StudioSelectionWorkspace";
import type { TwinViewportClientPoint } from "./TwinViewport";

const fixture = goldenTwin as TwinProject;
const fixtureNodeKey = "ifc:fixture-wall:body";

const manifest = {
  schemaVersion: "0.1.0",
  coordinateSystem: {
    unit: "metre",
    handedness: "right",
    upAxis: "Z",
  },
  source: {
    buildingPath: "fixture.ifc",
    buildingSha256: "a".repeat(64),
  },
  scene: {
    assetPath: "/fixtures/twin-pick.glb",
    assetSha256: "b".repeat(64),
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

class StoryMemoryStorage implements ProjectStorageAdapter<TwinProject> {
  readonly #primary = new Map<string, StoredProject<TwinProject>>();
  readonly #backup = new Map<string, StoredProject<TwinProject>>();
  readonly #recovery = new Map<string, StoredProject<TwinProject>>();
  readonly #staged = new Map<string, StoredProject<TwinProject>>();
  readonly #locks = new Map<string, string>();
  #stage = 0;

  seed(projectKey: string, project: StoredProject<TwinProject>): void {
    this.#primary.set(projectKey, structuredClone(project));
  }

  async acquireWriteLock(projectKey: string, ownerId: string): Promise<boolean> {
    const owner = this.#locks.get(projectKey);
    if (owner !== undefined && owner !== ownerId) return false;
    this.#locks.set(projectKey, ownerId);
    return true;
  }

  async releaseWriteLock(projectKey: string, ownerId: string): Promise<void> {
    if (this.#locks.get(projectKey) === ownerId) {
      this.#locks.delete(projectKey);
    }
  }

  async readPrimary(projectKey: string) {
    return structuredClone(this.#primary.get(projectKey) ?? null);
  }

  async readBackup(projectKey: string) {
    return structuredClone(this.#backup.get(projectKey) ?? null);
  }

  async readRecovery(projectKey: string) {
    return structuredClone(this.#recovery.get(projectKey) ?? null);
  }

  async stagePrimary(
    projectKey: string,
    ownerId: string,
    project: StoredProject<TwinProject>,
  ): Promise<string> {
    this.#assertLock(projectKey, ownerId);
    const stageId = `stage:${++this.#stage}`;
    this.#staged.set(stageId, structuredClone(project));
    return stageId;
  }

  async commitStaged(
    projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void> {
    this.#assertLock(projectKey, ownerId);
    const next = this.#staged.get(stageId);
    if (next === undefined) throw new Error("Missing staged project.");

    const current = this.#primary.get(projectKey);
    if (current !== undefined) {
      this.#backup.set(projectKey, structuredClone(current));
    }

    this.#primary.set(projectKey, structuredClone(next));
    this.#staged.delete(stageId);
  }

  async discardStaged(
    projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void> {
    this.#assertLock(projectKey, ownerId);
    this.#staged.delete(stageId);
  }

  async writeRecovery(
    projectKey: string,
    ownerId: string,
    project: StoredProject<TwinProject>,
  ): Promise<void> {
    this.#assertLock(projectKey, ownerId);
    this.#recovery.set(projectKey, structuredClone(project));
  }

  async clearRecovery(projectKey: string, ownerId: string): Promise<void> {
    this.#assertLock(projectKey, ownerId);
    this.#recovery.delete(projectKey);
  }

  #assertLock(projectKey: string, ownerId: string): void {
    if (this.#locks.get(projectKey) !== ownerId) {
      throw new Error("Story storage write lock not held.");
    }
  }
}

function GoldenHomeSelectionHarness() {
  const [controller, setController] =
    createSignal<StudioProjectController | null>(null);
  const [projected, setProjected] =
    createSignal<TwinViewportClientPoint | null>(null);

  onMount(() => {
    void (async () => {
      const storage = new StoryMemoryStorage();
      storage.seed("golden-home", {
        revision: 0,
        fingerprint: canonicalTwinFingerprint(fixture),
        canonical: fixture,
      });

      const opened = await openProjectPersistence(
        storage,
        assertTwinIntegrity,
        "golden-home",
        "storybook:selection-workspace",
      );

      if (opened.primary === null) {
        throw new Error("Golden Home story primary is missing.");
      }

      setController(
        new StudioProjectController(
          opened.primary.canonical,
          opened.session,
        ),
      );
    })();
  });

  return (
    <>
      <Show
        when={controller()}
        fallback={<p data-testid="workspace-loading">Loading workspace…</p>}
      >
        {(ready) => (
          <StudioSelectionWorkspace
            controller={ready()}
            manifest={manifest}
            glbUrl="/fixtures/twin-pick.glb"
            onViewportReady={(handle) => {
              setProjected(handle.projectNode(fixtureNodeKey));
            }}
          />
        )}
      </Show>
      <output hidden aria-label="Workspace fixture pick position">
        <span data-testid="workspace-projected-x">
          {projected()?.clientX ?? "pending"}
        </span>
        <span data-testid="workspace-projected-y">
          {projected()?.clientY ?? "pending"}
        </span>
      </output>
    </>
  );
}

const meta = {
  title: "Studio/SelectionWorkspace",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const GoldenHome: Story = {
  render: () => <GoldenHomeSelectionHarness />,
};
