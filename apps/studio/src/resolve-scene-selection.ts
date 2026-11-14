/** Resolve visual picks into authored twin identities without guessing IDs. */
export interface ScenePickIdentity {
  readonly canonicalId: string;
  readonly ifcGlobalId?: string;
}
export interface BuildingSelectionReference {
  readonly id: string;
  readonly ifcGlobalId: string;
}

/**
 * Exact canonical IDs take priority. A unique IFC GlobalId match permits a
 * derived scene to select its authored building reference even if the render
 * producer uses a different canonical label. Ambiguity fails closed.
 */
export function resolveSceneSelection(
  identity: ScenePickIdentity | null,
  authoredIds: readonly string[],
  buildingRefs: readonly BuildingSelectionReference[],
): string | null {
  if (!identity) return null;
  if (authoredIds.includes(identity.canonicalId) ||
      buildingRefs.some(ref => ref.id === identity.canonicalId)) {
    return identity.canonicalId;
  }
  if (identity.ifcGlobalId) {
    const matches = buildingRefs.filter(ref => ref.ifcGlobalId === identity.ifcGlobalId);
    if (matches.length === 1) return matches[0]!.id;
  }
  // Keep projected-only scene selections inspectable, but not editable.
  return identity.canonicalId;
}
