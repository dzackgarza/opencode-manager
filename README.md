[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)



# opencode-manager

This Bun-based package automates OpenCode sessions via GitHub and `npx`.

## Scope

This package provides session management and automation through the former harness utilities:

- `opx` manages run, resume, provider, and debug flows.
- `opx-session` provides broader session control.

Transcript rendering remains external and must be resolved through the following command:

```bash
uvx --from git+ssh://git@github.com/dzackgarza/opencode-transcripts.git opencode-transcript
```

## Run

Running these tools requires `npx`, `bun`, and GitHub SSH access to the private repository.

```bash
npx --yes --package=git+ssh://git@github.com/dzackgarza/opencode-manager.git opx --help
npx --yes --package=git+ssh://git@github.com/dzackgarza/opencode-manager.git opx-session --help
```

## Environment

- `OPENCODE_BASE_URL`: defaults to `http://127.0.0.1:4096`
- `OPENCODE_SERVER_USERNAME`: defaults to `opencode`
- `OPENCODE_SERVER_PASSWORD`: is optional
