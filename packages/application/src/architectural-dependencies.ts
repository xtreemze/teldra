/**
 * Renderer-neutral dependency index for prospective architectural edits.
 *
 * This is a disposable index of already-resolved IFC relationships, not a
 * canonical model, geometry writer, or persistence format. An IFC-aware adapter
 * is responsible for resolving and validating real IFC GlobalIds/relations.
 */
export interface ArchitecturalDependencyNode {
  readonly globalId: string;
  /** This entity depends on the continued validity of the listed IFC entities. */
  readonly dependsOn: readonly string[];
}

export class ArchitecturalDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchitecturalDependencyError";
  }
}

function validId(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

/**
 * Immutable dependency graph. Relationships are directed from prerequisite to
 * dependent when computing the dirty set. All outputs are lexically stable.
 */
export class ArchitecturalDependencyIndex {
  readonly #nodes: ReadonlyMap<string, readonly string[]>;
  readonly #dependents: ReadonlyMap<string, readonly string[]>;

  constructor(nodes: readonly ArchitecturalDependencyNode[]) {
    const sources = new Map<string, readonly string[]>();
    for (const node of nodes) {
      if (!validId(node.globalId)) throw new ArchitecturalDependencyError("Architectural GlobalId must be nonempty and trimmed.");
      if (sources.has(node.globalId)) throw new ArchitecturalDependencyError(`Duplicate architectural GlobalId: ${node.globalId}`);
      if (!Array.isArray(node.dependsOn)) throw new ArchitecturalDependencyError(`Invalid dependencies for ${node.globalId}`);
      const dependencies = new Set<string>();
      for (const dependency of node.dependsOn) {
        if (!validId(dependency)) throw new ArchitecturalDependencyError(`Invalid dependency of ${node.globalId}`);
        if (dependencies.has(dependency)) throw new ArchitecturalDependencyError(`Duplicate dependency ${dependency} for ${node.globalId}`);
        dependencies.add(dependency);
      }
      sources.set(node.globalId, [...dependencies].sort());
    }

    const dependents = new Map<string, string[]>();
    for (const id of sources.keys()) dependents.set(id, []);
    for (const [id, dependencies] of sources) {
      for (const dependency of dependencies) {
        if (!sources.has(dependency)) {
          throw new ArchitecturalDependencyError(`Missing architectural dependency ${dependency} for ${id}`);
        }
        dependents.get(dependency)!.push(id);
      }
    }

    // Reject cycles before allowing the index to serve a rebuild plan.
    const states = new Map<string, 0 | 1 | 2>();
    const visit = (id: string, path: string[]): void => {
      const state = states.get(id) ?? 0;
      if (state === 2) return;
      if (state === 1) {
        throw new ArchitecturalDependencyError(`Architectural dependency cycle: ${[...path, id].join(" -> ")}`);
      }
      states.set(id, 1);
      for (const dependency of sources.get(id)!) visit(dependency, [...path, id]);
      states.set(id, 2);
    };
    for (const id of [...sources.keys()].sort()) visit(id, []);
    for (const values of dependents.values()) values.sort();
    this.#nodes = sources;
    this.#dependents = dependents;
  }

  has(globalId: string): boolean {
    return this.#nodes.has(globalId);
  }

  /**
   * Return changed entities and transitive dependents in a deterministic,
   * prerequisite-first topological order. Never modifies canonical IFC.
   */
  affectedBy(changedGlobalIds: readonly string[]): readonly string[] {
    const affected = new Set<string>();
    const pending = [...new Set(changedGlobalIds)].sort();
    for (const id of pending) {
      if (!this.#nodes.has(id)) throw new ArchitecturalDependencyError(`Unknown architectural GlobalId: ${id}`);
    }
    while (pending.length) {
      const id = pending.shift()!;
      if (affected.has(id)) continue;
      affected.add(id);
      pending.push(...this.#dependents.get(id)!);
    }
    const ordered: string[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dependency of this.#nodes.get(id)!) {
        if (affected.has(dependency)) visit(dependency);
      }
      ordered.push(id);
    };
    for (const id of [...affected].sort()) visit(id);
    return ordered;
  }
}
