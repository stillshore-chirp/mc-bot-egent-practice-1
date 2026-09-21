"""ChatPipeline の deterministic routing とチャット重複防止を検証する。"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

import pytest

from chat_pipeline import ChatPipeline  # type: ignore  # noqa: E402
from agent import AgentOrchestrator  # type: ignore  # noqa: E402
from memory import Memory  # type: ignore  # noqa: E402
from planner import PlanOut  # type: ignore  # noqa: E402
from runtime.action_graph import ChatTask  # type: ignore  # noqa: E402


class _Memory:
    def __init__(self) -> None:
        self.values: Dict[str, Any] = {}

    def set(self, key: str, value: Any) -> None:
        self.values[key] = value

    def get(self, key: str, default: Any = None) -> Any:
        return self.values.get(key, default)


class _Status:
    def __init__(self, failures: List[str] | None = None) -> None:
        self.failures = failures or []

    async def prime_status_for_planning(self) -> List[str]:
        return self.failures

    def build_context_snapshot(self, *, current_role_id: str) -> Dict[str, Any]:
        return {"active_role": current_role_id}


class _Role:
    current_role = "generalist"


class _MineDojo:
    async def maybe_trigger_autorecovery(self, plan_out: PlanOut) -> bool:
        return False


class _Actions:
    def __init__(self) -> None:
        self.say_messages: List[str] = []

    async def say(self, message: str) -> Dict[str, bool]:
        self.say_messages.append(message)
        return {"ok": True}


class _IntegrationActions(_Actions):
    """実AgentOrchestrator経路で状態取得とfollowPlayerを記録するスタブ。"""

    def __init__(self) -> None:
        super().__init__()
        self.follow_calls: List[str] = []
        self.follow_response: Dict[str, Any] = {"ok": True}

    async def gather_status(self, kind: str) -> Dict[str, Any]:
        if kind == "position":
            return {
                "ok": True,
                "data": {"x": 10, "y": 64, "z": -5, "dimension": "overworld"},
            }
        if kind == "inventory":
            return {"ok": True, "data": {"items": [], "pickaxes": []}}
        return {"ok": True, "data": {"health": 20, "food": 20}}

    async def follow_player(self, target_name: str, **_: Any) -> Dict[str, Any]:
        self.follow_calls.append(target_name)
        return self.follow_response


class _Agent:
    def __init__(self, *, status_failures: List[str] | None = None) -> None:
        self.memory = _Memory()
        self.status_service = _Status(status_failures)
        self.role_perception = _Role()
        self.minedojo_handler = _MineDojo()
        self.actions = _Actions()
        self.logger = logging.getLogger("test.chat_pipeline")
        self.executed: List[PlanOut] = []

    async def _collect_block_evaluations(self) -> None:
        return None

    def _extract_coordinates(self, _: str) -> None:
        return None

    def _extract_argument_coordinates(self, _: Any) -> None:
        return None

    def _record_plan_summary(self, _: PlanOut) -> None:
        return None

    async def _execute_plan(self, plan_out: PlanOut, *, initial_target: Any = None) -> None:
        self.executed.append(plan_out)


@pytest.mark.anyio
async def test_clear_come_here_bypasses_planner_and_uses_chat_sender(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """come here は planner の座標確認に依存せず、話者付き計画を作る。"""

    async def unexpected_plan(*_: Any, **__: Any) -> PlanOut:
        raise AssertionError("明確な呼び寄せでは planner を呼ばない")

    monkeypatch.setattr("chat_pipeline.plan", unexpected_plan)
    caplog.set_level(logging.INFO, logger="test.chat_pipeline")
    agent = _Agent()

    await ChatPipeline(agent).run_chat_task(ChatTask("speaker", "come here"))

    assert agent.memory.get("last_requester") == "speaker"
    assert len(agent.executed) == 1
    assert agent.executed[0].intent == "move_to_player"
    assert agent.executed[0].plan == ["話者に合流する"]
    assert agent.actions.say_messages == [
        "呼びかけを受けました。合流できるか確認します。"
    ]
    route_records = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("deterministic route=")
    ]
    assert route_records == ["deterministic route=move_to_player"]
    plan_records = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("plan generated route=")
    ]
    assert plan_records == ["plan generated route=move_to_player steps=1"]
    assert all("come here" not in record.getMessage() for record in caplog.records)


@pytest.mark.anyio
async def test_chat_confirmation_response_is_not_sent_before_plan_executor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """chat 遷移時の resp は PlanExecutor 側だけが送信する契約を固定する。"""

    async def fake_plan(*_: Any, **__: Any) -> PlanOut:
        return PlanOut(
            resp="対象を確認してください。",
            blocking=True,
            clarification_needed="data_gap",
            next_action="chat",
        )

    monkeypatch.setattr("chat_pipeline.plan", fake_plan)
    agent = _Agent()

    await ChatPipeline(agent).run_chat_task(ChatTask("speaker", "曖昧な指示"))

    # このスタブは PlanExecutor を呼ばないため、pipeline が二重送信しない
    # ことだけを観測する。PlanExecutor 側の単一送信は専用テストで担保する。
    assert agent.actions.say_messages == []


@pytest.mark.anyio
async def test_come_here_stops_before_follow_when_status_preflight_fails() -> None:
    """安全観測が失敗した呼び寄せは、追従せず結果通知を一度だけ送る。"""

    agent = _Agent(status_failures=["position"])

    await ChatPipeline(agent).run_chat_task(ChatTask("speaker", "come here"))

    assert agent.actions.say_messages == [
        "周囲の状態を確認できないため、安全に合流できません。接続状況を確認してから、もう一度呼びかけてください。"
    ]
    assert agent.executed == []


@pytest.mark.anyio
async def test_plan_executor_sends_confirmation_response_once() -> None:
    """confirmation/chat 分岐は PlanExecutor の単一送信だけを行う。"""

    actions = _Actions()
    orchestrator = AgentOrchestrator(actions, Memory())
    plan_out = PlanOut(
        resp="対象を確認してください。",
        blocking=True,
        clarification_needed="data_gap",
        next_action="chat",
    )

    await orchestrator._execute_plan(plan_out)

    assert actions.say_messages == ["対象を確認してください。"]


@pytest.mark.anyio
async def test_come_here_reaches_follow_player_once_through_real_orchestrator(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """入口から実AgentOrchestratorのActionGraphまで話者追従を通す。"""

    actions = _IntegrationActions()
    orchestrator = AgentOrchestrator(actions, Memory())
    caplog.set_level(logging.INFO)

    async def no_block_evaluations() -> None:
        return None

    monkeypatch.setattr(
        orchestrator,
        "_collect_block_evaluations",
        no_block_evaluations,
    )

    await orchestrator._process_chat(ChatTask("speaker", "come here"))

    assert actions.follow_calls == ["speaker"]
    assert actions.say_messages == [
        "呼びかけを受けました。合流できるか確認します。",
        "speaker さんに合流しました。",
    ]
    assert all("come here" not in record.getMessage() for record in caplog.records)
    assert all("speaker" not in record.getMessage() for record in caplog.records)


@pytest.mark.anyio
async def test_come_here_ack_precedes_safe_failure_notice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """即時失敗でも、受理確認と失敗結果を同じ文言にせず一度ずつ送る。"""

    actions = _IntegrationActions()
    actions.follow_response = {
        "ok": False,
        "error": "rendezvous_target_offline",
        "detail": "private node detail",
    }
    orchestrator = AgentOrchestrator(actions, Memory())
    reflection_results: List[Dict[str, Any]] = []

    def record_reflection(**kwargs: Any) -> None:
        reflection_results.append(kwargs)

    orchestrator._plan_executor.memory.finalize_pending_reflection = record_reflection  # type: ignore[method-assign]

    async def no_block_evaluations() -> None:
        return None

    monkeypatch.setattr(
        orchestrator,
        "_collect_block_evaluations",
        no_block_evaluations,
    )

    await orchestrator._process_chat(ChatTask("speaker", "come here"))

    assert actions.follow_calls == ["speaker"]
    assert actions.say_messages == [
        "呼びかけを受けました。合流できるか確認します。",
        "対象プレイヤーが現在オンラインでないため、合流できません。対象が参加してから、もう一度呼びかけてください。",
    ]
    assert reflection_results[-1]["outcome"] == "failed"


@pytest.mark.anyio
async def test_relayed_chat_rephrased_as_come_here_cannot_follow_sender(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """元発話が伝言なら、LLMのcome here言い換え後もfollowPlayerへ進まない。"""

    actions = _IntegrationActions()
    orchestrator = AgentOrchestrator(actions, Memory())
    caplog.set_level(logging.INFO)

    async def no_block_evaluations() -> None:
        return None

    async def relayed_plan(*_: Any, **__: Any) -> PlanOut:
        return PlanOut(plan=["come here"], intent="move_to_player")

    monkeypatch.setattr(orchestrator, "_collect_block_evaluations", no_block_evaluations)
    monkeypatch.setattr("chat_pipeline.plan", relayed_plan)

    await orchestrator._process_chat(ChatTask("speaker", "tell Alex to come here"))

    assert actions.follow_calls == []
    assert actions.say_messages == [
        "別のプレイヤーへの伝言または来訪を望まない発話として解釈されたため、合流を開始しません。直接呼びかける場合は「ここに来て」と送ってください。"
    ]
    assert all("tell Alex to come here" not in record.getMessage() for record in caplog.records)
    assert all("speaker" not in record.getMessage() for record in caplog.records)
    assert all("Alex" not in record.getMessage() for record in caplog.records)


@pytest.mark.anyio
async def test_relayed_move_plan_suppresses_initial_resp_before_safe_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """伝言をmove_to_playerへ誤昇格した計画でも通知を一意にする。"""

    actions = _IntegrationActions()
    orchestrator = AgentOrchestrator(actions, Memory())

    async def no_block_evaluations() -> None:
        return None

    async def relayed_plan(*_: Any, **__: Any) -> PlanOut:
        return PlanOut(
            plan=["come here"],
            intent="move_to_player",
            resp="Alexさんへ伝えます。",
        )

    monkeypatch.setattr(orchestrator, "_collect_block_evaluations", no_block_evaluations)
    monkeypatch.setattr("chat_pipeline.plan", relayed_plan)

    await orchestrator._process_chat(ChatTask("speaker", "tell Alex to come here"))

    assert actions.follow_calls == []
    assert actions.say_messages == [
        "別のプレイヤーへの伝言または来訪を望まない発話として解釈されたため、合流を開始しません。直接呼びかける場合は「ここに来て」と送ってください。"
    ]


def test_memory_sensitive_chat_values_are_redacted_from_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    memory = Memory()

    with caplog.at_level(logging.INFO, logger="memory"):
        memory.set("last_requester", "SecretPlayer")
        memory.set("_active_chat_message", "come here with private context")
        memory.set(
            "last_chat",
            {"username": "SecretPlayer", "message": "come here with private context"},
        )

    messages = [record.getMessage() for record in caplog.records]
    assert all("SecretPlayer" not in message for message in messages)
    assert all("private context" not in message for message in messages)
    assert any("'category': 'chat_speaker'" in message for message in messages)
    assert any("'category': 'chat_source'" in message for message in messages)
    assert any("'category': 'chat_record'" in message for message in messages)
