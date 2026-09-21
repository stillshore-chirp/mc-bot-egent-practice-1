# -*- coding: utf-8 -*-
"""Actions ファサードで共有するディスパッチ基底クラス。"""

from __future__ import annotations

import itertools
import logging
import time
from typing import Any, Awaitable, Callable, Dict, Optional

from bridge_ws import BotBridge
from utils import log_structured_event, setup_logger

from .errors import ActionValidationError


FOLLOW_PLAYER_RECV_TIMEOUT_SECONDS = 210.0
FOLLOW_PLAYER_MIN_WORKER_TIMEOUT_SECONDS = FOLLOW_PLAYER_RECV_TIMEOUT_SECONDS + 30.0
DEFAULT_WORKER_TASK_TIMEOUT_SECONDS = 300.0


class ActionDispatcher:
    """BotBridge との送受信を一元管理する基底クラス。

    各アクションモジュールはこのクラスのインスタンスを共有し、
    コマンド番号の採番や directive メタデータの付与などの横断的処理を
    `_dispatch` を経由して実行する。
    """

    def __init__(
        self,
        bridge: BotBridge,
        *,
        on_bridge_retry: Optional[Callable[[int, str], Awaitable[None]]] = None,
        on_bridge_give_up: Optional[Callable[[int, str], Awaitable[None]]] = None,
        worker_task_timeout_seconds: float = DEFAULT_WORKER_TASK_TIMEOUT_SECONDS,
    ) -> None:
        # Bridge インスタンスを保持し、全アクションで共有する。
        self.bridge = bridge
        self.logger = setup_logger("actions")
        self._command_seq = itertools.count(1)
        self._on_bridge_retry = on_bridge_retry
        self._on_bridge_give_up = on_bridge_give_up
        self._worker_task_timeout_seconds = worker_task_timeout_seconds
        self._current_directive_meta: Optional[Dict[str, Any]] = None

    def begin_directive_scope(self, meta: Dict[str, Any]) -> None:
        """直後のコマンドへ directive メタデータを付与する。"""

        self._current_directive_meta = dict(meta)

    def end_directive_scope(self) -> None:
        """directive メタデータのスコープを終了する。"""

        self._current_directive_meta = None

    async def _dispatch(self, command: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """共通の送信処理: 付番、送信時間、レスポンスを詳細に記録する。"""

        command_id = next(self._command_seq)
        started_at = time.perf_counter()
        wire_payload = dict(payload)
        if self._current_directive_meta:
            wire_payload["meta"] = dict(self._current_directive_meta)
        is_follow_player = command == "followPlayer"
        if is_follow_player and self._worker_task_timeout_seconds < FOLLOW_PLAYER_MIN_WORKER_TIMEOUT_SECONDS:
            self.logger.warning(
                "followPlayer skipped because worker timeout is too short; command_id=%d",
                command_id,
            )
            return {
                "ok": False,
                "error": "rendezvous_worker_timeout_mismatch",
            }
        safe_log_payload = {"type": "followPlayer"} if is_follow_player else wire_payload
        log_structured_event(
            self.logger,
            "dispatch prepared",
            event_level="progress",
            context={"command": command, "command_id": command_id, "payload": safe_log_payload},
        )
        try:
            resp = await self.bridge.send(
                wire_payload,
                on_retry=None if is_follow_player else self._on_bridge_retry,
                on_give_up=None if is_follow_player else self._on_bridge_give_up,
                recv_timeout=FOLLOW_PLAYER_RECV_TIMEOUT_SECONDS if is_follow_player else None,
            )
        except Exception as error:  # noqa: BLE001 - 送信失敗はそのまま上位へ伝搬させる
            failure_payload = {"type": "followPlayer"} if is_follow_player else wire_payload
            failure_kwargs: Dict[str, Any] = {
                "level": logging.ERROR,
                "event_level": "fault",
                "context":{"command": command, "command_id": command_id, "payload": failure_payload},
            }
            if not is_follow_player:
                failure_kwargs["exc_info"] = error
            log_structured_event(
                self.logger,
                "dispatch failed",
                **failure_kwargs,
            )
            raise

        elapsed = time.perf_counter() - started_at
        event_level = "success" if resp.get("ok") else "fault"
        safe_response = {"ok": bool(resp.get("ok"))} if is_follow_player else resp
        log_structured_event(
            self.logger,
            "dispatch completed",
            level=logging.INFO if resp.get("ok") else logging.ERROR,
            event_level=event_level,
            context={
                "command": command,
                "command_id": command_id,
                "payload": safe_log_payload,
                "response": safe_response,
                "duration_sec": round(elapsed, 3),
            },
        )
        return resp

    def _normalize_command_payload(self, payload: Dict[str, Any], *, label: str) -> Dict[str, Any]:
        """汎用コマンドペイロードの妥当性検証を行うヘルパー。"""

        if not isinstance(payload, dict):
            raise ActionValidationError(f"{label} はオブジェクトで指定してください")
        command_type = payload.get("type")
        if not isinstance(command_type, str) or not command_type.strip():
            raise ActionValidationError(f"{label}.type は 1 文字以上の文字列で指定してください")
        args = payload.get("args") or {}
        if not isinstance(args, dict):
            raise ActionValidationError(f"{label}.args はオブジェクトで指定してください")
        normalized: Dict[str, Any] = {
            "type": command_type.strip(),
            "args": dict(args),
        }
        return normalized

    def _normalize_vpt_actions(
        self,
        actions: Optional[list[Dict[str, Any]]],
    ) -> list[Dict[str, Any]]:
        """VPT 指示のリスト形式を安全に正規化する。"""

        if actions is None:
            return []
        if not isinstance(actions, list):
            raise ActionValidationError("vpt_actions は配列で指定してください")
        normalized: list[Dict[str, Any]] = []
        for index, item in enumerate(actions):
            if not isinstance(item, dict):
                raise ActionValidationError(f"vpt_actions[{index}] はオブジェクトで指定してください")
            normalized.append(item)
        return normalized


class ActionModule:
    """各種アクションカテゴリが継承する共通モジュール基底クラス。"""

    def __init__(self, dispatcher: ActionDispatcher) -> None:
        # 送信ロジックを一本化するため、ActionDispatcher インスタンスを保持する。
        self._dispatcher = dispatcher

    @property
    def logger(self) -> logging.Logger:
        """共通ロガーへのアクセスを提供する。"""

        return self._dispatcher.logger

    async def _dispatch(self, command: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """ActionDispatcher 経由でコマンドを送信するヘルパー。"""

        return await self._dispatcher._dispatch(command, payload)

    def _normalize_command_payload(self, payload: Dict[str, Any], *, label: str) -> Dict[str, Any]:
        """ディスパッチャの正規化処理を委譲する。"""

        return self._dispatcher._normalize_command_payload(payload, label=label)

    def _normalize_vpt_actions(
        self,
        actions: Optional[list[Dict[str, Any]]],
    ) -> list[Dict[str, Any]]:
        """VPT 指示の正規化をディスパッチャへ委譲する。"""

        return self._dispatcher._normalize_vpt_actions(actions)


__all__ = ["ActionDispatcher", "ActionModule"]
