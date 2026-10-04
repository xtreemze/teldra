# ADR 0019: Locale, display units, and time-zone presentation

Status: accepted

## Context

Teldra moves data between IFC, SH3D, smart-home adapters, project files, browser UI, CLI reports, and renderer projections. Canonical values must not change merely because one user prefers Swedish formatting and metres while another prefers US formatting and architectural feet/inches.

Presentation preferences are therefore separate from source/canonical semantics.

## Canonical boundary

- architectural/project distances remain metres;
- architectural/project angles remain radians;
- timestamps that represent instants retain an explicit source timezone/offset;
- other physical values retain an explicit source/canonical unit defined by their owning contract.

Presentation services never write formatted strings or display-unit values back into canonical IFC/twin state.

Changing locale, timezone, or display units is a view/session preference and is not a canonical application command.

## Shared presentation service

`@teldra/presentation` is the framework-neutral formatter/parser contract.

It uses platform `Intl` facilities and has no SolidJS, Lit, renderer, Home Assistant, or filesystem dependency. Studio, Lit embeds, CLI reporting, and integration surfaces may consume the same service.

The initial policy covers:

- locale;
- display timezone;
- decimal metric/imperial length units;
- architectural feet/inches with explicit fractional precision;
- degree/radian angle display;
- Celsius/Fahrenheit/Kelvin temperature display;
- locale-aware date/time presentation.

## Length

Canonical architectural length is metres.

Supported explicit source/display units are millimetres, centimetres, metres, inches, and feet.

Architectural display is a presentation transform from metres into feet/inches. It does not change the canonical value or IFC placement.

## Parsing and import

Parsing is stricter than formatting.

A numeric string is converted only when the caller supplies:

1. the intended locale for decimal syntax;
2. the explicit physical source unit.

The shared parser does not infer a source unit from locale, filename, current UI preference, or magnitude.

Grouped numeric input is rejected by the canonical conversion helper rather than interpreting ambiguous strings such as `1,234` differently in different locales.

Importers should prefer source-format metadata over localized text. Mixed-unit source projects are normalized element-by-element using each value's explicit source unit, then stored in canonical units.

## Time

Source timestamps representing instants must be RFC3339 with `Z` or an explicit offset.

User-local rendering applies the selected IANA timezone only at presentation time. It never rewrites the original source timestamp or changes event ordering.

Locale-specific date strings without an explicit timezone are not accepted as persisted instants.

## Temperature and other measurements

Temperature conversion always names both source and target units. The presentation preference selects Celsius, Fahrenheit, or Kelvin but does not reinterpret an unlabelled number.

The same principle applies to future pressure, energy, power, flow, illuminance, and other measurements: the owning data contract defines the physical unit; presentation converts explicitly.

## Round-trip rule

Canonical-to-display-to-canonical conversion is not used as a persistence pipeline because display formatting may round.

Round-trip safety means:

- import/source value + explicit source unit -> canonical value;
- canonical value remains unchanged while any number of presentation policies render it;
- export uses the target format's explicitly requested unit, not a previously formatted UI string.

## Consequences

- SolidJS and Lit cannot drift into separate unit/locale implementations;
- Home Assistant display preferences cannot redefine Teldra canonical semantics;
- mixed-unit imported homes can normalize deterministically;
- CLI and browser reports can agree on presentation policy;
- locale changes do not create dirty project state or undo/redo entries.
