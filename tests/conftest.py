from __future__ import annotations

import json
import os
import re
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
DEFAULT_BASE_URL = os.environ.get("OPENCODE_BASE_URL", "http://127.0.0.1:4097")
PROOF_AGENT = "opencode-manager-proof"


@dataclass
class CliResult:
    args: list[str]
    exit_code: int
    stdout: str
    stderr: str

    def json(self) -> dict[str, object]:
        return json.loads(self.stdout)


@dataclass
class LiveRuntime:
    base_url: str
    created_sessions: list[str] = field(default_factory=list)

    def env(self) -> dict[str, str]:
        return {**os.environ, "OPENCODE_BASE_URL": self.base_url}

    def run(self, *args: str, timeout: int = 180) -> CliResult:
        completed = subprocess.run(
            ["ocm", *args],
            cwd=ROOT,
            env=self.env(),
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return CliResult(
            args=list(args),
            exit_code=completed.returncode,
            stdout=completed.stdout.strip(),
            stderr=completed.stderr.strip(),
        )

    def begin(self, prompt: str) -> str:
        result = self.run("begin-session", prompt, "--agent", PROOF_AGENT, "--json")
        assert result.exit_code == 0, result.stderr
        session_id = str(result.json()["sessionID"])
        self.created_sessions.append(session_id)
        return session_id

    def begin_json(self, prompt: str) -> dict[str, object]:
        result = self.run("begin-session", prompt, "--agent", PROOF_AGENT, "--json")
        assert result.exit_code == 0, result.stderr
        payload = result.json()
        session_id = str(payload["sessionID"])
        self.created_sessions.append(session_id)
        return payload

    def transcript_json(self, session_id: str) -> dict[str, object]:
        result = self.run("transcript", session_id, "--json")
        assert result.exit_code == 0, result.stderr
        return result.json()

    def session_messages(self, session_id: str) -> list[dict[str, object]]:
        response = httpx.get(f"{self.base_url}/session/{session_id}/message", timeout=10.0)
        response.raise_for_status()
        payload = response.json()
        assert isinstance(payload, list)
        return [item for item in payload if isinstance(item, dict)]

    def session_ids(self) -> list[str]:
        response = httpx.get(f"{self.base_url}/session", timeout=10.0)
        response.raise_for_status()
        payload = response.json()
        assert isinstance(payload, list)
        output: list[str] = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            session_id = item.get("id")
            if isinstance(session_id, str) and session_id:
                output.append(session_id)
        return output

    @staticmethod
    def transcript_session_id(markdown: str) -> str:
        match = re.search(r"Confirmed session ID: `([^`]+)`", markdown)
        assert match is not None
        return match.group(1)

    def delete_session(self, session_id: str) -> None:
        subprocess.run(
            ["ocm", "delete", session_id],
            cwd=ROOT,
            env=self.env(),
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )


@pytest.fixture(autouse=True)
def ensure_live_server_for_live_tests(request: pytest.FixtureRequest) -> None:
    if request.node.get_closest_marker("live") is None:
        return
    response = httpx.get(f"{DEFAULT_BASE_URL}/app", timeout=5.0)
    assert response.status_code == 200, (
        f"expected live OpenCode server at {DEFAULT_BASE_URL}; run `just test` or "
        "`just --justfile ../../justfile test-sandbox-up` before invoking pytest directly"
    )


@pytest.fixture
def live_runtime() -> Iterator[LiveRuntime]:
    runtime = LiveRuntime(base_url=DEFAULT_BASE_URL)
    try:
        yield runtime
    finally:
        for session_id in runtime.created_sessions:
            runtime.delete_session(session_id)
