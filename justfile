set fallback := true

default:
    @just --list

install:
    uv sync --all-groups

format:
    uv run ruff format .

[private]
_lint:
    uv run ruff check .

[private]
_typecheck:
    uv run basedpyright

lint: _lint

typecheck: _typecheck

test *ARGS: _lint _typecheck
    #!/usr/bin/env bash
    set -euo pipefail
    repo="{{justfile_directory()}}"
    root="$(cd "$repo/../.." && pwd)"
    TEST_SANDBOX_CONFIG_JSON="$repo/test-support/opencode/opencode.json" \
    TEST_SANDBOX_CONFIG_PACKAGE_JSON="$repo/test-support/opencode/package.json" \
    TEST_SANDBOX_CONFIG_GITIGNORE="$repo/test-support/opencode/.gitignore" \
    just --justfile "$root/justfile" test-sandbox-up
    trap 'just --justfile "$root/justfile" test-sandbox-down' EXIT
    source "$root/.test-sandbox-env.sh"
    uv run pytest {{ARGS}}
