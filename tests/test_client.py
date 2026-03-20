from __future__ import annotations

from typing import cast

from opencode_manager.client import observed_identity
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
