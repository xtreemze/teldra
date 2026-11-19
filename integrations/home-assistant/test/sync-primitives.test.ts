import { describe, expect, it } from "vitest";
import {
  EchoTracker,
  HaWsClient,
  HomeAssistantModeError,
  backoffDelayMs,
  isStale,
  type HaTransport,
} from "../src/index.js";

describe("backoffDelayMs", () => {
  const policy = { initialMs: 1000, maxMs: 30_000, factor: 2, jitterRatio: 0.2 };

  it("grows exponentially and caps at maxMs", () => {
    const mid = () => 0.5; // zero jitter
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(n, policy, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });

  it("applies bounded jitter in both directions and never exceeds the cap", () => {
    expect(backoffDelayMs(0, policy, () => 0)).toBe(800);
    expect(backoffDelayMs(0, policy, () => 0.999999)).toBeLessThanOrEqual(1200);
    expect(backoffDelayMs(10, policy, () => 0.999999)).toBe(30_000);
  });
});

describe("EchoTracker", () => {
  it("recognizes remembered contexts until they expire", () => {
    const tracker = new EchoTracker(1000);
    tracker.remember("ctx-1", 0);
    expect(tracker.isOwn("ctx-1", 999)).toBe(true);
    expect(tracker.isOwn("ctx-2", 999)).toBe(false);
    expect(tracker.isOwn(undefined, 999)).toBe(false);
    expect(tracker.isOwn("ctx-1", 1000)).toBe(false);
    expect(tracker.size).toBe(0);
  });
});

describe("isStale (last-writer by HA timestamp)", () => {
  const at = (iso: string) => ({
    entity_id: "light.sim_x",
    state: "on",
    attributes: {},
    last_changed: iso,
    last_updated: iso,
  });

  it("treats strictly older incoming state as stale", () => {
    expect(isStale(at("2026-01-01T00:00:10Z"), at("2026-01-01T00:00:05Z"))).toBe(true);
    expect(isStale(at("2026-01-01T00:00:10Z"), at("2026-01-01T00:00:10Z"))).toBe(false);
    expect(isStale(at("2026-01-01T00:00:10Z"), at("2026-01-01T00:00:11Z"))).toBe(false);
    expect(isStale(undefined, at("2026-01-01T00:00:05Z"))).toBe(false);
  });
});

describe("HaWsClient guard", () => {
  function inertTransport(sent: string[]): HaTransport {
    return {
      send: (d) => void sent.push(d),
      close: () => undefined,
      onMessage: () => () => undefined,
      onClose: () => () => undefined,
    };
  }

  it("a read-only client throws on call_service and puts nothing on the wire", () => {
    const sent: string[] = [];
    const client = new HaWsClient(inertTransport(sent), "read-only");
    expect(() => client.callService("light", "turn_on", "light.sim_x", {})).toThrow(
      HomeAssistantModeError,
    );
    expect(() => client.request({ type: "call_service", domain: "light" })).toThrow(
      HomeAssistantModeError,
    );
    expect(sent).toEqual([]);
  });

  it("rejects any message type outside the allowlist, even for control clients", () => {
    const sent: string[] = [];
    const client = new HaWsClient(inertTransport(sent), "control");
    expect(() => client.request({ type: "config/area_registry/create", name: "x" })).toThrow(
      HomeAssistantModeError,
    );
    expect(() => client.request({ type: "auth/sign_path" })).toThrow(HomeAssistantModeError);
    expect(sent).toEqual([]);
  });

  it("permits registry reads on a read-only client", () => {
    const sent: string[] = [];
    const client = new HaWsClient(inertTransport(sent), "read-only");
    void client.request({ type: "config/area_registry/list" });
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ type: "config/area_registry/list", id: 1 });
  });
});
