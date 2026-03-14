[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)

# opencode-manager

`opencode-manager` is an opinionated workflow CLI for OpenCode sessions.

It intentionally exposes a small workflow surface instead of mirroring the raw
session API. If you need direct endpoint control, use the OpenCode API or SDK
directly.

## Install

```bash
npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git opx --help
npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git opencode-transcript --help
```

## Environment

`opx` and `opencode-transcript` use the normal OpenCode server environment:

- `OPENCODE_BASE_URL`: OpenCode server base URL. Defaults to `http://127.0.0.1:4096`.
- `OPENCODE_API_KEY`: Optional bearer token for direct API access.
- `OPENCODE_SERVER_USERNAME`: Optional basic-auth username when talking to a protected server.
- `OPENCODE_SERVER_PASSWORD`: Optional basic-auth password when talking to a protected server.

For repo-local verification, prefer a repo-local server:

```bash
direnv allow
direnv exec . zsh -lc 'command opencode serve --hostname 127.0.0.1 --port 4198'
```

Then point `opx` at that server:

```bash
OPENCODE_BASE_URL=http://127.0.0.1:4198 bun run src/cli.ts --help
```

## Workflow Model

There are two public workflows.

### One-shot

Use `one-shot` when the session should be created, answered, and deleted in one
command.

```bash
opx one-shot --prompt "Reply with ONLY OK."
opx one-shot --agent Minimal --model github-copilot/claude-sonnet-4.6 --prompt "Reply with ONLY OK."
opx one-shot --prompt "Summarize the repo." --transcript
```

Behavior:

- creates a session
- injects a visible prompt
- waits until the session is idle
- returns the last assistant message by default
- deletes the session

### Prolonged Session

Use `begin-session` plus follow-up commands when the session must stay alive
across turns.

```bash
opx begin-session "Inspect the README." --agent Minimal --model github-copilot/gpt-5-mini
opx chat --session ses_123 --prompt "Now inspect the justfile."
opx system --session ses_123 --prompt "Stay terse." --no-reply
opx wait --session ses_123
opx transcript --session ses_123
opx final --session ses_123 --prompt "Reply with ONLY DONE."
```

Behavior:

- `begin-session` creates the session and injects the initial user-visible prompt
- `chat` injects later user-visible prompts
- `system` injects an agent-only prompt
- prompts advance by default
- `--no-reply` queues without allowing continuation
- `wait` blocks until idle
- `transcript` is the canonical inspection surface
- `final` returns the last assistant message by default and deletes the session
- `delete` deletes a prolonged session explicitly

## Responder Identity

Responder identity is the pair:

- `--agent <name>`
- `--model provider/model`

For prolonged sessions this identity is fixed by the first prompt, whether it
was explicit or came from OpenCode defaults. Continued-session commands derive
that identity from the live session transcript and do not accept per-turn
overrides.

## Commands

### Workflow

```bash
opx one-shot --prompt <text> [--agent <name>] [--model provider/model] [--transcript]
opx begin-session <prompt> [--agent <name>] [--model provider/model] [--json]
opx chat --session <id> --prompt <text> [--no-reply]
opx system --session <id> --prompt <text> [--no-reply]
opx wait --session <id> [--json]
opx transcript --session <id> [--json] [--output PATH | --tee-temp]
opx final --session <id> --prompt <text> [--transcript]
opx delete --session <id>
```

### Advanced

```bash
opx advanced provider-list
opx advanced provider-health --provider github-copilot
```

### Debug

```bash
opx debug --help
opx debug trace --session ses_123
opx debug probe-limit --model github-copilot/claude-sonnet-4.6
```

## Transcript Renderer

`opencode-transcript` remains the standalone transcript renderer for live
sessions or saved transcript exports.

```bash
opencode-transcript ses_123
opencode-transcript ses_123 --json
opencode-transcript --input ./transcript.json
```

## Validation

Use the repo `justfile` for all verification:

```bash
just install
just check
```

## Breaking Changes

The redesign removes the old raw-session product surface:

- `opx-session` is no longer a public binary
- `opx run` became `opx one-shot`
- `opx start` became `opx begin-session`
- `opx prompt` split into `opx chat` and `opx system`
- `opx resume`, `opx messages`, and `opx session ...` are removed from the public surface
- per-turn `--agent` and `--model` overrides are removed from continued-session commands
- `--keep` is removed

See [CHANGELOG.md](/home/dzack/opencode-plugins/opencode-manager/CHANGELOG.md) for
the release record.
