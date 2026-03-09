# opencode-manager

Bun-based OpenCode session automation, run from GitHub with `npx`.

## Scope

This package owns the former harness utilities:

- `opx` for run, resume, provider, and debug flows
- `opx-session` for broader session management

Transcript rendering is intentionally external and always resolved through:

```bash
uvx --from git+ssh://git@github.com/dzackgarza/opencode-transcripts.git opencode-transcript
```

## Run

Requires `npx`, `bun`, and GitHub SSH access to the private repo.

```bash
npx --yes --package=git+ssh://git@github.com/dzackgarza/opencode-manager.git opx --help
npx --yes --package=git+ssh://git@github.com/dzackgarza/opencode-manager.git opx-session --help
```

## Environment

- `OPENCODE_BASE_URL` defaults to `http://127.0.0.1:4096`
- `OPENCODE_SERVER_USERNAME` defaults to `opencode`
- `OPENCODE_SERVER_PASSWORD` is optional
