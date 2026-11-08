/** Immutable build identity embedded in the running Studio JS bundle.
 * GitHub Pages supplies VITE_TELDRA_COMMIT; local builds remain explicitly
 * identified as development instead of inventing a deployed revision.
 */
const revision = import.meta.env.VITE_TELDRA_COMMIT;
export const studioBuildCommit: string | null =
  typeof revision === "string" && /^[0-9a-f]{40}$/i.test(revision) ? revision.toLowerCase() : null;
export const studioBuildLabel = studioBuildCommit?.slice(0, 12) ?? "development";
