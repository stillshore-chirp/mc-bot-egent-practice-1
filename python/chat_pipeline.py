# -*- coding: utf-8 -*-
"""Chat processing and action handling pipeline."""

from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Optional, Tuple, TYPE_CHECKING

from orchestrator.action_analyzer import (
    is_move_to_player_command,
    is_move_to_player_source_excluded,
)
from planner import PlanOut, plan
from runtime.action_graph import ChatTask
from runtime.rules import ACTION_TASK_RULES, ORE_PICKAXE_REQUIREMENTS, PICKAXE_TIER_BY_NAME


_MOVE_TO_PLAYER_ACK = "呼びかけを受けました。合流できるか確認します。"

if TYPE_CHECKING:  # pragma: no cover - 型チェック専用の依存
    from agent import AgentOrchestrator


class ChatPipeline:
    """AgentOrchestrator から切り出したチャット処理フロー。"""

    def __init__(self, agent: "AgentOrchestrator") -> None:
        self._agent = agent

    async def run_chat_task(self, task: ChatTask) -> None:
        """単一のチャット指示に対して LLM 計画とアクション実行を行う。"""

        agent = self._agent
        deterministic_move_to_player = is_move_to_player_command(task.message)
        source_excluded_move_to_player = is_move_to_player_source_excluded(task.message)
        agent.memory.set("last_requester", task.username)
        failures = await agent.status_service.prime_status_for_planning()
        if failures:
            if deterministic_move_to_player:
                # 合流は安全観測なしに開始しない。通常プランの既存障壁通知は
                # 維持し、明確な呼び寄せだけ固定の一意な結果へまとめる。
                await agent.actions.say(
                    "周囲の状態を確認できないため、安全に合流できません。接続状況を確認してから、もう一度呼びかけてください。"
                )
                agent.memory.set("last_chat", {"username": task.username, "message": task.message})
                return
            await agent.movement_service.report_execution_barrier(
                "状態取得",
                f"{', '.join(failures)} の取得に失敗しました。Mineflayer への接続状況を確認してください。",
            )
        if deterministic_move_to_player:
            # 行動計画や重い周辺観測を待たせず、受理状態だけを先に一度通知する。
            await agent.actions.say(_MOVE_TO_PLAYER_ACK)
        await agent._collect_block_evaluations()
        context = agent.status_service.build_context_snapshot(
            current_role_id=agent.role_perception.current_role
        )
        if deterministic_move_to_player:
            agent.logger.info("deterministic route=move_to_player")
        elif source_excluded_move_to_player:
            agent.logger.info("deterministic route=blocked_source")
        else:
            agent.logger.info(
                "creating plan for username=%s message='%s' context=%s",
                task.username,
                task.message,
                context,
            )

        user_hint_coords = agent._extract_coordinates(task.message)
        if user_hint_coords:
            agent.logger.info("user message provided coordinates=%s", user_hint_coords)

        if deterministic_move_to_player:
            # 明確な呼び寄せは、座標を要求する LLM 確認へ流さず、チャット
            # 送信者を target_player として ActionGraph の followPlayer へ渡す。
            plan_out = PlanOut(
                # 元チャット本文をPlanExecutor/ReActログへ渡さない固定step。
                plan=["話者に合流する"],
                intent="move_to_player",
                goal_profile={
                    "summary": "発話したプレイヤーのもとへ移動",
                    "category": "move_to_player",
                },
            )
        else:
            plan_out = await plan(task.message, context)
        if source_excluded_move_to_player and plan_out.intent == "move_to_player":
            # 伝言・否定をLLMがcome hereへ言い換えても、原文とrespを
            # ActionGraph/ReActログへ渡さず、固定stepの安全拒否へ収束させる。
            plan_out.plan = ["話者に合流する"]
            plan_out.resp = ""
        if deterministic_move_to_player or source_excluded_move_to_player:
            agent.logger.info(
                "plan generated route=%s steps=%d",
                "move_to_player" if deterministic_move_to_player else "blocked_source",
                len(plan_out.plan),
            )
        else:
            agent.logger.info(
                "plan generated steps=%d plan=%s resp=%s",
                len(plan_out.plan),
                plan_out.plan,
                plan_out.resp,
            )
        agent._record_plan_summary(plan_out)

        if await agent.minedojo_handler.maybe_trigger_autorecovery(plan_out):
            agent.memory.set("last_chat", {"username": task.username, "message": task.message})
            return

        structured_coords = agent._extract_argument_coordinates(plan_out.arguments)
        if structured_coords:
            agent.logger.info("plan arguments provided coordinates=%s", structured_coords)
        initial_target = structured_coords or user_hint_coords

        # 確認・質問へ遷移するプランは PlanExecutor が唯一の送信責務を持つ。
        # ここでも送ると同じ resp が二重にチャットへ出力される。
        should_relay_initial_response = bool(plan_out.resp) and not (
            plan_out.blocking
            or plan_out.clarification_needed != "none"
            or plan_out.next_action == "chat"
        )
        if (
            should_relay_initial_response
            and source_excluded_move_to_player
            and plan_out.intent == "move_to_player"
        ):
            # 元発話を後段が安全拒否する経路では、LLMの初期respを重ねない。
            should_relay_initial_response = False
        if should_relay_initial_response:
            if source_excluded_move_to_player:
                agent.logger.info("relaying response route=blocked_source")
            else:
                agent.logger.info(
                    "relaying llm response to player username=%s resp='%s'",
                    task.username,
                    plan_out.resp,
                )
            await agent.actions.say(plan_out.resp)

        agent.memory.set("_active_chat_message", task.message)
        try:
            await agent._execute_plan(plan_out, initial_target=initial_target)
        finally:
            agent.memory.set("_active_chat_message", None)
        agent.memory.set("last_chat", {"username": task.username, "message": task.message})

    async def handle_action_task(
        self,
        category: str,
        step: str,
        *,
        last_target_coords: Optional[Tuple[int, int, int]],
        backlog: List[Dict[str, str]],
        explicit_coords: Optional[Tuple[int, int, int]] = None,
    ) -> Tuple[bool, Optional[Tuple[int, int, int]], Optional[str]]:
        """行動タスクを処理し、失敗時は理由を添えて返す。"""

        agent = self._agent
        rule = ACTION_TASK_RULES.get(category)
        if not rule:
            backlog.append({"category": category, "step": step, "label": category})
            agent.logger.warning(
                "action category=%s missing rule so queued to backlog step='%s'",
                category,
                step,
            )
            return False, last_target_coords, None

        structured_event_history, perception_history = agent._collect_recent_mineflayer_context()
        target_player = agent.memory.get("last_requester")
        agent.logger.info(
            "delegating action category=%s step='%s' to langgraph module=%s",
            category,
            step,
            rule.label or category,
        )
        await agent.minedojo_handler.attach_context(category, step)
        handled, updated_target, failure_detail = await agent._action_graph.run(
            category=category,
            step=step,
            last_target_coords=last_target_coords,
            backlog=backlog,
            rule=rule,
            explicit_coords=explicit_coords,
            structured_event_history=structured_event_history,
            perception_history=perception_history,
            target_player=target_player if isinstance(target_player, str) else None,
        )
        return handled, updated_target, failure_detail

    async def handle_action_backlog(
        self,
        backlog: Iterable[Dict[str, str]],
        *,
        already_responded: bool,
    ) -> None:
        """未実装アクションの backlog をメモリとチャットへ整理する。"""

        agent = self._agent
        backlog_list = list(backlog)
        if not backlog_list:
            return

        agent.memory.set("last_pending_actions", backlog_list)

        unique_labels: List[str] = []
        for item in backlog_list:
            label = item.get("label") or item.get("category") or "未分類の行動"
            if label not in unique_labels:
                unique_labels.append(label)

        if already_responded:
            agent.logger.info(
                "skip action backlog follow-up because initial response already sent backlog=%s",
                backlog_list,
            )
            return

        summary = "、".join(unique_labels)
        await agent.actions.say(
            (
                f"{summary}の行動リクエストを検知しましたが、Mineflayer 側の下位アクションが未実装のため待機中です。"
                "追加の指示や優先順位があればお知らせください。"
            )
        )

    async def handle_detection_reports(
        self,
        reports: Iterable[Dict[str, Any]],
        *,
        already_responded: bool,
    ) -> None:
        """検出報告タスクをメモリへ整理し、必要に応じて丁寧な補足メッセージを送る。"""

        agent = self._agent
        report_list = list(reports)
        if not report_list:
            return

        agent.memory.set("last_detection_reports", report_list)
        if already_responded:
            agent.logger.info(
                "skip detection follow-up because initial response already sent reports=%s",
                report_list,
            )
            return

        segments: List[str] = []
        for item in report_list:
            summary_text = str(item.get("summary") or "").strip()
            if summary_text:
                segments.append(summary_text.rstrip("。"))

        if not segments:
            labels = []
            for item in report_list:
                category = item.get("category", "")
                label = agent._DETECTION_LABELS.get(category)
                if label and label not in labels:
                    labels.append(label)
            if not labels:
                labels.append("状況確認")
            message = f"{'、'.join(labels)}の確認結果を取得しました。"
        else:
            message = "。".join(segments) + "。"

        await agent.actions.say(message)

    def select_pickaxe_for_targets(
        self,
        ore_names: Iterable[str],
    ) -> Optional[Dict[str, Any]]:
        """要求鉱石に適したツルハシが記憶済みインベントリにあるかを調べる。"""

        agent = self._agent
        inventory_detail = agent.memory.get("inventory_detail")
        if not isinstance(inventory_detail, dict):
            return None

        pickaxes = inventory_detail.get("pickaxes")
        if not isinstance(pickaxes, list):
            return None

        required_tier = 1
        for ore in ore_names:
            tier = ORE_PICKAXE_REQUIREMENTS.get(ore, 1)
            required_tier = max(required_tier, tier)

        best_candidate: Optional[Dict[str, Any]] = None
        best_tier = 0
        for item in pickaxes:
            if not isinstance(item, dict):
                continue

            name = item.get("name")
            if not isinstance(name, str):
                continue

            tier = PICKAXE_TIER_BY_NAME.get(name)
            if tier is None or tier < required_tier:
                continue

            if not self._has_sufficient_pickaxe_durability(item):
                continue

            if tier > best_tier:
                best_candidate = item
                best_tier = tier

        return best_candidate

    def _has_sufficient_pickaxe_durability(self, item: Dict[str, Any]) -> bool:
        """ツルハシの耐久値が残っているかを柔軟に判断する。"""

        remaining = self._extract_pickaxe_remaining_durability(item)
        if remaining is None:
            return True
        return remaining > 0

    def _extract_pickaxe_remaining_durability(
        self,
        item: Dict[str, Any],
    ) -> Optional[float]:
        """所持ツルハシ情報から残耐久を推定して数値として返す。"""

        direct_value = item.get("durability")
        if isinstance(direct_value, (int, float)):
            return float(direct_value)

        max_durability = item.get("maxDurability")
        durability_used = item.get("durabilityUsed")
        if isinstance(max_durability, (int, float)) and isinstance(
            durability_used, (int, float)
        ):
            return float(max_durability) - float(durability_used)

        for key in ("durabilityRemaining", "remainingDurability"):
            value = item.get(key)
            if isinstance(value, (int, float)):
                return float(value)

        for key in ("durabilityRatio", "durability_ratio"):
            value = item.get(key)
            if isinstance(value, (int, float)):
                return float(value)

        for key in ("durabilityPercent", "durability_percent"):
            value = item.get(key)
            if isinstance(value, (int, float)):
                return float(value) / 100.0

        return None


__all__ = ["ChatPipeline"]
