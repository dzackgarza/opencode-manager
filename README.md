[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)



# opencode-manager

This Bun-based package automates OpenCode sessions via GitHub and `npx`.

## Scope

This package provides session management and automation through the former harness utilities:

- `opx` manages run, resume, provider, and debug flows.
- `opx-session` provides broader session control.
- `opx-session transcript <session-id>` renders a turn/step markdown transcript
  from the configured OpenCode server without relying on an external package.
- `opx-session transcript <session-id> --json` emits the compact structured
  transcript document used by downstream prompt-based summarizers.
- `opencode-transcript` remains available as a compatibility entrypoint for
  transcript-only workflows, including `--input /path/to/export.json`.

## Run

Running these tools requires `npx` and `bun`.

```bash
npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git opx --help
npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git opx-session --help
npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git opencode-transcript --help
```

Transcript examples:

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
  opx-session transcript --input /tmp/session-export.json

npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git \
  opencode-transcript --input /tmp/session-export.json
```

## Environment

- `OPENCODE_BASE_URL`: defaults to `http://127.0.0.1:4096`
- `OPENCODE_SERVER_USERNAME`: defaults to `opencode`
- `OPENCODE_SERVER_PASSWORD`: is optional

`opx` and `opx-session` always target `OPENCODE_BASE_URL`, so they can attach to any
OpenCode server you start yourself. For repo-local workflow tests, prefer a dedicated
custom-port server started inside that repo's `direnv`/config surface instead of the
shared default instance.

```bash
direnv exec /path/to/plugin \
  opencode serve --hostname 127.0.0.1 --port 4198

OPENCODE_BASE_URL=http://127.0.0.1:4198 \
  npx --yes --package=git+https://github.com/dzackgarza/opencode-manager.git \
  opx-session list --json
```
