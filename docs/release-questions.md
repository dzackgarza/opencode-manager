# Release Questions

These items did not block the redesign implementation, but they should be
reviewed after the release is pushed.

## Identity Defaults

- `begin-session` currently accepts omitted `--agent` / `--model` because the
  documented usage marks them optional.
- Continued-session prompt commands require stored responder identity and will
  fail loudly if either field was omitted at creation time.
- Review question: should a future release make `begin-session` require both
  flags, or should the manager learn how to resolve and persist the server's
  effective default responder identity?

## System Prompt Queue Validation

- The OpenCode prompt API exposes a `system` field for agent-only prompts.
- For `system --no-reply`, the implementation validates acceptance by observing
  that the session's `time.updated` changes after prompt injection.
- Review question: is there a stronger canonical server-side witness for queued
  system prompts before continuation occurs?
