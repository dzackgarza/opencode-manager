set fallback := true
repo_root := justfile_directory()
python_qc_justfile := env_var_or_default("OPENCODE_PYTHON_QC_JUSTFILE", "/home/dzack/ai/quality-control/justfile")

default:
    @just test

install:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec uv sync --all-groups

[private]
_format:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec uv run ruff format .

[private]
_lint:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec uv run ruff check .

[private]
_typecheck:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{repo_root}}"
    exec uv run basedpyright

[private]
_quality-control:
    #!/usr/bin/env bash
    set -euo pipefail
    exec direnv exec "{{repo_root}}" \
        just --justfile "{{python_qc_justfile}}" --working-directory "{{repo_root}}" test

test: _lint _typecheck _quality-control

check: test
