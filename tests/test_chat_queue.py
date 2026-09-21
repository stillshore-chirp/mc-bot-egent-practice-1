from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import List

import pytest

from runtime.action_graph import ChatTask  # type: ignore  # noqa: E402
from runtime.chat_queue import ChatQueue  # type: ignore  # noqa: E402


def _queue(
    process_task,
    *,
    queue_max_size: int = 0,
    task_timeout_seconds: float = 1.0,
    timeout_retry_limit: int = 0,
    say_messages: List[str] | None = None,
) -> ChatQueue:
    async def say(message: str) -> None:
        if say_messages is not None:
            say_messages.append(message)

    return ChatQueue(
        process_task=process_task,
        say=say,
        queue_max_size=queue_max_size,
        task_timeout_seconds=task_timeout_seconds,
        timeout_retry_limit=timeout_retry_limit,
        logger=logging.getLogger("test.chat_queue"),
    )


@pytest.mark.anyio
async def test_enqueue_log_hides_username_and_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def process_task(_: ChatTask) -> None:
        return None

    queue = _queue(process_task)
    with caplog.at_level(logging.INFO, logger="test.chat_queue"):
        await queue.enqueue_chat("SecretPlayer", "come here with private context")

    messages = [record.getMessage() for record in caplog.records]
    assert messages
    assert all("SecretPlayer" not in message for message in messages)
    assert all("private context" not in message for message in messages)
    assert any("category=chat" in message for message in messages)


@pytest.mark.anyio
async def test_timeout_log_hides_username_and_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def process_task(_: ChatTask) -> None:
        await asyncio.sleep(1)

    queue = _queue(process_task, task_timeout_seconds=0.01)
    worker = asyncio.create_task(queue.worker())
    try:
        with caplog.at_level(logging.INFO, logger="test.chat_queue"):
            await queue.enqueue_chat("SecretPlayer", "come here with private context")
            await asyncio.sleep(0.05)
    finally:
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker

    messages = [record.getMessage() for record in caplog.records]
    assert all("SecretPlayer" not in message for message in messages)
    assert all("private context" not in message for message in messages)


@pytest.mark.anyio
async def test_overflow_log_hides_usernames_and_messages(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def process_task(_: ChatTask) -> None:
        return None

    queue = _queue(process_task, queue_max_size=1)
    with caplog.at_level(logging.INFO, logger="test.chat_queue"):
        await queue.enqueue_chat("FirstSecret", "first private context")
        await queue.enqueue_chat("SecondSecret", "second private context")

    messages = [record.getMessage() for record in caplog.records]
    assert any("chat queue overflow" in message for message in messages)
    assert all("FirstSecret" not in message for message in messages)
    assert all("SecondSecret" not in message for message in messages)
    assert all("private context" not in message for message in messages)
