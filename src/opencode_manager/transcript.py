"""Transcript export rendering."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .errors import TranscriptRenderError

type JsonDict = dict[str, object]


def _as_json_dict(value: object) -> JsonDict:
    return value if isinstance(value, dict) else {}


def _as_json_list(value: object) -> list[JsonDict]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


@dataclass(frozen=True, slots=True)
class RenderOptions:
    generated_at_ms: int | None = None
    saved_copy_path: str | None = None


def _as_number(value: object) -> int | float | None:
    if isinstance(value, int | float):
        return value
    return None


def _message_created_ms(message: JsonDict | None) -> int | float | None:
    if not isinstance(message, dict):
        return None
    info = message.get("info")
    if not isinstance(info, dict):
        return None
    time = info.get("time")
    if not isinstance(time, dict):
        return None
    return _as_number(time.get("created"))


def _message_completed_ms(message: JsonDict | None) -> int | float | None:
    if not isinstance(message, dict):
        return None
    info = message.get("info")
    if not isinstance(info, dict):
        return None
    time = info.get("time")
    if not isinstance(time, dict):
        return _message_created_ms(message)
    return _as_number(time.get("completed")) or _message_created_ms(message)


def _iso_timestamp(epoch_ms: int | float | None) -> str:
    if epoch_ms is None:
        return "unknown"
    return datetime.fromtimestamp(epoch_ms / 1000, tz=UTC).isoformat().replace("+00:00", "Z")


def _duration_text(start_ms: int | float | None, end_ms: int | float | None) -> str:
    if start_ms is None or end_ms is None:
        return "unknown"
    duration_ms = max(0.0, float(end_ms) - float(start_ms))
    return f"{duration_ms / 1000:.3f}s"


def _hinted_duration_text(
    start_ms: int | float | None,
    end_ms: int | float | None,
    hint_ms: int | float | None,
    hint_source: str | None,
) -> str:
    if hint_ms is not None:
        rendered = f"{float(hint_ms) / 1000:.3f}s"
        return f"{rendered} ({hint_source})" if hint_source else rendered
    return _duration_text(start_ms, end_ms)


def _text_parts(parts: list[JsonDict]) -> str:
    blocks: list[str] = []
    for part in parts:
        if part.get("type") != "text":
            continue
        text = part.get("text")
        if isinstance(text, str) and text.strip():
            blocks.append(text.strip())
    return "\n\n".join(blocks)


def _reasoning_parts(parts: list[JsonDict]) -> list[str]:
    output: list[str] = []
    for part in parts:
        part_type = part.get("type")
        if not isinstance(part_type, str) or "reasoning" not in part_type:
            continue
        text = part.get("text")
        if isinstance(text, str) and text.strip():
            output.append(text.strip())
    return output


def _render_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, indent=2)


def _render_block(label: str, value: object) -> list[str]:
    if value is None:
        return []
    rendered = _render_value(value)
    if not rendered.strip():
        return []
    return [label, *[f"    {line}" for line in rendered.splitlines()]]


def _step_heading(part: JsonDict) -> str:
    part_type = part.get("type")
    if part_type == "tool":
        tool = part.get("tool")
        return f"tool:{tool}" if isinstance(tool, str) else "tool:unknown"
    if isinstance(part_type, str):
        return part_type
    return "unknown"


def _part_duration_hint(part: JsonDict) -> tuple[int | float | None, str | None]:
    timing = part.get("timing")
    if isinstance(timing, dict):
        latency_s = timing.get("latency_s")
        if isinstance(latency_s, int | float):
            return max(0.0, float(latency_s) * 1000), "legacy tool timing"
    return None, None


def _part_started_ms(part: JsonDict, message: JsonDict) -> tuple[int | float | None, str | None]:
    part_type = part.get("type")
    if part_type == "tool":
        state = part.get("state")
        if isinstance(state, dict):
            time = state.get("time")
            if isinstance(time, dict):
                start = _as_number(time.get("start"))
                if start is not None:
                    return start, "tool state"
    if part_type in {"text", "reasoning", "patch"}:
        time = part.get("time")
        if isinstance(time, dict):
            start = _as_number(time.get("start"))
            if start is not None:
                return start, f"{part_type} part"
    if part_type == "step-start":
        return _message_created_ms(message), "assistant message start"
    if part_type == "step-finish":
        return _message_completed_ms(message), "assistant message completion"
    return None, None


def _part_completed_ms(part: JsonDict, message: JsonDict) -> tuple[int | float | None, str | None]:
    part_type = part.get("type")
    if part_type == "tool":
        state = part.get("state")
        if isinstance(state, dict):
            time = state.get("time")
            if isinstance(time, dict):
                end = _as_number(time.get("end"))
                if end is not None:
                    return end, "tool state"
    if part_type in {"text", "reasoning", "patch"}:
        time = part.get("time")
        if isinstance(time, dict):
            end = _as_number(time.get("end"))
            if end is not None:
                return end, f"{part_type} part"
    if part_type == "step-start":
        return _message_created_ms(message), "assistant message start"
    if part_type == "step-finish":
        return _message_completed_ms(message), "assistant message completion"
    return None, None


def _build_steps(message: JsonDict) -> list[JsonDict]:
    raw_parts = message.get("parts")
    parts = raw_parts if isinstance(raw_parts, list) else []
    steps: list[JsonDict] = []
    for index, raw_part in enumerate(parts, start=1):
        if not isinstance(raw_part, dict):
            continue
        started_ms, started_source = _part_started_ms(raw_part, message)
        completed_ms, completed_source = _part_completed_ms(raw_part, message)
        duration_hint_ms, duration_hint_source = _part_duration_hint(raw_part)
        steps.append(
            {
                "completed_ms": completed_ms,
                "completed_source": completed_source,
                "duration_hint_ms": duration_hint_ms,
                "duration_hint_source": duration_hint_source,
                "heading": _step_heading(raw_part),
                "index": index,
                "part": raw_part,
                "started_ms": started_ms,
                "started_source": started_source,
            }
        )

    for index, step in enumerate(steps):
        if step["started_ms"] is not None:
            continue
        previous = steps[index - 1] if index > 0 else None
        previous_end = previous["completed_ms"] if previous is not None else None
        previous_start = previous["started_ms"] if previous is not None else None
        step["started_ms"] = previous_end or previous_start or _message_created_ms(message)
        step["started_source"] = "previous step boundary" if previous else "assistant message start"

    for index in range(len(steps) - 1, -1, -1):
        step = steps[index]
        if step["completed_ms"] is not None:
            continue
        next_step = steps[index + 1] if index + 1 < len(steps) else None
        next_start = next_step["started_ms"] if next_step is not None else None
        next_end = next_step["completed_ms"] if next_step is not None else None
        step["completed_ms"] = next_start or next_end or _message_completed_ms(message)
        step["completed_source"] = (
            "next step boundary" if next_step else "assistant message completion"
        )

    for step in steps:
        if step["started_ms"] is None and step["completed_ms"] is not None:
            step["started_ms"] = step["completed_ms"]
            step["started_source"] = step["completed_source"]
        if step["completed_ms"] is None and step["started_ms"] is not None:
            step["completed_ms"] = step["started_ms"]
            step["completed_source"] = step["started_source"]
        started = step["started_ms"]
        completed = step["completed_ms"]
        if (
            isinstance(started, int | float)
            and isinstance(completed, int | float)
            and completed < started
        ):
            step["completed_ms"] = started
            if not step["completed_source"]:
                step["completed_source"] = step["started_source"]

    return steps


def _build_turns(messages: list[JsonDict]) -> list[JsonDict]:
    turns: list[JsonDict] = []
    current: JsonDict | None = None
    for message in messages:
        info = message.get("info")
        role = info.get("role") if isinstance(info, dict) else None
        if role == "user":
            if current is not None:
                turns.append(current)
            current = {
                "assistant_messages": [],
                "completed_ms": _message_completed_ms(message),
                "index": len(turns) + 1,
                "started_ms": _message_created_ms(message),
                "user_message": message,
            }
            continue
        if current is None:
            current = {
                "assistant_messages": [],
                "completed_ms": None,
                "index": len(turns) + 1,
                "started_ms": _message_created_ms(message),
                "user_message": None,
            }
        assistant_messages = current["assistant_messages"]
        if isinstance(assistant_messages, list):
            assistant_messages.append(message)
        if current["started_ms"] is None:
            current["started_ms"] = _message_created_ms(message)
        current["completed_ms"] = _message_completed_ms(message) or current["completed_ms"]
    if current is not None:
        turns.append(current)
    return turns


def _render_step(step: JsonDict) -> JsonDict | None:
    part = step.get("part")
    if not isinstance(part, dict):
        return None

    started_ms = step.get("started_ms")
    completed_ms = step.get("completed_ms")
    duration_hint_ms = step.get("duration_hint_ms")
    duration_hint_source = step.get("duration_hint_source")
    duration = _hinted_duration_text(
        started_ms if isinstance(started_ms, int | float) else None,
        completed_ms if isinstance(completed_ms, int | float) else None,
        duration_hint_ms if isinstance(duration_hint_ms, int | float) else None,
        duration_hint_source if isinstance(duration_hint_source, str) else None,
    )
    part_type = part.get("type")
    if part_type == "tool":
        state = part.get("state")
        state_dict = state if isinstance(state, dict) else {}
        return {
            "duration": duration,
            "heading": step["heading"],
            "index": step["index"],
            "inputText": _render_value(state_dict.get("input", {})),
            "outputText": _render_value(state_dict["output"]) if "output" in state_dict else None,
            "status": str(state_dict.get("status", "unknown")),
            "tool": str(part.get("tool", "unknown")),
            "type": "tool",
        }
    if part_type in {"text", "reasoning", "patch"}:
        return {
            "contentText": _render_value(part.get("text", part)),
            "duration": duration,
            "heading": step["heading"],
            "index": step["index"],
            "type": str(part_type),
        }
    return None


def _render_assistant_message(message: JsonDict, *, index: int) -> JsonDict:
    message_info = message.get("info")
    info_dict = message_info if isinstance(message_info, dict) else {}
    message_parts = message.get("parts")
    parts = (
        [part for part in message_parts if isinstance(part, dict)]
        if isinstance(message_parts, list)
        else []
    )
    rendered_steps = [
        rendered for rendered in (_render_step(step) for step in _build_steps(message)) if rendered
    ]
    return {
        "duration": _duration_text(_message_created_ms(message), _message_completed_ms(message)),
        "finish": str(info_dict.get("finish", "unknown")),
        "index": index,
        "reasoning": _reasoning_parts(parts),
        "steps": rendered_steps,
        "text": _text_parts(parts),
    }


def _render_turn(turn: JsonDict) -> JsonDict:
    assistant_messages = [
        message
        for message in _as_json_list(turn.get("assistant_messages"))
        if isinstance(message, dict)
    ]
    user_message = turn.get("user_message")
    if not isinstance(user_message, dict):
        user_message = None
    turn_start = turn.get("started_ms") or _message_created_ms(user_message)
    turn_end = turn.get("completed_ms") or _message_completed_ms(
        assistant_messages[-1] if assistant_messages else user_message
    )
    user_parts = _as_json_list(user_message.get("parts")) if user_message is not None else []
    user_info = _as_json_dict(user_message.get("info")) if user_message is not None else {}
    raw_system_prompt = user_info.get("system")
    rendered_assistant_messages = [
        _render_assistant_message(message, index=index)
        for index, message in enumerate(assistant_messages, start=1)
    ]
    return {
        "assistantMessages": rendered_assistant_messages,
        "duration": _duration_text(
            turn_start if isinstance(turn_start, int | float) else None,
            turn_end if isinstance(turn_end, int | float) else None,
        ),
        "index": turn.get("index", 0),
        "systemPrompt": (
            raw_system_prompt.strip()
            if isinstance(raw_system_prompt, str) and raw_system_prompt.strip()
            else None
        ),
        "userPrompt": _text_parts(user_parts),
    }


def render_transcript_json(data: JsonDict) -> JsonDict:
    info = data.get("info")
    messages = data.get("messages")
    if not isinstance(info, dict) or not isinstance(messages, list):
        raise TranscriptRenderError(
            "Transcript export must contain object fields 'info' and 'messages'."
        )

    turns = _build_turns([message for message in messages if isinstance(message, dict)])
    rendered_turns = [_render_turn(turn) for turn in turns]
    return {
        "directory": str(info.get("directory", "unknown")),
        "sessionID": str(info.get("id", "unknown")),
        "title": str(info.get("title", "unknown")),
        "turns": rendered_turns,
    }


def render_transcript_markdown(data: JsonDict, options: RenderOptions | None = None) -> str:
    options = options or RenderOptions()
    rendered = render_transcript_json(data)
    generated_at_ms = options.generated_at_ms or int(datetime.now(tz=UTC).timestamp() * 1000)
    turns = rendered["turns"]
    if not isinstance(turns, list):
        raise TranscriptRenderError("Transcript JSON turns must be a list.")

    lines = [
        "# OpenCode Session Transcript",
        "",
        f"- Confirmed session ID: `{rendered['sessionID']}`",
        f"- Title: `{rendered['title']}`",
        f"- Directory: `{rendered['directory']}`",
        f"- Turns: {len(turns)}",
        f"- Generated at: {_iso_timestamp(generated_at_ms)}",
    ]
    if options.saved_copy_path:
        lines.append(f"- Saved copy: `{options.saved_copy_path}`")
    lines.append("")
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        lines.append(f"## Turn {turn['index']}")
        lines.append(f"- Duration: {turn['duration']}")
        system_prompt = turn.get("systemPrompt", "")
        lines.extend(_render_block("System Prompt:", system_prompt))
        user_prompt = turn.get("userPrompt", "")
        lines.extend(_render_block("Prompt:", user_prompt))
        assistant_list = _as_json_list(turn.get("assistantMessages"))
        if not assistant_list:
            lines.append("- Assistant messages: 0")
            lines.append("")
            continue
        lines.append(f"- Assistant messages: {len(assistant_list)}")
        lines.append("")
        for assistant in assistant_list:
            if not isinstance(assistant, dict):
                continue
            lines.append(f"### Agent Message {assistant['index']}")
            lines.append(f"- Duration: {assistant['duration']}")
            lines.append(f"- Finish: `{assistant['finish']}`")
            lines.extend(_render_block("Text:", assistant.get("text", "")))
            steps = assistant.get("steps")
            step_list = steps if isinstance(steps, list) else []
            for step in step_list:
                if not isinstance(step, dict):
                    continue
                lines.append(f"#### Step {step['index']} `{step['heading']}`")
                lines.append(f"- Duration: {step['duration']}")
                if "status" in step and step["status"] is not None:
                    lines.append(f"- Status: `{step['status']}`")
                lines.extend(_render_block("Content:", step.get("contentText")))
                lines.extend(_render_block("Input:", step.get("inputText")))
                lines.extend(_render_block("Output:", step.get("outputText")))
            lines.append("")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def load_transcript_export(path: str | Path) -> JsonDict:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise TranscriptRenderError("Transcript export root must be a JSON object.")
    return payload
