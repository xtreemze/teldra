import { canonicalTwinFingerprint } from "@teldra/application";
import { assertTwinIntegrity, type TwinProject } from "@teldra/domain";
import {
  openProjectPersistence,
  openTeldraArchive,
  replaceTeldraTwin,
  type OpenTeldraArchive,
  type ProjectStorageAdapter,
  type StoredProject,
} from "@teldra/project-format";
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

export interface BrowserStudioProject {
  readonly fileName: string;
  readonly projectKey: string;
  readonly controller: StudioProjectController;
  close(): Promise<void>;
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

  const controller = new StudioProjectController(
    opened.primary.canonical,
    opened.session,
  );

  return {
    fileName: handle.name,
    projectKey: storage.projectKey,
    controller,
    close: () => opened.session.close(),
  };
}

export async function openBrowserTeldraProjectWithPicker(
  ownerId: string,
  host: unknown = globalThis,
): Promise<BrowserStudioProject> {
  const handle = await pickBrowserTeldraFile(host);
  return openBrowserTeldraProject(handle, ownerId);
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
