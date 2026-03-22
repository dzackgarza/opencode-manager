from __future__ import annotations

import json
import os
import subprocess
import sys

from .conftest import ROOT


def test_doctor_prefers_project_config_under_standard_precedence(tmp_path) -> None:
    config_path = tmp_path / "opencode.json"
    config_path.write_text("{}", encoding="utf-8")

    env = {
        **os.environ,
        "OPENCODE_CONFIG": str(config_path),
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
    assert payload["config_origin"] == "project"
    assert payload["config_path"] == str(ROOT / "opencode.json")
    assert payload["proof_workspace"] == str(ROOT)
    checks = {check["name"]: check for check in payload["checks"]}
    assert checks["config_path"]["ok"] is True
    assert checks["proof_workspace"]["ok"] is True
    assert checks["server_checks"]["ok"] is True
