import { describe, expect, it } from "vitest";
import {
  createSupportBundle,
  privateField,
  publicField,
  sanitizeDiagnosticEvent,
  secretField,
  validateDiagnosticEvent,
  validateSupportBundle,
  type DiagnosticEvent,
} from "../src/index.js";

const event: DiagnosticEvent = {
  schemaVersion: "0.1.0",
  eventId: "event:42",
  timestamp: "2026-10-04T09:00:00Z",
  level: "error",
  subsystem: "home-assistant",
  code: "adapter.command.failed",
  correlationId: "correlation:scene-to-device",
  operationId: "operation:set-light",
  userMessage: "The light command could not be completed.",
  detail: "The adapter rejected the normalized command.",
  fields: {
    adapterKind: publicField("home-assistant"),
    capability: publicField("light"),
    deviceId: privateField("device:living-room-floor-lamp"),
    externalEntityId: privateField("light.living_room_floor_lamp"),
    accessToken: secretField("super-secret-token"),
  },
};

describe("diagnostic event contract", () => {
  it("accepts deterministic structured diagnostic events", () => {
    expect(validateDiagnosticEvent(event)).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("requires secret-like fields to be explicitly classified secret", () => {
    const invalid = {
      ...event,
      fields: {
        ...event.fields,
        password: publicField("should-not-be-public"),
      },
    };

    const result = validateDiagnosticEvent(invalid);
    expect(result.valid).toBe(false);

    if (!result.valid) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/fields/password/sensitivity",
          }),
        ]),
      );
    }
  });

  it("redacts secrets and pseudonymizes project-private values", () => {
    const sanitized = sanitizeDiagnosticEvent(
      event,
      "0123456789abcdef-support-bundle",
    );

    expect(sanitized.fields.accessToken).toEqual({
      sensitivity: "secret",
      value: "<redacted>",
    });
    expect(sanitized.fields.deviceId?.value).toMatch(/^p:[a-f0-9]{16}$/);
    expect(sanitized.fields.externalEntityId?.value).toMatch(
      /^p:[a-f0-9]{16}$/,
    );
    expect(sanitized.fields.adapterKind?.value).toBe("home-assistant");

    expect(JSON.stringify(sanitized)).not.toContain("super-secret-token");
    expect(JSON.stringify(sanitized)).not.toContain(
      "device:living-room-floor-lamp",
    );
    expect(JSON.stringify(sanitized)).not.toContain(
      "light.living_room_floor_lamp",
    );
  });

  it("preserves correlation while pseudonymizing raw correlation identifiers", () => {
    const salt = "0123456789abcdef-support-bundle";
    const first = sanitizeDiagnosticEvent(event, salt);
    const second = sanitizeDiagnosticEvent(
      {
        ...event,
        eventId: "event:43",
        subsystem: "babylon",
        code: "renderer.projection.failed",
      },
      salt,
    );

    expect(first.correlationId).toBe(second.correlationId);
    expect(first.correlationId).not.toBe(event.correlationId);
    expect(first.eventId).not.toBe(second.eventId);
  });
});

describe("support bundle", () => {
  it("contains safe environment, toolchain, adapter, and correlated event diagnostics", () => {
    const bundle = createSupportBundle({
      createdAt: "2026-10-04T09:10:00Z",
      application: {
        version: "0.0.0",
        sourceCommit: "abc123",
        toolchainManifestSha256: "a".repeat(64),
      },
      environment: {
        runtime: "browser",
        browser: "Chrome 151",
        os: "macOS",
        renderBackend: "babylon-webgpu",
      },
      projectFingerprint: "sha256:private-home-fingerprint",
      projectFormatVersion: "0.1.0",
      adapters: [
        {
          kind: "home-assistant",
          status: "degraded",
          capabilities: ["light", "sensor"],
        },
      ],
      events: [event],
      pseudonymizationSalt: "0123456789abcdef-support-bundle",
    });

    expect(validateSupportBundle(bundle)).toEqual({
      valid: true,
      issues: [],
    });
    expect(bundle.project.fingerprint).toMatch(/^p:[a-f0-9]{16}$/);
    expect(bundle.adapters[0]).toEqual({
      kind: "home-assistant",
      status: "degraded",
      capabilities: ["light", "sensor"],
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("private-home-fingerprint");
    expect(serialized).not.toContain("light.living_room_floor_lamp");
  });

  it("rejects too-short pseudonymization salts", () => {
    expect(() =>
      createSupportBundle({
        createdAt: "2026-10-04T09:10:00Z",
        application: {
          version: "0.0.0",
          sourceCommit: "abc123",
          toolchainManifestSha256: "a".repeat(64),
        },
        environment: {
          runtime: "browser",
          renderBackend: "babylon-webgpu",
        },
        projectFingerprint: "private",
        events: [],
        pseudonymizationSalt: "short",
      }),
    ).toThrow("at least 16 characters");
  });
});
