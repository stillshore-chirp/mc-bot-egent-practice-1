from __future__ import annotations

import json
from typing import Any, Dict

import pytest
from openai.lib._pydantic import to_strict_json_schema

from planner import (
    PlanOut,
    PlanOutWire,
    PlanOutWireConversionError,
    _build_responses_payload,
    wire_to_plan_out,
)
import planner.graph as planner_graph
from planner.graph import _parse_plan_dict, build_plan_graph
from planner.priority import PlanPriorityManager
from planner_config import PlannerConfig


def _wire_payload() -> Dict[str, Any]:
    return {
        "plan": ["指定座標へ移動"],
        "resp": "移動します。",
        "intent": "move",
        "arguments": {
            "coordinates": {"x": 12, "y": 64, "z": -8},
            "quantity": None,
            "target": None,
            "notes": json.dumps({"text": "橋の近く", "unknown": {"level": 2}}, ensure_ascii=False),
            "confidence": 0.9,
            "clarification_needed": "none",
            "detected_modalities": ["text"],
        },
        "blocking": False,
        "react_trace": [
            {"thought": "安全確認", "action": "移動", "observation": ""}
        ],
        "confidence": 0.9,
        "clarification_needed": "none",
        "detected_modalities": ["text"],
        "backlog": [
            json.dumps({"type": "plan", "label": "確認", "future": "保持"})
        ],
        "next_action": "execute",
        "goal_profile": {
            "summary": "指定地点へ到達",
            "category": "move",
            "priority": "medium",
            "success_criteria": ["到達"],
            "blockers": [],
        },
        "constraints": [],
        "execution_hints": [],
        "directives": [
            {
                "directive_id": "step-1",
                "step": "指定座標へ移動",
                "label": "移動",
                "category": "move",
                "executor": "mineflayer",
                "args": json.dumps(
                    {
                        "coordinates": {"x": 12, "y": 64, "z": -8},
                        "unknown_arg": {"keep": True},
                    }
                ),
                "safety_checks": [],
                "success_criteria": ["到達"],
                "fallback": "",
            }
        ],
        "recovery_hints": [],
    }


def _walk_schema(node: Any):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk_schema(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk_schema(value)


class _StructuredResponse:
    def __init__(self, parsed: Dict[str, Any]) -> None:
        self.output_text = ""
        self.output = []
        self.output_parsed = parsed


class _StructuredResponses:
    def __init__(self, response: _StructuredResponse) -> None:
        self.response = response

    async def create(self, **_: Any) -> _StructuredResponse:
        return self.response


class _StructuredClient:
    def __init__(self, response: _StructuredResponse) -> None:
        self.responses = _StructuredResponses(response)


async def _run_structured_graph(payload: Dict[str, Any]) -> Dict[str, Any]:
    config = PlannerConfig(llm_timeout_seconds=30.0)
    response = _StructuredResponse(payload)
    client = _StructuredClient(response)
    graph = build_plan_graph(
        config,
        priority_manager=PlanPriorityManager(config),
        async_client_factory=lambda: client,
        payload_builder=lambda _system, _user: {
            "model": config.model,
            "input": [],
            "text": {"format": {"type": "json_schema"}},
        },
    )
    return await graph.ainvoke(
        {"user_msg": "test", "context": {}, "structured_events": []}
    )


def test_planout_wire_schema_is_strict_without_defaults() -> None:
    schema = to_strict_json_schema(PlanOutWire)

    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    for node in _walk_schema(schema):
        assert "default" not in node
        if node.get("type") == "object":
            assert node.get("additionalProperties") is False
            assert set(node.get("required", ())) == set(node.get("properties", ()))


def test_graph_star_exports_are_resolvable() -> None:
    assert all(hasattr(planner_graph, name) for name in planner_graph.__all__)


def test_payload_uses_wire_schema_even_when_runtime_planout_is_requested() -> None:
    payload = _build_responses_payload(
        "system",
        "user",
        PlannerConfig(llm_timeout_seconds=30.0),
        schema_model=PlanOut,
        schema_name="plan_out",
    )

    assert payload["text"]["format"]["type"] == "json_schema"
    assert payload["text"]["format"]["schema"]["title"] == "PlanOutWire"


def test_wire_to_runtime_preserves_unknown_json_objects() -> None:
    runtime = wire_to_plan_out(PlanOutWire.model_validate(_wire_payload()))

    assert runtime.arguments.coordinates == {"x": 12, "y": 64, "z": -8}
    assert runtime.arguments.notes["unknown"] == {"level": 2}
    assert runtime.directives[0].args["unknown_arg"] == {"keep": True}
    assert runtime.backlog[0]["future"] == "保持"


def test_graph_parser_converts_wire_payload_to_runtime_planout() -> None:
    runtime = _parse_plan_dict(_wire_payload(), allow_legacy=False)

    assert isinstance(runtime, PlanOut)
    assert runtime.directives[0].args["unknown_arg"]["keep"] is True


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("mutation", "expected_error"),
    [
        ("carrier_type", "structured_output_schema_mismatch"),
        ("carrier_json", "structured_output_carrier_validation_failed"),
    ],
)
async def test_structured_wire_errors_do_not_fallback_to_legacy(
    mutation: str,
    expected_error: str,
) -> None:
    payload = _wire_payload()
    if mutation == "carrier_type":
        payload["directives"][0]["args"] = {"unknown_arg": "legacy object"}
    else:
        payload["directives"][0]["args"] = "{broken"

    result = await _run_structured_graph(payload)

    assert result["plan_out"].plan == []
    assert result["parse_error_code"] == expected_error


@pytest.mark.parametrize(
    "field",
    ["arguments.notes", "directives[0].args", "backlog[0]"],
)
def test_wire_to_runtime_rejects_malformed_json_carrier(field: str) -> None:
    payload = _wire_payload()
    if field == "arguments.notes":
        payload["arguments"]["notes"] = "not-json"
    elif field == "directives[0].args":
        payload["directives"][0]["args"] = "[]"
    else:
        payload["backlog"][0] = "{broken"

    wire = PlanOutWire.model_validate(payload)
    with pytest.raises(PlanOutWireConversionError, match=field.split("[")[0].split(".")[0]):
        wire_to_plan_out(wire)
