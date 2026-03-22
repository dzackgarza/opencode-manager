"""Strict public command contracts."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    """Common strict Pydantic settings for public CLI contracts."""

    model_config = ConfigDict(extra="forbid", strict=True)


def _strip_required(value: str, *, label: str) -> str:
    text = value.strip()
    if not text:
        raise ValueError(f"{label} must not be empty.")
    return text


def _strip_optional(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None


def _validate_model_ref(value: str | None) -> str | None:
    if value is None:
        return None
    provider_id, _, model_id = value.partition("/")
    if not provider_id or not model_id:
        raise ValueError("model must use provider/model format.")
    return value


class OneShotCommand(StrictModel):
    prompt: str
    agent: str | None = None
    model: str | None = None
    transcript: bool = False

    @field_validator("prompt")
    @classmethod
    def _prompt_validator(cls, value: str) -> str:
        return _strip_required(value, label="prompt")

    @field_validator("agent")
    @classmethod
    def _agent_validator(cls, value: str | None) -> str | None:
        return _strip_optional(value)

    @field_validator("model")
    @classmethod
    def _model_validator(cls, value: str | None) -> str | None:
        return _validate_model_ref(_strip_optional(value))


class BeginSessionCommand(StrictModel):
    prompt: str
    agent: str | None = None
    model: str | None = None
    json_output: bool = False

    @field_validator("prompt")
    @classmethod
    def _prompt_validator(cls, value: str) -> str:
        return _strip_required(value, label="prompt")

    @field_validator("agent")
    @classmethod
    def _agent_validator(cls, value: str | None) -> str | None:
        return _strip_optional(value)

    @field_validator("model")
    @classmethod
    def _model_validator(cls, value: str | None) -> str | None:
        return _validate_model_ref(_strip_optional(value))


class ContinuedPromptCommand(StrictModel):
    session_id: str = Field(alias="session_id")
    prompt: str
    system: bool = False
    no_reply: bool = False
    json_output: bool = False

    @field_validator("session_id")
    @classmethod
    def _session_validator(cls, value: str) -> str:
        return _strip_required(value, label="session_id")

    @field_validator("prompt")
    @classmethod
    def _prompt_validator(cls, value: str) -> str:
        return _strip_required(value, label="prompt")

    @property
    def visibility(self) -> str:
        return "system" if self.system else "chat"


class WaitCommand(StrictModel):
    session_id: str = Field(alias="session_id")
    json_output: bool = False
    timeout_sec: float = 180.0

    @field_validator("session_id")
    @classmethod
    def _session_validator(cls, value: str) -> str:
        return _strip_required(value, label="session_id")

    @field_validator("timeout_sec")
    @classmethod
    def _timeout_positive(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("timeout_sec must be greater than 0.")
        return value


class TranscriptCommand(StrictModel):
    session_id: str = Field(alias="session_id")
    json_output: bool = False
    output: str | None = None
    tee_temp: bool = False

    @field_validator("session_id")
    @classmethod
    def _session_validator(cls, value: str) -> str:
        return _strip_required(value, label="session_id")

    @field_validator("output")
    @classmethod
    def _output_validator(cls, value: str | None) -> str | None:
        return _strip_optional(value)

    @model_validator(mode="after")
    def _validate_output_mode(self) -> TranscriptCommand:
        if self.output and self.tee_temp:
            raise ValueError("Use either --output or --tee-temp, not both.")
        return self


class FinalCommand(StrictModel):
    session_id: str = Field(alias="session_id")
    prompt: str
    transcript: bool = False

    @field_validator("session_id")
    @classmethod
    def _session_validator(cls, value: str) -> str:
        return _strip_required(value, label="session_id")

    @field_validator("prompt")
    @classmethod
    def _prompt_validator(cls, value: str) -> str:
        return _strip_required(value, label="prompt")


class DeleteCommand(StrictModel):
    session_id: str = Field(alias="session_id")

    @field_validator("session_id")
    @classmethod
    def _session_validator(cls, value: str) -> str:
        return _strip_required(value, label="session_id")


class DoctorCommand(StrictModel):
    json_output: bool = False
    skip_server_check: bool = False
    timeout_sec: float = 5.0

    @field_validator("timeout_sec")
    @classmethod
    def _timeout_positive(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("timeout_sec must be greater than 0.")
        return value


class DoctorCheck(StrictModel):
    name: str
    ok: bool
    detail: str


class DoctorReport(StrictModel):
    base_url: str
    cwd: str
    config_origin: str
    config_path: str
    proof_workspace: str
    checks: list[DoctorCheck]

    @property
    def ok(self) -> bool:
        return all(check.ok for check in self.checks)

    def as_json(self) -> dict[str, Any]:
        payload = self.model_dump()
        payload["ok"] = self.ok
        return payload


class TranscriptRenderCommand(StrictModel):
    session_id: str | None = None
    input_path: str | None = None
    json_output: bool = False
    output: str | None = None
    tee_temp: bool = False

    @field_validator("session_id")
    @classmethod
    def _session_validator(cls, value: str | None) -> str | None:
        return _strip_optional(value)

    @field_validator("input_path")
    @classmethod
    def _input_validator(cls, value: str | None) -> str | None:
        return _strip_optional(value)

    @field_validator("output")
    @classmethod
    def _output_validator(cls, value: str | None) -> str | None:
        return _strip_optional(value)

    @model_validator(mode="after")
    def _validate_shape(self) -> TranscriptRenderCommand:
        if (self.session_id is None) == (self.input_path is None):
            raise ValueError("Provide exactly one of <session-id> or --input.")
        if self.output and self.tee_temp:
            raise ValueError("Use either --output or --tee-temp, not both.")
        return self

    @property
    def output_path(self) -> Path | None:
        return Path(self.output).resolve() if self.output else None


def validate_base_url(value: str) -> str:
    """Validate the configured OpenCode base URL."""
    text = value.strip()
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base_url must be a valid http or https URL.")
    return text.rstrip("/")
