import {
  LiveTwinStore,
  type CapabilityRuntimeSnapshot,
  type LiveApplyResult,
  type TeldraLiveEnvelope,
} from "@teldra/live-state";

export type StudioLiveStateListener = () => void;

export class StudioLiveStateController {
  readonly #store = new LiveTwinStore();
  readonly #listeners = new Set<StudioLiveStateListener>();
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  apply(input: TeldraLiveEnvelope): LiveApplyResult {
    const result = this.#store.apply(input);

    if (result.status === "applied") {
      this.#revision += 1;
      for (const listener of this.#listeners) {
        listener();
      }
    }

    return result;
  }

  getCapability(
    deviceId: string,
    capabilityId: string,
  ): CapabilityRuntimeSnapshot {
    return this.#store.getCapability(deviceId, capabilityId);
  }

  subscribe(listener: StudioLiveStateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
