from __future__ import annotations

import logging
from typing import Any, Dict, List, Sequence

import pytest

from actions import ActionValidationError, Actions  # type: ignore  # noqa: E402

class RecordingBridge:
    """テスト用に送信内容を記録する簡易 WebSocket ブリッジ。"""

    def __init__(self, response: Dict[str, Any] | None = None) -> None:
        self.sent: List[Dict[str, Any]] = []
        self.send_kwargs: List[Dict[str, Any]] = []
        self.response = response or {"ok": True, "marker": "test"}

    async def send(self, payload: Dict[str, Any], **_: Any) -> Dict[str, Any]:  # noqa: D401 - テスト用スタブ
        self.sent.append(payload)
        self.send_kwargs.append(dict(_))
        return self.response | {"echo": payload}

class ScriptedBridge(RecordingBridge):
    """送信ごとに異なるレスポンスを返すブリッジ。"""

    def __init__(self, responses: Sequence[Dict[str, Any]]) -> None:
        super().__init__()
        self._responses = list(responses)

    async def send(self, payload: Dict[str, Any], **_: Any) -> Dict[str, Any]:
        self.sent.append(payload)
        self.send_kwargs.append(dict(_))
        if self._responses:
            response = self._responses.pop(0)
        else:
            response = {"ok": True}
        return response | {"echo": payload}

@pytest.mark.anyio
async def test_mine_blocks_payload() -> None:
    bridge = RecordingBridge()
    actions = Actions(bridge)

    result = await actions.mine_blocks([{"x": 1, "y": 64, "z": -3}])

    assert bridge.sent[-1] == {
        "type": "mineBlocks",
        "args": {"positions": [{"x": 1, "y": 64, "z": -3}]},
    }
    assert result["ok"] is True

@pytest.mark.anyio
async def test_place_block_payload_with_face() -> None:
    bridge = RecordingBridge()
    actions = Actions(bridge)

    await actions.place_block("oak_planks", {"x": 2, "y": 65, "z": 5}, face="north", sneak=True)

    assert bridge.sent[-1] == {
        "type": "placeBlock",
        "args": {
            "block": "oak_planks",
            "position": {"x": 2, "y": 65, "z": 5},
            "sneak": True,
            "face": "north",
        },
    }

@pytest.mark.anyio
async def test_follow_player_payload() -> None:
    bridge = RecordingBridge()
    actions = Actions(bridge)

    await actions.follow_player("Taishi", stop_distance=4, maintain_line_of_sight=False)

    assert bridge.sent[-1] == {
        "type": "followPlayer",
        "args": {"target": "Taishi", "stopDistance": 4, "maintainLineOfSight": False},
    }


@pytest.mark.anyio
async def test_follow_player_uses_long_recv_timeout_without_give_up_callback() -> None:
    bridge = RecordingBridge()
    give_up_called = False

    async def on_give_up(_: int, __: str) -> None:
        nonlocal give_up_called
        give_up_called = True

    actions = Actions(bridge, on_bridge_give_up=on_give_up)

    await actions.follow_player("Taishi")

    assert bridge.sent[-1]["type"] == "followPlayer"
    assert bridge.send_kwargs[-1]["recv_timeout"] == 210.0
    assert bridge.send_kwargs[-1]["on_give_up"] is None
    assert bridge.send_kwargs[-1]["on_retry"] is None
    assert give_up_called is False


@pytest.mark.anyio
async def test_follow_player_fails_closed_when_worker_timeout_is_too_short() -> None:
    bridge = RecordingBridge()
    actions = Actions(bridge, worker_task_timeout_seconds=239.0)

    result = await actions.follow_player("Taishi")

    assert result == {"ok": False, "error": "rendezvous_worker_timeout_mismatch"}
    assert bridge.sent == []


@pytest.mark.anyio
async def test_follow_player_logs_hide_target_payload_and_raw_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bridge = RecordingBridge(response={"ok": False, "error": "rendezvous_busy", "message": "raw"})
    actions = Actions(bridge)

    with caplog.at_level(logging.INFO, logger="actions"):
        await actions.follow_player("SecretTarget")

    messages = [record.getMessage() for record in caplog.records]
    assert all("SecretTarget" not in message for message in messages)
    assert all('"target"' not in message for message in messages)
    assert all("raw" not in message for message in messages)

@pytest.mark.anyio
async def test_attack_entity_mode_validation() -> None:
    bridge = RecordingBridge()
    actions = Actions(bridge)

    with pytest.raises(ActionValidationError):
        await actions.attack_entity("zombie", mode="invalid")

@pytest.mark.anyio
async def test_craft_item_payload() -> None:
    bridge = RecordingBridge()
    actions = Actions(bridge)

    await actions.craft_item("oak_planks", amount=3, use_crafting_table=False)

    assert bridge.sent[-1] == {
        "type": "craftItem",
        "args": {"item": "oak_planks", "amount": 3, "useCraftingTable": False},
    }

@pytest.mark.anyio
async def test_dispatch_outputs_structured_log(caplog: pytest.LogCaptureFixture) -> None:
    bridge = RecordingBridge()
    actions = Actions(bridge)

    with caplog.at_level(logging.INFO, logger="actions"):
        await actions.say("進捗ログ")

    # 進捗と完了の両方が出力されることを期待する。
    progress = [record for record in caplog.records if getattr(record, "event_level", "") == "progress"]
    completed = [record for record in caplog.records if getattr(record, "event_level", "") == "success"]
    assert progress, "dispatch prepared ログが出力されていません"
    assert completed, "dispatch completed ログが出力されていません"

@pytest.mark.anyio
async def test_validate_positions_rejects_empty() -> None:
    bridge = RecordingBridge()
    actions = Actions(bridge)

    with pytest.raises(ActionValidationError):
        await actions.mine_blocks([])

@pytest.mark.anyio
async def test_execute_hybrid_action_uses_vpt_when_available() -> None:
    bridge = RecordingBridge()
    actions = Actions(bridge)

    result = await actions.execute_hybrid_action(
        vpt_actions=[{"kind": "wait", "durationTicks": 1}],
        fallback_command=None,
        metadata={"source": "test"},
    )

    assert result["executor"] == "vpt"
    assert bridge.sent[-1]["type"] == "playVptActions"

@pytest.mark.anyio
async def test_execute_hybrid_action_falls_back_to_command() -> None:
    bridge = ScriptedBridge(
        [
            {"ok": False, "error": "disabled"},
            {"ok": True},
        ]
    )
    actions = Actions(bridge)

    result = await actions.execute_hybrid_action(
        vpt_actions=[{"kind": "wait", "durationTicks": 1}],
        fallback_command={"type": "moveTo", "args": {"x": 1, "y": 64, "z": 1}},
    )

    assert result["executor"] == "command"
    assert len(bridge.sent) == 2
    assert bridge.sent[-1]["type"] == "moveTo"

@pytest.mark.anyio
async def test_execute_hybrid_action_requires_payloads() -> None:
    bridge = RecordingBridge()
    actions = Actions(bridge)

    with pytest.raises(ActionValidationError):
        await actions.execute_hybrid_action(vpt_actions=None)
