"""Tests 共通の外部永続状態隔離。"""

from __future__ import annotations

from pathlib import Path

import pytest

import memory as memory_module


@pytest.fixture(autouse=True)
def isolate_default_reflection_store(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """既定 Memory が実環境の reflection store を読み込まないようにする。"""

    reflection_store_type = memory_module.ReflectionStore

    class IsolatedReflectionStore(reflection_store_type):
        def __init__(
            self, path: str | Path = tmp_path / "reflections.json"
        ) -> None:
            super().__init__(path)

    monkeypatch.setattr(memory_module, "ReflectionStore", IsolatedReflectionStore)
