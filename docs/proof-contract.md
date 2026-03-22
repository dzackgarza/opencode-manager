# Proof Contract

`opencode-manager` proves orchestration at the live CLI-to-server boundary.

Its purpose is operational, not cosmetic: it provides a minimal command surface for creating, continuing, waiting on, inspecting, and deleting real OpenCode sessions while preserving the actual continuation contract. The value of the tool is that each command can be proven from live transcript and session state.

## Public Contract

- `one-shot <prompt>` creates a session, records a real assistant turn, then deletes the session.
- `begin-session <prompt>` creates a persistent session and completes the opening turn.
- `chat <session-id> <prompt>` resumes the live agent turn by default.
- `chat --no-reply <session-id> <prompt>` queues only a user message and must not create a new assistant turn.
- `chat --system <session-id> <prompt>` records an agent-only instruction in the live transcript; that system message is part of session state, not a user-visible prompt.
- `chat --system --no-reply <session-id> <prompt>` queues an idle system message first; the next real continued turn must carry that queued system prompt into `/message`.
- `final <session-id> <prompt>` completes the last turn and deletes the session.
- `transcript <session-id>` renders real session exports, not fabricated fixtures.
- `doctor` verifies config resolution under the normal global-plus-project precedence, reports the resolved proof workspace, and optionally checks server reachability without mutating session state.

## Proof Witnesses

- Default continuation success:
  a new assistant turn appears in live session state after the prompt.
- Queue-only chat success:
  the queued user message is recorded and assistant-turn count does not increase.
- Queue-only system success:
  the queued system message is recorded while assistant-turn count does not increase.
- Deferred system effect success:
  a later `chat` turn materially differs from the baseline because the queued system prompt is carried into the resumed `/message` request.
- Final success:
  the last assistant turn is recorded and the session becomes `404`.

## Diagnostics

- `PromptDeliveryError`: prompt transport succeeded but the expected transcript/session witness never appeared.
- `SessionLookupError`: the requested session does not exist.
- `WaitTimeoutError`: session mutation never stabilized within the allowed window.
- `TranscriptRenderError`: the export shape does not match the expected canonical transcript structure.
- Pydantic contract errors: public command inputs were invalid before orchestration began.

Use `OPX_LOG=INFO` or higher to localize failures around prompt submission, queued-system carry-forward, transcript reads, and idle detection.
