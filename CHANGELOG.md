# Changelog

## 3.0.0

- Rewrote `opencode-manager` from Bun/TypeScript to Python with `cyclopts`.
- Renamed the main CLI command to `ocm`.
- Replaced helper-heavy Bun tests with proof-oriented pytest coverage against the canonical isolated OpenCode server.
- Moved isolated server startup and teardown out of the package and into the centralized top-level sandbox recipes.
- Restored live responder-identity derivation for continued turns.
- Made `chat --no-reply` use the real queue-only transport with `noReply: true`.
- Collapsed agent-only prompting into `chat --system`, documenting that the system message is recorded in transcript/session state without appearing as a user-visible prompt.
- Made queued `chat --system --no-reply` prompts persist as idle transcript/session state and carry into the next real continued turn.
- Added strict Pydantic command contracts and a `doctor` setup-verification subcommand.
- Removed the obsolete TypeScript implementation and Bun-only test suite.
