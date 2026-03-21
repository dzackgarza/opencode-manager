set fallback := true

# WORKFLOW: Always run `just test`. It is the only gate that counts.
# All private recipes below are dependencies of `test` — never run them
# individually in place of the full gate, as that defeats enforcement.
# Add new analyses as private recipes (prefix _) and wire them into `test`.

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

# Complexity + NLOC gate. Catches Codacy violations locally before CI.
# Limit mirrors Codacy's project setting (20 lines per method/function).
# -i 20: ratchet at current baseline — fails if violations increase beyond 20.
# Decrease the ratchet as existing functions are refactored down.
[private]
_lizard:
    uvx lizard src --CCN 10 --length 20 -i 20

# Dead-code detection. Flags unused functions, classes, and variables.
[private]
_vulture:
    uvx vulture src tests --min-confidence 80

# Dependency hygiene: missing, unused, and transitive deps in src/.
[private]
_deptry:
    uvx deptry .

# Copy-paste detection across src/. Catches structural duplication.
[private]
_jscpd:
    npx -y jscpd src --reporters console --min-lines 6 --min-tokens 50

lint: _lint

typecheck: _typecheck

test *ARGS: _lint _typecheck _lizard _vulture _deptry _jscpd
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
