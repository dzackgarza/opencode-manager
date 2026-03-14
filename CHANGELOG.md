# Changelog

## 2.0.0

### Breaking Changes

- `opx begin-session` now requires the initial prompt as a positional
  argument:
  - old: `opx begin-session [--agent ...] [--model ...] [--json]`
  - new: `opx begin-session <prompt> [--agent ...] [--model ...] [--json]`
- `begin-session` no longer creates an empty prolonged session. Session
  creation and first prompt submission are now one workflow step.
- `begin-session --json` no longer echoes requested responder knobs. It returns
  the created session handle and context only.
- Prolonged-session continuation no longer relies on manager-owned persisted
  responder metadata. Continued prompts derive the active agent/model from the
  live session history.

### Fixed

- Fixed the invalid empty-session workflow that could create a session record
  without any initial conversational turn.
- Fixed explicit startup responder selection for prolonged sessions so the
  first turn now records the requested `--agent` / `--model` instead of
  falling back to OpenCode defaults.
- Fixed continuation so later `chat`, `system`, and `final` prompts reuse the
  session's observed responder identity without exposing public mid-session
  agent/model overrides.
- Fixed top-level and command help so the public workflow matches the actual
  CLI contract.

### Changed

- README now documents the corrected prolonged-session workflow with a
  required initial prompt and live session-derived continuation identity.
- Removed the obsolete redesign implementation plan file now that the work is
  represented by the shipped CLI contract, tests, and changelog.

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
