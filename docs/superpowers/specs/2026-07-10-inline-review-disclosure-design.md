# Inline Review Disclosure Design

## Goal

Make inline AI findings and review comments readable by default and make their expand/collapse behavior immediately understandable.

## Interaction

- Every inline AI finding and review comment starts expanded, including findings streamed into an open review.
- A developer can collapse or expand one item without changing its review status, dismissing it, or affecting another item.
- The gutter marker is a disclosure chevron: down while expanded and right while collapsed.
- Marker color preserves provenance: violet for AI, blue for the reviewer's comments, and muted gray for published GitHub comments.
- Expanded AI finding cards include a compact chevron control in the header so collapse is available where the developer is already reading.
- Hover text names the action and item, for example, `Collapse AI review: ...` or `Expand your comment`.
- Navigating directly to a finding expands it because opening a finding is an explicit request to inspect it.

## State

Use an in-memory set of explicitly collapsed AI finding IDs. An empty set therefore gives the desired default-expanded behavior and naturally includes newly streamed findings. Existing comment collapse state keeps the same explicit-collapse model. Re-rendering preserves the developer's choices for the current review window.

## Accessibility And Visual Treatment

The control uses a familiar chevron rather than a decorative sparkle or status dot. Its hit target remains aligned to Monaco's gutter grid, with restrained provenance color and a visible hover/focus treatment. The card-header control has an accessible label and tooltip but no persistent text label that would add code-canvas noise.

## Verification

- Unit-test default-expanded and explicit toggle behavior independently of Monaco.
- Assert that finding navigation reopens an explicitly collapsed item.
- Keep smoke coverage for disclosure classes, actionable hover text, and the in-card collapse control.
- Run type checking, the focused tests, the complete test suite, and the production web build.
