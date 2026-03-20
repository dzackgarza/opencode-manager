"""Environment and request configuration."""

from __future__ import annotations

from dataclasses import dataclass
from os import environ, getcwd
from urllib.parse import quote

DEFAULT_BASE_URL = "http://127.0.0.1:4096"


@dataclass(frozen=True, slots=True)
class SessionContext:
    """Per-session directory/workspace headers."""

    directory: str | None = None
    workspace_id: str | None = None


def base_url() -> str:
    """Return the configured server base URL."""
    return environ.get("OPENCODE_BASE_URL", DEFAULT_BASE_URL).rstrip("/")


def default_session_context() -> SessionContext:
    """Use the current working directory for new sessions."""
    return SessionContext(directory=getcwd())


def _encode_directory(directory: str) -> str:
    return quote(directory, safe="/._-")


def auth_headers() -> dict[str, str]:
    """Build auth headers from the normal OpenCode environment variables."""
    headers: dict[str, str] = {}
    api_key = environ.get("OPENCODE_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
        return headers

    username = environ.get("OPENCODE_SERVER_USERNAME", "").strip()
    password = environ.get("OPENCODE_SERVER_PASSWORD", "").strip()
    if username and password:
        import base64

        basic = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
        headers["Authorization"] = f"Basic {basic}"
    return headers


def session_headers(
    context: SessionContext | None,
    *,
    content_type: str | None = None,
    accept: str | None = None,
) -> dict[str, str]:
    """Build request headers for session-scoped endpoints."""
    headers = auth_headers()
    if content_type:
        headers["Content-Type"] = content_type
    if accept:
        headers["Accept"] = accept
    if context is not None:
        if context.directory:
            headers["x-opencode-directory"] = _encode_directory(context.directory)
        if context.workspace_id:
            headers["x-opencode-workspace"] = context.workspace_id
    return headers
