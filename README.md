[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)



# opencode-manager

This Bun-based package automates OpenCode sessions via GitHub and `npx`.

## Features

- `opx run` — create session, send prompt, wait for idle, print transcript, auto-delete
- `opx resume` — send follow-up prompts to existing sessions
- `opx session` / `opx provider` / `opx debug` — session management, provider health, and diagnostic tools
- `opx-session` — full session API surface (list, get, create, prompt, transcript, revert, permissions, and more)
- `opencode-transcript` — standalone transcript renderer for live sessions or saved transcript JSON
- `findFreePort`-based server setup for safe parallel test runs

## Scope

This package provides session management and automation through the former harness utilities:

- `opx` manages run, resume, provider, and debug flows.
- `opx-session` provides broader session control.
- `opx-session transcript <session-id>` renders a turn/step markdown transcript
  from the configured OpenCode server without relying on an external package.
- `opx-session transcript <session-id> --json` emits the compact structured
  transcript document used by downstream prompt-based summarizers.
- `opencode-transcript` remains available as a compatibility entrypoint for
  transcript-only workflows, including `--input /path/to/transcript.json`.

## Run

Running these tools requires `npx` and `bun`.

```bash
npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git opx --help
npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git opx-session --help
npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git opencode-transcript --help
```

## Commands

### `opx` — automation harness

#### `opx run`

Create a session, send a prompt, wait for idle, print transcript, then delete the session.

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--prompt <text>` | Yes | — | Prompt to send |
| `--model <provider/model>` | No | server default | Model slug (e.g. `github-copilot/claude-sonnet-4.6`) |
| `--agent <name>` | No | server default | Agent name |
| `--linger <sec>` | No | `0` | Extra idle wait after first idle (use when agent may spawn async tools) |
| `--keep` | No | false | Do not delete session after completion; prints session ID to stderr |
| `--timeout <sec>` | No | `180` | Hard wall-clock timeout |

Exit codes: `0` = success, `1` = failure/timeout, `2` = provider rate-limited.

#### `opx resume`

Send a follow-up prompt to an existing session and wait for idle.

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--session <id>` | Yes | — | Session ID to resume |
| `--prompt <text>` | Yes | — | Follow-up prompt |
| `--model <provider/model>` | No | — | Override model for this turn |
| `--agent <name>` | No | — | Override agent for this turn |
| `--linger <sec>` | No | `0` | Extra idle wait |
| `--keep` | No | false | Do not delete session |
| `--timeout <sec>` | No | `180` | Hard wall-clock timeout |

#### `opx session`

| Subcommand | Required args | Description |
|------------|---------------|-------------|
| `session delete` | `--session <id>` | Delete a session |
| `session messages` | `--session <id>` | Dump all messages as JSON |

#### `opx provider`

| Subcommand | Required args | Optional flags | Description |
|------------|---------------|----------------|-------------|
| `provider list` | — | — | List providers seen in recent sessions |
| `provider health` | `--provider <id>` | `--model <provider/model>` | Fire a minimal probe; returns `{ provider, model, ok, exitCode, errorKind }` |

#### `opx debug`

| Subcommand | Required args | Optional flags | Description |
|------------|---------------|----------------|-------------|
| `debug trace` | `--session <id>` | `--timeout`, `--verbose`, `--include-aborted`, `--no-service-log` | Stream events + systemd log |
| `debug errors` | `--session <id>` | — | Dump assistant error events as JSON |
| `debug limit-errors` | `--session <id>` | `--verbose` | Dump rate-limit errors, classified |
| `debug probe-limit` | `--model <provider/model>` | `--agent`, `--prompt` | Trigger a rate-limit response |
| `debug probe-limit-known` | `--provider <id>` | `--timeout` | Strict deterministic limit probe against `known_limit_patterns.json` |
| `debug probe-limit-trace` | `--model <provider/model>` | `--agent`, `--timeout`, `--verbose`, `--include-aborted` | `probe-limit` + full event trace |
| `debug probe-async-command` | — | `--model`, `--agent` | Verify `async_command` plugin tool is reachable |
| `debug probe-async-subagent` | — | `--model`, `--agent` | Verify `async_subagent` plugin tool is reachable |

---

### `opx-session` — full session API

| Command | Required args | Optional flags | Description |
|---------|---------------|----------------|-------------|
| `list` | — | `--limit <n>`, `--json` | List all sessions |
| `get <id>` | session ID | `--json` | Get session details |
| `children <id>` | session ID | `--json` | List child sessions |
| `create` | — | `--title <text>`, `--parent <id>`, `--json` | Create a new session |
| `update <id>` | session ID | `--title <text>`, `--json` | Update session metadata |
| `delete <id>` | session ID | `--json` | Delete a session |
| `abort <id>` | session ID | `--json` | Abort a running session |
| `share <id>` | session ID | `--json` | Share a session |
| `unshare <id>` | session ID | `--json` | Unshare a session |
| `summarize <id>` | session ID | `--model <provider/model>`, `--json` | Generate a session summary |
| `messages <id>` | session ID | `--limit <n>`, `--json` | List messages |
| `message <id> <msg-id>` | session ID, message ID | `--json` | Get a single message |
| `transcript <id>` | session ID or `--input <path>` | `--json`, `--output <path>`, `--tee-temp` | Render session transcript as markdown or JSON |
| `prompt <id> <text>` | session ID, prompt text | `--agent <name>`, `--no-reply`, `--output-format <fmt>` | Inject a prompt into a session |
| `command <id> <cmd>` | session ID, command | — | Run a command in a session |
| `shell <id> <cmd>` | session ID, command | `--agent <name>` | Run a shell command in a session |
| `revert <id> <msg-id>` | session ID, message ID | `--json` | Revert to a message |
| `unrevert <id>` | session ID | `--json` | Undo a revert |
| `init <id>` | session ID | `--message-id <id>`, `--model <provider/model>`, `--json` | Initialize a session from a message |
| `permissions` | — | `--session <id>`, `--json` | List pending permissions |
| `permission <id> <perm-id> <response>` | session ID, permission ID, response | — | Respond to a permission request |
| `stats` | — | `--json` | Server statistics |

---

### `opencode-transcript` — transcript renderer

Standalone entrypoint for rendering transcripts from saved export files or live sessions.

| Flag | Required | Description |
|------|----------|-------------|
| `<session-id>` | One of session ID or `--input` | Session ID to render via the server API |
| `--input <path>` | One of session ID or `--input` | Render a saved transcript JSON file |
| `--json` | No | Emit compact structured JSON instead of markdown |
| `--output <path>` | No | Save transcript to a file (mutually exclusive with `--tee-temp`) |
| `--tee-temp` | No | Stream transcript and save a copy to a temp file |

```bash
npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git \
  opx-session transcript ses_abc123

npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git \
  opx-session transcript ses_abc123 --json

npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git \
  opx-session transcript ses_abc123 --output /tmp/session.md

npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git \
  opx-session transcript ses_abc123 --tee-temp

npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git \
  opx-session transcript --input /tmp/session.json

npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git \
  opencode-transcript --input /tmp/session.json
```

## Environment Variables

| Name | Required | Default | Controls |
|------|----------|---------|---------|
| `OPENCODE_BASE_URL` | No | `http://127.0.0.1:4096` | OpenCode server URL |
| `OPENCODE_SERVER_USERNAME` | No | `opencode` | HTTP basic auth username |
| `OPENCODE_SERVER_PASSWORD` | No | — | HTTP basic auth password |

`opx` and `opx-session` always target `OPENCODE_BASE_URL`, so they can attach to any
OpenCode server you start yourself. For repo-local workflow tests, prefer a dedicated
custom-port server started inside that repo's `direnv`/config surface instead of the
shared default instance.

```bash
direnv exec /path/to/plugin \
  command opencode serve --hostname 127.0.0.1 --port 4198

OPENCODE_BASE_URL=http://127.0.0.1:4198 \
  npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git \
  opx-session list --json
```
