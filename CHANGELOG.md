# Changelog

## 1.0.0

### Breaking Changes

- Removed the public `opx-session` binary. The package no longer ships a raw
  session-API CLI as part of the supported product surface.
- Replaced `opx run` with `opx one-shot`.
- Replaced `opx start` with `opx begin-session`.
- Replaced `opx prompt` with two workflow commands:
  - `opx chat` for user-visible prompts
  - `opx system` for agent-only prompts
- Removed public `opx resume`, `opx messages`, and `opx session ...`.
- Removed per-turn `--agent` and `--model` overrides from continued-session
  commands. Responder identity is now fixed at session creation time.
- Removed `--keep`. Lifecycle is now encoded in command semantics:
  - `one-shot` always deletes
  - `begin-session` never deletes implicitly
  - `final` always deletes
  - `delete` deletes explicitly

### Added

- Layered help with a workflow-first top-level surface plus explicit
  `advanced` and `debug` command layers.
- Canonical persisted workflow session metadata for prolonged-session commands.
- Workflow-specific output selection:
  - `one-shot` and `final` return the last assistant message by default
  - `--transcript` returns the canonical transcript instead

### Changed

- `transcript` is now the canonical public inspection surface.
- README and package metadata now describe the workflow model instead of the raw
  session API mirror.
