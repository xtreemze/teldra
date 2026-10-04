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
