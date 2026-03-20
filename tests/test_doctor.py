from __future__ import annotations

import json
import os
import subprocess
import sys

from .conftest import ROOT


def test_doctor_uses_explicit_config_and_sandbox_paths(tmp_path) -> None:
    config_path = tmp_path / "opencode.json"
    config_path.write_text("{}", encoding="utf-8")
    sandbox_env_path = tmp_path / ".test-sandbox-env.sh"
    sandbox_env_path.write_text(
        "export OPENCODE_BASE_URL=http://127.0.0.1:4097\n",
        encoding="utf-8",
    )

    env = {
        **os.environ,
        "OPENCODE_CONFIG": str(config_path),
        "OPX_SANDBOX_ENV": str(sandbox_env_path),
        "OPENCODE_BASE_URL": "http://127.0.0.1:4097",
    }
    result = subprocess.run(
        [sys.executable, "-m", "opencode_manager.cli", "doctor", "--json", "--skip-server-check"],
        cwd=ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["config_path"] == str(config_path)
    assert payload["sandbox_env_path"] == str(sandbox_env_path)
    checks = {check["name"]: check for check in payload["checks"]}
    assert checks["config_path"]["ok"] is True
    assert checks["sandbox_env"]["ok"] is True
    assert checks["server_checks"]["ok"] is True
