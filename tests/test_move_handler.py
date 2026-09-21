# -*- coding: utf-8 -*-
"""move_handler モジュールの単体テスト。"""
import asyncio
from typing import Any, Dict, Optional, Tuple

import pytest

from services.movement_service import MovementResult
from runtime.move_handler import handle_move

class DummyOrchestrator:
    """移動ハンドラが参照する orchestrator API を最小限で模倣するテスト用スタブ。"""

    def __init__(self):
        self._reported: Dict[str, str] = {}
        self._move_requests: Tuple[Tuple[int, int, int], ...] = tuple()
        self.low_food_threshold = 4
        self.default_move_target: Optional[Tuple[int, int, int]] = None
        self._extracted: Optional[Tuple[int, int, int]] = None
        self._move_response: Tuple[bool, Optional[str]] = (True, None)
        self.movement_service = self._build_movement_service()

    def _extract_coordinates(self, step: str):
        return self._extracted

    def _build_movement_service(self) -> Any:
        orchestrator = self

        class _StubMovementService:
            def __init__(self) -> None:
                self._stub_orchestrator = orchestrator

            async def report_execution_barrier(self, step: str, reason: str) -> None:
                orchestrator._reported[step] = reason

            async def move_to_coordinates(self, target: Tuple[int, int, int]) -> MovementResult:
                orchestrator._move_requests += (target,)
                ok, error = orchestrator._move_response
                return MovementResult(
                    ok=ok,
                    destination=target,
                    error_detail=error,
                    raw_response={"ok": ok, "error": error},
                )

        return _StubMovementService()

class MemoryStub:
    def __init__(self, data: Optional[Dict[str, Any]] = None) -> None:
        self._data = data or {}

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

class FollowOrchestrator(DummyOrchestrator):
    """追従コマンド経由で move_to_player を検証するスタブ。"""

    def __init__(self):
        super().__init__()
        self.memory = MemoryStub({"last_requester": "targetUser"})
        self.follow_calls = []
        self.say_messages = []
        self.follow_response: Dict[str, Any] = {"ok": True}

        class _Actions:
            def __init__(self, outer: "FollowOrchestrator") -> None:
                self._outer = outer

            async def follow_player(self, target_name: str) -> Dict[str, Any]:
                self._outer.follow_calls.append(target_name)
                return self._outer.follow_response

            async def say(self, message: str) -> Dict[str, Any]:
                self._outer.say_messages.append(message)
                return {"ok": True}

        self.actions = _Actions(self)

def test_handle_move_uses_explicit_coordinates():
    orchestrator = DummyOrchestrator()
    state: Dict[str, Any] = {
        "step": "座標へ移動",
        "explicit_coords": (1, 2, 3),
        "last_target_coords": (9, 9, 9),
        "backlog": [],
        "role_transitioned": False,
        "perception_history": [],
    }

    result = asyncio.run(handle_move(state, orchestrator))

    assert result == {"handled": True, "updated_target": (1, 2, 3), "failure_detail": None}
    assert orchestrator._move_requests == ((1, 2, 3),)
    assert orchestrator._reported == {}

def test_handle_move_falls_back_to_default_and_reports_barrier():
    orchestrator = DummyOrchestrator()
    orchestrator.default_move_target = (5, 5, 5)
    orchestrator._move_response = (True, None)
    orchestrator._extracted = None
    state: Dict[str, Any] = {
        "step": "どこかへ移動",
        "explicit_coords": None,
        "last_target_coords": None,
        "backlog": [],
        "role_transitioned": False,
        "perception_history": [],
    }

    result = asyncio.run(handle_move(state, orchestrator))

    assert result == {"handled": True, "updated_target": (5, 5, 5), "failure_detail": None}
    assert orchestrator._move_requests == ((5, 5, 5),)
    assert "どこかへ移動" in orchestrator._reported
    assert "既定座標" in orchestrator._reported["どこかへ移動"]

def test_handle_move_adds_backlog_when_hungry_and_role_changed():
    orchestrator = DummyOrchestrator()
    orchestrator._extracted = (2, 0, -1)
    orchestrator._move_response = (True, None)
    state: Dict[str, Any] = {
        "step": "移動して食料確認",
        "explicit_coords": None,
        "last_target_coords": None,
        "backlog": [],
        "role_transitioned": True,
        "active_role": "builder",
        "role_transition_reason": "緊急対応",
        "perception_history": [
            {"food_level": 2, "weather": "rainy"},
        ],
    }

    result = asyncio.run(handle_move(state, orchestrator))

    assert result["handled"] is True
    assert len(state["backlog"]) == 2
    hunger_entry = next(item for item in state["backlog"] if item["category"] == "status")
    assert hunger_entry["food_level"] == 2
    role_entry = next(item for item in state["backlog"] if item["category"] == "role")
    assert role_entry["role"] == "builder"

def test_handle_move_returns_failure_when_move_rejected():
    orchestrator = DummyOrchestrator()
    orchestrator._extracted = (0, 0, 0)
    orchestrator._move_response = (False, "blocked")
    state: Dict[str, Any] = {
        "step": "失敗する移動",
        "explicit_coords": None,
        "last_target_coords": (7, 7, 7),
        "backlog": [],
        "role_transitioned": False,
        "perception_history": [],
    }

    result = asyncio.run(handle_move(state, orchestrator))

    assert result["handled"] is False
    assert result["updated_target"] == (7, 7, 7)
    assert "blocked" in result["failure_detail"]

def test_handle_move_follows_last_requester_when_state_missing_target():
    orchestrator = FollowOrchestrator()
    state: Dict[str, Any] = {
        "step": "ここに来て",
        "category": "move_to_player",
        "explicit_coords": (99, 99, 99),  # 明示座標があっても follow を優先する
        "last_target_coords": None,
        "backlog": [],
        "role_transitioned": False,
        "perception_history": [{"position": {"x": 0, "y": 64, "z": 0}}],
    }

    result = asyncio.run(handle_move(state, orchestrator))

    assert result == {"handled": True, "updated_target": (0, 64, 0), "failure_detail": None}
    assert orchestrator.follow_calls == ["targetUser"]
    assert orchestrator._move_requests == tuple()
    assert orchestrator.say_messages == ["targetUser さんに合流しました。"]
    assert "X=" not in orchestrator.say_messages[0]


def test_handle_move_maps_rendezvous_error_without_exposing_raw_details():
    orchestrator = FollowOrchestrator()
    orchestrator.follow_response = {
        "ok": False,
        "error": "rendezvous_no_path",
        "detail": "raw path and coordinates must not be shown",
    }
    state: Dict[str, Any] = {
        "step": "ここに来て",
        "category": "move_to_player",
        "explicit_coords": None,
        "last_target_coords": None,
        "backlog": [],
        "role_transitioned": False,
        "perception_history": [],
    }

    result = asyncio.run(handle_move(state, orchestrator))

    assert result["handled"] is False
    assert result["failure_detail"] == (
        "対象まで安全な経路を見つけられませんでした。対象の近くで再度呼びかけてください。"
    )
    assert orchestrator.say_messages == [result["failure_detail"]]
    assert "raw" not in orchestrator.say_messages[0]
    assert "coordinates" not in orchestrator.say_messages[0]


@pytest.mark.parametrize(
    ("error_code", "expected_message"),
    (
        (
            "rendezvous_busy",
            "別の合流処理が進行中のため、今回は合流を開始できません。処理が終わってから、もう一度呼びかけてください。",
        ),
        (
            "rendezvous_target_offline",
            "対象プレイヤーが現在オンラインでないため、合流できません。対象が参加してから、もう一度呼びかけてください。",
        ),
        (
            "rendezvous_position_service_unavailable",
            "対象プレイヤーの位置情報を取得できないため、安全な移動を開始できません。しばらく待ってから、もう一度呼びかけてください。",
        ),
        (
            "rendezvous_observation_unavailable",
            "周辺の安全情報を取得できないため、安全を確認できず移動を停止しました。しばらく待ってから、もう一度呼びかけてください。",
        ),
        (
            "rendezvous_line_of_sight_unsupported",
            "対象の視線確認を利用できないため、今回は移動を開始しません。Bot設定を確認してから、もう一度呼びかけてください。",
        ),
        (
            "rendezvous_distance_limit",
            "対象までの距離が安全な上限を超えているため、合流を完了できませんでした。対象の近くで再度呼びかけてください。",
        ),
        (
            "recv_timeout",
            "合流結果を確認できません。Botの接続・動作状況を確認してから、もう一度呼びかけてください。",
        ),
        (
            "recv_error",
            "合流結果を確認できません。Botの接続・動作状況を確認してから、もう一度呼びかけてください。",
        ),
        (
            "connect_refused",
            "合流結果を確認できません。Botの接続・動作状況を確認してから、もう一度呼びかけてください。",
        ),
    ),
)
def test_handle_move_maps_each_rendezvous_service_error(
    error_code: str, expected_message: str
) -> None:
    """Node固定enumを、原因に応じた安全な回復案へ変換する。"""

    orchestrator = FollowOrchestrator()
    orchestrator.follow_response = {
        "ok": False,
        "error": error_code,
        "detail": "internal service detail must stay private",
    }
    state: Dict[str, Any] = {
        "step": "ここに来て",
        "category": "move_to_player",
        "explicit_coords": None,
        "last_target_coords": None,
        "backlog": [],
        "role_transitioned": False,
        "perception_history": [],
    }

    result = asyncio.run(handle_move(state, orchestrator))

    assert result["handled"] is False
    assert result["failure_detail"] == expected_message
    assert orchestrator.say_messages == [expected_message]
    assert "internal" not in expected_message
