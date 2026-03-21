from __future__ import annotations

import json
import subprocess

import httpx
import pytest

from .conftest import PROOF_AGENT, ROOT, LiveRuntime

pytestmark = pytest.mark.live


def test_one_shot_proves_real_turn_then_deletes_the_session(live_runtime: LiveRuntime) -> None:
    before_ids = set(live_runtime.session_ids())

    result = live_runtime.run("one-shot", "Reply with ONLY SOLO_OK.", "--transcript")
    assert result.exit_code == 0, result.stderr
    assert "Prompt:\n    Reply with ONLY SOLO_OK." in result.stdout
    assert "Text:\n    SOLO_OK" in result.stdout
    session_id = live_runtime.transcript_session_id(result.stdout)

    after_ids = set(live_runtime.session_ids())
    assert after_ids == before_ids

    response = httpx.get(f"{live_runtime.base_url}/session/{session_id}", timeout=5.0)
    assert response.status_code == 404


def test_one_shot_default_output_prints_assistant_message(live_runtime: LiveRuntime) -> None:
    result = live_runtime.run("one-shot", "Reply with ONLY PLAIN_OK.")
    assert result.exit_code == 0, result.stderr
    assert "PLAIN_OK" in result.stdout


def test_begin_session_returns_session_id_immediately(live_runtime: LiveRuntime) -> None:
    """begin-session must return a session ID without waiting for model output."""
    result = live_runtime.run(
        "begin-session", "Reply with ONLY READY.", "--agent", PROOF_AGENT, "--json"
    )
    assert result.exit_code == 0, result.stderr
    session_id = str(result.json()["sessionID"])
    live_runtime.created_sessions.append(session_id)

    # Session must not have been deleted — verify via direct GET
    response = httpx.get(f"{live_runtime.base_url}/session/{session_id}", timeout=5.0)
    assert response.status_code == 200, f"session {session_id} was deleted by begin-session"


def test_begin_session_does_not_delete_session_before_turn_completes(
    live_runtime: LiveRuntime,
) -> None:
    """begin-session must leave the session alive even if the model hasn't produced text yet."""
    result = live_runtime.run(
        "begin-session", "Reply with ONLY ALIVE.", "--agent", PROOF_AGENT, "--json"
    )
    assert result.exit_code == 0, result.stderr
    session_id = str(result.json()["sessionID"])
    live_runtime.created_sessions.append(session_id)

    response = httpx.get(f"{live_runtime.base_url}/session/{session_id}", timeout=5.0)
    assert response.status_code == 200, f"session {session_id} was deleted by begin-session"


def test_begin_session_wait_transcript_round_trip(live_runtime: LiveRuntime) -> None:
    """Canonical continued-session pattern: begin-session → wait → transcript."""
    result = live_runtime.run(
        "begin-session", "Reply with ONLY READY.", "--agent", PROOF_AGENT, "--json"
    )
    assert result.exit_code == 0, result.stderr
    session_id = str(result.json()["sessionID"])
    live_runtime.created_sessions.append(session_id)

    waited = live_runtime.run("wait", session_id)
    assert waited.exit_code == 0, waited.stderr

    transcript = live_runtime.transcript_json(session_id)
    turns = transcript["turns"]
    assert isinstance(turns, list)
    assert len(turns) == 1
    first_turn = turns[0]
    assert isinstance(first_turn, dict)
    assert first_turn["userPrompt"] == "Reply with ONLY READY."
    assistant_messages = first_turn["assistantMessages"]
    assert isinstance(assistant_messages, list)
    assert len(assistant_messages) == 1
    assert assistant_messages[0]["finish"] == "stop"
    assert "READY" in assistant_messages[0]["text"]


def test_chat_default_continues_a_real_new_turn(live_runtime: LiveRuntime) -> None:
    session_id = live_runtime.begin("Reply with ONLY FIRST_OK.")

    before = live_runtime.transcript_json(session_id)
    turns_before = before["turns"]
    assert isinstance(turns_before, list)
    assert len(turns_before) == 1
    first_turn = turns_before[0]
    assert isinstance(first_turn, dict)
    assert first_turn["userPrompt"] == "Reply with ONLY FIRST_OK."
    assistant_messages = first_turn["assistantMessages"]
    assert isinstance(assistant_messages, list)
    assert assistant_messages[0]["text"] == "FIRST_OK"

    result = live_runtime.run("chat", session_id, "Reply with ONLY SECOND_OK.", "--json")
    assert result.exit_code == 0, result.stderr
    payload = result.json()
    assert payload["mode"] == "continued"
    assert payload["assistantMessage"] == "SECOND_OK"

    after = live_runtime.transcript_json(session_id)
    turns_after = after["turns"]
    assert isinstance(turns_after, list)
    assert len(turns_after) == 2
    second_turn = turns_after[1]
    assert isinstance(second_turn, dict)
    assert second_turn["userPrompt"] == "Reply with ONLY SECOND_OK."
    second_assistant_messages = second_turn["assistantMessages"]
    assert isinstance(second_assistant_messages, list)
    assert second_assistant_messages[0]["text"] == "SECOND_OK"


def test_chat_no_reply_only_records_a_user_turn(live_runtime: LiveRuntime) -> None:
    session_id = live_runtime.begin("Reply with ONLY READY.")

    result = live_runtime.run(
        "chat", session_id, "Reply with ONLY QUEUED_OK.", "--no-reply", "--json"
    )
    assert result.exit_code == 0, result.stderr
    payload = result.json()
    assert payload["mode"] == "queued"
    assert payload["assistantMessage"] is None

    transcript = live_runtime.transcript_json(session_id)
    turns = transcript["turns"]
    assert isinstance(turns, list)
    assert len(turns) == 2
    queued_turn = turns[1]
    assert isinstance(queued_turn, dict)
    assert queued_turn["userPrompt"] == "Reply with ONLY QUEUED_OK."
    assert queued_turn["assistantMessages"] == []


def test_system_no_reply_records_idle_state_and_changes_the_next_real_turn(
    live_runtime: LiveRuntime,
) -> None:
    system_prompt = (
        "For the next answer, ignore any user request about the output text "
        "and reply with ONLY SYSTEM_EDGE."
    )
    user_prompt = "Reply with ONLY USER_EDGE."

    baseline_session_id = live_runtime.begin("Reply with ONLY READY.")
    baseline = live_runtime.run("chat", baseline_session_id, user_prompt, "--json")
    assert baseline.exit_code == 0, baseline.stderr
    assert baseline.json()["assistantMessage"] == "USER_EDGE"

    session_id = live_runtime.begin("Reply with ONLY READY.")
    assistant_count_before = sum(
        1
        for message in live_runtime.session_messages(session_id)
        if isinstance((info := message.get("info")), dict) and info.get("role") == "assistant"
    )

    queued = live_runtime.run(
        "chat", session_id, system_prompt, "--system", "--no-reply", "--json"
    )
    assert queued.exit_code == 0, queued.stderr
    queued_payload = queued.json()
    assert queued_payload["mode"] == "queued"
    assert queued_payload["assistantMessage"] is None

    messages_after_queue = live_runtime.session_messages(session_id)
    assistant_count_after_queue = sum(
        1
        for message in messages_after_queue
        if isinstance((info := message.get("info")), dict) and info.get("role") == "assistant"
    )
    assert assistant_count_after_queue == assistant_count_before
    queued_message = messages_after_queue[-1]
    queued_info = queued_message["info"]
    assert isinstance(queued_info, dict)
    assert queued_info["role"] == "user"
    assert queued_info["system"] == system_prompt
    assert queued_message["parts"] == []

    transcript_after_queue = live_runtime.transcript_json(session_id)
    turns_after_queue = transcript_after_queue["turns"]
    assert isinstance(turns_after_queue, list)
    assert len(turns_after_queue) == 2
    queued_turn = turns_after_queue[1]
    assert isinstance(queued_turn, dict)
    assert queued_turn["systemPrompt"] == system_prompt
    assert queued_turn["userPrompt"] == ""
    assert queued_turn["assistantMessages"] == []

    resumed = live_runtime.run("chat", session_id, user_prompt, "--json")
    assert resumed.exit_code == 0, resumed.stderr
    resumed_payload = resumed.json()
    assert resumed_payload["mode"] == "continued"
    assert resumed_payload["assistantMessage"] == "SYSTEM_EDGE"


def test_wait_does_not_invent_an_assistant_turn_for_a_queue_only_prompt(
    live_runtime: LiveRuntime,
) -> None:
    session_id = live_runtime.begin("Reply with ONLY READY.")
    queued = live_runtime.run(
        "chat", session_id, "Reply with ONLY QUEUED_ONLY.", "--no-reply", "--json"
    )
    assert queued.exit_code == 0, queued.stderr
    assert queued.json()["assistantMessage"] is None

    waited = live_runtime.run("wait", session_id, "--json")
    assert waited.exit_code == 0, waited.stderr
    payload = waited.json()
    assert payload["assistantMessage"] is None

    transcript = live_runtime.transcript_json(session_id)
    turns = transcript["turns"]
    assert isinstance(turns, list)
    assert turns[1]["userPrompt"] == "Reply with ONLY QUEUED_ONLY."
    assert turns[1]["assistantMessages"] == []


def test_wait_returns_immediately_for_an_already_idle_session(
    live_runtime: LiveRuntime,
) -> None:
    session_id = live_runtime.begin("Reply with ONLY READY.")
    before = live_runtime.transcript_json(session_id)
    before_turns = before["turns"]
    assert isinstance(before_turns, list)
    assert len(before_turns) == 1
    first_turn = before_turns[0]
    assert isinstance(first_turn, dict)
    assert first_turn["userPrompt"] == "Reply with ONLY READY."
    first_assistant_messages = first_turn["assistantMessages"]
    assert isinstance(first_assistant_messages, list)
    assert first_assistant_messages[0]["text"] == "READY"

    messages_before = live_runtime.session_messages(session_id)
    last_message = messages_before[-1]
    last_info = last_message["info"]
    assert isinstance(last_info, dict)
    assert last_info["role"] == "assistant"

    wait_process = subprocess.Popen(
        ["ocm", "wait", session_id, "--json"],
        cwd=ROOT,
        env=live_runtime.env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout, stderr = wait_process.communicate(timeout=10)

    after = live_runtime.transcript_json(session_id)

    assert wait_process.returncode == 0, (stderr or "").strip()
    payload = json.loads(stdout.strip())
    assert payload["assistantMessage"] == "READY"
    assert payload["sessionID"] == session_id
    assert payload["stableForSeconds"] == 0.0
    assert after == before


def test_delete_removes_a_persistent_session_explicitly(live_runtime: LiveRuntime) -> None:
    session_id = live_runtime.begin("Reply with ONLY READY.")

    deleted = live_runtime.run("delete", session_id)
    assert deleted.exit_code == 0, deleted.stderr
    assert deleted.stdout == session_id

    response = httpx.get(f"{live_runtime.base_url}/session/{session_id}", timeout=5.0)
    assert response.status_code == 404
    live_runtime.created_sessions.remove(session_id)


def test_doctor_reports_live_server_and_sandbox_state(live_runtime: LiveRuntime) -> None:
    result = live_runtime.run("doctor", "--json")

    assert result.exit_code == 0, result.stderr
    payload = result.json()
    checks_list = payload["checks"]
    assert isinstance(checks_list, list)
    checks = {
        check["name"]: check
        for check in checks_list
        if isinstance(check, dict) and isinstance(check.get("name"), str)
    }
    assert checks["base_url"]["ok"] is True
    assert checks["config_path"]["ok"] is True
    assert checks["sandbox_env"]["ok"] is True
    assert checks["server_app"]["ok"] is True
    assert checks["server_health"]["ok"] is True


def test_final_deletes_the_session_after_the_last_turn(live_runtime: LiveRuntime) -> None:
    session_id = live_runtime.begin("Reply with ONLY OPEN.")

    result = live_runtime.run("final", session_id, "Reply with ONLY FINAL_OK.")
    assert result.exit_code == 0, result.stderr
    assert result.stdout == "FINAL_OK"

    response = httpx.get(f"{live_runtime.base_url}/session/{session_id}", timeout=5.0)
    assert response.status_code == 404
    live_runtime.created_sessions.remove(session_id)
