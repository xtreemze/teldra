import { createSignal, onMount, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import goldenTwin from "../../../fixtures/projects/golden-home/twin.json";
import { canonicalTwinFingerprint } from "@teldra/application";
import {
  HomeAssistantControlAdapter,
  HomeAssistantReadAdapter,
  type HomeAssistantMessageEvent,
  type HomeAssistantWebSocket,
} from "@teldra/home-assistant";
import {
  capabilityAuthorityKey,
  deviceAuthorityKey,
  type ControlAuthoritySnapshot,
} from "@teldra/control-policy";
import {
  assertTwinIntegrity,
  type TwinProject,
} from "@teldra/domain";
import {
  openProjectPersistence,
  type ProjectStorageAdapter,
  type StoredProject,
} from "@teldra/project-format";
import { StudioLiveStateController } from "./StudioLiveStateController";
import { StudioPhysicalControlController } from "./StudioPhysicalControlController";
import { StudioProjectController } from "./StudioProjectController";
import {
  StudioSelectionWorkspace,
} from "./StudioSelectionWorkspace";
import type { TwinViewportClientPoint } from "./TwinViewport";

const fixture = goldenTwin as TwinProject;
const fixtureNodeKey = "ifc:fixture-wall:body";
const fixtureDeviceId = "device:living-room-floor-lamp";
const fixtureCapabilityId = "capability:living-room-floor-lamp:light";

class StoryCommandSocket implements HomeAssistantWebSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Set<
    (event: HomeAssistantMessageEvent) => void
  >();

  send(data: string): void {
    this.sent.push(data);
  }

  addEventListener(
    _type: "message",
    listener: (event: HomeAssistantMessageEvent) => void,
  ): void {
    this.#listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: HomeAssistantMessageEvent) => void,
  ): void {
    this.#listeners.delete(listener);
  }
}

function authorizedStoryControlState(): ControlAuthoritySnapshot {
  return {
    revision: 1,
    adapters: {
      "home-assistant": {
        read: true,
        control: true,
        connection: "connected",
        connectionRevision: 1,
      },
    },
    devices: {
      [deviceAuthorityKey("home-assistant", fixtureDeviceId)]: {
        read: true,
        control: true,
      },
    },
    capabilities: {
      [capabilityAuthorityKey(
        "home-assistant",
        fixtureDeviceId,
        fixtureCapabilityId,
      )]: {
        read: true,
        control: true,
      },
    },
    sessions: {
      "session:storybook": {
        sessionId: "session:storybook",
        allowedOrigins: ["studio"],
        userPresent: true,
      },
    },
  };
}

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

function GoldenHomeSelectionHarness(props: { readonly physicalControl?: boolean } = {}) {
  const [controller, setController] =
    createSignal<StudioProjectController | null>(null);
  const [projected, setProjected] =
    createSignal<TwinViewportClientPoint | null>(null);
  const liveState = new StudioLiveStateController();
  const homeAssistant = new HomeAssistantReadAdapter(fixture, {
    onEnvelope: (envelope) => liveState.apply(envelope),
    now: () => "2026-10-04T12:00:00Z",
  });

  const controlAuthority = authorizedStoryControlState();
  const commandSocket = new StoryCommandSocket();
  const commandAdapter = new HomeAssistantControlAdapter(fixture, {
    authority: () => controlAuthority,
    onEnvelope: (envelope) => liveState.apply(envelope),
    now: () => "2026-10-04T12:00:05Z",
    requestIdStart: 200,
  });
  commandAdapter.attach(commandSocket);

  let commandSequence = 0;
  const physicalControl = new StudioPhysicalControlController(commandAdapter, {
    sessionId: "session:storybook",
    authority: () => controlAuthority,
    now: () => "2026-10-04T12:00:05Z",
    createCommandId: () => `command:storybook:${++commandSequence}`,
    createCorrelationId: () => "correlation:storybook-light",
  });

  const injectOnline = () => {
    homeAssistant.ingestState({
      entity_id: "light.living_room_floor_lamp",
      state: "on",
      attributes: {
        brightness: 128,
        rgb_color: [255, 128, 0],
      },
      last_changed: "2026-10-04T11:59:59Z",
    });
  };

  const injectUnavailable = () => {
    homeAssistant.ingestState({
      entity_id: "light.living_room_floor_lamp",
      state: "unavailable",
      attributes: {},
      last_changed: "2026-10-04T12:01:00Z",
    });
  };

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

      const studioController = new StudioProjectController(
        opened.primary.canonical,
        opened.session,
      );
      if (props.physicalControl === true) {
        studioController.selectCanonicalId(fixtureDeviceId);
      }
      setController(studioController);
      injectOnline();
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
            liveState={liveState}
            {...(props.physicalControl === true
              ? { physicalControl }
              : {})}
            onViewportReady={(handle) => {
              setProjected(handle.projectNode(fixtureNodeKey));
            }}
          />
        )}
      </Show>
      <Show when={props.physicalControl === true}>
        <output hidden data-testid="story-last-service-call">
          {commandSocket.sent.at(-1) ?? ""}
        </output>
      </Show>
      <aside aria-label="Story fixture controls">
        <button type="button" data-testid="inject-live-online" onClick={injectOnline}>
          Inject live online
        </button>
        <button
          type="button"
          data-testid="inject-live-unavailable"
          onClick={injectUnavailable}
        >
          Inject live unavailable
        </button>
      </aside>
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

export const AuthorizedLightControl: Story = {
  render: () => <GoldenHomeSelectionHarness physicalControl />,
};
