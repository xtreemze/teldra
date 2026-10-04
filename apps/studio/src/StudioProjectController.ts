import {
  TwinEditor,
  canonicalTwinFingerprint,
  type CommandHistoryStatus,
} from "@teldra/application";
import type { TwinProject } from "@teldra/domain";
import type { ProjectPersistenceSession } from "@teldra/project-format";

export class StudioProjectController {
  readonly #editor: TwinEditor;
  readonly #persistence: ProjectPersistenceSession<TwinProject>;
  #selectedCanonicalId: string | null = null;

  constructor(
    initialTwin: TwinProject,
    persistence: ProjectPersistenceSession<TwinProject>,
  ) {
    this.#persistence = persistence;
    this.#editor = new TwinEditor(
      initialTwin,
      persistence.savedRevision ?? 0,
    );
    this.#syncPersistence();
  }

  get twin(): Readonly<TwinProject> {
    return this.#editor.twin;
  }

  get devices(): TwinProject["devices"] {
    return this.#editor.twin.devices;
  }

  get selectedCanonicalId(): string | null {
    return this.#selectedCanonicalId;
  }

  get selectedDevice(): TwinProject["devices"][number] | null {
    if (this.#selectedCanonicalId === null) {
      return null;
    }

    return (
      this.#editor.twin.devices.find(
        (device) => device.id === this.#selectedCanonicalId,
      ) ?? null
    );
  }

  get revision(): number {
    return this.#editor.revision;
  }

  get history(): CommandHistoryStatus {
    return this.#editor.history;
  }

  get dirty(): boolean {
    return this.#persistence.dirty;
  }

  get persistenceStatus() {
    return this.#persistence.status;
  }

  selectCanonical(canonicalId: string | null): void {
    if (canonicalId !== null && canonicalId.trim().length === 0) {
      throw new Error("Selected canonical ID must not be empty.");
    }

    this.#selectedCanonicalId = canonicalId;
  }

  renameDevice(
    deviceId: string,
    name: string,
    correlationId?: string,
  ): void {
    this.#editor.renameDevice(deviceId, name, correlationId);
    this.#syncPersistence();
  }

  undo(): boolean {
    const commit = this.#editor.undo();
    if (commit === null) {
      return false;
    }

    this.#syncPersistence();
    return true;
  }

  redo(): boolean {
    const commit = this.#editor.redo();
    if (commit === null) {
      return false;
    }

    this.#syncPersistence();
    return true;
  }

  async save(): Promise<void> {
    const canonical = structuredClone(this.#editor.twin) as TwinProject;

    await this.#persistence.save({
      revision: this.#editor.revision,
      fingerprint: canonicalTwinFingerprint(canonical),
      canonical,
    });
  }

  async autosave(): Promise<void> {
    const canonical = structuredClone(this.#editor.twin) as TwinProject;

    await this.#persistence.autosave({
      revision: this.#editor.revision,
      fingerprint: canonicalTwinFingerprint(canonical),
      canonical,
    });
  }

  #syncPersistence(): void {
    this.#persistence.markCurrent(
      this.#editor.revision,
      canonicalTwinFingerprint(this.#editor.twin as TwinProject),
    );
  }
}
