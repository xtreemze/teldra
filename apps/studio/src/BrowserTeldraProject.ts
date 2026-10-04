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
import {
  decodeTeldraArchive,
  encodeTeldraArchive,
  replaceTeldraTwin,
  type TeldraArchive,
} from "@teldra/project-format/archive";
import { StudioProjectController } from "./StudioProjectController";

export interface BrowserProjectWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface BrowserProjectFileHandle {
  readonly name: string;
  getFile(): Promise<Blob>;
  createWritable(): Promise<BrowserProjectWritable>;
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

export interface OpenedBrowserStudioProject {
  readonly controller: StudioProjectController;
  readonly displayName: string;
  readonly projectKey: string;
  readonly close: () => Promise<void>;
}

interface StagedProject {
  readonly id: string;
  readonly project: StoredProject<TwinProject>;
  readonly archive: TeldraArchive;
  readonly bytes: Uint8Array;
}

const inProcessLocks = new Map<string, string>();

export class BrowserTeldraStorageAdapter
  implements ProjectStorageAdapter<TwinProject>
{
  readonly #handle: BrowserProjectFileHandle;
  readonly #recoveryStore: BrowserRecoveryStore;
  readonly #projectKey: string;

  #archive: TeldraArchive;
  #revision = 0;
  #stageSequence = 0;
  readonly #staged = new Map<string, StagedProject>();
  #lockOwner: string | null = null;
  #releaseWebLock: (() => void) | null = null;
  #webLockTask: Promise<void> | null = null;

  private constructor(
    handle: BrowserProjectFileHandle,
    recoveryStore: BrowserRecoveryStore,
    archive: TeldraArchive,
  ) {
    this.#handle = handle;
    this.#recoveryStore = recoveryStore;
    this.#archive = archive;
    this.#projectKey = [
      "teldra",
      handle.name,
      archive.manifest.building.sha256,
    ].join(":");
  }

  static async create(
    handle: BrowserProjectFileHandle,
    recoveryStore: BrowserRecoveryStore = new IndexedDbBrowserRecoveryStore(),
  ): Promise<BrowserTeldraStorageAdapter> {
    const file = await handle.getFile();
    const archive = await decodeTeldraArchive(
      new Uint8Array(await file.arrayBuffer()),
    );

    return new BrowserTeldraStorageAdapter(
      handle,
      recoveryStore,
      archive,
    );
  }

  get projectKey(): string {
    return this.#projectKey;
  }

  get displayName(): string {
    return this.#handle.name;
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
        .then(() => undefined);

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

    return this.#storedProject(
      this.#archive.twin,
      this.#revision,
    );
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

    const archive = await replaceTeldraTwin(
      this.#archive,
      project.canonical,
    );
    const bytes = encodeTeldraArchive(archive);
    const id = `browser-stage:${++this.#stageSequence}`;

    this.#staged.set(id, {
      id,
      project: structuredClone(project),
      archive,
      bytes,
    });

    return id;
  }

  async commitStaged(
    projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void> {
    this.#assertWriteOwner(projectKey, ownerId);

    const staged = this.#staged.get(stageId);
    if (staged === undefined) {
      throw new Error(`Unknown browser project stage "${stageId}".`);
    }

    const previous = this.#storedProject(
      this.#archive.twin,
      this.#revision,
    );

    const writable = await this.#handle.createWritable();

    try {
      await writable.write(staged.bytes);
      await writable.close();
    } catch (error) {
      if (writable.abort !== undefined) {
        try {
          await writable.abort(error);
        } catch {
          // Preserve the original write failure.
        }
      }
      throw error;
    }

    await this.#recoveryStore.set(
      "backup",
      projectKey,
      previous,
    );

    this.#archive = staged.archive;
    this.#revision = staged.project.revision;
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

export class IndexedDbBrowserRecoveryStore
  implements BrowserRecoveryStore
{
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
      const request = transaction
        .objectStore("projects")
        .get(this.#key(slot, projectKey));

      const result = await requestResult(request);
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
        .put(
          structuredClone(project),
          this.#key(slot, projectKey),
        );
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

  #key(
    slot: "backup" | "recovery",
    projectKey: string,
  ): string {
    return `${slot}:${projectKey}`;
  }
}

export function supportsBrowserProjectFiles(): boolean {
  return (
    typeof window !== "undefined" &&
    "showOpenFilePicker" in window
  );
}

export async function pickBrowserTeldraFile(): Promise<
  BrowserProjectFileHandle | null
> {
  const picker = (
    window as Window & {
      showOpenFilePicker?: (
        options?: unknown,
      ) => Promise<BrowserProjectFileHandle[]>;
    }
  ).showOpenFilePicker;

  if (picker === undefined) {
    throw new Error(
      "This browser cannot open writable local .teldra files. Use a current Chromium-based browser with the File System Access API.",
    );
  }

  try {
    const [handle] = await picker({
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

    return handle ?? null;
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "AbortError"
    ) {
      return null;
    }
    throw error;
  }
}

export async function openBrowserStudioProject(
  handle?: BrowserProjectFileHandle,
): Promise<OpenedBrowserStudioProject | null> {
  const selected = handle ?? (await pickBrowserTeldraFile());
  if (selected === null) {
    return null;
  }

  const adapter = await BrowserTeldraStorageAdapter.create(selected);
  const ownerId =
    globalThis.crypto?.randomUUID?.() ??
    `studio:${Date.now()}:${Math.random().toString(16).slice(2)}`;

  const opened = await openProjectPersistence(
    adapter,
    assertTwinIntegrity,
    adapter.projectKey,
    ownerId,
  );

  if (opened.primary === null) {
    await opened.session.close();
    throw new Error(
      "The selected .teldra file does not contain a canonical twin.",
    );
  }

  return {
    controller: new StudioProjectController(
      opened.primary.canonical,
      opened.session,
    ),
    displayName: adapter.displayName,
    projectKey: adapter.projectKey,
    close: () => opened.session.close(),
  };
}

function requestResult<T>(
  request: IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new Error("IndexedDB request failed."),
      );
  });
}

function transactionDone(
  transaction: IDBTransaction,
): Promise<void> {
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
