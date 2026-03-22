# opencode-manager

`opencode-manager` is a proof-first Python CLI for OpenCode session orchestration.

The main command is `ocm`.

The active CLI contract is summarized in [proof-contract.md](/home/dzack/opencode-plugins/clis/opencode-manager/docs/proof-contract.md).

## Why This Exists

OpenCode already has primitives for creating sessions, continuing sessions, queueing prompts, and exporting transcripts. What it does not provide by itself is a narrow, proof-oriented operator CLI that makes continued-session orchestration explicit and testable.

`opencode-manager` exists to solve that exact gap:

- turn session continuation into a small, documented CLI surface instead of ad hoc HTTP calls
- preserve the real continued-session contract: default prompts resume the agent, while `--no-reply` is the explicit queue-only edge case
- make queued system prompts observable in transcript/session state and prove their later effect on the next real turn
- give plugin and workflow authors a canonical way to prove behavior against an isolated OpenCode instance instead of helper-heavy simulations

In short: this tool is for managing real OpenCode sessions in a way that can be proven from live state, not guessed from mocked transcripts or inferred from optimistic success messages.

It is intentionally narrow:

- prove real session continuation against the canonical isolated OpenCode server
- derive continued-turn identity from live session history
- carry queued system prompts into the next real continued turn

## Install

```bash
uv sync --all-groups
```

## Commands

Prompt-bearing commands take positional arguments.

```bash
ocm one-shot "Reply with ONLY OK."
ocm begin-session "Reply with ONLY READY." --agent opencode-manager-proof
ocm chat ses_123 "Reply with ONLY SECOND_OK."
ocm chat ses_123 "Stay terse." --system
ocm doctor --json
ocm wait ses_123 --json
ocm transcript ses_123 --json
ocm final ses_123 "Reply with ONLY DONE."
ocm delete ses_123
opencode-transcript ses_123
opencode-transcript --input tests/fixtures/transcript-multiturn.json
```

## Workflow Contract

- Public command inputs are validated through strict Pydantic models before orchestration work begins.
- Default continued-session behavior resumes the agent turn.
- `chat --no-reply` is the explicit queue-only edge case.
- `chat --system` records an agent-only system prompt in the transcript; it is carried in session state but is not shown to the user as a visible prompt line.
- A recorded user message without a new assistant turn is not considered success for default continuation.
- Continued turns re-send the observed agent/model identity from the live session transcript.
- `chat --system --no-reply` records an idle queued system message, and the next continued turn carries that queued system prompt into the live `/message` request.
- `doctor` verifies config resolution under standard OpenCode precedence, reports the resolved proof workspace, and optionally checks server reachability.

## Test Runtime

Live proofs are managed by the centralized CI workflow. The repo-local `just test` contract assumes a prepared proof environment instead of creating its own sandbox.

```bash
just test
```

`just test` will:

1. lint and typecheck the CLI
2. run the shared Python QC gate
3. execute live proofs if `OPENCODE_BASE_URL` points at a managed proof server while the repo-root [`opencode.json`](/home/dzack/opencode-plugins/clis/opencode-manager/opencode.json) remains in place for standard project config discovery

## Testing Surface

- Live orchestration proofs run through the centralized CI proof workflow against a clean OpenCode server.

## Verification

```bash
just test
```
