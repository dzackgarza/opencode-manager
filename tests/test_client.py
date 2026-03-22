from __future__ import annotations

import time
from typing import cast

from opencode_manager.client import (
    OpenCodeManagerClient,
    WaitConfig,
    assistant_message_completed,
    assistant_messages,
    observed_identity,
)
from opencode_manager.config import SessionContext, session_headers


def test_observed_identity_prefers_nested_model_reference() -> None:
    messages = cast(
        list[dict[str, object]],
        [
        {"info": {"role": "user"}},
        {
            "info": {
                "role": "assistant",
                "agent": "proof-agent",
                "model": {"providerID": "openai", "modelID": "gpt-5.4"},
            }
        },
        ],
    )

    assert observed_identity(messages) == ("proof-agent", "openai/gpt-5.4")


def test_observed_identity_rejects_flat_provider_and_model_fields() -> None:
    messages = cast(
        list[dict[str, object]],
        [
            {
                "info": {
                    "role": "assistant",
                    "providerID": "anthropic",
                    "modelID": "claude-opus-4",
                }
            }
        ],
    )

    assert observed_identity(messages) == (None, None)


def test_session_headers_quote_directory_paths() -> None:
    headers = session_headers(SessionContext(directory="/tmp/space dir/project"))

    assert headers["x-opencode-directory"] == "/tmp/space%20dir/project"


def test_assistant_turn_helpers_distinguish_placeholder_from_completed_reply() -> None:
    placeholder = cast(
        dict[str, object],
        {
            "info": {
                "role": "assistant",
                "time": {"created": 1774182399739},
            },
            "parts": [
                {
                    "type": "step-start",
                    "snapshot": "ae818702f7d35c824690b8cc2503cd27b65e3950",
                }
            ],
        },
    )
    completed = cast(
        dict[str, object],
        {
            "info": {
                "role": "assistant",
                "time": {
                    "created": 1774182399739,
                    "completed": 1774182405468,
                },
                "finish": "stop",
            },
            "parts": [
                {
                    "type": "step-start",
                    "snapshot": "ae818702f7d35c824690b8cc2503cd27b65e3950",
                },
                {
                    "type": "text",
                    "text": "READY",
                    "time": {
                        "start": 1774182405398,
                        "end": 1774182405398,
                    },
                },
                {
                    "type": "step-finish",
                    "reason": "stop",
                    "snapshot": "ae818702f7d35c824690b8cc2503cd27b65e3950",
                },
            ],
        },
    )
    messages = cast(
        list[dict[str, object]],
        [
            {"info": {"role": "user"}},
            placeholder,
        ],
    )

    assert assistant_messages(messages) == [placeholder]
    assert assistant_message_completed(placeholder) is False
    assert assistant_message_completed(completed) is True


def test_wait_detects_a_new_incomplete_assistant_turn() -> None:
    placeholder = cast(
        dict[str, object],
        {
            "info": {
                "role": "assistant",
                "time": {"created": 1774182399739},
            },
            "parts": [
                {
                    "type": "step-start",
                    "snapshot": "ae818702f7d35c824690b8cc2503cd27b65e3950",
                }
            ],
        },
    )
    completed = cast(
        dict[str, object],
        {
            "info": {
                "role": "assistant",
                "time": {
                    "created": 1774182399739,
                    "completed": 1774182405468,
                },
                "finish": "stop",
            },
            "parts": [
                {
                    "type": "step-start",
                    "snapshot": "ae818702f7d35c824690b8cc2503cd27b65e3950",
                },
                {
                    "type": "text",
                    "text": "READY",
                },
                {
                    "type": "step-finish",
                    "reason": "stop",
                },
            ],
        },
    )
    placeholder_messages = cast(
        list[dict[str, object]],
        [
            {"info": {"role": "user"}},
            placeholder,
        ],
    )
    completed_messages = cast(
        list[dict[str, object]],
        [
            {"info": {"role": "user"}},
            completed,
        ],
    )

    assert (
        OpenCodeManagerClient._assistant_turn_in_progress(
            placeholder_messages,
            WaitConfig(initial_assistant_count=0),
        )
        is True
    )
    assert (
        OpenCodeManagerClient._assistant_turn_in_progress(
            completed_messages,
            WaitConfig(initial_assistant_count=0),
        )
        is False
    )
    assert (
        OpenCodeManagerClient._assistant_turn_in_progress(
            completed_messages,
            WaitConfig(initial_assistant_count=1),
        )
        is False
    )


def test_idle_signature_ignores_session_updated_at_noise() -> None:
    messages = cast(
        list[dict[str, object]],
        [
            {
                "info": {"role": "user"},
                "parts": [{"type": "text", "text": "Reply with ONLY READY."}],
            },
            {
                "info": {
                    "role": "assistant",
                    "finish": "stop",
                    "time": {"created": 1774182399739, "completed": 1774182405468},
                },
                "parts": [{"type": "text", "text": "READY"}],
            },
        ],
    )

    first = OpenCodeManagerClient._idle_signature(1000, messages, session_state="idle")
    second = OpenCodeManagerClient._idle_signature(1001, messages, session_state="idle")

    assert first == second


def test_idle_signature_changes_when_session_state_changes() -> None:
    messages = cast(
        list[dict[str, object]],
        [
            {
                "info": {"role": "user"},
                "parts": [{"type": "text", "text": "Reply with ONLY READY."}],
            },
            {
                "info": {
                    "role": "assistant",
                    "time": {"created": 1774182399739},
                },
                "parts": [{"type": "text", "text": "READY"}],
            },
        ],
    )

    active = OpenCodeManagerClient._idle_signature(1000, messages, session_state="active")
    idle = OpenCodeManagerClient._idle_signature(1000, messages, session_state="idle")

    assert active != idle


def test_wait_accepts_stable_assistant_text_without_finish_markers() -> None:
    messages = cast(
        list[dict[str, object]],
        [
            {
                "info": {"role": "user"},
                "parts": [{"type": "text", "text": "Reply with ONLY READY."}],
            },
            {
                "info": {
                    "role": "assistant",
                    "time": {"created": 1774182399739},
                },
                "parts": [
                    {
                        "type": "step-start",
                        "snapshot": "ae818702f7d35c824690b8cc2503cd27b65e3950",
                    },
                    {
                        "type": "text",
                        "text": "READY",
                    },
                ],
            },
        ],
    )

    client = OpenCodeManagerClient.__new__(OpenCodeManagerClient)
    result = client._idle_wait_result(
        messages=messages,
        wait=WaitConfig(initial_assistant_count=0),
        stable_since=time.monotonic() - 5.0,
        session_state=None,
    )

    assert result is not None
    assistant_message, stable_for = result
    assert assistant_message == "READY"
    assert stable_for >= 1.5
