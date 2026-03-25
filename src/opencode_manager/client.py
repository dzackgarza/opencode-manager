"""OpenCode session client for workflow commands."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from opencode_ai import Opencode

from .config import SessionContext, auth_headers, base_url, default_session_context, session_headers
from .errors import PromptDeliveryError, SessionLookupError, WaitTimeoutError

LOG = logging.getLogger(__name__)

JsonDict = dict[str, object]


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


@dataclass(frozen=True, slots=True)
class SubmissionRequest:
    prompt: str
    visibility: str
    agent: str | None = None
    model: str | None = None
    context: SessionContext | None = None


@dataclass(frozen=True, slots=True)
class PreparedSubmission:
    request: SubmissionRequest
    context: SessionContext
    initial_messages: list[JsonDict]
    payload: JsonDict

    @property
    def initial_assistant_count(self) -> int:
        return len(assistant_texts(self.initial_messages))


@dataclass(frozen=True, slots=True)
class WaitConfig:
    require_new_assistant: bool = False
    initial_assistant_count: int = 0
    quiet_period_sec: float = 1.5


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


def assistant_messages(messages: list[JsonDict]) -> list[JsonDict]:
    """Return assistant messages in transcript order."""
    output: list[JsonDict] = []
    for message in messages:
        info = message.get("info")
        if not isinstance(info, dict) or info.get("role") != "assistant":
            continue
        output.append(message)
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


def latest_assistant_message(messages: list[JsonDict]) -> JsonDict | None:
    """Return the latest assistant message if present."""
    assistants = assistant_messages(messages)
    return assistants[-1] if assistants else None


def _assistant_message_finished(message: JsonDict) -> bool:
    info = message.get("info")
    if not isinstance(info, dict):
        return False
    timing = info.get("time")
    if isinstance(timing, dict) and isinstance(timing.get("completed"), int | float):
        return True
    finish = info.get("finish")
    return isinstance(finish, str) and bool(finish.strip())


def _assistant_message_has_step_finish(message: JsonDict) -> bool:
    parts = message.get("parts")
    if not isinstance(parts, list):
        return False
    return any(
        isinstance(part, dict) and part.get("type") == "step-finish" for part in parts
    )


def assistant_message_completed(message: JsonDict) -> bool:
    """Return whether an assistant message reached a terminal recorded state."""
    return _assistant_message_finished(message) or _assistant_message_has_step_finish(message)


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


def _non_empty_string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _model_ref_from_info(info: JsonDict) -> str | None:
    model = info.get("model")
    if not isinstance(model, dict):
        return None
    provider_id = _non_empty_string(model.get("providerID"))
    model_id = _non_empty_string(model.get("modelID"))
    return f"{provider_id}/{model_id}" if provider_id and model_id else None


def observed_identity(messages: list[JsonDict]) -> tuple[str, str]:
    """Return the agent and model from the last user message."""
    user_message = next(
        (m for m in reversed(messages) if m["info"]["role"] == "user"),
        None
    )
    if user_message is None:
        raise RuntimeError("No user message with model found in session history")
    info = user_message["info"]
    return info["agent"], f"{info['model']['providerID']}/{info['model']['modelID']}"


def _merge_system_prompts(existing: list[str], prompt_system: str | None) -> str | None:
    merged = [*existing]
    if isinstance(prompt_system, str) and prompt_system.strip():
        merged.append(prompt_system.strip())
    return "\n\n".join(merged) if merged else None


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

    def __exit__(self, _exc_type: object, _exc: object, _exc_tb: object) -> None:
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

    def _prepare_submission(
        self,
        session_id: str,
        request: SubmissionRequest,
    ) -> PreparedSubmission:
        """Validate, resolve context, fetch history, and build the prompt payload."""
        self._validate_visibility(request.visibility)
        context = request.context or self.session_context(session_id)
        messages = self.list_messages(session_id, context=context)
        payload = self._payload_for_submission(
            request=request,
            messages=messages,
        )
        return PreparedSubmission(
            request=request,
            context=context,
            initial_messages=messages,
            payload=payload,
        )

    @staticmethod
    def _validate_visibility(visibility: str) -> None:
        if visibility not in {"chat", "system"}:
            raise PromptDeliveryError(f"Unsupported prompt visibility: {visibility}")

    def submit_prompt(
        self,
        session_id: str,
        request: SubmissionRequest,
        *,
        no_reply: bool = False,
    ) -> PromptResult:
        """Submit a workflow prompt and verify the intended transport semantics."""
        submission = self._prepare_submission(session_id, request)
        if no_reply:
            return self._queue_prompt(session_id, submission)
        return self._continue_prompt(session_id, submission)

    def wait_until_idle(
        self,
        session_id: str,
        *,
        timeout_sec: float = 180.0,
        wait: WaitConfig | None = None,
        context: SessionContext | None = None,
    ) -> WaitResult:
        """Wait until a session stops mutating for a short quiet period."""
        wait = wait or WaitConfig()
        context = context or self.session_context(session_id)
        deadline = time.monotonic() + timeout_sec
        previous_signature: tuple[object, ...] | None = None
        stable_since = time.monotonic()
        latest_updated_at: int | float | None = None

        while time.monotonic() < deadline:
            latest_updated_at, messages, signature, session_state = self._wait_snapshot(
                session_id, context=context
            )
            if signature != previous_signature:
                previous_signature = signature
                stable_since = time.monotonic()
            result = self._idle_wait_result(
                messages=messages,
                wait=wait,
                stable_since=stable_since,
                session_state=session_state,
            )
            if result is not None:
                assistant_message, stable_for = result
                return self._wait_result(
                    assistant_message,
                    session_id,
                    stable_for,
                    latest_updated_at,
                )
            time.sleep(0.5)

        raise WaitTimeoutError(
            f"Timed out waiting for session {session_id} to become idle after {timeout_sec:.0f}s."
        )

    def _wait_for_prompt_recording(
        self,
        session_id: str,
        submission: PreparedSubmission,
        *,
        timeout_sec: float = 10.0,
    ) -> None:
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            messages = self.list_messages(session_id, context=submission.context)
            if len(messages) <= len(submission.initial_messages):
                time.sleep(0.2)
                continue
            new_messages = messages[len(submission.initial_messages) :]
            if any(
                self._matches_recorded_prompt(
                    message,
                    submission.request.prompt,
                    submission.request.visibility,
                )
                for message in new_messages
            ):
                return
            time.sleep(0.2)
        raise PromptDeliveryError(
            f"Queue-only {submission.request.visibility} prompt for {session_id} was not recorded "
            f"in session state within {timeout_sec:.0f}s."
        )

    def _payload_for_submission(
        self,
        request: SubmissionRequest,
        *,
        messages: list[JsonDict],
    ) -> JsonDict:
        derived_agent, derived_model = observed_identity(messages)
        payload = self._prompt_payload(
            prompt=request.prompt,
            visibility=request.visibility,
            agent=request.agent or derived_agent,
            model=request.model or derived_model,
        )
        queued_systems = pending_system_prompts(messages)
        return self._apply_pending_system_prompts(
            payload=payload,
            visibility=request.visibility,
            queued_systems=queued_systems,
        )

    def _apply_pending_system_prompts(
        self,
        *,
        payload: JsonDict,
        visibility: str,
        queued_systems: list[str],
    ) -> JsonDict:
        if not queued_systems:
            return payload
        if visibility == "chat":
            payload["system"] = "\n\n".join(queued_systems)
            LOG.info(
                "carrying %d queued system prompt(s) into continued chat prompt",
                len(queued_systems),
            )
            return payload
        current_system = payload.get("system")
        merged = _merge_system_prompts(
            queued_systems,
            current_system if isinstance(current_system, str) else None,
        )
        if merged is not None:
            payload["system"] = merged
        LOG.info(
            "merging %d queued system prompt(s) into continued system prompt",
            len(queued_systems),
        )
        return payload

    def _queue_prompt(
        self,
        session_id: str,
        submission: PreparedSubmission,
    ) -> PromptResult:
        LOG.info(
            "queue-only prompt %s visibility=%s",
            session_id,
            submission.request.visibility,
        )
        submission.payload["noReply"] = True
        response = self._http.post(
            f"/session/{session_id}/prompt_async",
            headers=session_headers(submission.context, content_type="application/json"),
            json=submission.payload,
        )
        response.raise_for_status()
        self._wait_for_prompt_recording(session_id, submission)
        return PromptResult(assistant_message=None, session_id=session_id)

    def _post_message_stream(
        self,
        session_id: str,
        *,
        context: SessionContext,
        payload: JsonDict,
    ) -> AbstractContextManager[Any]:
        """Return an HTTP stream context manager for POST /session/{id}/message."""
        return self._http.stream(
            "POST",
            f"/session/{session_id}/message",
            headers=session_headers(
                context,
                accept="text/event-stream",
                content_type="application/json",
            ),
            json=payload,
        )

    def _continue_prompt(
        self,
        session_id: str,
        submission: PreparedSubmission,
    ) -> PromptResult:
        visibility = submission.request.visibility
        LOG.info("continued prompt %s visibility=%s", session_id, visibility)
        with self._post_message_stream(
            session_id,
            context=submission.context,
            payload=submission.payload,
        ) as response:
            response.raise_for_status()
            self._consume_stream(response.iter_lines())

        messages = self.list_messages(session_id, context=submission.context)
        assistant_message = latest_assistant_text_since(
            messages,
            submission.initial_assistant_count,
        )
        if assistant_message is None:
            raise PromptDeliveryError(
                f"Session {session_id} accepted a continued {visibility} prompt "
                "but never produced a new assistant turn."
            )
        return PromptResult(assistant_message=assistant_message, session_id=session_id)

    def _submit_detached(
        self,
        session_id: str,
        *,
        visibility: str,
        context: SessionContext,
        payload: JsonDict,
    ) -> PromptResult:
        """Queue a prompt for async execution and return immediately.

        The inference continues server-side. Caller must use wait_until_idle() to
        determine when the turn is complete.
        """
        LOG.info("detached prompt submission %s visibility=%s", session_id, visibility)
        response = self._http.post(
            f"/session/{session_id}/prompt_async",
            headers=session_headers(context, content_type="application/json"),
            json=payload,
        )
        response.raise_for_status()
        return PromptResult(assistant_message=None, session_id=session_id)

    def submit_prompt_no_wait(
        self,
        session_id: str,
        request: SubmissionRequest,
    ) -> PromptResult:
        """Submit a prompt to start an agent turn without waiting for a text response.

        Use wait_until_idle() afterward to block until the full turn is complete."""
        submission = self._prepare_submission(session_id, request)
        result = self._submit_detached(
            session_id,
            visibility=submission.request.visibility,
            context=submission.context,
            payload=submission.payload,
        )
        self._wait_for_prompt_recording(session_id, submission)
        return result

    def _wait_snapshot(
        self, session_id: str, *, context: SessionContext
    ) -> tuple[int | float | None, list[JsonDict], tuple[object, ...], str | None]:
        session = self.get_session(session_id)
        updated_at = self._session_updated_at(session)
        messages = self.list_messages(session_id, context=context)
        session_state = self.session_status(session_id)
        return (
            updated_at,
            messages,
            self._idle_signature(updated_at, messages, session_state=session_state),
            session_state,
        )

    def session_status(self, session_id: str) -> str | None:
        """Return the server-reported session state when available."""
        response = self._http.get("/session/status")
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise PromptDeliveryError("Session status payload was not a JSON object.")
        raw_status = payload.get(session_id)
        if not isinstance(raw_status, dict):
            return None
        state = raw_status.get("state")
        if not isinstance(state, str) or not state.strip():
            return None
        return state.strip().lower()

    def _idle_wait_result(
        self,
        *,
        messages: list[JsonDict],
        wait: WaitConfig,
        stable_since: float,
        session_state: str | None,
    ) -> tuple[str | None, float] | None:
        if session_state not in {None, "idle"}:
            return None
        assistant_message = self._assistant_message_for_wait(messages, wait)
        stable_for = time.monotonic() - stable_since
        if self._can_accept_stable_assistant_without_finish(
            messages,
            wait,
            assistant_message=assistant_message,
            stable_for=stable_for,
            session_state=session_state,
        ):
            return assistant_message, stable_for
        if not self._idle_wait_ready(
            messages,
            wait,
            assistant_message=assistant_message,
            stable_for=stable_for,
        ):
            return None
        if not wait.require_new_assistant and not has_pending_prompt(messages):
            return assistant_message, 0.0
        return assistant_message, stable_for

    @staticmethod
    def _can_accept_stable_assistant_without_finish(
        messages: list[JsonDict],
        wait: WaitConfig,
        *,
        assistant_message: str | None,
        stable_for: float,
        session_state: str | None,
    ) -> bool:
        if session_state is not None:
            return False
        if not OpenCodeManagerClient._assistant_turn_in_progress(messages, wait):
            return False
        return (
            stable_for >= wait.quiet_period_sec
            and assistant_message is not None
            and latest_message_role(messages) == "assistant"
            and not has_pending_prompt(messages)
        )

    @staticmethod
    def _idle_wait_ready(
        messages: list[JsonDict],
        wait: WaitConfig,
        *,
        assistant_message: str | None,
        stable_for: float,
    ) -> bool:
        if OpenCodeManagerClient._assistant_turn_in_progress(messages, wait):
            return assistant_message is not None and stable_for >= wait.quiet_period_sec
        if not wait.require_new_assistant and not has_pending_prompt(messages):
            return True
        if assistant_message is None:
            return False
        return stable_for >= wait.quiet_period_sec

    @staticmethod
    def _assistant_message_for_wait(messages: list[JsonDict], wait: WaitConfig) -> str | None:
        if wait.require_new_assistant:
            return latest_assistant_text_since(messages, wait.initial_assistant_count)
        return latest_assistant_text(messages)

    @staticmethod
    def _assistant_turn_in_progress(messages: list[JsonDict], wait: WaitConfig) -> bool:
        assistants = assistant_messages(messages)
        if len(assistants) <= wait.initial_assistant_count:
            return False
        latest = latest_assistant_message(messages)
        if latest is None:
            return False
        return not assistant_message_completed(latest)

    @staticmethod
    def _wait_result(
        assistant_message: str | None,
        session_id: str,
        stable_for_seconds: float,
        updated_at: int | float | None,
    ) -> WaitResult:
        return WaitResult(
            assistant_message=assistant_message,
            session_id=session_id,
            stable_for_seconds=stable_for_seconds,
            updated_at=updated_at,
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
        updated_at: int | float | None,
        messages: list[JsonDict],
        *,
        session_state: str | None = None,
    ) -> tuple[object, ...]:
        latest = messages[-1] if messages else {}
        info = latest.get("info") if isinstance(latest, dict) else {}
        role = info.get("role") if isinstance(info, dict) else None
        finish = info.get("finish") if isinstance(info, dict) else None
        latest_parts = latest.get("parts")
        latest_text = flatten_text(latest_parts) if isinstance(latest_parts, list) else ""
        return (session_state, len(messages), role, finish, latest_text)

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

    @classmethod
    def _matches_recorded_prompt(cls, message: JsonDict, prompt: str, visibility: str) -> bool:
        if visibility == "chat":
            return cls._matches_chat_prompt(message, prompt)
        return cls._matches_system_prompt(message, prompt)
