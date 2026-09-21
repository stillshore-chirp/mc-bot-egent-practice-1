# -*- coding: utf-8 -*-
import asyncio
import json
import logging
import os
from uuid import uuid4
from typing import Any, Awaitable, Callable, Dict, Optional

import websockets

from runtime.transport_envelope import make_transport_envelope
from utils import log_structured_event, setup_logger

logger = setup_logger("bridge")

class BotBridge:
    """Python→Node WebSocket ブリッジ（単純な送信ユーティリティ）"""

    def __init__(
        self,
        ws_url: str | None = None,
        *,
        connect_timeout: float = 5.0,
        send_timeout: float = 3.0,
        recv_timeout: float = 5.0,
        max_retries: int = 4,
        backoff_base: float = 1.0,
    ) -> None:
        # Docker Compose 実行時はサービス名でルーティングできるよう、node-bot ホストを既定とする。
        self.ws_url = ws_url or os.getenv("WS_URL", "ws://node-bot:8765")
        # タイムアウトとリトライ設定を明示して、デッドロックや無限待機を避ける。
        self.connect_timeout = connect_timeout
        self.send_timeout = send_timeout
        self.recv_timeout = recv_timeout
        self.max_retries = max(1, max_retries)
        self.backoff_base = backoff_base

    async def send(
        self,
        payload: Dict[str, Any],
        *,
        on_retry: Optional[Callable[[int, str], Awaitable[None]]] = None,
        on_give_up: Optional[Callable[[int, str], Awaitable[None]]] = None,
        recv_timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """WebSocket 送信を行い、接続/送信/受信ごとにタイムアウトと例外を区別する。

        on_retry/on_give_up を通じて呼び出し元（Actions など）が Mineflayer や
        ユーザーへ再試行/断念の通知を転送できるフックを提供する。
        """

        trace_id = uuid4().hex
        run_id = uuid4().hex
        command_name = str(payload.get("type") or "unknown")
        effective_recv_timeout = self.recv_timeout if recv_timeout is None else recv_timeout
        is_follow_player = command_name == "followPlayer"
        envelope = make_transport_envelope(
            source="python-agent",
            kind="command",
            name=command_name,
            body=payload,
            trace_id=trace_id,
            run_id=run_id,
        )
        logger.info("WS send trace_id=%s run_id=%s command=%s", trace_id, run_id, command_name)
        for attempt in range(1, self.max_retries + 1):
            stage = "connect"
            try:
                async with websockets.connect(
                    self.ws_url, open_timeout=self.connect_timeout
                ) as ws:
                    stage = "send"
                    await asyncio.wait_for(
                        ws.send(json.dumps(envelope, ensure_ascii=False)),
                        timeout=self.send_timeout,
                    )
                    stage = "recv"
                    resp = await asyncio.wait_for(ws.recv(), timeout=effective_recv_timeout)
                    if is_follow_player:
                        logger.info("WS recv command=followPlayer ok=%s", _response_ok(resp))
                    else:
                        logger.info("WS recv: %s", resp)
                    return json.loads(resp)
            except Exception as error:  # noqa: BLE001 - 失敗種別ごとに判定するため広く捕捉
                error_type = self._classify_error(stage, error)
                is_connect_failure = stage == "connect"
                should_retry = is_connect_failure and attempt < self.max_retries
                event_level = "retry" if should_retry else "fault"
                failure_context = {
                    "stage": stage,
                    "attempt": attempt,
                    "max_retries": self.max_retries,
                    "payload": _safe_log_payload(envelope) if is_follow_player else envelope,
                    "error_type": error_type,
                }
                log_kwargs: Dict[str, Any] = {
                    "level": logging.WARNING if should_retry else logging.ERROR,
                    "event_level": event_level,
                    "context": failure_context,
                }
                if not is_follow_player:
                    log_kwargs["exc_info"] = error
                log_structured_event(logger, "WS communication failed", **log_kwargs)
                if should_retry:
                    if on_retry:
                        await on_retry(attempt, error_type)
                    await asyncio.sleep(self._compute_backoff(attempt))
                    continue

                if on_give_up:
                    await on_give_up(attempt - 1, error_type)
                result = {
                    "ok": False,
                    "error": error_type,
                    "retries": attempt - 1,
                }
                if not is_follow_player:
                    result["message"] = str(error)
                return result

    def _classify_error(self, stage: str, error: Exception) -> str:
        """例外内容から段階別のエラー種別をテキストで返す。"""

        if isinstance(error, asyncio.TimeoutError):
            return f"{stage}_timeout"
        if isinstance(error, ConnectionRefusedError):
            return "connect_refused"
        if isinstance(error, OSError):
            return f"{stage}_os_error"
        return f"{stage}_error"

    def _compute_backoff(self, attempt: int) -> float:
        """指数バックオフの遅延を計算する。"""

        return min(self.backoff_base * (2 ** (attempt - 1)), 8.0)


def _response_ok(raw_response: str) -> bool:
    try:
        return bool(json.loads(raw_response).get("ok"))
    except (TypeError, ValueError, AttributeError):
        return False


def _safe_log_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    """followPlayerログから対象名・元payloadを除く。wire payload自体は変更しない。"""

    return {"type": "followPlayer"}
