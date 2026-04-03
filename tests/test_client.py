from __future__ import annotations

import time
from typing import cast

import pytest

from opencode_manager.client import (
    OpenCodeManagerClient,
    SubmissionRequest,
    WaitConfig,
    assistant_message_completed,
    assistant_messages,
    observed_identity,
)
from opencode_manager.config import SessionContext, session_headers


def test_observed_identity_returns_last_user_message_model() -> None:
    messages = cast(
        list[dict[str, object]],
        [
            {
                "info": {
                    "role": "user",
                    "agent": "Interactive",
                    "model": {"providerID": "openai", "modelID": "gpt-5.4"},
                },
                "parts": [{"type": "text", "text": "Keep using gpt-5.4."}],
            },
            {
                "info": {
                    "role": "assistant",
                    "agent": "proof-agent",
                    "model": {"providerID": "anthropic", "modelID": "claude-4"},
                }
            },
        ],
    )

    assert observed_identity(messages) == ("Interactive", "openai/gpt-5.4")


def test_observed_identity_ignores_empty_user_records_with_model_metadata() -> None:
    messages = cast(
        list[dict[str, object]],
        [
            {
                "info": {
                    "role": "user",
                    "agent": "Interactive",
                    "model": {"providerID": "minimax", "modelID": "text-01"},
                },
                "parts": [{"type": "text", "text": "Keep using minimax."}],
            },
            {
                "info": {
                    "role": "user",
                    "agent": "Kilo-Auto",
                    "model": {"providerID": "opencode", "modelID": "kilo-auto"},
                },
                "parts": [],
            },
        ],
    )

    assert observed_identity(messages) == ("Interactive", "minimax/text-01")


def test_observed_identity_raises_when_no_user_message_exists() -> None:
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

    with pytest.raises(RuntimeError, match="No prior user chat message with agent/model found"):
        observed_identity(messages)


def test_payload_for_submission_raises_without_prior_user_prompt() -> None:
    client = OpenCodeManagerClient.__new__(OpenCodeManagerClient)

    with pytest.raises(RuntimeError, match="No prior user chat message with agent/model found"):
        client._payload_for_submission(
            SubmissionRequest(prompt="Continue", visibility="chat"),
            messages=[],
        )


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


def test_wait_does_not_accept_an_unfinished_assistant_turn_immediately() -> None:
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
        stable_since=time.monotonic(),
        session_state="idle",
    )

    assert result is None
