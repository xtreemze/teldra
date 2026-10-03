export type ProjectOpenMode = "read-only" | "read-write";
export type ProjectPersistenceStatus =
  | "clean"
  | "dirty"
  | "saving"
  | "save-failed"
  | "closed";
export type ProjectRecoverySource = "backup" | "recovery";

export interface StoredProject<Canonical, Derived = unknown> {
  revision: number;
  fingerprint: string;
  canonical: Canonical;
  derived?: Derived;
}

export interface ProjectStorageAdapter<Canonical, Derived = unknown> {
  acquireWriteLock(projectKey: string, ownerId: string): Promise<boolean>;
  releaseWriteLock(projectKey: string, ownerId: string): Promise<void>;

  readPrimary(projectKey: string): Promise<StoredProject<Canonical, Derived> | null>;
  readBackup(projectKey: string): Promise<StoredProject<Canonical, Derived> | null>;
  readRecovery(projectKey: string): Promise<StoredProject<Canonical, Derived> | null>;

  stagePrimary(
    projectKey: string,
    ownerId: string,
    project: StoredProject<Canonical, Derived>,
  ): Promise<string>;

  /**
   * Atomically replace the primary with one previously staged candidate.
   *
   * On success, the old primary should become the backup. On failure, the old
   * primary and backup must remain unchanged and the staged candidate must not
   * become visible as the primary.
   */
  commitStaged(
    projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void>;

  discardStaged(
    projectKey: string,
    ownerId: string,
    stageId: string,
  ): Promise<void>;

  writeRecovery(
    projectKey: string,
    ownerId: string,
    project: StoredProject<Canonical, Derived>,
  ): Promise<void>;

  clearRecovery(projectKey: string, ownerId: string): Promise<void>;
}

export type CanonicalProjectValidator<Canonical> = (canonical: Canonical) => void;

export interface OpenedProject<Canonical, Derived = unknown> {
  primary: StoredProject<Canonical, Derived> | null;
  recovery: StoredProject<Canonical, Derived> | null;
  recoveryAvailable: boolean;
  session: ProjectPersistenceSession<Canonical, Derived>;
}

export class ProjectPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectPersistenceError";
  }
}

export class ProjectLockError extends ProjectPersistenceError {
  readonly projectKey: string;

  constructor(projectKey: string) {
    super(`Project "${projectKey}" is already open for writing.`);
    this.name = "ProjectLockError";
    this.projectKey = projectKey;
  }
}

export class ProjectCorruptionError extends ProjectPersistenceError {
  readonly projectKey: string;
  readonly recoverableSources: readonly ProjectRecoverySource[];

  constructor(
    projectKey: string,
    recoverableSources: readonly ProjectRecoverySource[],
    cause: unknown,
  ) {
    const suffix =
      recoverableSources.length > 0
        ? ` Valid recovery source(s): ${recoverableSources.join(", ")}.`
        : " No valid backup or recovery source is available.";

    super(`Canonical project data for "${projectKey}" is corrupt.${suffix}`, {
      cause,
    });
    this.name = "ProjectCorruptionError";
    this.projectKey = projectKey;
    this.recoverableSources = recoverableSources;
  }
}

export class ProjectSaveError extends ProjectPersistenceError {
  readonly projectKey: string;

  constructor(projectKey: string, cause: unknown) {
    super(`Could not atomically save project "${projectKey}".`, { cause });
    this.name = "ProjectSaveError";
    this.projectKey = projectKey;
  }
}

export class ProjectRecoveryError extends ProjectPersistenceError {
  readonly projectKey: string;
  readonly source: ProjectRecoverySource;

  constructor(projectKey: string, source: ProjectRecoverySource, message: string) {
    super(message);
    this.name = "ProjectRecoveryError";
    this.projectKey = projectKey;
    this.source = source;
  }
}

export class ProjectPersistenceSession<Canonical, Derived = unknown> {
  readonly #adapter: ProjectStorageAdapter<Canonical, Derived>;
  readonly #validateCanonical: CanonicalProjectValidator<Canonical>;
  readonly #projectKey: string;
  readonly #ownerId: string;
  readonly #mode: ProjectOpenMode;

  #status: ProjectPersistenceStatus;
  #savedFingerprint: string | null;
  #savedRevision: number | null;
  #currentFingerprint: string | null;
  #currentRevision: number | null;

  constructor(
    adapter: ProjectStorageAdapter<Canonical, Derived>,
    validateCanonical: CanonicalProjectValidator<Canonical>,
    projectKey: string,
    ownerId: string,
    mode: ProjectOpenMode,
    primary: StoredProject<Canonical, Derived> | null,
  ) {
    this.#adapter = adapter;
    this.#validateCanonical = validateCanonical;
    this.#projectKey = projectKey;
    this.#ownerId = ownerId;
    this.#mode = mode;
    this.#savedFingerprint = primary?.fingerprint ?? null;
    this.#savedRevision = primary?.revision ?? null;
    this.#currentFingerprint = this.#savedFingerprint;
    this.#currentRevision = this.#savedRevision;
    this.#status = "clean";
  }

  get status(): ProjectPersistenceStatus {
    return this.#status;
  }

  get mode(): ProjectOpenMode {
    return this.#mode;
  }

  get projectKey(): string {
    return this.#projectKey;
  }

  get dirty(): boolean {
    return this.#currentFingerprint !== this.#savedFingerprint;
  }

  get savedRevision(): number | null {
    return this.#savedRevision;
  }

  get currentRevision(): number | null {
    return this.#currentRevision;
  }

  markCurrent(revision: number, fingerprint: string): void {
    this.#assertOpen();
    assertRevision(revision);
    assertFingerprint(fingerprint);

    this.#currentRevision = revision;
    this.#currentFingerprint = fingerprint;

    if (this.#status !== "saving") {
      this.#status = this.dirty ? "dirty" : "clean";
    }
  }

  async autosave(project: StoredProject<Canonical, Derived>): Promise<void> {
    this.#assertWritable();
    this.#assertCurrentCandidate(project);
    this.#validateCanonical(project.canonical);

    await this.#adapter.writeRecovery(
      this.#projectKey,
      this.#ownerId,
      project,
    );

    if (this.#status !== "saving") {
      this.#status = this.dirty ? "dirty" : "clean";
    }
  }

  async save(project: StoredProject<Canonical, Derived>): Promise<void> {
    this.#assertWritable();
    this.#assertCurrentCandidate(project);
    this.#validateCanonical(project.canonical);

    this.#status = "saving";
    let stageId: string | null = null;

    try {
      stageId = await this.#adapter.stagePrimary(
        this.#projectKey,
        this.#ownerId,
        project,
      );

      await this.#adapter.commitStaged(
        this.#projectKey,
        this.#ownerId,
        stageId,
      );

      this.#savedFingerprint = project.fingerprint;
      this.#savedRevision = project.revision;

      try {
        await this.#adapter.clearRecovery(this.#projectKey, this.#ownerId);
      } catch {
        // A stale recovery slot is safe: open semantics compare it with primary
        // and never treat it as canonical automatically.
      }

      this.#status = this.dirty ? "dirty" : "clean";
    } catch (error) {
      if (stageId !== null) {
        try {
          await this.#adapter.discardStaged(
            this.#projectKey,
            this.#ownerId,
            stageId,
          );
        } catch {
          // The original save failure is authoritative. Staged data remains
          // non-canonical and may be cleaned by the storage adapter later.
        }
      }

      this.#status = this.dirty ? "save-failed" : "clean";
      throw new ProjectSaveError(this.#projectKey, error);
    }
  }

  async discardRecovery(): Promise<void> {
    this.#assertWritable();
    await this.#adapter.clearRecovery(this.#projectKey, this.#ownerId);
  }

  async close(): Promise<void> {
    if (this.#status === "closed") {
      return;
    }

    if (this.#mode === "read-write") {
      await this.#adapter.releaseWriteLock(this.#projectKey, this.#ownerId);
    }

    this.#status = "closed";
  }

  #assertCurrentCandidate(project: StoredProject<Canonical, Derived>): void {
    validateStoredProjectMetadata(project);

    if (
      this.#currentRevision !== project.revision ||
      this.#currentFingerprint !== project.fingerprint
    ) {
      throw new ProjectPersistenceError(
        `Save candidate for "${this.#projectKey}" does not match the current application revision/fingerprint.`,
      );
    }
  }

  #assertOpen(): void {
    if (this.#status === "closed") {
      throw new ProjectPersistenceError(
        `Project session "${this.#projectKey}" is closed.`,
      );
    }
  }

  #assertWritable(): void {
    this.#assertOpen();

    if (this.#mode !== "read-write") {
      throw new ProjectPersistenceError(
        `Project "${this.#projectKey}" is open read-only.`,
      );
    }
  }
}

export async function openProjectPersistence<Canonical, Derived = unknown>(
  adapter: ProjectStorageAdapter<Canonical, Derived>,
  validateCanonical: CanonicalProjectValidator<Canonical>,
  projectKey: string,
  ownerId: string,
  mode: ProjectOpenMode = "read-write",
): Promise<OpenedProject<Canonical, Derived>> {
  let lockAcquired = false;

  if (mode === "read-write") {
    lockAcquired = await adapter.acquireWriteLock(projectKey, ownerId);
    if (!lockAcquired) {
      throw new ProjectLockError(projectKey);
    }
  }

  try {
    const primary = await adapter.readPrimary(projectKey);

    if (primary !== null) {
      try {
        validateStoredProjectMetadata(primary);
        validateCanonical(primary.canonical);
      } catch (error) {
        const recoverableSources = await findRecoverableSources(
          adapter,
          validateCanonical,
          projectKey,
        );

        throw new ProjectCorruptionError(
          projectKey,
          recoverableSources,
          error,
        );
      }
    }

    const recovery = await readValidCandidate(
      await adapter.readRecovery(projectKey),
      validateCanonical,
    );

    const recoveryAvailable =
      recovery !== null &&
      (primary === null ||
        recovery.fingerprint !== primary.fingerprint ||
        recovery.revision > primary.revision);

    return {
      primary,
      recovery,
      recoveryAvailable,
      session: new ProjectPersistenceSession(
        adapter,
        validateCanonical,
        projectKey,
        ownerId,
        mode,
        primary,
      ),
    };
  } catch (error) {
    if (lockAcquired) {
      await adapter.releaseWriteLock(projectKey, ownerId);
    }
    throw error;
  }
}

export async function restoreProjectFrom<Canonical, Derived = unknown>(
  adapter: ProjectStorageAdapter<Canonical, Derived>,
  validateCanonical: CanonicalProjectValidator<Canonical>,
  projectKey: string,
  ownerId: string,
  source: ProjectRecoverySource,
): Promise<StoredProject<Canonical, Derived>> {
  const acquired = await adapter.acquireWriteLock(projectKey, ownerId);
  if (!acquired) {
    throw new ProjectLockError(projectKey);
  }

  let stageId: string | null = null;

  try {
    const candidate =
      source === "backup"
        ? await adapter.readBackup(projectKey)
        : await adapter.readRecovery(projectKey);

    if (candidate === null) {
      throw new ProjectRecoveryError(
        projectKey,
        source,
        `No ${source} candidate exists for project "${projectKey}".`,
      );
    }

    try {
      validateStoredProjectMetadata(candidate);
      validateCanonical(candidate.canonical);
    } catch (error) {
      throw new ProjectRecoveryError(
        projectKey,
        source,
        `${source} candidate for project "${projectKey}" is invalid: ${errorMessage(error)}`,
      );
    }

    stageId = await adapter.stagePrimary(projectKey, ownerId, candidate);
    await adapter.commitStaged(projectKey, ownerId, stageId);

    if (source === "recovery") {
      try {
        await adapter.clearRecovery(projectKey, ownerId);
      } catch {
        // A stale recovery slot is non-canonical and safe to leave behind.
      }
    }

    return candidate;
  } catch (error) {
    if (stageId !== null) {
      try {
        await adapter.discardStaged(projectKey, ownerId, stageId);
      } catch {
        // Preserve the primary recovery error.
      }
    }

    if (error instanceof ProjectPersistenceError) {
      throw error;
    }

    throw new ProjectSaveError(projectKey, error);
  } finally {
    await adapter.releaseWriteLock(projectKey, ownerId);
  }
}

async function findRecoverableSources<Canonical, Derived>(
  adapter: ProjectStorageAdapter<Canonical, Derived>,
  validateCanonical: CanonicalProjectValidator<Canonical>,
  projectKey: string,
): Promise<ProjectRecoverySource[]> {
  const sources: ProjectRecoverySource[] = [];

  const backup = await readValidCandidate(
    await adapter.readBackup(projectKey),
    validateCanonical,
  );
  if (backup !== null) {
    sources.push("backup");
  }

  const recovery = await readValidCandidate(
    await adapter.readRecovery(projectKey),
    validateCanonical,
  );
  if (recovery !== null) {
    sources.push("recovery");
  }

  return sources;
}

async function readValidCandidate<Canonical, Derived>(
  candidate: StoredProject<Canonical, Derived> | null,
  validateCanonical: CanonicalProjectValidator<Canonical>,
): Promise<StoredProject<Canonical, Derived> | null> {
  if (candidate === null) {
    return null;
  }

  try {
    validateStoredProjectMetadata(candidate);
    validateCanonical(candidate.canonical);
    return candidate;
  } catch {
    return null;
  }
}

function validateStoredProjectMetadata<Canonical, Derived>(
  project: StoredProject<Canonical, Derived>,
): void {
  assertRevision(project.revision);
  assertFingerprint(project.fingerprint);
}

function assertRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new ProjectPersistenceError(
      "Project revision must be a non-negative integer.",
    );
  }
}

function assertFingerprint(fingerprint: string): void {
  if (fingerprint.trim().length === 0) {
    throw new ProjectPersistenceError("Project fingerprint must not be empty.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
