import {
  isAuthoritativeProjectStateKind,
  type AuthoritativeProjectStateKind,
  type RuntimeStateKind,
} from "./state-ownership.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CanonicalCommand<
  Kind extends string = string,
  Payload extends JsonValue = JsonValue,
> {
  id: string;
  kind: Kind;
  authority: AuthoritativeProjectStateKind;
  payload: Payload;
  correlationId?: string;
}

export interface CommandTransaction<
  Command extends CanonicalCommand = CanonicalCommand,
> {
  id: string;
  commands: readonly Command[];
  expectedRevision?: number;
  correlationId?: string;
}

export interface CommandApplication<
  State,
  Command extends CanonicalCommand = CanonicalCommand,
> {
  state: State;
  inverse: Command;
}

export type CommandHandler<
  State,
  Command extends CanonicalCommand = CanonicalCommand,
> = (
  state: Readonly<State>,
  command: Command,
) => CommandApplication<State, Command>;

export type CommandResolver<
  State,
  Command extends CanonicalCommand = CanonicalCommand,
> = (command: Command) => CommandHandler<State, Command>;

export interface AppliedCommandTransaction<
  State,
  Command extends CanonicalCommand = CanonicalCommand,
> {
  state: State;
  inverseCommands: readonly Command[];
}

export type CommandCommitDirection = "execute" | "undo" | "redo";

export interface CommandCommit<
  State,
  Command extends CanonicalCommand = CanonicalCommand,
> {
  direction: CommandCommitDirection;
  transactionId: string;
  correlationId?: string;
  revisionBefore: number;
  revisionAfter: number;
  state: Readonly<State>;
  commands: readonly Command[];
}

export interface CommandHistoryStatus {
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
}

interface HistoryEntry<Command extends CanonicalCommand> {
  forward: CommandTransaction<Command>;
  inverse: CommandTransaction<Command>;
}

export class CommandContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandContractError";
  }
}

export class CommandConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Command transaction expected revision ${expectedRevision}, but current revision is ${actualRevision}.`,
    );
    this.name = "CommandConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class CommandTransactionError extends Error {
  readonly transactionId: string;
  readonly commandId: string;
  readonly commandIndex: number;

  constructor(
    transactionId: string,
    commandId: string,
    commandIndex: number,
    cause: unknown,
  ) {
    super(
      `Transaction "${transactionId}" failed at command ${commandIndex} ("${commandId}").`,
      { cause },
    );
    this.name = "CommandTransactionError";
    this.transactionId = transactionId;
    this.commandId = commandId;
    this.commandIndex = commandIndex;
  }
}

/**
 * Applies a transaction as a pure state transition.
 *
 * Handlers must not mutate the supplied state or perform external side effects.
 * A failed transaction never publishes its intermediate state. IFC, filesystem,
 * adapter, and renderer effects belong behind transactional application services
 * that commit only after this command phase succeeds.
 */
export function applyCommandTransaction<
  State,
  Command extends CanonicalCommand,
>(
  initialState: State,
  transaction: CommandTransaction<Command>,
  resolve: CommandResolver<State, Command>,
): AppliedCommandTransaction<State, Command> {
  assertTransactionContract(transaction);

  let state = initialState;
  const inverseCommands: Command[] = [];
  const commandIds = new Set<string>();

  for (let index = 0; index < transaction.commands.length; index += 1) {
    const command = transaction.commands[index];

    if (command === undefined) {
      throw new CommandContractError(
        `Transaction "${transaction.id}" contains a missing command at index ${index}.`,
      );
    }

    assertCommandContract(command);

    if (commandIds.has(command.id)) {
      throw new CommandContractError(
        `Transaction "${transaction.id}" contains duplicate command id "${command.id}".`,
      );
    }
    commandIds.add(command.id);

    try {
      const result = resolve(command)(state, command);
      assertCommandContract(result.inverse);

      if (result.inverse.authority !== command.authority) {
        throw new CommandContractError(
          `Inverse command "${result.inverse.id}" changes authority from "${command.authority}" to "${result.inverse.authority}".`,
        );
      }

      state = result.state;
      inverseCommands.unshift(result.inverse);
    } catch (error) {
      if (error instanceof CommandTransactionError) {
        throw error;
      }

      throw new CommandTransactionError(
        transaction.id,
        command.id,
        index,
        error,
      );
    }
  }

  return {
    state,
    inverseCommands,
  };
}

/**
 * In-memory canonical command processor.
 *
 * The processor owns revision and undo/redo bookkeeping but not persistence.
 * #32 defines save/recovery mechanics; physical smart-home command authority is
 * separately governed by #33 and never enters this history.
 */
export class CommandProcessor<
  State,
  Command extends CanonicalCommand,
> {
  #state: State;
  #revision = 0;
  readonly #resolve: CommandResolver<State, Command>;
  readonly #undoStack: HistoryEntry<Command>[] = [];
  readonly #redoStack: HistoryEntry<Command>[] = [];
  readonly #executedTransactionIds = new Set<string>();

  constructor(initialState: State, resolve: CommandResolver<State, Command>) {
    this.#state = initialState;
    this.#resolve = resolve;
  }

  get state(): Readonly<State> {
    return this.#state;
  }

  get revision(): number {
    return this.#revision;
  }

  get history(): CommandHistoryStatus {
    return {
      revision: this.#revision,
      canUndo: this.#undoStack.length > 0,
      canRedo: this.#redoStack.length > 0,
      undoDepth: this.#undoStack.length,
      redoDepth: this.#redoStack.length,
    };
  }

  execute(transaction: CommandTransaction<Command>): CommandCommit<State, Command> {
    this.#assertExpectedRevision(transaction);

    if (this.#executedTransactionIds.has(transaction.id)) {
      throw new CommandContractError(
        `Transaction id "${transaction.id}" has already been committed.`,
      );
    }

    const applied = applyCommandTransaction(
      this.#state,
      transaction,
      this.#resolve,
    );

    const forward: CommandTransaction<Command> = {
      id: transaction.id,
      commands: [...transaction.commands],
      ...(transaction.correlationId === undefined
        ? {}
        : { correlationId: transaction.correlationId }),
    };
    const inverse: CommandTransaction<Command> = {
      id: `undo:${transaction.id}`,
      commands: [...applied.inverseCommands],
      ...(transaction.correlationId === undefined
        ? {}
        : { correlationId: transaction.correlationId }),
    };

    const revisionBefore = this.#revision;
    this.#state = applied.state;
    this.#revision += 1;
    this.#undoStack.push({ forward, inverse });
    this.#redoStack.length = 0;
    this.#executedTransactionIds.add(transaction.id);

    return this.#commit(
      "execute",
      transaction.id,
      transaction.correlationId,
      revisionBefore,
      forward.commands,
    );
  }

  undo(): CommandCommit<State, Command> | null {
    const entry = this.#undoStack.at(-1);

    if (entry === undefined) {
      return null;
    }

    const applied = applyCommandTransaction(
      this.#state,
      entry.inverse,
      this.#resolve,
    );

    const revisionBefore = this.#revision;
    this.#state = applied.state;
    this.#revision += 1;
    this.#undoStack.pop();
    this.#redoStack.push(entry);

    return this.#commit(
      "undo",
      entry.forward.id,
      entry.forward.correlationId,
      revisionBefore,
      entry.inverse.commands,
    );
  }

  redo(): CommandCommit<State, Command> | null {
    const entry = this.#redoStack.at(-1);

    if (entry === undefined) {
      return null;
    }

    const applied = applyCommandTransaction(
      this.#state,
      entry.forward,
      this.#resolve,
    );

    const revisionBefore = this.#revision;
    this.#state = applied.state;
    this.#revision += 1;
    this.#redoStack.pop();
    this.#undoStack.push(entry);

    return this.#commit(
      "redo",
      entry.forward.id,
      entry.forward.correlationId,
      revisionBefore,
      entry.forward.commands,
    );
  }

  #assertExpectedRevision(transaction: CommandTransaction<Command>): void {
    if (
      transaction.expectedRevision !== undefined &&
      transaction.expectedRevision !== this.#revision
    ) {
      throw new CommandConflictError(
        transaction.expectedRevision,
        this.#revision,
      );
    }
  }

  #commit(
    direction: CommandCommitDirection,
    transactionId: string,
    correlationId: string | undefined,
    revisionBefore: number,
    commands: readonly Command[],
  ): CommandCommit<State, Command> {
    return {
      direction,
      transactionId,
      ...(correlationId === undefined ? {} : { correlationId }),
      revisionBefore,
      revisionAfter: this.#revision,
      state: this.#state,
      commands: [...commands],
    };
  }
}

function assertTransactionContract<Command extends CanonicalCommand>(
  transaction: CommandTransaction<Command>,
): void {
  if (transaction.id.trim().length === 0) {
    throw new CommandContractError("Transaction id must not be empty.");
  }

  if (transaction.commands.length === 0) {
    throw new CommandContractError(
      `Transaction "${transaction.id}" must contain at least one command.`,
    );
  }

  if (
    transaction.correlationId !== undefined &&
    transaction.correlationId.trim().length === 0
  ) {
    throw new CommandContractError(
      `Transaction "${transaction.id}" correlationId must not be empty.`,
    );
  }

  if (
    transaction.expectedRevision !== undefined &&
    (!Number.isInteger(transaction.expectedRevision) ||
      transaction.expectedRevision < 0)
  ) {
    throw new CommandContractError(
      `Transaction "${transaction.id}" has an invalid expected revision.`,
    );
  }
}

function assertCommandContract(command: CanonicalCommand): void {
  if (command.id.trim().length === 0) {
    throw new CommandContractError("Command id must not be empty.");
  }

  if (
    command.correlationId !== undefined &&
    command.correlationId.trim().length === 0
  ) {
    throw new CommandContractError(
      `Command "${command.id}" correlationId must not be empty.`,
    );
  }

  if (command.kind.trim().length === 0) {
    throw new CommandContractError(
      `Command "${command.id}" kind must not be empty.`,
    );
  }

  if (
    !isAuthoritativeProjectStateKind(
      command.authority as RuntimeStateKind,
    )
  ) {
    throw new CommandContractError(
      `Command "${command.id}" targets non-canonical authority "${String(command.authority)}".`,
    );
  }

  if (!isJsonValue(command.payload)) {
    throw new CommandContractError(
      `Command "${command.id}" payload must be JSON-serializable.`,
    );
  }
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, seen));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(value).every((item) => isJsonValue(item, seen));
}
