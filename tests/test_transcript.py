from __future__ import annotations

import json

import pytest

from opencode_manager.errors import TranscriptRenderError
from opencode_manager.transcript import (
    RenderOptions,
    render_transcript_json,
    render_transcript_markdown,
)

from .conftest import FIXTURES


def test_render_transcript_json_groups_turns_and_steps() -> None:
    fixture = json.loads((FIXTURES / "transcript-multiturn.json").read_text(encoding="utf-8"))

    rendered = render_transcript_json(fixture)

    assert rendered["sessionID"] == "ses_multiturn_fixture"
    turns = rendered["turns"]
    assert isinstance(turns, list)
    assert len(turns) == 2
    first_turn = turns[0]
    assert first_turn["userPrompt"].startswith("Use introspection")
    first_assistant_messages = first_turn["assistantMessages"]
    assert isinstance(first_assistant_messages, list)
    assert len(first_assistant_messages) == 2
    first_steps = first_assistant_messages[0]["steps"]
    assert isinstance(first_steps, list)
    assert first_steps[0]["heading"] == "tool:introspection"
    assert first_assistant_messages[1]["text"] == "SESSION_OK"


def test_render_transcript_markdown_includes_saved_copy_path() -> None:
    fixture = json.loads((FIXTURES / "sample-export.json").read_text(encoding="utf-8"))

    rendered = render_transcript_markdown(
        fixture,
        RenderOptions(
            generated_at_ms=1773332600000,
            saved_copy_path="/tmp/ocm-session-ses_fixture.md",
        ),
    )

    assert "# OpenCode Session Transcript" in rendered
    assert "- Saved copy: `/tmp/ocm-session-ses_fixture.md`" in rendered
    assert "## Turn 1" in rendered
    assert "#### Step 2 `tool:webfetch`" in rendered
    assert "example output" in rendered


def test_render_transcript_json_exposes_system_prompt_turns() -> None:
    rendered = render_transcript_json(
        {
            "info": {
                "id": "ses_system_fixture",
                "title": "queued-system",
                "directory": "/tmp/system-fixture",
            },
            "messages": [
                {
                    "info": {
                        "role": "user",
                        "time": {"created": 1773332500000},
                        "system": "For the next answer, reply with ONLY SYSTEM_EDGE.",
                    },
                    "parts": [],
                }
            ],
        }
    )

    turns = rendered["turns"]
    assert isinstance(turns, list)
    assert len(turns) == 1
    turn = turns[0]
    assert turn["systemPrompt"] == "For the next answer, reply with ONLY SYSTEM_EDGE."
    assert turn["userPrompt"] == ""


def test_render_transcript_json_renders_tool_step_details() -> None:
    fixture = json.loads((FIXTURES / "sample-export.json").read_text(encoding="utf-8"))

    rendered = render_transcript_json(fixture)

    turns = rendered["turns"]
    assert isinstance(turns, list)
    first_assistant_message = turns[0]["assistantMessages"][0]
    first_step = first_assistant_message["steps"][1]
    assert first_step["type"] == "tool"
    assert first_step["tool"] == "webfetch"
    assert first_step["status"] == "success"
    assert "https://example.com" in first_step["inputText"]
    assert "example output" in first_step["outputText"]


def test_render_transcript_json_rejects_invalid_export_shape() -> None:
    with pytest.raises(TranscriptRenderError):
        render_transcript_json({"info": [], "messages": {}})
