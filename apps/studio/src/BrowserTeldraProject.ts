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
  abort?(): Promise<void>;
}

export interface BrowserTeldraFileHandle {
  readonly name: string;
  getFile(): Promise<Blob>;
  createWritable(): Promise<BrowserWritableFile>;
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
  readonly controller: StudioProjectController;
  close(): Promise<void>;
}

export class BrowserTeldraFileStorage
  implements ProjectStorageAdapter<TwinProject>
{
  readonly #handle: BrowserTeldraFileHandle;
  #archive: OpenTeldraArchive;
  #primary: StoredProject<TwinProject>;
  #backup: StoredProject<TwinProject> | null = null;
  #recovery: StoredProject<TwinProject> | null = null;
  #lockOwner: string | null = null;
  readonly #staged = new Map<string, StagedWrite>();
  #stageSequence = 0;

  private constructor(
    handle: BrowserTeldraFileHandle,
    archive: OpenTeldraArchive,
  ) {
    this.#handle = handle;
    this.#archive = archive;
    this.#primary = {
      revision: 0,
      fingerprint: canonicalTwinFingerprint(archive.twin),
      canonical: structuredClone(archive.twin),
    };
  }

  static async open(
    handle: BrowserTeldraFileHandle,
  ): Promise<BrowserTeldraFileStorage> {
    const file = await handle.getFile();
    const archive = await openTeldraArchive(
      new Uint8Array(await file.arrayBuffer()),
    );
    return new BrowserTeldraFileStorage(handle, archive);
  }

  get archive(): OpenTeldraArchive {
    return this.#archive;
  }

  async acquireWriteLock(
    _projectKey: string,
    ownerId: string,
  ): Promise<boolean> {
    if (this.#lockOwner !== null && this.#lockOwner !== ownerId) {
      return false;
    }
    this.#lockOwner = ownerId;
    return true;
  }

  async releaseWriteLock(
    _projectKey: string,
    ownerId: string,
  ): Promise<void> {
    if (this.#lockOwner === ownerId) {
      this.#lockOwner = null;
    }
  }

  async readPrimary(): Promise<StoredProject<TwinProject>> {
    return structuredClone(this.#primary);
  }

  async readBackup(): Promise<StoredProject<TwinProject> | null> {
    return structuredClone(this.#backup);
  }

  async readRecovery(): Promise<StoredProject<TwinProject> | null> {
    return structuredClone(this.#recovery);
  }

  async stagePrimary(
    _projectKey: string,
    ownerId: string,
    project: StoredProject<TwinProject>,
  ): Promise<string> {
    this.#assertLock(ownerId);

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
    _projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void> {
    this.#assertLock(ownerId);
    const staged = this.#staged.get(stageId);
    if (staged === undefined) {
      throw new Error(`Unknown browser save stage "${stageId}".`);
    }

    const writable = await this.#handle.createWritable();
    try {
      await writable.write(staged.bytes);
      await writable.close();
    } catch (error) {
      try {
        await writable.abort?.();
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }

    this.#backup = structuredClone(this.#primary);
    this.#primary = structuredClone(staged.stored);
    this.#archive = staged.archive;
    this.#staged.delete(stageId);
  }

  async discardStaged(
    _projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void> {
    this.#assertLock(ownerId);
    this.#staged.delete(stageId);
  }

  async writeRecovery(
    _projectKey: string,
    ownerId: string,
    project: StoredProject<TwinProject>,
  ): Promise<void> {
    this.#assertLock(ownerId);
    this.#recovery = structuredClone(project);
  }

  async clearRecovery(
    _projectKey: string,
    ownerId: string,
  ): Promise<void> {
    this.#assertLock(ownerId);
    this.#recovery = null;
  }

  #assertLock(ownerId: string): void {
    if (this.#lockOwner !== ownerId) {
      throw new Error("Browser project write lock is not held by this session.");
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
}

export async function openBrowserTeldraProject(
  handle: BrowserTeldraFileHandle,
  ownerId: string,
): Promise<BrowserStudioProject> {
  const storage = await BrowserTeldraFileStorage.open(handle);
  const opened = await openProjectPersistence(
    storage,
    assertTwinIntegrity,
    handle.name,
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
