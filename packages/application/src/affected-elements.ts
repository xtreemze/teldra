/**
 * Remembers which IFC GlobalIds each canonical history entry touched, in lock-step with an
 * editor's undo/redo stacks, so derived scenes can be regenerated for exactly those elements
 * after apply, undo or redo (undo regenerates from the restored bytes, never from cached meshes).
 */
export class AffectedElementLog {
  readonly #undo: (readonly string[])[] = [];
  #redo: (readonly string[])[] = [];
  #last: readonly string[] = [];
  /** GlobalIds touched by the most recent apply, undo or redo (deduplicated, stable order). */
  get last(): readonly string[] { return this.#last; }
  recordApply(globalIds: readonly string[]): void {
    const ids = [...new Set(globalIds)];
    this.#undo.push(ids); this.#redo = []; this.#last = ids;
  }
  recordUndo(): void {
    const ids = this.#undo.pop();
    if (ids) { this.#redo.push(ids); this.#last = ids; }
  }
  recordRedo(): void {
    const ids = this.#redo.pop();
    if (ids) { this.#undo.push(ids); this.#last = ids; }
  }
}
