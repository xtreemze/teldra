export type LengthUnit =
  | "millimetre"
  | "centimetre"
  | "metre"
  | "inch"
  | "foot";

export type AngleUnit = "radian" | "degree";
export type TemperatureUnit = "kelvin" | "celsius" | "fahrenheit";

export type LengthDisplayPolicy =
  | {
      readonly style: "decimal";
      readonly unit: LengthUnit;
      readonly maximumFractionDigits?: number;
    }
  | {
      readonly style: "architectural";
      readonly fractionalInchDenominator?: 2 | 4 | 8 | 16 | 32 | 64;
    };

export interface PresentationPolicy {
  readonly locale: string;
  readonly timeZone: string;
  readonly length: LengthDisplayPolicy;
  readonly angleUnit: AngleUnit;
  readonly temperatureUnit: TemperatureUnit;
  readonly maximumFractionDigits?: number;
}

export interface PresentationService {
  readonly policy: PresentationPolicy;
  formatNumber(value: number): string;
  formatLength(metres: number): string;
  formatAngle(radians: number): string;
  formatTemperature(value: number, sourceUnit: TemperatureUnit): string;
  formatTimestamp(rfc3339: string): string;
  parseLength(text: string, sourceUnit: LengthUnit): number;
}

const METRES_PER_UNIT: Readonly<Record<LengthUnit, number>> = {
  millimetre: 0.001,
  centimetre: 0.01,
  metre: 1,
  inch: 0.0254,
  foot: 0.3048,
};

const INTL_LENGTH_UNIT: Readonly<Record<LengthUnit, string>> = {
  millimetre: "millimeter",
  centimetre: "centimeter",
  metre: "meter",
  inch: "inch",
  foot: "foot",
};

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function createPresentationService(
  policy: PresentationPolicy,
): PresentationService {
  validatePolicy(policy);

  return {
    policy,
    formatNumber: (value) => formatNumber(value, policy),
    formatLength: (metres) => formatLength(metres, policy),
    formatAngle: (radians) => formatAngle(radians, policy),
    formatTemperature: (value, sourceUnit) =>
      formatTemperature(value, sourceUnit, policy),
    formatTimestamp: (rfc3339) => formatTimestamp(rfc3339, policy),
    parseLength: (text, sourceUnit) =>
      parseLengthToMetres(text, sourceUnit, policy.locale),
  };
}

export function formatNumber(
  value: number,
  policy: Pick<PresentationPolicy, "locale" | "maximumFractionDigits">,
): string {
  assertFinite(value, "value");

  return new Intl.NumberFormat(policy.locale, {
    maximumFractionDigits: policy.maximumFractionDigits ?? 3,
  }).format(value);
}

export function formatLength(
  metres: number,
  policy: Pick<PresentationPolicy, "locale" | "length">,
): string {
  assertFinite(metres, "metres");

  if (policy.length.style === "architectural") {
    return formatArchitecturalLength(
      metres,
      policy.length.fractionalInchDenominator ?? 16,
    );
  }

  const value = lengthFromMetres(metres, policy.length.unit);
  return new Intl.NumberFormat(policy.locale, {
    style: "unit",
    unit: INTL_LENGTH_UNIT[policy.length.unit],
    unitDisplay: "short",
    maximumFractionDigits: policy.length.maximumFractionDigits ?? 3,
  }).format(value);
}

export function formatAngle(
  radians: number,
  policy: Pick<PresentationPolicy, "locale" | "angleUnit" | "maximumFractionDigits">,
): string {
  assertFinite(radians, "radians");

  const value =
    policy.angleUnit === "degree"
      ? radians * (180 / Math.PI)
      : radians;
  const suffix = policy.angleUnit === "degree" ? "°" : " rad";
  const formatted = new Intl.NumberFormat(policy.locale, {
    maximumFractionDigits: policy.maximumFractionDigits ?? 2,
  }).format(value);

  return `${formatted}${suffix}`;
}

export function formatTemperature(
  value: number,
  sourceUnit: TemperatureUnit,
  policy: Pick<
    PresentationPolicy,
    "locale" | "temperatureUnit" | "maximumFractionDigits"
  >,
): string {
  const converted = convertTemperature(value, sourceUnit, policy.temperatureUnit);
  const formatted = new Intl.NumberFormat(policy.locale, {
    maximumFractionDigits: policy.maximumFractionDigits ?? 1,
  }).format(converted);

  return `${formatted} ${temperatureSymbol(policy.temperatureUnit)}`;
}

export function formatTimestamp(
  rfc3339: string,
  policy: Pick<PresentationPolicy, "locale" | "timeZone">,
): string {
  const instant = parseRfc3339Instant(rfc3339);

  return new Intl.DateTimeFormat(policy.locale, {
    timeZone: policy.timeZone,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(instant);
}

export function parseLengthToMetres(
  text: string,
  sourceUnit: LengthUnit,
  locale: string,
): number {
  const value = parseLocalizedNumber(text, locale);
  return lengthToMetres(value, sourceUnit);
}

export function parseLocalizedNumber(text: string, locale: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Numeric input must not be empty.");
  }

  const positiveParts = new Intl.NumberFormat(locale, {
    useGrouping: true,
  }).formatToParts(12345.6);
  const decimal =
    positiveParts.find((part) => part.type === "decimal")?.value ?? ".";
  const group = positiveParts.find((part) => part.type === "group")?.value;

  if (
    group !== undefined &&
    group.length > 0 &&
    trimmed.includes(group)
  ) {
    throw new Error(
      "Grouped numeric input is not accepted for canonical conversion.",
    );
  }

  const minus =
    new Intl.NumberFormat(locale)
      .formatToParts(-1)
      .find((part) => part.type === "minusSign")?.value ?? "-";

  let normalized = trimmed;
  if (minus !== "-") {
    normalized = normalized.split(minus).join("-");
  }

  if (decimal !== ".") {
    if (normalized.includes(".")) {
      throw new Error(
        "Numeric input uses a decimal separator that does not match the declared locale.",
      );
    }
    normalized = normalized.split(decimal).join(".");
  }

  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    throw new Error(
      "Numeric input is invalid or ambiguous for the declared locale.",
    );
  }

  const parsed = Number(normalized);
  assertFinite(parsed, "parsed number");
  return parsed;
}

export function lengthToMetres(value: number, unit: LengthUnit): number {
  assertFinite(value, "length");
  return value * METRES_PER_UNIT[unit];
}

export function lengthFromMetres(metres: number, unit: LengthUnit): number {
  assertFinite(metres, "metres");
  return metres / METRES_PER_UNIT[unit];
}

export function angleToRadians(value: number, unit: AngleUnit): number {
  assertFinite(value, "angle");
  return unit === "radian" ? value : value * (Math.PI / 180);
}

export function convertTemperature(
  value: number,
  sourceUnit: TemperatureUnit,
  targetUnit: TemperatureUnit,
): number {
  assertFinite(value, "temperature");

  const kelvin = toKelvin(value, sourceUnit);
  switch (targetUnit) {
    case "kelvin":
      return kelvin;
    case "celsius":
      return kelvin - 273.15;
    case "fahrenheit":
      return (kelvin - 273.15) * (9 / 5) + 32;
  }
}

export function parseRfc3339Instant(value: string): Date {
  if (!RFC3339.test(value)) {
    throw new Error(
      "Timestamp must be RFC3339 and include an explicit timezone.",
    );
  }

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Timestamp is not a valid instant.");
  }

  return new Date(milliseconds);
}

function formatArchitecturalLength(
  metres: number,
  denominator: 2 | 4 | 8 | 16 | 32 | 64,
): string {
  const sign = metres < 0 ? "-" : "";
  const totalInches = Math.abs(metres) / METRES_PER_UNIT.inch;
  const roundedInches =
    Math.round(totalInches * denominator) / denominator;

  let feet = Math.floor(roundedInches / 12);
  let remaining = roundedInches - feet * 12;
  let wholeInches = Math.floor(remaining + 1e-10);
  let numerator = Math.round((remaining - wholeInches) * denominator);

  if (numerator === denominator) {
    wholeInches += 1;
    numerator = 0;
  }

  if (wholeInches === 12) {
    feet += 1;
    wholeInches = 0;
  }

  if (numerator === 0) {
    return `${sign}${feet}′ ${wholeInches}″`;
  }

  const divisor = greatestCommonDivisor(numerator, denominator);
  return `${sign}${feet}′ ${wholeInches} ${numerator / divisor}/${denominator / divisor}″`;
}

function toKelvin(value: number, unit: TemperatureUnit): number {
  switch (unit) {
    case "kelvin":
      return value;
    case "celsius":
      return value + 273.15;
    case "fahrenheit":
      return (value - 32) * (5 / 9) + 273.15;
  }
}

function temperatureSymbol(unit: TemperatureUnit): string {
  switch (unit) {
    case "kelvin":
      return "K";
    case "celsius":
      return "°C";
    case "fahrenheit":
      return "°F";
  }
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);

  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a || 1;
}

function validatePolicy(policy: PresentationPolicy): void {
  if (policy.locale.trim().length === 0) {
    throw new Error("Presentation locale must not be empty.");
  }
  if (policy.timeZone.trim().length === 0) {
    throw new Error("Presentation timeZone must not be empty.");
  }

  try {
    new Intl.DateTimeFormat(policy.locale, {
      timeZone: policy.timeZone,
    }).format(new Date(0));
  } catch (error) {
    throw new Error("Presentation locale/timeZone is invalid.", {
      cause: error,
    });
  }
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number.`);
  }
}
