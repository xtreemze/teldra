import type { TwinProject } from "@teldra/domain";

type BuildingRef = TwinProject["building"]["refs"][number];
export const FURNITURE_REF_KINDS: readonly string[] = ["furniture", "fixture", "other", "distribution-element"];

export type FurnitureRemovalVetoCode = "device-bound" | "not-furniture" | "unknown-reference";
/** Explicit refusal: removing the IFC element would orphan twin identity or external bindings. */
export class FurnitureRemovalVetoError extends Error {
  readonly code: FurnitureRemovalVetoCode;
  readonly deviceIds: readonly string[];
  readonly bindingIds: readonly string[];
  constructor(code: FurnitureRemovalVetoCode, message: string, deviceIds: readonly string[] = [], bindingIds: readonly string[] = []) {
    super(message); this.name = "FurnitureRemovalVetoError"; this.code = code; this.deviceIds = deviceIds; this.bindingIds = bindingIds;
  }
}

/**
 * Twin devices reference IFC elements through `device.buildingRefId` (canonical id -> ifcGlobalId),
 * and external-system bindings hang off devices. Returns the removable furniture reference, or vetoes.
 */
export function assertFurnitureRemovable(twin: Readonly<TwinProject>, refId: string): BuildingRef {
  const ref = twin.building.refs.find(value => value.id === refId);
  if (!ref) throw new FurnitureRemovalVetoError("unknown-reference", `Unknown building object "${refId}".`);
  if (!FURNITURE_REF_KINDS.includes(ref.kind))
    throw new FurnitureRemovalVetoError("not-furniture", `Only furniture-like IFC elements can be removed; "${refId}" is a ${ref.kind}.`);
  const devices = twin.devices.filter(device => device.buildingRefId === refId);
  if (devices.length > 0) {
    const ids = new Set(devices.map(device => device.id));
    const bindingIds = twin.bindings.filter(binding => ids.has(binding.deviceId)).map(binding => binding.id);
    const bound = bindingIds.length > 0 ? ` with external bindings ${bindingIds.join(", ")}` : "";
    throw new FurnitureRemovalVetoError("device-bound",
      `"${ref.name ?? refId}" cannot be removed: twin device ${devices.map(d => d.id).join(", ")} is attached to it${bound}. Remove or re-attach the device first.`,
      devices.map(device => device.id), bindingIds);
  }
  return ref;
}

/** Stable, unique canonical id for a copy: `chair` -> `chair-copy` -> `chair-copy-2`. */
export function nextFurnitureCopyId(sourceId: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = sourceId.replace(/-copy(?:-\d+)?$/, "");
  let candidate = `${base}-copy`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-copy-${n}`;
  return candidate;
}

const IFC_BASE64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
/** Compress 128 bits (e.g. from crypto.getRandomValues) into a 22-character IFC GlobalId. */
export function ifcGlobalIdFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("An IFC GlobalId needs exactly 16 bytes.");
  let value = 0n; for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = IFC_BASE64[Number((value >> 126n) & 3n)]!;
  for (let shift = 120n; shift >= 0n; shift -= 6n) text += IFC_BASE64[Number((value >> shift) & 63n)]!;
  return text;
}
