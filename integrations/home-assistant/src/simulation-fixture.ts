import type { HaRawSnapshot } from "./inventory.js";

/**
 * Small deterministic synthetic home used by simulation mode and tests.
 *
 * Every entity id here is synthetic (`*.sim_*`). Nothing in this fixture
 * identifies a real home, device, or Home Assistant instance.
 */
export function syntheticHomeSnapshot(): HaRawSnapshot {
  const t = "2026-01-01T00:00:00.000Z";
  return {
    areas: [
      { area_id: "sim_living", name: "Sim Living Room" },
      { area_id: "sim_hall", name: "Sim Hall" },
    ],
    devices: [
      { id: "dev_sim_ceiling", name: "Sim Ceiling", area_id: "sim_living" },
      { id: "dev_sim_lamp", name: "Sim Lamp", area_id: null },
      { id: "dev_sim_strip", name: "Sim Strip", area_id: "sim_hall" },
    ],
    entities: [
      { entity_id: "light.sim_ceiling", device_id: "dev_sim_ceiling", platform: "sim" },
      // Entity-level area overrides device-level (none) area.
      { entity_id: "light.sim_lamp", device_id: "dev_sim_lamp", area_id: "sim_living", platform: "sim" },
      { entity_id: "light.sim_strip", device_id: "dev_sim_strip", platform: "sim" },
      { entity_id: "light.sim_group_living", platform: "group" },
      { entity_id: "light.sim_disabled", platform: "sim", disabled_by: "user" },
    ],
    states: [
      {
        entity_id: "light.sim_ceiling",
        state: "on",
        attributes: {
          friendly_name: "Sim Ceiling",
          supported_color_modes: ["brightness"],
          color_mode: "brightness",
          brightness: 200,
          supported_features: 32,
        },
        last_changed: t,
        last_updated: t,
      },
      {
        entity_id: "light.sim_lamp",
        state: "off",
        attributes: {
          friendly_name: "Sim Lamp",
          supported_color_modes: ["color_temp"],
          min_color_temp_kelvin: 2200,
          max_color_temp_kelvin: 6500,
          supported_features: 0,
        },
        last_changed: t,
        last_updated: t,
      },
      {
        entity_id: "light.sim_strip",
        state: "on",
        attributes: {
          friendly_name: "Sim Strip",
          supported_color_modes: ["color_temp", "rgb"],
          color_mode: "rgb",
          min_color_temp_kelvin: 2000,
          max_color_temp_kelvin: 6535,
          effect_list: ["rainbow", "pulse"],
          effect: "rainbow",
          brightness: 120,
          rgb_color: [255, 0, 0],
          supported_features: 4,
        },
        last_changed: t,
        last_updated: t,
      },
      {
        entity_id: "light.sim_group_living",
        state: "on",
        attributes: {
          friendly_name: "Sim Living Group",
          entity_id: ["light.sim_ceiling", "light.sim_lamp"],
          supported_color_modes: ["brightness", "color_temp"],
          min_color_temp_kelvin: 2200,
          max_color_temp_kelvin: 6500,
          brightness: 200,
          supported_features: 32,
        },
        last_changed: t,
        last_updated: t,
      },
      {
        entity_id: "scene.sim_evening",
        state: "unknown",
        attributes: {
          friendly_name: "Sim Evening",
          entity_id: ["light.sim_ceiling", "light.sim_lamp"],
        },
        last_changed: t,
        last_updated: t,
      },
      {
        entity_id: "switch.adaptive_lighting_sim_living",
        state: "on",
        attributes: {
          friendly_name: "Adaptive Lighting: sim_living",
          configuration: { lights: ["light.sim_lamp", "light.sim_group_living"] },
          manual_control: ["light.sim_lamp"],
        },
        last_changed: t,
        last_updated: t,
      },
      {
        entity_id: "switch.adaptive_lighting_sleep_mode_sim_living",
        state: "off",
        attributes: { friendly_name: "Adaptive Lighting Sleep Mode: sim_living" },
        last_changed: t,
        last_updated: t,
      },
    ],
  };
}
