import {
  authorizeControlIntent,
  type ControlAuthoritySnapshot,
  type ControlDenialReason,
  type ControlLease,
} from "@teldra/control-policy";
import type {
  HomeAssistantControlDispatchResult,
} from "@teldra/home-assistant";

export interface StudioPhysicalCommandAdapter {
  dispatchLightPower(
    lease: ControlLease,
    power: boolean,
  ): HomeAssistantControlDispatchResult;
}

export interface StudioPhysicalControlOptions {
  readonly sessionId: string;
  readonly authority: () => ControlAuthoritySnapshot;
  readonly now?: () => string;
  readonly createCommandId?: () => string;
  readonly createCorrelationId?: () => string;
}

export type StudioLightControlResult =
  | {
      readonly status: "dispatched";
      readonly commandId: string;
      readonly requestId: number;
    }
  | {
      readonly status: "denied";
      readonly commandId: string;
      readonly reason:
        | ControlDenialReason
        | "not-attached"
        | "unsupported-control";
    };

export class StudioPhysicalControlController {
  readonly #adapter: StudioPhysicalCommandAdapter;
  readonly #sessionId: string;
  readonly #authority: () => ControlAuthoritySnapshot;
  readonly #now: () => string;
  readonly #createCommandId: () => string;
  readonly #createCorrelationId: () => string;

  constructor(
    adapter: StudioPhysicalCommandAdapter,
    options: StudioPhysicalControlOptions,
  ) {
    if (options.sessionId.trim().length === 0) {
      throw new Error("Studio control sessionId must not be empty.");
    }

    this.#adapter = adapter;
    this.#sessionId = options.sessionId;
    this.#authority = options.authority;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createCommandId =
      options.createCommandId ??
      (() => `command:studio:${crypto.randomUUID()}`);
    this.#createCorrelationId =
      options.createCorrelationId ??
      (() => `correlation:studio:${crypto.randomUUID()}`);
  }

  setLightPower(
    deviceId: string,
    capabilityId: string,
    power: boolean,
  ): StudioLightControlResult {
    const commandId = this.#createCommandId();
    const intent = {
      commandId,
      correlationId: this.#createCorrelationId(),
      target: "physical" as const,
      adapter: "home-assistant",
      deviceId,
      capabilityId,
      capabilityKind: "light" as const,
      origin: {
        surface: "studio" as const,
        sessionId: this.#sessionId,
      },
    };

    const decision = authorizeControlIntent(
      this.#authority(),
      intent,
      this.#now(),
    );

    if (!decision.allowed) {
      return {
        status: "denied",
        commandId,
        reason: decision.reason,
      };
    }

    const dispatch = this.#adapter.dispatchLightPower(
      decision.lease,
      power,
    );

    return dispatch.status === "dispatched"
      ? {
          status: "dispatched",
          commandId,
          requestId: dispatch.requestId,
        }
      : {
          status: "denied",
          commandId,
          reason: dispatch.reason,
        };
  }
}
