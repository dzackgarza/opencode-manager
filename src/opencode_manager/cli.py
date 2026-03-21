"""Cyclopts CLI for proof-first OpenCode workflows."""

from __future__ import annotations

import json as json_lib
import logging
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from tempfile import gettempdir
from typing import Annotated

import httpx
from cyclopts import App, Parameter

from .client import OpenCodeManagerClient, assistant_texts, latest_message_role
from .config import auth_headers, base_url, default_session_context
from .contracts import (
    BeginSessionCommand,
    ContinuedPromptCommand,
    DeleteCommand,
    DoctorCheck,
    DoctorCommand,
    DoctorReport,
    FinalCommand,
    OneShotCommand,
    TranscriptCommand,
    WaitCommand,
    validate_base_url,
)
from .errors import OpxError
from .transcript import RenderOptions, render_transcript_json, render_transcript_markdown

app = App(
    name="ocm",
    help=(
        "Proof-first workflow CLI for managing real OpenCode sessions and proving "
        "continued-session behavior from live state."
    ),
)


def _configure_logging() -> None:
    if logging.getLogger().handlers:
        return
    level_name = os.environ.get("OPX_LOG", "").strip().upper()
    level = getattr(logging, level_name, logging.WARNING)
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def _session_handle(session: dict[str, object]) -> dict[str, object]:
    return {
        "directory": session.get("directory"),
        "sessionID": session["id"],
        "workspaceID": session.get("workspaceID"),
    }


def _package_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _sandbox_env_candidates() -> list[Path]:
    explicit = os.environ.get("OPX_SANDBOX_ENV", "").strip()
    if explicit:
        return [Path(explicit).expanduser().resolve()]

    seen: set[Path] = set()
    candidates: list[Path] = []
    roots = [Path.cwd(), _package_root()]
    for root in roots:
        for parent in (root, *root.parents):
            candidate = parent / ".test-sandbox-env.sh"
            if candidate in seen:
                continue
            seen.add(candidate)
            candidates.append(candidate)
    return candidates


def _sandbox_env_path() -> Path | None:
    for candidate in _sandbox_env_candidates():
        if candidate.is_file():
            return candidate
    return None


def _resolved_config_path() -> Path:
    explicit = os.environ.get("OPENCODE_CONFIG", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    xdg_config_home = os.environ.get("XDG_CONFIG_HOME", "").strip()
    if xdg_config_home:
        return Path(xdg_config_home).expanduser().resolve() / "opencode" / "opencode.json"
    return Path.home() / ".config" / "opencode" / "opencode.json"


def _doctor_checks(
    resolved_base_url: str, config_path: Path, sandbox_env_path: Path | None
) -> list[DoctorCheck]:
    sandbox_detail = (
        f"Centralized sandbox env file exists at {sandbox_env_path}."
        if sandbox_env_path is not None
        else (
            "Centralized sandbox env file was not found via "
            "OPX_SANDBOX_ENV or parent-directory search."
        )
    )
    return [
        DoctorCheck(
            name="base_url",
            ok=True,
            detail=f"Using OpenCode base URL {resolved_base_url}.",
        ),
        DoctorCheck(
            name="config_path",
            ok=config_path.is_file(),
            detail=(
                f"Resolved OpenCode config at {config_path}."
                if config_path.is_file()
                else f"Resolved OpenCode config is missing: {config_path}."
            ),
        ),
        DoctorCheck(name="sandbox_env", ok=sandbox_env_path is not None, detail=sandbox_detail),
    ]


def _server_checks(command: DoctorCommand, resolved_base_url: str) -> list[DoctorCheck]:
    if command.skip_server_check:
        return [
            DoctorCheck(
                name="server_checks",
                ok=True,
                detail="Server reachability checks skipped by request.",
            )
        ]
    checks: list[DoctorCheck] = []
    with httpx.Client(
        base_url=resolved_base_url,
        headers=auth_headers(),
        timeout=command.timeout_sec,
        follow_redirects=True,
    ) as client:
        for name, path in (("server_app", "/app"), ("server_health", "/global/health")):
            try:
                response = client.get(path)
                ok = response.status_code == 200
                detail = f"{path} returned {response.status_code}."
            except httpx.HTTPError as exc:
                ok = False
                detail = f"{path} failed: {exc}"
            checks.append(DoctorCheck(name=name, ok=ok, detail=detail))
    return checks


def _doctor_report(command: DoctorCommand) -> DoctorReport:
    resolved_base_url = validate_base_url(base_url())
    config_path = _resolved_config_path()
    sandbox_env_path = _sandbox_env_path()
    checks = _doctor_checks(resolved_base_url, config_path, sandbox_env_path)
    checks.extend(_server_checks(command, resolved_base_url))

    return DoctorReport(
        base_url=resolved_base_url,
        cwd=str(Path.cwd()),
        config_path=str(config_path),
        sandbox_env_path=str(sandbox_env_path),
        checks=checks,
    )


def _render_live_transcript(
    client: OpenCodeManagerClient,
    session_id: str,
    *,
    as_json: bool,
    saved_copy_path: str | None = None,
) -> str:
    exported = client.transcript_export(session_id)
    if as_json:
        return json_lib.dumps(render_transcript_json(exported), indent=2)
    return render_transcript_markdown(exported, RenderOptions(saved_copy_path=saved_copy_path))


def _write_transcript_output(content: str, *, output: str | None, tee_temp: bool) -> None:
    if output and tee_temp:
        raise OpxError("Use either --output or --tee-temp, not both.")

    if tee_temp:
        suffix = ".json" if content.lstrip().startswith("{") else ".md"
        stamp = int(datetime.now(tz=UTC).timestamp())
        temp_path = Path(gettempdir()) / f"opencode-transcript-{stamp}{suffix}"
        temp_path.write_text(content, encoding="utf-8")
        sys.stdout.write(content)
        return

    if output:
        resolved = Path(output).resolve()
        resolved.write_text(content, encoding="utf-8")
        print(resolved)
        return

    sys.stdout.write(content)


@app.command(name="one-shot")
def one_shot(
    prompt: str,
    *,
    agent: str | None = None,
    model: str | None = None,
    render_transcript: Annotated[bool, Parameter(name="--transcript")] = False,
) -> None:
    """Create a session, run a complete turn (including tool calls), print result, and delete it."""
    command = OneShotCommand.model_validate(
        {
            "prompt": prompt,
            "agent": agent,
            "model": model,
            "transcript": render_transcript,
        }
    )
    with OpenCodeManagerClient() as client:
        session = client.create_session(title=f"ocm:one-shot:{datetime.now(tz=UTC).isoformat()}")
        session_id = str(session["id"])
        context = default_session_context()
        try:
            client.submit_prompt_no_wait(
                session_id,
                prompt=command.prompt,
                visibility="chat",
                agent=command.agent,
                model=command.model,
                context=context,
            )
            client.wait_until_idle(
                session_id,
                require_new_assistant=True,
                initial_assistant_count=0,
                context=context,
            )
            if command.transcript:
                sys.stdout.write(_render_live_transcript(client, session_id, as_json=False))
                return
            messages = client.list_messages(session_id, context=context)
            assistant_message = assistant_texts(messages)
            if not assistant_message:
                raise OpxError(
                    f"No assistant reply was recorded for one-shot session {session_id}."
                )
            print(assistant_message[-1])
        finally:
            client.delete_session(session_id, context=context)


@app.command(name="begin-session")
def begin_session(
    prompt: str,
    *,
    agent: str | None = None,
    model: str | None = None,
    json: bool = False,
) -> None:
    """Create a session and submit the opening prompt. Use `ocm wait` to block until idle."""
    command = BeginSessionCommand.model_validate(
        {"prompt": prompt, "agent": agent, "model": model, "json_output": json}
    )
    with OpenCodeManagerClient() as client:
        session = client.create_session(title=f"ocm:session:{datetime.now(tz=UTC).isoformat()}")
        session_id = str(session["id"])
        context = default_session_context()
        try:
            client.submit_prompt_no_wait(
                session_id,
                prompt=command.prompt,
                visibility="chat",
                agent=command.agent,
                model=command.model,
                context=context,
            )
        except Exception:
            client.delete_session(session_id, context=context)
            raise

        if command.json_output:
            print(json_lib.dumps(_session_handle(session), indent=2))
            return
        print(session_id)


def _continued_prompt(
    *,
    session_id: str,
    prompt: str,
    system: bool,
    no_reply: bool,
    json: bool,
) -> None:
    command = ContinuedPromptCommand.model_validate(
        {
            "session_id": session_id,
            "prompt": prompt,
            "system": system,
            "no_reply": no_reply,
            "json_output": json,
        }
    )
    with OpenCodeManagerClient() as client:
        result = client.submit_prompt(
            command.session_id,
            prompt=command.prompt,
            visibility=command.visibility,
            no_reply=command.no_reply,
        )
        if command.json_output:
            print(
                json_lib.dumps(
                    {
                        "assistantMessage": result.assistant_message,
                        "mode": "queued" if command.no_reply else "continued",
                        "sessionID": result.session_id,
                        "visibility": command.visibility,
                    },
                    indent=2,
                )
            )
            return
        if result.assistant_message:
            print(result.assistant_message)
            return
        print(session_id)


@app.command
def chat(
    session_id: str,
    prompt: str,
    *,
    system: Annotated[
        bool,
        Parameter(
            help=(
                "Record an agent-only system message in the transcript. "
                "It affects the agent state but is not shown as a user-visible prompt."
            )
        ),
    ] = False,
    no_reply: Annotated[
        bool, Parameter(help="Queue the prompt without resuming the agent turn.")
    ] = False,
    json: bool = False,
) -> None:
    """Continue a session with a user-visible prompt or an agent-only system prompt."""
    _continued_prompt(
        session_id=session_id,
        prompt=prompt,
        system=system,
        no_reply=no_reply,
        json=json,
    )


@app.command
def wait(session_id: str, *, json: bool = False, timeout_sec: float = 180.0) -> None:
    """Wait until the session becomes idle and return the latest assistant reply when present."""
    command = WaitCommand.model_validate(
        {"session_id": session_id, "json_output": json, "timeout_sec": timeout_sec}
    )
    with OpenCodeManagerClient() as client:
        messages = client.list_messages(command.session_id)
        initial_assistant_count = len(assistant_texts(messages))
        result = client.wait_until_idle(
            command.session_id,
            timeout_sec=command.timeout_sec,
            initial_assistant_count=initial_assistant_count,
        )
        final_messages = client.list_messages(command.session_id)
        new_assistant_message = None
        if len(assistant_texts(final_messages)) > initial_assistant_count:
            new_assistant_message = assistant_texts(final_messages)[-1]
        elif latest_message_role(final_messages) == "assistant":
            texts = assistant_texts(final_messages)
            new_assistant_message = texts[-1] if texts else None
        if command.json_output:
            print(
                json_lib.dumps(
                    {
                        "assistantMessage": new_assistant_message,
                        "sessionID": result.session_id,
                        "stableForSeconds": round(result.stable_for_seconds, 3),
                        "updatedAt": result.updated_at,
                    },
                    indent=2,
                )
            )
            return
        if new_assistant_message:
            print(new_assistant_message)
            return
        print(f"Session {command.session_id} is idle.")


@app.command
def transcript(
    session_id: str,
    *,
    json: bool = False,
    output: str | None = None,
    tee_temp: bool = False,
) -> None:
    """Render the canonical transcript for a live session."""
    command = TranscriptCommand.model_validate(
        {
            "session_id": session_id,
            "json_output": json,
            "output": output,
            "tee_temp": tee_temp,
        }
    )
    with OpenCodeManagerClient() as client:
        content = _render_live_transcript(
            client,
            command.session_id,
            as_json=command.json_output,
            saved_copy_path=command.output,
        )
    _write_transcript_output(content, output=command.output, tee_temp=command.tee_temp)


@app.command
def final(
    session_id: str,
    prompt: str,
    *,
    render_transcript: Annotated[bool, Parameter(name="--transcript")] = False,
) -> None:
    """Continue one final turn, print the result, and delete the session."""
    command = FinalCommand.model_validate(
        {"session_id": session_id, "prompt": prompt, "transcript": render_transcript}
    )
    with OpenCodeManagerClient() as client:
        context = client.session_context(command.session_id)
        try:
            client.submit_prompt(
                command.session_id,
                prompt=command.prompt,
                visibility="chat",
                context=context,
            )
            if command.transcript:
                sys.stdout.write(_render_live_transcript(client, command.session_id, as_json=False))
                return
            messages = client.list_messages(command.session_id, context=context)
            assistant_message = assistant_texts(messages)
            if not assistant_message:
                raise OpxError(
                    f"No assistant reply was recorded before deleting session {command.session_id}."
                )
            print(assistant_message[-1])
        finally:
            client.delete_session(command.session_id, context=context)


@app.command
def delete(session_id: str) -> None:
    """Delete a prolonged session explicitly."""
    command = DeleteCommand.model_validate({"session_id": session_id})
    with OpenCodeManagerClient() as client:
        client.delete_session(command.session_id)
    print(command.session_id)


@app.command
def doctor(
    *,
    json: bool = False,
    skip_server_check: bool = False,
    timeout_sec: float = 5.0,
) -> None:
    """Verify local CLI setup, config resolution, and optional server reachability."""
    command = DoctorCommand.model_validate(
        {
            "json_output": json,
            "skip_server_check": skip_server_check,
            "timeout_sec": timeout_sec,
        }
    )
    report = _doctor_report(command)
    if command.json_output:
        print(json_lib.dumps(report.as_json(), indent=2))
    else:
        print(f"base-url: {report.base_url}")
        print(f"cwd: {report.cwd}")
        print(f"config-path: {report.config_path}")
        print(f"sandbox-env-path: {report.sandbox_env_path or 'not found'}")
        for check in report.checks:
            status = "ok" if check.ok else "fail"
            print(f"{status}: {check.name}: {check.detail}")
    if not report.ok:
        raise OpxError("Doctor found one or more setup problems.")


def main() -> None:
    _configure_logging()
    try:
        app()
    except OpxError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
