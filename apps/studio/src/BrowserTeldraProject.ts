import { canonicalTwinFingerprint } from "@teldra/application";
import { assertTwinIntegrity, type TwinProject } from "@teldra/domain";
import {
  openProjectPersistence,
  openTeldraArchive,
  replaceTeldraTwin,
  sha256Bytes,
  type OpenTeldraArchive,
  type ProjectStorageAdapter,
  type StoredProject,
} from "@teldra/project-format";
import {
  parseSceneManifest,
  type TeldraSceneManifest,
} from "@teldra/scene-manifest";
import { StudioProjectController } from "./StudioProjectController";

export interface BrowserWritableFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface BrowserTeldraFileHandle {
  readonly name: string;
  getFile(): Promise<Blob>;
  createWritable(): Promise<BrowserWritableFile>;
}

export interface BrowserRecoveryStore {
  get(
    slot: "backup" | "recovery",
    projectKey: string,
  ): Promise<StoredProject<TwinProject> | null>;
  set(
    slot: "backup" | "recovery",
    projectKey: string,
    project: StoredProject<TwinProject>,
  ): Promise<void>;
  delete(
    slot: "backup" | "recovery",
    projectKey: string,
  ): Promise<void>;
}

interface BrowserFilePickerOptions {
  readonly multiple?: boolean;
  readonly types?: readonly {
    readonly description?: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
  }[];
}

interface FilePickerHost {
  showOpenFilePicker?: (
    options?: BrowserFilePickerOptions,
  ) => Promise<readonly BrowserTeldraFileHandle[]>;
}

interface StagedWrite {
  readonly stored: StoredProject<TwinProject>;
  readonly bytes: Uint8Array;
  readonly archive: OpenTeldraArchive;
}

export interface BrowserAssetUrlFactory {
  create(bytes: Uint8Array, mediaType: string): string;
  revoke(url: string): void;
}

export interface BrowserStudioScene {
  readonly manifest: TeldraSceneManifest;
  readonly glbUrl: string;
}

export interface BrowserStudioProject {
  readonly fileName: string;
  readonly projectKey: string;
  readonly controller: StudioProjectController;
  readonly scene?: BrowserStudioScene;
  close(): Promise<void>;
}

interface BrowserStudioSceneResource {
  readonly scene: BrowserStudioScene;
  dispose(): void;
}

const inProcessLocks = new Map<string, string>();
const memoryRecoveryValues = new Map<string, StoredProject<TwinProject>>();

export class MemoryBrowserRecoveryStore implements BrowserRecoveryStore {
  async get(
    slot: "backup" | "recovery",
    projectKey: string,
  ): Promise<StoredProject<TwinProject> | null> {
    const value = memoryRecoveryValues.get(`${slot}:${projectKey}`);
    return value === undefined ? null : structuredClone(value);
  }

  async set(
    slot: "backup" | "recovery",
    projectKey: string,
    project: StoredProject<TwinProject>,
  ): Promise<void> {
    memoryRecoveryValues.set(
      `${slot}:${projectKey}`,
      structuredClone(project),
    );
  }

  async delete(
    slot: "backup" | "recovery",
    projectKey: string,
  ): Promise<void> {
    memoryRecoveryValues.delete(`${slot}:${projectKey}`);
  }
}

export class IndexedDbBrowserRecoveryStore implements BrowserRecoveryStore {
  readonly #databaseName: string;

  constructor(databaseName = "teldra-studio-recovery-v1") {
    this.#databaseName = databaseName;
  }

  async get(
    slot: "backup" | "recovery",
    projectKey: string,
  ): Promise<StoredProject<TwinProject> | null> {
    const database = await this.#open();
    try {
      const transaction = database.transaction("projects", "readonly");
      const result = await requestResult(
        transaction.objectStore("projects").get(this.#key(slot, projectKey)),
      );
      await transactionDone(transaction);
      return result === undefined
        ? null
        : (structuredClone(result) as StoredProject<TwinProject>);
    } finally {
      database.close();
    }
  }

  async set(
    slot: "backup" | "recovery",
    projectKey: string,
    project: StoredProject<TwinProject>,
  ): Promise<void> {
    const database = await this.#open();
    try {
      const transaction = database.transaction("projects", "readwrite");
      transaction
        .objectStore("projects")
        .put(structuredClone(project), this.#key(slot, projectKey));
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async delete(
    slot: "backup" | "recovery",
    projectKey: string,
  ): Promise<void> {
    const database = await this.#open();
    try {
      const transaction = database.transaction("projects", "readwrite");
      transaction
        .objectStore("projects")
        .delete(this.#key(slot, projectKey));
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async #open(): Promise<IDBDatabase> {
    if (globalThis.indexedDB === undefined) {
      throw new Error(
        "IndexedDB is unavailable; browser recovery storage cannot be opened.",
      );
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.#databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("projects")) {
          database.createObjectStore("projects");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          request.error ??
            new Error("Could not open Teldra recovery database."),
        );
    });
  }

  #key(slot: "backup" | "recovery", projectKey: string): string {
    return `${slot}:${projectKey}`;
  }
}

export class BrowserTeldraFileStorage
  implements ProjectStorageAdapter<TwinProject>
{
  readonly #handle: BrowserTeldraFileHandle;
  readonly #recoveryStore: BrowserRecoveryStore;
  readonly #projectKey: string;
  #archive: OpenTeldraArchive;
  #revision = 0;
  #lockOwner: string | null = null;
  #releaseWebLock: (() => void) | null = null;
  #webLockTask: Promise<void> | null = null;
  readonly #staged = new Map<string, StagedWrite>();
  #stageSequence = 0;

  private constructor(
    handle: BrowserTeldraFileHandle,
    archive: OpenTeldraArchive,
    recoveryStore: BrowserRecoveryStore,
  ) {
    this.#handle = handle;
    this.#archive = archive;
    this.#recoveryStore = recoveryStore;
    this.#projectKey = [
      "teldra",
      handle.name,
      archive.manifest.building.sha256,
    ].join(":");
  }

  static async open(
    handle: BrowserTeldraFileHandle,
    recoveryStore: BrowserRecoveryStore = defaultRecoveryStore(),
  ): Promise<BrowserTeldraFileStorage> {
    const file = await handle.getFile();
    const archive = await openTeldraArchive(
      new Uint8Array(await file.arrayBuffer()),
    );
    return new BrowserTeldraFileStorage(handle, archive, recoveryStore);
  }

  get archive(): OpenTeldraArchive {
    return this.#archive;
  }

  get projectKey(): string {
    return this.#projectKey;
  }

  async acquireWriteLock(
    projectKey: string,
    ownerId: string,
  ): Promise<boolean> {
    this.#assertProjectKey(projectKey);

    if (this.#lockOwner === ownerId) {
      return true;
    }
    if (this.#lockOwner !== null) {
      return false;
    }

    const locks = globalThis.navigator?.locks;
    if (locks !== undefined) {
      let resolveAcquired!: (value: boolean) => void;
      const acquired = new Promise<boolean>((resolve) => {
        resolveAcquired = resolve;
      });

      let resolveRelease!: () => void;
      const held = new Promise<void>((resolve) => {
        resolveRelease = resolve;
      });

      this.#webLockTask = locks
        .request(
          `teldra-project:${projectKey}`,
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            if (lock === null) {
              resolveAcquired(false);
              return;
            }

            this.#lockOwner = ownerId;
            this.#releaseWebLock = resolveRelease;
            resolveAcquired(true);
            await held;
          },
        )
        .then(
          () => undefined,
          () => {
            resolveAcquired(false);
          },
        );

      return acquired;
    }

    const current = inProcessLocks.get(projectKey);
    if (current !== undefined && current !== ownerId) {
      return false;
    }

    inProcessLocks.set(projectKey, ownerId);
    this.#lockOwner = ownerId;
    return true;
  }

  async releaseWriteLock(
    projectKey: string,
    ownerId: string,
  ): Promise<void> {
    this.#assertProjectKey(projectKey);
    if (this.#lockOwner !== ownerId) {
      return;
    }

    this.#lockOwner = null;

    if (this.#releaseWebLock !== null) {
      const release = this.#releaseWebLock;
      this.#releaseWebLock = null;
      release();
      try {
        await this.#webLockTask;
      } finally {
        this.#webLockTask = null;
      }
      return;
    }

    if (inProcessLocks.get(projectKey) === ownerId) {
      inProcessLocks.delete(projectKey);
    }
  }

  async readPrimary(
    projectKey: string,
  ): Promise<StoredProject<TwinProject>> {
    this.#assertProjectKey(projectKey);
    return this.#storedProject(this.#archive.twin, this.#revision);
  }

  async readBackup(
    projectKey: string,
  ): Promise<StoredProject<TwinProject> | null> {
    this.#assertProjectKey(projectKey);
    return this.#recoveryStore.get("backup", projectKey);
  }

  async readRecovery(
    projectKey: string,
  ): Promise<StoredProject<TwinProject> | null> {
    this.#assertProjectKey(projectKey);
    return this.#recoveryStore.get("recovery", projectKey);
  }

  async stagePrimary(
    projectKey: string,
    ownerId: string,
    project: StoredProject<TwinProject>,
  ): Promise<string> {
    this.#assertWriteOwner(projectKey, ownerId);
    const replacement = await replaceTeldraTwin(
      this.#archive,
      project.canonical,
    );
    const stageId = `browser-stage:${++this.#stageSequence}`;
    this.#staged.set(stageId, {
      stored: structuredClone(project),
      bytes: replacement.bytes,
      archive: replacement.archive,
    });
    return stageId;
  }

  async commitStaged(
    projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void> {
    this.#assertWriteOwner(projectKey, ownerId);
    const staged = this.#staged.get(stageId);
    if (staged === undefined) {
      throw new Error(`Unknown browser save stage "${stageId}".`);
    }

    const previous = this.#storedProject(this.#archive.twin, this.#revision);
    await this.#recoveryStore.set("backup", projectKey, previous);

    const writable = await this.#handle.createWritable();
    try {
      await writable.write(staged.bytes);
      await writable.close();
    } catch (error) {
      try {
        await writable.abort?.(error);
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }

    this.#archive = staged.archive;
    this.#revision = staged.stored.revision;
    this.#staged.delete(stageId);
  }

  async discardStaged(
    projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void> {
    this.#assertWriteOwner(projectKey, ownerId);
    this.#staged.delete(stageId);
  }

  async writeRecovery(
    projectKey: string,
    ownerId: string,
    project: StoredProject<TwinProject>,
  ): Promise<void> {
    this.#assertWriteOwner(projectKey, ownerId);
    assertTwinIntegrity(project.canonical);
    await this.#recoveryStore.set(
      "recovery",
      projectKey,
      structuredClone(project),
    );
  }

  async clearRecovery(
    projectKey: string,
    ownerId: string,
  ): Promise<void> {
    this.#assertWriteOwner(projectKey, ownerId);
    await this.#recoveryStore.delete("recovery", projectKey);
  }

  #storedProject(
    twin: TwinProject,
    revision: number,
  ): StoredProject<TwinProject> {
    return {
      revision,
      fingerprint: canonicalTwinFingerprint(twin),
      canonical: structuredClone(twin),
    };
  }

  #assertProjectKey(projectKey: string): void {
    if (projectKey !== this.#projectKey) {
      throw new Error(
        `Browser project adapter does not own "${projectKey}".`,
      );
    }
  }

  #assertWriteOwner(projectKey: string, ownerId: string): void {
    this.#assertProjectKey(projectKey);
    if (this.#lockOwner !== ownerId) {
      throw new Error(
        `Browser project write lock for "${projectKey}" is not held by "${ownerId}".`,
      );
    }
  }
}

export function supportsBrowserTeldraFileAccess(
  host: unknown = globalThis,
): boolean {
  return (
    typeof host === "object" &&
    host !== null &&
    "showOpenFilePicker" in host &&
    typeof (host as FilePickerHost).showOpenFilePicker === "function"
  );
}

export async function pickBrowserTeldraFile(
  host: unknown = globalThis,
): Promise<BrowserTeldraFileHandle> {
  if (!supportsBrowserTeldraFileAccess(host)) {
    throw new Error(
      "This browser does not expose the File System Access API required for direct .teldra editing.",
    );
  }

  const picker = (host as FilePickerHost).showOpenFilePicker;
  if (picker === undefined) {
    throw new Error("File picker capability disappeared before use.");
  }

  try {
    const handles = await picker({
      multiple: false,
      types: [
        {
          description: "Teldra project",
          accept: {
            "application/zip": [".teldra"],
          },
        },
      ],
    });

    const handle = handles[0];
    if (handle === undefined) {
      throw new Error("No .teldra file was selected.");
    }
    return handle;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Project selection was cancelled.", { cause: error });
    }
    throw error;
  }
}

export async function openBrowserTeldraProject(
  handle: BrowserTeldraFileHandle,
  ownerId: string,
  recoveryStore?: BrowserRecoveryStore,
  assetUrlFactory: BrowserAssetUrlFactory = defaultAssetUrlFactory(),
): Promise<BrowserStudioProject> {
  const storage = await BrowserTeldraFileStorage.open(handle, recoveryStore);
  const opened = await openProjectPersistence(
    storage,
    assertTwinIntegrity,
    storage.projectKey,
    ownerId,
  );

  if (opened.primary === null) {
    await opened.session.close();
    throw new Error(`Project "${handle.name}" contains no canonical twin.`);
  }

  try {
    const sceneResource = await resolveBrowserStudioScene(
      storage.archive,
      assetUrlFactory,
    );
    const controller = new StudioProjectController(
      opened.primary.canonical,
      opened.session,
    );

    return {
      fileName: handle.name,
      projectKey: storage.projectKey,
      controller,
      ...(sceneResource === null ? {} : { scene: sceneResource.scene }),
      close: async () => {
        try {
          await opened.session.close();
        } finally {
          sceneResource?.dispose();
        }
      },
    };
  } catch (error) {
    await opened.session.close();
    throw error;
  }
}

export async function openBrowserTeldraProjectWithPicker(
  ownerId: string,
  host: unknown = globalThis,
): Promise<BrowserStudioProject> {
  const handle = await pickBrowserTeldraFile(host);
  return openBrowserTeldraProject(handle, ownerId);
}


async function resolveBrowserStudioScene(
  archive: OpenTeldraArchive,
  assetUrlFactory: BrowserAssetUrlFactory,
): Promise<BrowserStudioSceneResource | null> {
  const derivedPaths = archive.manifest.derived?.map((artifact) => artifact.path) ?? [];
  const conventionalPath = derivedPaths.find(
    (path) => path === "scene.manifest.json" || path.endsWith("/scene.manifest.json"),
  );

  let manifest: TeldraSceneManifest | null = null;
  let manifestPath: string | null = null;

  if (conventionalPath !== undefined) {
    const entry = archive.entries.find((candidate) => candidate.path === conventionalPath);
    if (entry === undefined) {
      throw new Error(
        `Scene manifest "${conventionalPath}" is referenced by the project but missing from the archive.`,
      );
    }

    manifest = parseSceneManifest(parseArchiveJson(entry.bytes, conventionalPath));
    manifestPath = conventionalPath;
  } else {
    for (const path of derivedPaths) {
      const entry = archive.entries.find((candidate) => candidate.path === path);
      if (entry === undefined) continue;

      try {
        const candidate = parseSceneManifest(parseArchiveJson(entry.bytes, path));
        if (manifest !== null) {
          throw new Error(
            `Project contains more than one valid scene manifest ("${manifestPath}" and "${path}").`,
          );
        }
        manifest = candidate;
        manifestPath = path;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Project contains more than one valid scene manifest")
        ) {
          throw error;
        }
        // Other derived manifests are expected not to match the scene schema.
      }
    }
  }

  if (manifest === null) {
    return null;
  }

  const glb = archive.entries.find(
    (entry) => entry.path === manifest.scene.assetPath,
  );
  if (glb === undefined) {
    throw new Error(
      `Scene manifest "${manifestPath}" references missing GLB "${manifest.scene.assetPath}".`,
    );
  }

  const actualSha256 = await sha256Bytes(glb.bytes);
  if (actualSha256 !== manifest.scene.assetSha256) {
    throw new Error(
      `Scene GLB "${manifest.scene.assetPath}" SHA-256 mismatch: expected ${manifest.scene.assetSha256}, got ${actualSha256}.`,
    );
  }

  const glbUrl = assetUrlFactory.create(glb.bytes, "model/gltf-binary");
  return {
    scene: {
      manifest,
      glbUrl,
    },
    dispose: () => assetUrlFactory.revoke(glbUrl),
  };
}

function parseArchiveJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    throw new Error(
      `Derived manifest "${path}" is not valid UTF-8 JSON.`,
      { cause: error },
    );
  }
}

function defaultAssetUrlFactory(): BrowserAssetUrlFactory {
  if (
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error(
      "This browser cannot create temporary URLs for portable scene assets.",
    );
  }

  return {
    create(bytes, mediaType) {
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return URL.createObjectURL(new Blob([buffer], { type: mediaType }));
    },
    revoke(url) {
      URL.revokeObjectURL(url);
    },
  };
}

function defaultRecoveryStore(): BrowserRecoveryStore {
  return globalThis.indexedDB === undefined
    ? new MemoryBrowserRecoveryStore()
    : new IndexedDbBrowserRecoveryStore();
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error("IndexedDB request failed."),
      );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ??
          new Error("IndexedDB transaction failed."),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error("IndexedDB transaction was aborted."),
      );
  });
}
