# AI Map Presentation Gate Design

## Problem

The review viewer currently becomes visible as soon as its renderer boots. For an uncached review, that renderer starts with a provisional deterministic map while semantic map generation continues in the background. The provisional viewer is technically usable, but it does not provide the AI-generated review journey that makes the cockpit valuable. Showing it first also creates a distracting replacement when the semantic map arrives.

The viewer should remain hidden until it can present either the completed AI-generated map or a truthful deterministic fallback.

## Goals

1. Do not show the review viewer with a provisional or in-progress map.
2. Boot the renderer and generate the semantic map concurrently so the presentation gate adds as little latency as possible.
3. Show a cached semantic map as soon as the renderer is ready.
4. Show the viewer with the generated semantic map only after the map has been persisted and delivered to the renderer.
5. If semantic mapping fails, show the existing deterministic fallback with a warning rather than leaving the viewer hidden indefinitely.
6. Keep AI findings generation and the rest of the review lifecycle unchanged.

## Non-Goals

- Adding a new loading window or progress screen.
- Waiting for AI findings before showing the viewer.
- Changing semantic map generation, validation, or fallback quality.
- Removing provisional maps from persistence or from the mapping pipeline.

## Design

### Presentation gate

`ReviewWindowController` will separate renderer readiness from permission to present the native window. The controller will expose an idempotent method that releases the presentation gate.

The native window is shown only when both conditions are true:

- the renderer has completed its authenticated boot handshake; and
- the host has released the presentation gate because a semantic, semantic-repaired, or fallback map is ready.

The controller will attempt presentation whenever either condition changes. This makes both event orders safe: map readiness may precede renderer boot, or renderer boot may precede map readiness. The existing boot watchdog remains responsible only for renderer readiness and is not extended to cover model execution.

### Cached semantic maps

When startup restores a valid `semantic` or `semantic-repaired` map, the host releases the presentation gate immediately after starting the controller. The viewer then appears as soon as the renderer boot handshake completes.

A restored `fallback` map does not suppress a fresh semantic-map attempt. The viewer remains hidden until that attempt returns a new semantic map or a new fallback result.

### Generated maps

For provisional, mapping, or restored fallback states, semantic map generation continues through the existing background pipeline while the renderer boots hidden.

After generation completes, the host:

1. updates the in-memory review map and derived analysis coverage;
2. saves the completed map in the review session;
3. updates the renderer protocol context;
4. sends the completed map to the renderer; and
5. releases the presentation gate.

Releasing the gate after delivery prevents a visible provisional-map frame.

### Failure behavior

The semantic map runner already converts expected scout, planning, criticism, and compilation failures into a deterministic map with `fallback` status. That fallback follows the same save, delivery, and presentation sequence as a semantic result.

If an unexpected error escapes the mapping task, the host will convert the existing provisional map into a truthful fallback map, attach a diagnostic describing the failure, update and persist the review state, deliver it to the renderer, warn through the host UI, and release the presentation gate. The review therefore remains accessible without presenting provisional content as AI-generated.

If persistence fails, existing session-save handling remains authoritative. The viewer is not presented with state that the startup flow could not durably save.

### Lifecycle and cancellation

The existing terminal waiting UI remains active while the native window is hidden. Escape cancellation and controller errors continue to close the review lifecycle normally. Releasing the presentation gate after cancellation or disposal is a no-op.

AI findings remain independent. They may be queued or generated after the mapped viewer appears, matching current behavior.

## Testing

Controller tests will verify:

- renderer boot alone does not show a gated window;
- gate release alone does not show an unbooted window;
- the window is shown exactly once when boot happens before gate release;
- the window is shown exactly once when gate release happens before boot; and
- release after disposal does nothing.

Review startup tests will verify:

- cached semantic maps release presentation without running a replacement map;
- successful semantic generation delivers the map before releasing presentation; and
- an escaped mapping error produces, persists, and presents a labeled fallback.

The full test suite and static type check must pass.

## Acceptance Criteria

- A new uncached review never displays the provisional review map.
- The viewer first appears with a `semantic`, `semantic-repaired`, or `fallback` map.
- Cached semantic reviews retain their fast startup path.
- Mapping failure cannot leave the review waiting forever when a deterministic fallback can be shown.
- AI findings behavior is unchanged.
