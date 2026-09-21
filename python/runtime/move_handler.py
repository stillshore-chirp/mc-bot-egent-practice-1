# -*- coding: utf-8 -*-
"""移動系 LangGraph ノードの責務を集約した専用モジュール。"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple, TYPE_CHECKING


if TYPE_CHECKING:
    from agent import AgentOrchestrator


_RENDEZVOUS_USER_MESSAGES = {
    "rendezvous_invalid_args": "合流指示の対象を確認できません。対象プレイヤー名を確認して、もう一度呼びかけてください。",
    "rendezvous_worker_timeout_mismatch": "合流処理の実行時間設定が短いため、安全に開始できません。設定を確認してから、もう一度呼びかけてください。",
    "rendezvous_busy": "別の合流処理が進行中のため、今回は合流を開始できません。処理が終わってから、もう一度呼びかけてください。",
    "rendezvous_bot_unavailable": "Botが接続されていないため、合流を開始できません。接続を確認して、もう一度呼びかけてください。",
    "rendezvous_target_invalid": "対象プレイヤーを確認できないため、合流を開始できません。プレイヤー名を確認してください。",
    "rendezvous_target_unavailable": "対象プレイヤーを確認できないため、合流を開始できません。対象が同じワールドにいるか確認してください。",
    "rendezvous_target_offline": "対象プレイヤーが現在オンラインでないため、合流できません。対象が参加してから、もう一度呼びかけてください。",
    "rendezvous_position_service_unavailable": "対象プレイヤーの位置情報を取得できないため、安全な移動を開始できません。しばらく待ってから、もう一度呼びかけてください。",
    "rendezvous_dimension_unknown": "対象プレイヤーのワールドを確認できないため、安全のため移動を停止しました。",
    "rendezvous_dimension_mismatch": "対象プレイヤーと同じワールドにいないため、合流できません。",
    "rendezvous_observation_unavailable": "周辺の安全情報を取得できないため、安全を確認できず移動を停止しました。しばらく待ってから、もう一度呼びかけてください。",
    "rendezvous_hazard_blocked": "安全な経路を確保できないため、移動を停止しました。対象の近くで再度呼びかけてください。",
    "rendezvous_no_path": "対象まで安全な経路を見つけられませんでした。対象の近くで再度呼びかけてください。",
    "rendezvous_timeout": "合流処理が時間内に完了しませんでした。対象の近くで再度呼びかけてください。",
    "rendezvous_target_moved": "対象が移動したため、合流を完了できませんでした。対象の近くで再度呼びかけてください。",
    "rendezvous_arrival_unconfirmed": "合流先への到着を確認できませんでした。対象の近くで再度呼びかけてください。",
    "rendezvous_distance_limit": "対象までの距離が安全な上限を超えているため、合流を完了できませんでした。対象の近くで再度呼びかけてください。",
    "rendezvous_path_failed": "対象まで安全に移動できませんでした。周囲を確認して、もう一度呼びかけてください。",
    "rendezvous_line_of_sight_unsupported": "対象の視線確認を利用できないため、今回は移動を開始しません。Bot設定を確認してから、もう一度呼びかけてください。",
}
_RENDEZVOUS_UNCONFIRMED_MESSAGE = (
    "合流結果を確認できません。Botの接続・動作状況を確認してから、もう一度呼びかけてください。"
)
for _transport_error in (
    "recv_timeout",
    "recv_error",
    "recv_os_error",
    "connect_timeout",
    "connect_refused",
    "connect_error",
    "connect_os_error",
    "send_timeout",
    "send_error",
    "send_os_error",
):
    _RENDEZVOUS_USER_MESSAGES[_transport_error] = _RENDEZVOUS_UNCONFIRMED_MESSAGE
_DEFAULT_RENDEZVOUS_FAILURE_MESSAGE = (
    "対象プレイヤーへの合流に失敗しました。対象が同じワールドにいるか確認して、もう一度呼びかけてください。"
)


def _safe_rendezvous_failure(response: Any) -> str:
    """Node の固定error codeだけを利用し、raw errorをチャットへ出さない。"""

    if isinstance(response, dict):
        for key in ("errorCode", "code", "error"):
            value = response.get(key)
            if isinstance(value, str):
                message = _RENDEZVOUS_USER_MESSAGES.get(value.strip())
                if message:
                    return message
    return _DEFAULT_RENDEZVOUS_FAILURE_MESSAGE


async def handle_move(
    state: Dict[str, Any],
    orchestrator: "AgentOrchestrator",
) -> Dict[str, Any]:
    """座標推定・既定座標フォールバック・空腹時バックログ追記をまとめて処理する。"""

    step = state["step"]
    explicit_coords: Optional[Tuple[int, int, int]] = state.get("explicit_coords")
    last_target = state.get("last_target_coords")
    perception_history = state.get("perception_history") or []
    recent_perception = perception_history[-1] if perception_history else {}
    hunger_level = recent_perception.get("food_level")
    weather = recent_perception.get("weather")
    category = state.get("category", "")
    target_player = (state.get("target_player") or "").strip()
    if category == "move_to_player" and not target_player:
        memory = getattr(orchestrator, "memory", None)
        if memory and hasattr(memory, "get"):
            fallback_player = memory.get("last_requester")
            if isinstance(fallback_player, str):
                target_player = fallback_player.strip()
        if not target_player:
            await orchestrator.actions.say(  # type: ignore[attr-defined]
                "チャット送信者を特定できず、追従先を決定できませんでした。もう一度呼びかけてください。"
            )
            return {
                "handled": False,
                "updated_target": last_target,
                "failure_detail": "追従対象のプレイヤー名が不明です。",
            }
    current_pos = None
    if isinstance(recent_perception, dict):
        pos = recent_perception.get("position")
        if isinstance(pos, dict):
            x = pos.get("x")
            y = pos.get("y")
            z = pos.get("z")
            if all(isinstance(v, (int, float)) for v in (x, y, z)):
                current_pos = (int(x), int(y), int(z))

    # move_to_player はプレイヤー名が分かれば追従コマンドを優先する。
    if category == "move_to_player" and target_player:
        # action_analyzer は runtime.rules 経由で本モジュールを参照するため、
        # 循環importを避けて実行時に解決する。
        from orchestrator.action_analyzer import is_move_to_player_source_excluded

        memory = getattr(orchestrator, "memory", None)
        active_chat_message = memory.get("_active_chat_message") if memory else None
        if isinstance(active_chat_message, str) and is_move_to_player_source_excluded(
            active_chat_message
        ):
            blocked_message = (
                "別のプレイヤーへの伝言または来訪を望まない発話として解釈されたため、合流を開始しません。"
                "直接呼びかける場合は「ここに来て」と送ってください。"
            )
            await orchestrator.actions.say(blocked_message)  # type: ignore[attr-defined]
            return {
                "handled": False,
                "updated_target": last_target,
                "failure_detail": blocked_message,
            }
        follow_resp = await orchestrator.actions.follow_player(target_player)  # type: ignore[attr-defined]
        if isinstance(follow_resp, dict) and follow_resp.get("ok"):
            await orchestrator.actions.say(  # type: ignore[attr-defined]
                f"{target_player} さんに合流しました。"
            )
            return {
                "handled": True,
                "updated_target": current_pos or last_target,
                "failure_detail": None,
            }

        error_detail = _safe_rendezvous_failure(follow_resp)
        # Nodeの固定enumを安全文言へ変換済み。barrier報告は別のLLM通知を
        # 生成して二重送信や自動replanを招くため、ここでは結果を一度だけ送る。
        await orchestrator.actions.say(error_detail)  # type: ignore[attr-defined]
        return {
            "handled": False,
            "updated_target": last_target,
            "failure_detail": error_detail,
        }

    target = explicit_coords or orchestrator._extract_coordinates(step)  # type: ignore[attr-defined]
    if target is None:
        target = last_target
    used_default = False
    if target is None:
        target = orchestrator.default_move_target  # type: ignore[attr-defined]
        used_default = True
    if target is None:
        await orchestrator.movement_service.report_execution_barrier(  # type: ignore[attr-defined]
            step,
            "指示文から移動先の座標を特定できず、実行を継続できませんでした。文章に XYZ 形式の座標を含めてください。",
        )
        return {
            "handled": False,
            "updated_target": last_target,
            "failure_detail": "移動先の座標が不明です。",
        }

    move_result = await orchestrator.movement_service.move_to_coordinates(target)  # type: ignore[attr-defined]
    if used_default:
        await orchestrator.movement_service.report_execution_barrier(  # type: ignore[attr-defined]
            step,
            "指示文から移動先の座標を特定できず、既定座標へ退避しました。文章に XYZ 形式の座標を含めてください。",
        )
    if not move_result.ok:
        error_detail = move_result.error_detail or "Mineflayer 側で移動が拒否されました"
        return {
            "handled": False,
            "updated_target": last_target,
            "failure_detail": error_detail,
        }

    if category == "move_to_player":
        x, y, z = move_result.destination
        await orchestrator.actions.say(  # type: ignore[attr-defined]
            f"プレイヤー付近へ到着しました。現在位置は X={x} / Y={y} / Z={z} です。"
        )

    if isinstance(hunger_level, (int, float)) and hunger_level <= orchestrator.low_food_threshold:  # type: ignore[attr-defined]
        # LangGraph の後続ノードへ空腹度情報を渡し、食料補給のフォローアップを促す。
        state["backlog"].append(
            {
                "category": "status",
                "step": step,
                "label": "空腹度が低いため、食料補給を検討してください",
                "weather": weather,
                "food_level": hunger_level,
            }
        )

    if state.get("role_transitioned"):
        active_role = state.get("active_role", "")
        reason = state.get("role_transition_reason") or ""
        state["backlog"].append(
            {
                "category": "role",
                "step": step,
                "label": f"役割切替: {active_role or '不明'}",
                "module": "role",
                "role": active_role,
                "reason": reason,
            }
        )

    return {
        "handled": True,
        "updated_target": target,
        "failure_detail": None,
    }


__all__ = ["handle_move"]
