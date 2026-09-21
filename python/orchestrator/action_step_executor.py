# -*- coding: utf-8 -*-
"""Action ステップの実行を専門化したモジュール。

PlanExecutor から切り出した行動タスクの分類・実行・ログ文言生成を一手に
引き受け、PlanExecutor.run 側の分岐を浅く保つ。新人メンバーが追いやすい
ように、戻り値へログレベルや目的地の更新結果を含めて呼び出し元の処理を
単純化する。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from orchestrator.directive_utils import directive_scope
from runtime.rules import ACTION_TASK_RULES


@dataclass
class ActionStepResult:
    """ActionStepExecutor が返すシンプルな結果コンテナ。"""

    handled: bool
    observation: str
    status: str
    event_level: str = "trace"
    log_level: int = logging.INFO
    last_target_coords: Optional[Tuple[int, int, int]] = None
    failure_reason: Optional[str] = None
    should_halt: bool = False
    terminal_failure: bool = False
    emit_log: bool = True


class ActionStepExecutor:
    """アクションステップ（移動・一般タスク・報告）を担当する協調クラス。"""

    def __init__(self, plan_executor: Any) -> None:  # type: ignore[valid-type]
        # PlanExecutor 経由で必要な依存へアクセスする。__getattr__ に頼らず
        # 明示的に参照を保持することで、依存がどこから来るのかを新人メンバー
        # が理解しやすいようにする。
        self._plan = plan_executor
        self._logger = plan_executor.logger
        self._actions = plan_executor.actions
        self._task_router = plan_executor.task_router
        self._default_move_target = plan_executor.default_move_target

    async def handle_step(
        self,
        step: str,
        directive_meta: Optional[Dict[str, Any]],
        directive_coords: Optional[Tuple[int, int, int]],
        last_target_coords: Optional[Tuple[int, int, int]],
        action_backlog: List[Dict[str, str]],
        *,
        directive_category: Optional[str] = None,
    ) -> Optional[ActionStepResult]:
        """単一ステップを分類・実行し、PlanExecutor が必要とする情報を返す。"""

        action_category = self._resolve_action_category(step, directive_category)
        if action_category:
            return await self._handle_action_task(
                step,
                action_category,
                directive_meta,
                directive_coords,
                last_target_coords,
                action_backlog,
            )

        if "報告" in step or "伝える" in step:
            return await self._handle_status_report(step, directive_meta)

        return None

    def _resolve_action_category(
        self, step: str, directive_category: Optional[str]
    ) -> Optional[str]:
        if directive_category and directive_category in ACTION_TASK_RULES:
            return directive_category
        return self._task_router.classify_action_task(step)

    async def _handle_action_task(
        self,
        step: str,
        action_category: str,
        directive_meta: Optional[Dict[str, Any]],
        directive_coords: Optional[Tuple[int, int, int]],
        last_target_coords: Optional[Tuple[int, int, int]],
        action_backlog: List[Dict[str, str]],
    ) -> ActionStepResult:
        """行動タスクを LangGraph 側へ委譲し、結果を整形して返す。"""

        self._logger.info(
            "plan_step classified as action_task category=%s",
            action_category,
        )
        explicit_coords = directive_coords if action_category in ("move", "move_to_player") else None
        with directive_scope(self._actions, directive_meta):
            handled, updated_target, failure_detail = await self._task_router.handle_action_task(
                action_category,
                step,
                last_target_coords=last_target_coords,
                backlog=action_backlog,
                explicit_coords=explicit_coords,
            )

        if handled:
            if action_category in ("move", "move_to_player"):
                if action_category == "move_to_player":
                    # followPlayer は座標をユーザーへ露出しない契約。到着結果は
                    # move 一般の座標観測ログとも分離する。
                    observation_text = "合流しました。"
                else:
                    destination = updated_target or self._default_move_target
                    if destination:
                        observation_text = (
                            f"移動成功: X={destination[0]} / Y={destination[1]} / Z={destination[2]}"
                        )
                    else:
                        observation_text = "移動に成功しました。"
            else:
                observation_text = f"{action_category} タスクを完了しました。"
            return ActionStepResult(
                handled=True,
                observation=observation_text,
                status="completed",
                event_level="progress",
                last_target_coords=updated_target,
                # move_to_player の成功は計画停止ではなく完了。should_halt は
                # PlanExecutor では失敗回復へ入る信号として扱われるため、
                # 成功時に立てると同じ指示を再計画してしまう。
                should_halt=False,
            )

        observation_text = (
            failure_detail
            or "Mineflayer からアクションが拒否され、残りの計画を進められませんでした。"
        )
        return ActionStepResult(
            handled=True,
            observation=observation_text,
            status="failed",
            event_level="fault",
            log_level=logging.WARNING,
            last_target_coords=updated_target,
            failure_reason=failure_detail
            or "Mineflayer からアクションが拒否され、残りの計画を進められませんでした。",
            # move_to_player は handle_move が安全な結果通知を既に1回送る。
            # RecoveryCoordinatorへ渡すと同じ障壁の再通知と自動replanが起きる。
            should_halt=action_category != "move_to_player",
            terminal_failure=action_category == "move_to_player",
        )

    async def _handle_status_report(
        self, step: str, directive_meta: Optional[Dict[str, Any]]
    ) -> ActionStepResult:
        """進捗報告を求められたステップに対してチャット送信を行う。"""

        with directive_scope(self._actions, directive_meta):
            await self._actions.say("進捗を確認しています。続報をお待ちください。")
        observation_text = "進捗報告メッセージを送信しました。"
        return ActionStepResult(
            handled=True,
            observation=observation_text,
            status="completed",
            event_level="progress",
        )


__all__ = ["ActionStepExecutor", "ActionStepResult"]
