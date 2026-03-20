"""Custom errors for the OpenCode workflow CLI."""

from __future__ import annotations


class OpxError(RuntimeError):
    """Base workflow error."""


class SessionLookupError(OpxError):
    """Raised when a session cannot be resolved."""


class PromptDeliveryError(OpxError):
    """Raised when the server does not record or continue a prompt as expected."""


class WaitTimeoutError(OpxError):
    """Raised when a session never reaches the expected idle state."""


class TranscriptRenderError(OpxError):
    """Raised when transcript data cannot be rendered."""
