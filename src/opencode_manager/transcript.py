"""Transcript export rendering."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .errors import TranscriptRenderError

JsonDict = dict[str, object]


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


def _message_time(message: JsonDict | None, field: str) -> int | float | None:
    if not isinstance(message, dict):
        return None
    info = message.get("info")
    if not isinstance(info, dict):
        return None
    time = info.get("time")
    if not isinstance(time, dict):
        return None
    return _as_number(time.get(field))


def _message_created_ms(message: JsonDict | None) -> int | float | None:
    return _message_time(message, "created")


def _message_completed_ms(message: JsonDict | None) -> int | float | None:
    return _message_time(message, "completed") or _message_created_ms(message)


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
    if not isinstance(timing, dict):
        return None, None
    latency_s = timing.get("latency_s")
    if not isinstance(latency_s, int | float):
        return None, None
    return max(0.0, float(latency_s) * 1000), "legacy tool timing"


def _time_from_mapping(
    value: object, field: str, source: str
) -> tuple[int | float | None, str | None]:
    if not isinstance(value, dict):
        return None, None
    timestamp = _as_number(value.get(field))
    if timestamp is None:
        return None, None
    return timestamp, source


def _tool_state_time(part: JsonDict, field: str) -> tuple[int | float | None, str | None]:
    state = part.get("state")
    if not isinstance(state, dict):
        return None, None
    return _time_from_mapping(state.get("time"), field, "tool state")


def _content_part_time(
    part: JsonDict, field: str, part_type: str
) -> tuple[int | float | None, str | None]:
    return _time_from_mapping(part.get("time"), field, f"{part_type} part")


def _part_boundary_ms(
    part_type: object, message: JsonDict
) -> tuple[int | float | None, str | None]:
    if part_type == "step-start":
        return _message_created_ms(message), "assistant message start"
    if part_type == "step-finish":
        return _message_completed_ms(message), "assistant message completion"
    return None, None


def _part_started_ms(part: JsonDict, message: JsonDict) -> tuple[int | float | None, str | None]:
    part_type = part.get("type")
    if part_type == "tool":
        return _tool_state_time(part, "start")
    if part_type in {"text", "reasoning", "patch"}:
        return _content_part_time(part, "start", str(part_type))
    return _part_boundary_ms(part_type, message)


def _part_completed_ms(part: JsonDict, message: JsonDict) -> tuple[int | float | None, str | None]:
    part_type = part.get("type")
    if part_type == "tool":
        return _tool_state_time(part, "end")
    if part_type in {"text", "reasoning", "patch"}:
        return _content_part_time(part, "end", str(part_type))
    return _part_boundary_ms(part_type, message)


def _new_step(index: int, part: JsonDict, message: JsonDict) -> JsonDict:
    started_ms, started_source = _part_started_ms(part, message)
    completed_ms, completed_source = _part_completed_ms(part, message)
    duration_hint_ms, duration_hint_source = _part_duration_hint(part)
    return {
        "completed_ms": completed_ms,
        "completed_source": completed_source,
        "duration_hint_ms": duration_hint_ms,
        "duration_hint_source": duration_hint_source,
        "heading": _step_heading(part),
        "index": index,
        "part": part,
        "started_ms": started_ms,
        "started_source": started_source,
    }


def _initial_steps(message: JsonDict) -> list[JsonDict]:
    raw_parts = message.get("parts")
    parts = raw_parts if isinstance(raw_parts, list) else []
    steps: list[JsonDict] = []
    for index, part in enumerate(parts, start=1):
        if isinstance(part, dict):
            steps.append(_new_step(index, part, message))
    return steps


def _fill_missing_step_starts(steps: list[JsonDict], message: JsonDict) -> None:
    for index, step in enumerate(steps):
        if step["started_ms"] is not None:
            continue
        step["started_ms"], step["started_source"] = _fallback_step_start(steps, index, message)


def _fallback_step_start(
    steps: list[JsonDict], index: int, message: JsonDict
) -> tuple[int | float | None, str]:
    previous = steps[index - 1] if index > 0 else None
    if previous is None:
        return _message_created_ms(message), "assistant message start"
    previous_end = previous["completed_ms"]
    previous_start = previous["started_ms"]
    return previous_end or previous_start, "previous step boundary"


def _fill_missing_step_completions(steps: list[JsonDict], message: JsonDict) -> None:
    for index in range(len(steps) - 1, -1, -1):
        step = steps[index]
        if step["completed_ms"] is not None:
            continue
        step["completed_ms"], step["completed_source"] = _fallback_step_completion(
            steps,
            index,
            message,
        )


def _fallback_step_completion(
    steps: list[JsonDict], index: int, message: JsonDict
) -> tuple[int | float | None, str]:
    next_step = steps[index + 1] if index + 1 < len(steps) else None
    if next_step is None:
        return _message_completed_ms(message), "assistant message completion"
    next_start = next_step["started_ms"]
    next_end = next_step["completed_ms"]
    return next_start or next_end, "next step boundary"


def _mirror_missing_boundary(
    step: JsonDict,
    *,
    target: str,
    target_source: str,
    other: str,
    other_source: str,
) -> None:
    if step[target] is None and step[other] is not None:
        step[target] = step[other]
        step[target_source] = step[other_source]


def _coerce_reversed_step_boundary(step: JsonDict) -> None:
    started = step["started_ms"]
    completed = step["completed_ms"]
    if not (
        isinstance(started, int | float)
        and isinstance(completed, int | float)
        and completed < started
    ):
        return
    step["completed_ms"] = started
    if not step["completed_source"]:
        step["completed_source"] = step["started_source"]


def _normalize_step_boundaries(steps: list[JsonDict]) -> None:
    for step in steps:
        _mirror_missing_boundary(
            step,
            target="started_ms",
            target_source="started_source",
            other="completed_ms",
            other_source="completed_source",
        )
        _mirror_missing_boundary(
            step,
            target="completed_ms",
            target_source="completed_source",
            other="started_ms",
            other_source="started_source",
        )
        _coerce_reversed_step_boundary(step)


def _build_steps(message: JsonDict) -> list[JsonDict]:
    steps = _initial_steps(message)
    _fill_missing_step_starts(steps, message)
    _fill_missing_step_completions(steps, message)
    _normalize_step_boundaries(steps)
    return steps


def _start_turn(turns: list[JsonDict], message: JsonDict) -> JsonDict:
    return {
        "assistant_messages": [],
        "completed_ms": _message_completed_ms(message),
        "index": len(turns) + 1,
        "started_ms": _message_created_ms(message),
        "user_message": message,
    }


def _append_assistant_message(current: JsonDict, message: JsonDict) -> None:
    assistant_messages = current["assistant_messages"]
    if isinstance(assistant_messages, list):
        assistant_messages.append(message)
    if current["started_ms"] is None:
        current["started_ms"] = _message_created_ms(message)
    current["completed_ms"] = _message_completed_ms(message) or current["completed_ms"]


def _build_turns(messages: list[JsonDict]) -> list[JsonDict]:
    turns: list[JsonDict] = []
    current: JsonDict | None = None
    for message in messages:
        info = message.get("info")
        role = info.get("role") if isinstance(info, dict) else None
        if role == "user":
            if current is not None:
                turns.append(current)
            current = _start_turn(turns, message)
            continue
        if current is None:
            current = {
                "assistant_messages": [],
                "completed_ms": None,
                "index": len(turns) + 1,
                "started_ms": _message_created_ms(message),
                "user_message": None,
            }
        _append_assistant_message(current, message)
    if current is not None:
        turns.append(current)
    return turns


def _tool_step_payload(step: JsonDict, part: JsonDict, duration: str) -> JsonDict:
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


def _content_step_payload(
    step: JsonDict, part: JsonDict, duration: str, part_type: str
) -> JsonDict:
    return {
        "contentText": _render_value(part.get("text", part)),
        "duration": duration,
        "heading": step["heading"],
        "index": step["index"],
        "type": part_type,
    }


def _render_step(step: JsonDict) -> JsonDict | None:
    part = step.get("part")
    if not isinstance(part, dict):
        return None
    duration = _step_duration(step)
    part_type = part.get("type")
    if part_type == "tool":
        return _tool_step_payload(step, part, duration)
    if part_type in {"text", "reasoning", "patch"}:
        return _content_step_payload(step, part, duration, str(part_type))
    return None


def _step_duration(step: JsonDict) -> str:
    started_ms = step.get("started_ms")
    completed_ms = step.get("completed_ms")
    duration_hint_ms = step.get("duration_hint_ms")
    duration_hint_source = step.get("duration_hint_source")
    return _hinted_duration_text(
        started_ms if isinstance(started_ms, int | float) else None,
        completed_ms if isinstance(completed_ms, int | float) else None,
        duration_hint_ms if isinstance(duration_hint_ms, int | float) else None,
        duration_hint_source if isinstance(duration_hint_source, str) else None,
    )


def _render_assistant_message(message: JsonDict, *, index: int) -> JsonDict:
    info_dict = _as_json_dict(message.get("info"))
    parts = _as_json_list(message.get("parts"))
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


def _turn_range(
    turn: JsonDict, user_message: JsonDict | None, assistant_messages: list[JsonDict]
) -> tuple[int | float | None, int | float | None]:
    turn_start = turn.get("started_ms") or _message_created_ms(user_message)
    final_message = assistant_messages[-1] if assistant_messages else user_message
    turn_end = turn.get("completed_ms") or _message_completed_ms(final_message)
    return (
        turn_start if isinstance(turn_start, int | float) else None,
        turn_end if isinstance(turn_end, int | float) else None,
    )


def _system_prompt_from_info(info: JsonDict) -> str | None:
    raw_prompt = info.get("system")
    if not isinstance(raw_prompt, str):
        return None
    system_prompt = raw_prompt.strip()
    return system_prompt or None


def _turn_index(turn: JsonDict) -> int:
    index = turn.get("index")
    if not isinstance(index, int):
        raise TranscriptRenderError("Rendered turn is missing integer field 'index'.")
    return index


def _render_turn(turn: JsonDict) -> JsonDict:
    assistant_messages = _as_json_list(turn.get("assistant_messages"))
    user_message = turn.get("user_message")
    if not isinstance(user_message, dict):
        user_message = None
    turn_start, turn_end = _turn_range(turn, user_message, assistant_messages)
    user_parts = _as_json_list(user_message.get("parts")) if user_message is not None else []
    user_info = _as_json_dict(user_message.get("info")) if user_message is not None else {}
    rendered_assistant_messages = [
        _render_assistant_message(message, index=index)
        for index, message in enumerate(assistant_messages, start=1)
    ]
    return {
        "assistantMessages": rendered_assistant_messages,
        "duration": _duration_text(turn_start, turn_end),
        "index": _turn_index(turn),
        "systemPrompt": _system_prompt_from_info(user_info),
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


def _render_markdown_step(lines: list[str], step: JsonDict) -> None:
    lines.append(f"#### Step {step['index']} `{step['heading']}`")
    lines.append(f"- Duration: {step['duration']}")
    if "status" in step and step["status"] is not None:
        lines.append(f"- Status: `{step['status']}`")
    lines.extend(_render_block("Content:", step.get("contentText")))
    lines.extend(_render_block("Input:", step.get("inputText")))
    lines.extend(_render_block("Output:", step.get("outputText")))


def _render_markdown_assistant(lines: list[str], assistant: JsonDict) -> None:
    lines.append(f"### Agent Message {assistant['index']}")
    lines.append(f"- Duration: {assistant['duration']}")
    lines.append(f"- Finish: `{assistant['finish']}`")
    lines.extend(_render_block("Text:", assistant.get("text", "")))
    for step in _as_json_list(assistant.get("steps")):
        _render_markdown_step(lines, step)
    lines.append("")


def _render_markdown_turn(lines: list[str], turn: JsonDict) -> None:
    lines.append(f"## Turn {turn['index']}")
    lines.append(f"- Duration: {turn['duration']}")
    lines.extend(_render_block("System Prompt:", turn.get("systemPrompt", "")))
    lines.extend(_render_block("Prompt:", turn.get("userPrompt", "")))
    assistant_list = _as_json_list(turn.get("assistantMessages"))
    if not assistant_list:
        lines.append("- Assistant messages: 0")
        lines.append("")
        return
    lines.append(f"- Assistant messages: {len(assistant_list)}")
    lines.append("")
    for assistant in assistant_list:
        _render_markdown_assistant(lines, assistant)
    lines.append("")


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
        if isinstance(turn, dict):
            _render_markdown_turn(lines, turn)
    return "\n".join(lines).rstrip() + "\n"


def load_transcript_export(path: str | Path) -> JsonDict:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise TranscriptRenderError("Transcript export root must be a JSON object.")
    return payload
