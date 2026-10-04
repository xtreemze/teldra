import { describe, expect, it } from "vitest";
import {
  angleToRadians,
  convertTemperature,
  createPresentationService,
  formatLength,
  formatTimestamp,
  lengthFromMetres,
  lengthToMetres,
  parseLengthToMetres,
  parseLocalizedNumber,
  parseRfc3339Instant,
  type PresentationPolicy,
} from "../src/index.js";

const metricPolicy: PresentationPolicy = {
  locale: "sv-SE",
  timeZone: "Europe/Stockholm",
  length: {
    style: "decimal",
    unit: "metre",
    maximumFractionDigits: 2,
  },
  angleUnit: "degree",
  temperatureUnit: "celsius",
  maximumFractionDigits: 1,
};

const imperialPolicy: PresentationPolicy = {
  locale: "en-US",
  timeZone: "America/New_York",
  length: {
    style: "decimal",
    unit: "foot",
    maximumFractionDigits: 2,
  },
  angleUnit: "degree",
  temperatureUnit: "fahrenheit",
  maximumFractionDigits: 1,
};

describe("presentation policy", () => {
  it("changes display locale and units without mutating canonical metres", () => {
    const canonicalMetres = 1.25;

    const metric = createPresentationService(metricPolicy);
    const imperial = createPresentationService(imperialPolicy);

    expect(normalizeSpace(metric.formatLength(canonicalMetres))).toBe("1,25 m");
    expect(normalizeSpace(imperial.formatLength(canonicalMetres))).toBe(
      "4.1 ft",
    );
    expect(canonicalMetres).toBe(1.25);
  });

  it("supports architectural feet-and-inches presentation", () => {
    expect(
      formatLength(1.8669, {
        locale: "en-US",
        length: {
          style: "architectural",
          fractionalInchDenominator: 16,
        },
      }),
    ).toBe("6′ 1 1/2″");
  });

  it("parses localized decimals only with an explicit source unit", () => {
    expect(parseLengthToMetres("1,25", "metre", "sv-SE")).toBe(1.25);
    expect(parseLengthToMetres("3.5", "foot", "en-US")).toBeCloseTo(
      1.0668,
      10,
    );
  });

  it("rejects grouping and mismatched locale separators instead of guessing", () => {
    expect(() => parseLocalizedNumber("1,234.5", "en-US")).toThrow(
      "Grouped numeric input",
    );
    expect(() => parseLocalizedNumber("1.25", "sv-SE")).toThrow(
      "does not match the declared locale",
    );
  });

  it("round-trips mixed explicit source units through canonical metres", () => {
    const fromMillimetres = lengthToMetres(2500, "millimetre");
    const fromFeet = lengthToMetres(
      lengthFromMetres(fromMillimetres, "foot"),
      "foot",
    );

    expect(fromMillimetres).toBe(2.5);
    expect(fromFeet).toBeCloseTo(2.5, 12);
  });

  it("keeps canonical radians independent from degree display", () => {
    const canonicalRadians = Math.PI;
    const service = createPresentationService(metricPolicy);

    expect(service.formatAngle(canonicalRadians)).toBe("180°");
    expect(angleToRadians(180, "degree")).toBeCloseTo(Math.PI, 12);
    expect(canonicalRadians).toBe(Math.PI);
  });

  it("formats temperature preferences from an explicit source unit", () => {
    const metric = createPresentationService(metricPolicy);
    const imperial = createPresentationService(imperialPolicy);

    expect(normalizeSpace(metric.formatTemperature(293.15, "kelvin"))).toBe(
      "20 °C",
    );
    expect(normalizeSpace(imperial.formatTemperature(293.15, "kelvin"))).toBe(
      "68 °F",
    );
    expect(convertTemperature(68, "fahrenheit", "celsius")).toBeCloseTo(
      20,
      12,
    );
  });

  it("presents one source instant in different user time zones without changing it", () => {
    const source = "2026-10-04T09:00:00Z";
    const instant = parseRfc3339Instant(source);

    const stockholm = formatTimestamp(source, {
      locale: "sv-SE",
      timeZone: "Europe/Stockholm",
    });
    const newYork = formatTimestamp(source, {
      locale: "en-US",
      timeZone: "America/New_York",
    });

    expect(stockholm).not.toBe(newYork);
    expect(instant.toISOString()).toBe("2026-10-04T09:00:00.000Z");
    expect(source).toBe("2026-10-04T09:00:00Z");
  });

  it("rejects timestamps without an explicit source timezone", () => {
    expect(() => parseRfc3339Instant("2026-10-04T09:00:00")).toThrow(
      "include an explicit timezone",
    );
  });
});

function normalizeSpace(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, " ");
}
