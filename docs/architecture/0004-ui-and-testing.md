# ADR 0004: UI framework and test-first development

Status: accepted

## Decision

Teldra Studio uses SolidJS for application UI. Framework-independent browser surfaces use Lit custom elements when they have a real embedding or interoperability requirement.

Babylon.js and deck.gl integrations remain plain TypeScript runtime adapters and must not depend on either UI framework. React is not part of the planned runtime stack.

## Storybook

Storybook is a first-class component workbench and executable UI specification.

The mature repository should support:

- a SolidJS Storybook for Studio UI;
- a Web Components/Lit Storybook for portable elements;
- shared fixtures, viewport presets, themes/decorators, and accessibility rules;
- coherent browsing across both Storybooks.

Stories should cover meaningful states, edge cases, keyboard/focus behavior, external-state changes, narrow viewports, unavailable/error states, and accessibility where applicable.

Storybook does not certify the complete GPU/BIM product. Babylon.js/deck.gl rendering, IFC workflows, Home Assistant integration, and cross-system flows remain covered by dedicated integration and Playwright tests.

## Test-driven development

For deterministic behavior, contributors should normally create the failing test or fixture before implementation. Regressions require a reproducing test whenever practical.

Tests should be placed at the lowest architectural boundary capable of proving the behavior:

```text
schema/domain invariants
        ↓
application use cases
        ↓
projection/adapter contracts
        ↓
Storybook component states
        ↓
real-browser renderer tests
        ↓
cross-system Playwright flows
        ↓
headless Blender/reference pipelines
```

End-to-end tests must not compensate for missing domain or adapter tests.
