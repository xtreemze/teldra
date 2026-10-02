import type { TeldraSceneManifest } from "@teldra/scene-manifest";

export interface TwinRenderIdentity {
  nodeKey: string;
  canonicalId: string;
  ifcGlobalId?: string;
}

export interface MetadataCarrier {
  metadata?: unknown;
  parent?: MetadataCarrier | null;
}

interface TeldraExtras {
  nodeKey: string;
  canonicalId: string;
  ifcGlobalId?: string;
}

export class BabylonIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BabylonIdentityError";
  }
}

export function indexSceneManifest(
  manifest: TeldraSceneManifest,
): ReadonlyMap<string, TwinRenderIdentity> {
  return new Map(
    manifest.nodes.map((node) => [
      node.nodeKey,
      {
        nodeKey: node.nodeKey,
        canonicalId: node.canonicalId,
        ...(node.ifcGlobalId === undefined ? {} : { ifcGlobalId: node.ifcGlobalId }),
      },
    ]),
  );
}

export function resolveTwinIdentity(
  node: MetadataCarrier | null | undefined,
  manifestByNodeKey: ReadonlyMap<string, TwinRenderIdentity>,
): TwinRenderIdentity | null {
  let current = node;

  while (current !== null && current !== undefined) {
    const extras = readTeldraExtras(current.metadata);

    if (extras !== null) {
      const canonical = manifestByNodeKey.get(extras.nodeKey);

      if (canonical === undefined) {
        throw new BabylonIdentityError(
          `Rendered node references unknown scene node key "${extras.nodeKey}".`,
        );
      }

      if (canonical.canonicalId !== extras.canonicalId) {
        throw new BabylonIdentityError(
          `Rendered node "${extras.nodeKey}" canonical identity does not match its manifest.`,
        );
      }

      if (canonical.ifcGlobalId !== extras.ifcGlobalId) {
        throw new BabylonIdentityError(
          `Rendered node "${extras.nodeKey}" IFC identity does not match its manifest.`,
        );
      }

      return canonical;
    }

    current = current.parent;
  }

  return null;
}

function readTeldraExtras(metadata: unknown): TeldraExtras | null {
  if (!isRecord(metadata)) {
    return null;
  }

  const gltf = metadata.gltf;
  if (!isRecord(gltf)) {
    return null;
  }

  const extras = gltf.extras;
  if (!isRecord(extras)) {
    return null;
  }

  const teldra = extras.teldra;
  if (!isRecord(teldra)) {
    return null;
  }

  if (
    typeof teldra.nodeKey !== "string" ||
    typeof teldra.canonicalId !== "string" ||
    (teldra.ifcGlobalId !== undefined && typeof teldra.ifcGlobalId !== "string")
  ) {
    throw new BabylonIdentityError("Malformed Teldra metadata in loaded glTF node.");
  }

  return {
    nodeKey: teldra.nodeKey,
    canonicalId: teldra.canonicalId,
    ...(teldra.ifcGlobalId === undefined ? {} : { ifcGlobalId: teldra.ifcGlobalId }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
