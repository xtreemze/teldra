import { describe, expect, it } from "vitest";
import {
  detectAdaptiveLightingInstances,
  detectLightCapabilities,
  normalizeInventory,
  syntheticHomeSnapshot,
  validateLightRequest,
} from "../src/index.js";

const snapshot = syntheticHomeSnapshot();
const inventory = normalizeInventory(snapshot);

function light(entityId: string) {
  const found = inventory.lights.find((l) => l.entityId === entityId);
  if (found === undefined) throw new Error(`missing ${entityId}`);
  return found;
}

describe("normalizeInventory", () => {
  it("lists areas sorted by id", () => {
    expect(inventory.areas.map((a) => a.areaId)).toEqual(["sim_hall", "sim_living"]);
  });

  it("resolves light areas, with entity area overriding device area", () => {
    expect(light("light.sim_ceiling").areaId).toBe("sim_living"); // via device
    expect(light("light.sim_lamp").areaId).toBe("sim_living"); // via entity override
    expect(light("light.sim_strip").areaId).toBe("sim_hall");
    expect(light("light.sim_group_living").areaId).toBeNull();
  });

  it("identifies groups through the entity_id attribute and back-links members", () => {
    const group = light("light.sim_group_living");
    expect(group.isGroup).toBe(true);
    expect(group.memberEntityIds).toEqual(["light.sim_ceiling", "light.sim_lamp"]);
    expect(light("light.sim_ceiling").isGroup).toBe(false);
    expect(light("light.sim_ceiling").memberOfGroups).toEqual(["light.sim_group_living"]);
    expect(inventory.groups).toEqual([
      {
        entityId: "light.sim_group_living",
        name: "Sim Living Group",
        memberEntityIds: ["light.sim_ceiling", "light.sim_lamp"],
      },
    ]);
  });

  it("flags disabled registry entities and keeps them out of controllable lights", () => {
    expect(light("light.sim_disabled").disabled).toBe(true);
    expect(light("light.sim_disabled").available).toBe(false);
  });

  it("exposes scenes as a read-only list", () => {
    expect(inventory.scenes).toEqual([
      {
        entityId: "scene.sim_evening",
        name: "Sim Evening",
        areaId: null,
        memberEntityIds: ["light.sim_ceiling", "light.sim_lamp"],
      },
    ]);
  });

  it("is deterministic and does not mutate its input", () => {
    const before = JSON.stringify(snapshot);
    expect(normalizeInventory(snapshot)).toEqual(inventory);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

describe("detectLightCapabilities", () => {
  it("reads color modes, kelvin range, effects and transition support", () => {
    const strip = light("light.sim_strip").capabilities;
    expect(strip.supportedColorModes).toEqual(["color_temp", "rgb"]);
    expect(strip.colorMode).toBe("rgb");
    expect(strip.brightness).toBe(true);
    expect(strip.colorTemp).toEqual({ minKelvin: 2000, maxKelvin: 6535 });
    expect(strip.rgb).toBe(true);
    expect(strip.effects).toEqual(["rainbow", "pulse"]);
    expect(strip.transition).toBe(false);
  });

  it("detects transition from supported_features bit 32", () => {
    expect(light("light.sim_ceiling").capabilities.transition).toBe(true);
    expect(light("light.sim_lamp").capabilities.transition).toBe(false);
  });

  it("falls back to HA default kelvin bounds when color_temp lacks them", () => {
    const caps = detectLightCapabilities({
      entity_id: "light.sim_x",
      state: "on",
      attributes: { supported_color_modes: ["color_temp"] },
      last_changed: "t",
    });
    expect(caps.colorTemp).toEqual({ minKelvin: 2000, maxKelvin: 6535 });
  });

  it("treats a light with no color-mode data as on/off only", () => {
    const caps = detectLightCapabilities({
      entity_id: "light.sim_x",
      state: "on",
      attributes: {},
      last_changed: "t",
    });
    expect(caps.supportedColorModes).toEqual(["onoff"]);
    expect(caps.brightness).toBe(false);
    expect(caps.colorTemp).toBeNull();
    expect(caps.rgb).toBe(false);
    expect(caps.effects).toEqual([]);
  });
});

describe("validateLightRequest", () => {
  const strip = light("light.sim_strip");
  const ceiling = light("light.sim_ceiling");
  const lamp = light("light.sim_lamp");

  it("clamps brightness percent and reports the adjustment", () => {
    const result = validateLightRequest(strip, { kind: "turn_on", brightnessPct: 150 });
    expect(result).toMatchObject({
      ok: true,
      service: "turn_on",
      serviceData: { brightness_pct: 100 },
      adjustments: [{ field: "brightnessPct", requested: 150, applied: 100 }],
    });
  });

  it("rejects brightness 0 and directs to turn_off", () => {
    expect(validateLightRequest(strip, { kind: "turn_on", brightnessPct: 0 })).toMatchObject({
      ok: false,
      error: { code: "use-turn-off" },
    });
  });

  it("clamps color temperature to the light's kelvin range", () => {
    expect(validateLightRequest(lamp, { kind: "turn_on", colorTempKelvin: 1000 })).toMatchObject({
      ok: true,
      serviceData: { color_temp_kelvin: 2200 },
    });
    expect(validateLightRequest(lamp, { kind: "turn_on", colorTempKelvin: 9000 })).toMatchObject({
      ok: true,
      serviceData: { color_temp_kelvin: 6500 },
    });
  });

  it("rejects unsupported features instead of silently dropping them", () => {
    expect(validateLightRequest(ceiling, { kind: "turn_on", colorTempKelvin: 3000 })).toMatchObject({
      ok: false,
      error: { code: "unsupported-color-temp" },
    });
    expect(validateLightRequest(lamp, { kind: "turn_on", rgbColor: [1, 2, 3] })).toMatchObject({
      ok: false,
      error: { code: "unsupported-rgb" },
    });
    expect(validateLightRequest(ceiling, { kind: "turn_on", effect: "rainbow" })).toMatchObject({
      ok: false,
      error: { code: "unknown-effect" },
    });
  });

  it("rejects an effect that is not in effect_list", () => {
    expect(validateLightRequest(strip, { kind: "turn_on", effect: "strobe" })).toMatchObject({
      ok: false,
      error: { code: "unknown-effect" },
    });
    expect(validateLightRequest(strip, { kind: "turn_on", effect: "pulse" })).toMatchObject({
      ok: true,
      serviceData: { effect: "pulse" },
    });
  });

  it("rejects conflicting color requests", () => {
    expect(
      validateLightRequest(strip, { kind: "turn_on", rgbColor: [1, 2, 3], colorTempKelvin: 3000 }),
    ).toMatchObject({ ok: false, error: { code: "conflicting-color" } });
  });

  it("clamps rgb channels and rounds to integers", () => {
    expect(validateLightRequest(strip, { kind: "turn_on", rgbColor: [300, -5, 12.6] })).toMatchObject({
      ok: true,
      serviceData: { rgb_color: [255, 0, 13] },
    });
  });

  it("drops transition when unsupported, clamps when supported", () => {
    const dropped = validateLightRequest(strip, { kind: "turn_on", transitionSeconds: 5 });
    expect(dropped).toMatchObject({ ok: true });
    if (dropped.ok) {
      expect(dropped.serviceData).not.toHaveProperty("transition");
      expect(dropped.adjustments[0]).toMatchObject({ field: "transitionSeconds", applied: null });
    }
    expect(validateLightRequest(ceiling, { kind: "turn_on", transitionSeconds: 9999 })).toMatchObject({
      ok: true,
      serviceData: { transition: 300 },
    });
  });

  it("rejects non-finite numbers", () => {
    expect(validateLightRequest(strip, { kind: "turn_on", brightnessPct: Number.NaN })).toMatchObject({
      ok: false,
      error: { code: "invalid-value" },
    });
  });

  it("rejects commands for unavailable or disabled lights", () => {
    const disabled = light("light.sim_disabled");
    expect(validateLightRequest(disabled, { kind: "turn_on" })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("allows plain turn_off for any available light", () => {
    expect(validateLightRequest(ceiling, { kind: "turn_off" })).toMatchObject({
      ok: true,
      service: "turn_off",
      serviceData: {},
    });
  });
});

describe("detectAdaptiveLightingInstances", () => {
  it("detects main switches read-only and ignores companion switches", () => {
    const instances = detectAdaptiveLightingInstances(snapshot.states);
    expect(instances).toEqual([
      {
        switchEntityId: "switch.adaptive_lighting_sim_living",
        enabled: true,
        lightEntityIds: ["light.sim_lamp", "light.sim_group_living"],
        manualControlEntityIds: ["light.sim_lamp"],
        coverage: "known",
      },
    ]);
  });

  it("surfaces that automations may override covered lights", () => {
    expect(light("light.sim_group_living").adaptiveLighting).toEqual({
      mayBeOverridden: true,
      switchEntityIds: ["switch.adaptive_lighting_sim_living"],
      manualControlActive: false,
    });
    // Manual control active: AL has backed off for now but may resume.
    expect(light("light.sim_lamp").adaptiveLighting).toEqual({
      mayBeOverridden: true,
      switchEntityIds: ["switch.adaptive_lighting_sim_living"],
      manualControlActive: true,
    });
    expect(light("light.sim_strip").adaptiveLighting).toEqual({
      mayBeOverridden: false,
      switchEntityIds: [],
      manualControlActive: false,
    });
  });

  it("treats an enabled instance with unknown coverage as possibly overriding every light", () => {
    const states = [
      {
        entity_id: "switch.adaptive_lighting_sim_x",
        state: "on",
        attributes: {},
        last_changed: "t",
      },
      ...snapshot.states.filter((s) => s.entity_id.startsWith("light.")),
    ];
    const inv = normalizeInventory({ ...snapshot, states });
    expect(inv.adaptiveLighting[0]?.coverage).toBe("unknown");
    expect(inv.lights.find((l) => l.entityId === "light.sim_strip")?.adaptiveLighting.mayBeOverridden).toBe(true);
  });

  it("does not report disabled instances as overriding", () => {
    const states = snapshot.states.map((s) =>
      s.entity_id === "switch.adaptive_lighting_sim_living" ? { ...s, state: "off" } : s,
    );
    const inv = normalizeInventory({ ...snapshot, states });
    expect(inv.lights.find((l) => l.entityId === "light.sim_group_living")?.adaptiveLighting.mayBeOverridden).toBe(false);
  });
});
