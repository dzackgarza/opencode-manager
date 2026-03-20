"""OpenCode session client for workflow commands."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
from opencode_ai import Opencode

from .config import SessionContext, auth_headers, base_url, default_session_context, session_headers
from .errors import PromptDeliveryError, SessionLookupError, WaitTimeoutError

LOG = logging.getLogger(__name__)

type JsonDict = dict[str, object]


@dataclass(frozen=True, slots=True)
class PromptResult:
    assistant_message: str | None
    session_id: str


@dataclass(frozen=True, slots=True)
class WaitResult:
    assistant_message: str | None
    session_id: str
    stable_for_seconds: float
    updated_at: int | float | None


def parse_model_ref(model: str | None) -> JsonDict | None:
    """Parse provider/model into the wire format used by OpenCode."""
    if model is None:
        return None
    value = model.strip()
    provider_id, _, model_id = value.partition("/")
    if not provider_id or not model_id:
        raise PromptDeliveryError("Model must use provider/model format.")
    return {"providerID": provider_id, "modelID": model_id}


def flatten_text(parts: list[JsonDict]) -> str:
    """Render text parts as plain text."""
    output: list[str] = []
    for part in parts:
        if part.get("type") != "text":
            continue
        text = part.get("text")
        if isinstance(text, str) and text.strip():
            output.append(text.strip())
    return "\n\n".join(output)


def latest_message_role(messages: list[JsonDict]) -> str | None:
    """Return the latest recorded message role."""
    for message in reversed(messages):
        info = message.get("info")
        if not isinstance(info, dict):
            continue
        role = info.get("role")
        if isinstance(role, str) and role:
            return role
    return None


def assistant_texts(messages: list[JsonDict]) -> list[str]:
    """Return assistant text blocks in order."""
    output: list[str] = []
    for message in messages:
        info = message.get("info")
        if not isinstance(info, dict) or info.get("role") != "assistant":
            continue
        parts = message.get("parts")
        rendered = flatten_text(parts if isinstance(parts, list) else [])
        if rendered:
            output.append(rendered)
    return output


def latest_assistant_text(messages: list[JsonDict]) -> str | None:
    """Return the latest assistant text if present."""
    texts = assistant_texts(messages)
    return texts[-1] if texts else None


def latest_assistant_text_since(
    messages: list[JsonDict], initial_assistant_count: int
) -> str | None:
    """Return the latest assistant text recorded after the given starting point."""
    new_texts = assistant_texts(messages)[initial_assistant_count:]
    return new_texts[-1] if new_texts else None


def pending_system_prompts(messages: list[JsonDict]) -> list[str]:
    """Return queued system prompts since the last assistant turn."""
    prompts: list[str] = []
    for message in reversed(messages):
        info = message.get("info")
        if not isinstance(info, dict):
            continue
        role = info.get("role")
        if role == "assistant":
            break
        system = info.get("system")
        if isinstance(system, str) and system.strip():
            prompts.append(system.strip())
    prompts.reverse()
    return prompts


def has_pending_prompt(messages: list[JsonDict]) -> bool:
    """Return whether the session has queued non-assistant work after the last assistant turn."""
    for message in reversed(messages):
        info = message.get("info")
        if not isinstance(info, dict):
            continue
        role = info.get("role")
        if role == "assistant":
            return False
        if role in {"user", "system"}:
            return True
    return False


def _agent_from_info(info: JsonDict) -> str | None:
    agent_value = info.get("agent")
    return agent_value if isinstance(agent_value, str) and agent_value else None


def _model_ref_from_info(info: JsonDict) -> str | None:
    model = info.get("model")
    if not isinstance(model, dict):
        return None
    provider = model.get("providerID")
    model_name = model.get("modelID")
    provider_id = provider if isinstance(provider, str) and provider else None
    model_id = model_name if isinstance(model_name, str) and model_name else None
    return f"{provider_id}/{model_id}" if provider_id and model_id else None


def observed_identity(messages: list[JsonDict]) -> tuple[str | None, str | None]:
    """Derive the active responder identity from live session history."""
    for message in reversed(messages):
        info = message.get("info")
        if not isinstance(info, dict):
            continue

        agent = _agent_from_info(info)
        model_ref = _model_ref_from_info(info)
        if agent or model_ref:
            return agent, model_ref

    return None, None


class OpenCodeManagerClient(AbstractContextManager["OpenCodeManagerClient"]):
    """Mixed SDK + raw HTTP client for the workflow CLI."""

    def __init__(self, *, timeout: float = 180.0) -> None:
        self._base_url = base_url()
        self._http = httpx.Client(
            base_url=self._base_url,
            headers=auth_headers(),
            timeout=timeout,
            follow_redirects=True,
        )
        self._sdk = Opencode(base_url=self._base_url, timeout=timeout, max_retries=0)

    def __exit__(self, exc_type: object, exc: object, exc_tb: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def create_session(
        self,
        *,
        title: str | None = None,
        context: SessionContext | None = None,
    ) -> JsonDict:
        """Create a new workflow session."""
        context = context or default_session_context()
        extra_query = {"directory": context.directory} if context.directory else None
        created = self._sdk.session.create(
            extra_headers=session_headers(context),
            extra_query=extra_query,
            extra_body={"title": title or f"ocm:{datetime.now(tz=UTC).isoformat()}"},
        )
        session_id = getattr(created, "id", None)
        if not isinstance(session_id, str) or not session_id:
            raise PromptDeliveryError("Server returned a session without an id.")
        return self.get_session(session_id)

    def get_session(self, session_id: str) -> JsonDict:
        """Load a session payload from the server."""
        response = self._http.get(f"/session/{session_id}")
        if response.status_code == 404:
            raise SessionLookupError(f"Session not found: {session_id}")
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise PromptDeliveryError(f"Session payload for {session_id} was not a JSON object.")
        return payload

    def session_context(self, session_id: str) -> SessionContext:
        """Resolve the current session context headers."""
        session = self.get_session(session_id)
        directory = session.get("directory")
        workspace_id = session.get("workspaceID")
        return SessionContext(
            directory=directory if isinstance(directory, str) else None,
            workspace_id=workspace_id if isinstance(workspace_id, str) else None,
        )

    def delete_session(self, session_id: str, *, context: SessionContext | None = None) -> None:
        """Delete a session."""
        context = context or self.session_context(session_id)
        self._sdk.session.delete(
            session_id,
            extra_headers=session_headers(context),
            extra_query={"directory": context.directory} if context.directory else None,
        )

    def list_messages(
        self, session_id: str, *, context: SessionContext | None = None
    ) -> list[JsonDict]:
        """Load the full message transcript for a session."""
        context = context or self.session_context(session_id)
        response = self._http.get(
            f"/session/{session_id}/message",
            headers=session_headers(context),
        )
        if response.status_code == 404:
            raise SessionLookupError(f"Session not found: {session_id}")
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, list):
            raise PromptDeliveryError(
                f"Message payload for {session_id} was not a JSON array: {type(payload).__name__}"
            )
        return [item for item in payload if isinstance(item, dict)]

    def transcript_export(self, session_id: str) -> JsonDict:
        """Return the canonical transcript export object."""
        session = self.get_session(session_id)
        context = self.session_context(session_id)
        return {"info": session, "messages": self.list_messages(session_id, context=context)}

    def submit_prompt(
        self,
        session_id: str,
        *,
        prompt: str,
        visibility: str,
        no_reply: bool = False,
        agent: str | None = None,
        model: str | None = None,
        context: SessionContext | None = None,
    ) -> PromptResult:
        """Submit a workflow prompt and verify the intended transport semantics."""
        if visibility not in {"chat", "system"}:
            raise PromptDeliveryError(f"Unsupported prompt visibility: {visibility}")

        context = context or self.session_context(session_id)
        initial_messages = self.list_messages(session_id, context=context)
        initial_assistant_count = len(assistant_texts(initial_messages))
        derived_agent, derived_model = observed_identity(initial_messages)
        queued_systems = pending_system_prompts(initial_messages)
        payload = self._prompt_payload(
            prompt=prompt,
            visibility=visibility,
            agent=agent or derived_agent,
            model=model or derived_model,
        )

        if no_reply:
            LOG.info("queue-only prompt %s visibility=%s", session_id, visibility)
            payload["noReply"] = True
            response = self._http.post(
                f"/session/{session_id}/prompt_async",
                headers=session_headers(context, content_type="application/json"),
                json=payload,
            )
            response.raise_for_status()
            self._wait_for_prompt_recording(
                session_id,
                context=context,
                initial_count=len(initial_messages),
                prompt=prompt,
                visibility=visibility,
            )
            return PromptResult(assistant_message=None, session_id=session_id)

        if visibility == "chat" and queued_systems:
            payload["system"] = "\n\n".join(queued_systems)
            LOG.info(
                "continued prompt %s visibility=%s carrying %d queued system prompt(s)",
                session_id,
                visibility,
                len(queued_systems),
            )
        elif visibility == "system" and queued_systems:
            current_system = payload.get("system")
            merged_systems = [*queued_systems]
            if isinstance(current_system, str) and current_system.strip():
                merged_systems.append(current_system.strip())
            payload["system"] = "\n\n".join(merged_systems)
            LOG.info(
                "continued prompt %s visibility=%s merging %d queued system prompt(s)",
                session_id,
                visibility,
                len(queued_systems),
            )

        LOG.info("continued prompt %s visibility=%s", session_id, visibility)
        with self._http.stream(
            "POST",
            f"/session/{session_id}/message",
            headers=session_headers(
                context,
                accept="text/event-stream",
                content_type="application/json",
            ),
            json=payload,
        ) as response:
            response.raise_for_status()
            self._consume_stream(response.iter_lines())

        messages = self.list_messages(session_id, context=context)
        assistant_message = latest_assistant_text_since(messages, initial_assistant_count)
        if assistant_message is None:
            raise PromptDeliveryError(
                f"Session {session_id} accepted a continued {visibility} prompt "
                "but never produced a new assistant turn."
            )
        return PromptResult(assistant_message=assistant_message, session_id=session_id)

    def wait_until_idle(
        self,
        session_id: str,
        *,
        timeout_sec: float = 180.0,
        require_new_assistant: bool = False,
        initial_assistant_count: int = 0,
        context: SessionContext | None = None,
        quiet_period_sec: float = 1.5,
    ) -> WaitResult:
        """Wait until a session stops mutating for a short quiet period."""
        context = context or self.session_context(session_id)
        deadline = time.monotonic() + timeout_sec
        previous_signature: tuple[object, ...] | None = None
        stable_since = time.monotonic()
        latest_updated_at: int | float | None = None

        while time.monotonic() < deadline:
            session = self.get_session(session_id)
            latest_updated_at = self._session_updated_at(session)
            messages = self.list_messages(session_id, context=context)
            signature = self._idle_signature(latest_updated_at, messages)
            if signature != previous_signature:
                previous_signature = signature
                stable_since = time.monotonic()
            assistant_message = (
                latest_assistant_text_since(messages, initial_assistant_count)
                if require_new_assistant
                else latest_assistant_text(messages)
            )
            if not require_new_assistant and not has_pending_prompt(messages):
                return WaitResult(
                    assistant_message=assistant_message,
                    session_id=session_id,
                    stable_for_seconds=0.0,
                    updated_at=latest_updated_at,
                )
            if require_new_assistant and assistant_message is None:
                time.sleep(0.5)
                continue
            stable_for = time.monotonic() - stable_since
            if stable_for >= quiet_period_sec:
                return WaitResult(
                    assistant_message=assistant_message,
                    session_id=session_id,
                    stable_for_seconds=stable_for,
                    updated_at=latest_updated_at,
                )
            time.sleep(0.5)

        raise WaitTimeoutError(
            f"Timed out waiting for session {session_id} to become idle after {timeout_sec:.0f}s."
        )

    def _wait_for_prompt_recording(
        self,
        session_id: str,
        *,
        context: SessionContext,
        initial_count: int,
        prompt: str,
        visibility: str,
        timeout_sec: float = 10.0,
    ) -> None:
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            messages = self.list_messages(session_id, context=context)
            if len(messages) <= initial_count:
                time.sleep(0.2)
                continue
            new_messages = messages[initial_count:]
            if visibility == "chat" and any(
                self._matches_chat_prompt(message, prompt) for message in new_messages
            ):
                return
            if visibility == "system" and any(
                self._matches_system_prompt(message, prompt) for message in new_messages
            ):
                return
            time.sleep(0.2)
        raise PromptDeliveryError(
            f"Queue-only {visibility} prompt for {session_id} was not recorded "
            f"in session state within {timeout_sec:.0f}s."
        )

    @staticmethod
    def _consume_stream(lines: Iterator[str]) -> None:
        for line in lines:
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                event = json.loads(data)
            except json.JSONDecodeError:
                LOG.debug("ignoring non-JSON SSE line: %s", data)
                continue
            LOG.debug("stream event %s", event.get("type"))

    @staticmethod
    def _prompt_payload(
        *,
        prompt: str,
        visibility: str,
        agent: str | None,
        model: str | None,
    ) -> JsonDict:
        payload: JsonDict = {}
        if agent:
            payload["agent"] = agent
        model_ref = parse_model_ref(model)
        if model_ref is not None:
            payload["model"] = model_ref
        if visibility == "system":
            payload["parts"] = []
            payload["system"] = prompt
            return payload
        payload["parts"] = [{"type": "text", "text": prompt}]
        return payload

    @staticmethod
    def _session_updated_at(session: JsonDict) -> int | float | None:
        time_data = session.get("time")
        if not isinstance(time_data, dict):
            return None
        updated = time_data.get("updated")
        return updated if isinstance(updated, int | float) else None

    @staticmethod
    def _idle_signature(
        updated_at: int | float | None, messages: list[JsonDict]
    ) -> tuple[object, ...]:
        latest = messages[-1] if messages else {}
        info = latest.get("info") if isinstance(latest, dict) else {}
        role = info.get("role") if isinstance(info, dict) else None
        finish = info.get("finish") if isinstance(info, dict) else None
        latest_parts = latest.get("parts")
        latest_text = flatten_text(latest_parts) if isinstance(latest_parts, list) else ""
        return (updated_at, len(messages), role, finish, latest_text)

    @staticmethod
    def _matches_chat_prompt(message: JsonDict, prompt: str) -> bool:
        info = message.get("info")
        if not isinstance(info, dict) or info.get("role") != "user":
            return False
        parts = message.get("parts")
        return flatten_text(parts if isinstance(parts, list) else []) == prompt

    @staticmethod
    def _matches_system_prompt(message: JsonDict, prompt: str) -> bool:
        info = message.get("info")
        if not isinstance(info, dict):
            return False
        role = info.get("role")
        if role not in {"system", "user"}:
            return False
        if info.get("system") == prompt or message.get("system") == prompt:
            return True
        parts = message.get("parts")
        if isinstance(parts, list) and flatten_text(parts) == prompt:
            return True
        return False
