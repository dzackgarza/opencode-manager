"""Standalone transcript renderer entrypoint."""

from __future__ import annotations

import json as json_lib
import sys
from datetime import UTC, datetime
from pathlib import Path
from tempfile import gettempdir
from typing import Annotated

from cyclopts import App, Parameter

from .client import OpenCodeManagerClient
from .contracts import TranscriptRenderCommand
from .errors import OpxError
from .transcript import load_transcript_export, render_transcript_json, render_transcript_markdown

app = App(name="opencode-transcript", help="Render a live or saved OpenCode transcript.")


def _write_stdout_line(value: str) -> None:
    sys.stdout.write(f"{value}\n")


def _write_stderr_line(value: str) -> None:
    sys.stderr.write(f"{value}\n")


@app.default
def render(
    session_id: str | None = None,
    *,
    input_path: Annotated[str | None, Parameter(name="--input")] = None,
    json: bool = False,
    output: str | None = None,
    tee_temp: bool = False,
) -> None:
    """Render a live session transcript or a saved export file."""
    command = TranscriptRenderCommand.model_validate(
        {
            "session_id": session_id,
            "input_path": input_path,
            "json_output": json,
            "output": output,
            "tee_temp": tee_temp,
        }
    )

    if command.session_id is not None:
        with OpenCodeManagerClient() as client:
            exported = client.transcript_export(command.session_id)
    else:
        if command.input_path is None:
            raise OpxError("Input path must be provided when session ID is missing.")
        exported = load_transcript_export(command.input_path)

    content = (
        json_lib.dumps(render_transcript_json(exported), indent=2)
        if command.json_output
        else render_transcript_markdown(exported)
    )

    if command.tee_temp:
        suffix = ".json" if content.lstrip().startswith("{") else ".md"
        stamp = int(datetime.now(tz=UTC).timestamp())
        temp_path = Path(gettempdir()) / f"opencode-transcript-{stamp}{suffix}"
        temp_path.write_text(content, encoding="utf-8")
        sys.stdout.write(content)
        return
    if command.output:
        resolved = Path(command.output).resolve()
        resolved.write_text(content, encoding="utf-8")
        _write_stdout_line(str(resolved))
        return
    sys.stdout.write(content)


def main() -> None:
    try:
        app()
    except OpxError as exc:
        _write_stderr_line(f"Error: {exc}")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
