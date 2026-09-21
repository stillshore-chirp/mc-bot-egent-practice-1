import llm.client as llm_client
import planner
from planner_config import PlannerConfig, load_planner_config


def test_sync_client_uses_official_base_url_when_unset(monkeypatch) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setenv("OPENAI_BASE_URL", "")

    class StubOpenAI:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(llm_client.openai, "OpenAI", StubOpenAI)

    client = llm_client.create_openai_client(PlannerConfig(api_key="test-key"))

    assert isinstance(client, StubOpenAI)
    assert captured == {
        "api_key": "test-key",
        "base_url": "https://api.openai.com/v1",
    }


def test_async_client_uses_official_base_url_when_unset(monkeypatch) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setenv("OPENAI_BASE_URL", "")

    class StubAsyncOpenAI:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(llm_client.openai, "AsyncOpenAI", StubAsyncOpenAI)

    client = llm_client.create_async_openai_client(PlannerConfig(api_key="test-key"))

    assert isinstance(client, StubAsyncOpenAI)
    assert captured == {
        "api_key": "test-key",
        "base_url": "https://api.openai.com/v1",
    }


def test_client_factories_forward_custom_base_url(monkeypatch) -> None:
    sync_kwargs: dict[str, object] = {}
    async_kwargs: dict[str, object] = {}

    class StubOpenAI:
        def __init__(self, **kwargs: object) -> None:
            sync_kwargs.update(kwargs)

    class StubAsyncOpenAI:
        def __init__(self, **kwargs: object) -> None:
            async_kwargs.update(kwargs)

    monkeypatch.setattr(llm_client.openai, "OpenAI", StubOpenAI)
    monkeypatch.setattr(llm_client.openai, "AsyncOpenAI", StubAsyncOpenAI)
    config = PlannerConfig(api_key="test-key", base_url="https://example.invalid/v1")

    llm_client.create_openai_client(config)
    llm_client.create_async_openai_client(config)

    expected = {
        "api_key": "test-key",
        "base_url": "https://example.invalid/v1",
    }
    assert sync_kwargs == expected
    assert async_kwargs == expected


def test_real_clients_use_official_base_url_after_empty_env_normalization(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    config = load_planner_config(
        {
            "OPENAI_API_KEY": "test-key",
            "OPENAI_BASE_URL": "",
        }
    )

    sync_client = llm_client.create_openai_client(config)
    async_client = llm_client.create_async_openai_client(config)

    assert config.base_url is None
    assert str(sync_client.base_url).rstrip("/") == llm_client.DEFAULT_OPENAI_BASE_URL
    assert str(async_client.base_url).rstrip("/") == llm_client.DEFAULT_OPENAI_BASE_URL


def test_planner_factory_honors_planner_async_client_double(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class StubAsyncOpenAI:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(planner, "_PLANNER_CONFIG", PlannerConfig(api_key="test-key"))
    monkeypatch.setattr(planner, "AsyncOpenAI", StubAsyncOpenAI)

    client = planner._default_async_client_factory()

    assert isinstance(client, StubAsyncOpenAI)
    assert captured["api_key"] == "test-key"
    assert captured["base_url"] == llm_client.DEFAULT_OPENAI_BASE_URL


def test_planner_factory_honors_shared_openai_async_client_double(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class StubAsyncOpenAI:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(planner, "_PLANNER_CONFIG", PlannerConfig(api_key="test-key"))
    monkeypatch.setattr(planner.openai, "AsyncOpenAI", StubAsyncOpenAI)

    client = planner._default_async_client_factory()

    assert isinstance(client, StubAsyncOpenAI)
    assert captured["api_key"] == "test-key"
    assert captured["base_url"] == llm_client.DEFAULT_OPENAI_BASE_URL


def test_planner_default_factory_uses_shared_client_factory(monkeypatch) -> None:
    config = PlannerConfig(api_key="test-key")
    sentinel = object()
    captured: list[PlannerConfig] = []

    def fake_factory(received: PlannerConfig) -> object:
        captured.append(received)
        return sentinel

    monkeypatch.setattr(planner, "_PLANNER_CONFIG", config)
    monkeypatch.setattr(planner, "create_async_openai_client", fake_factory, raising=False)

    assert planner._default_async_client_factory() is sentinel
    assert captured == [config]
