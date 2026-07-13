# GPT-5.6 Review Model Routing Design

## Context

The cockpit runs four distinct AI review phases: scout, parallel chapter review, validation, and synthesis. They currently inherit the active Pi model and vary only reasoning effort by review depth. Pi 0.80.6 exposes three GPT-5.6 category models through the `openai-codex` provider:

- `gpt-5.6-luna`: fast and affordable
- `gpt-5.6-terra`: balanced for everyday agentic work
- `gpt-5.6-sol`: frontier model for the hardest review judgment

The workflow should route each phase to the category that matches its job while preserving existing user configuration and safe fallback behavior.

## Goals

- Improve review quality where judgment matters most.
- Keep scouting and standard synthesis responsive.
- Preserve the existing `fast`, `standard`, and `deep` review-depth contract.
- Keep phase-level user configuration authoritative.
- Continue working on Pi installations whose model registry does not contain GPT-5.6.

## Default Routing

All built-in GPT-5.6 defaults use provider `openai-codex`.

| Phase | Fast | Standard | Deep |
| --- | --- | --- | --- |
| Scout | Luna `low` | Luna `medium` | Terra `high` |
| Chapter agents | Luna `medium` | Terra `high` | Sol `xhigh` |
| Validation critic | Terra `high` | Sol `xhigh` | Sol `max` |
| Synthesis | Luna `medium` | Terra `high` | Sol `xhigh` |

The standard profile remains the product default. It uses Luna for quick review planning, Terra for parallel evidence discovery, Sol for the false-positive-sensitive validation pass, and Terra for concise synthesis after validation has established the accepted findings.

## Resolution And Overrides

The configuration resolution order remains unchanged:

1. Built-in depth-aware GPT-5.6 defaults.
2. Global cockpit config.
3. Repository cockpit config.
4. Explicit config path from `PI_DIFF_REVIEW_COCKPIT_CONFIG`.

Later user configuration overrides earlier values. A phase can override provider, model, reasoning, or all three. An override to reasoning alone applies to the built-in model for that phase. An override to model alone uses the depth-default reasoning when that model supports it.

The JSON parser will accept Pi's supported reasoning values through `max`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

## Fallback Behavior

If a built-in or configured model is absent from the Pi model registry, the phase uses the active Pi model and records a concise warning in the resolved public configuration. The phase then applies its requested reasoning only when the fallback model supports that level; otherwise reasoning is disabled and the existing compatibility warning is retained.

Fallback must never prevent a human from opening the diff or running a review with an otherwise usable active model.

## Runtime Requirement

The local Pi installation must be upgraded from 0.80.3 to 0.80.6 so its model catalog contains Luna, Terra, and Sol. The cockpit's package dependencies already use 0.80.6. The package peer range remains compatible with older 0.80.x Pi installations because the runtime fallback is intentional.

## User Experience

The existing AI review status UI already exposes each phase's resolved model and reasoning level. No new control or model-management surface is required. The change should be visible as better defaults, not as additional workflow complexity.

## Testing

Add focused configuration tests that prove:

- Each depth resolves the exact model and reasoning matrix above.
- A phase-level user override wins over the built-in model and reasoning.
- A missing GPT-5.6 model falls back to the active Pi model with a warning.
- `max` is accepted and retained for a model that supports it.
- Unsupported reasoning still degrades to `off` with a warning.

Run the full type check and test suite after the focused tests pass.

## Non-Goals

- No automatic provider or account switching.
- No model picker in the review workspace.
- No changes to prompts, skills, parallelism, patch limits, or finding caps.
- No fallback to a different GPT-5.6 category before the active-model fallback.

## Acceptance Criteria

- A default standard review resolves to Luna `medium`, Terra `high`, Sol `xhigh`, and Terra `high` for scout, chapter, validation, and synthesis respectively.
- Fast and deep reviews resolve to their documented matrices.
- Existing configuration files can override every phase as before.
- Review startup remains usable when GPT-5.6 is unavailable.
- Pi 0.80.6 lists all three configured model IDs locally.
