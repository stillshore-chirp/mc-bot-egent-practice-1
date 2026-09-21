"""プランナー周辺の runtime model、strict wire model、補助変換ロジック。"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Literal, Mapping, Optional

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


class ReActStep(BaseModel):
    """ReAct 形式で LangGraph へ流す 1 ステップ分の思考と行動。"""

    thought: str = ""
    action: str = ""
    observation: str = ""


class PlanArguments(BaseModel):
    """LLM が推定した実行パラメータを型安全に保持するためのスキーマ。"""

    coordinates: Optional[Dict[str, int]] = Field(
        default=None,
        description="移動や採掘の起点となる座標 (X/Y/Z)。",
    )
    quantity: Optional[int] = Field(
        default=None,
        ge=0,
        description="要求された数量（負数は不正値として拒否する）。",
    )
    target: Optional[str] = Field(
        default=None,
        description="対象ブロックやアイテムの名称。",
    )
    notes: Dict[str, Any] = Field(
        default_factory=dict,
        description="補足情報（自由形式）。",
    )
    confidence: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="引数推定の確信度 (0.0～1.0)。",
    )
    clarification_needed: Literal["none", "confirmation", "data_gap"] = Field(
        default="none",
        description="追加確認の種類 (none/confirmation/data_gap)。",
    )
    detected_modalities: List[str] = Field(
        default_factory=list,
        description="入力に含まれるモダリティ（例: text, image）。",
    )

    @field_validator("notes", mode="before")
    @classmethod
    def _coerce_notes(cls, value: Any) -> Dict[str, Any]:
        """LLM から文字列で返ってきた場合も辞書へ正規化する。"""

        if value is None:
            return {}
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            return {"text": value}
        # その他の型はそのまま文字列表現で退避する
        return {"raw": str(value)}


class ConstraintSpec(BaseModel):
    """LLM が検出した制約条件を表す。"""

    label: str = ""
    rationale: str = ""
    severity: Literal["soft", "hard"] = "soft"


class GoalProfile(BaseModel):
    """タスクのゴール要約と優先度を構造化して保持する。"""

    summary: str = ""
    category: str = ""
    priority: Literal["low", "medium", "high"] = "medium"
    success_criteria: List[str] = Field(default_factory=list)
    blockers: List[str] = Field(default_factory=list)


class ExecutionHint(BaseModel):
    """Mineflayer/MineDojo 実行前に共有したいヒントの集合。"""

    key: str = ""
    value: str = ""
    source: str = ""


class ActionDirective(BaseModel):
    """plan[].step と 1:1 で対応する構造化指示。"""

    directive_id: str = ""
    step: str = ""
    label: str = ""
    category: str = ""
    executor: Literal["mineflayer", "minedojo", "chat", "hybrid"] = "mineflayer"
    args: Dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "executor 固有の追加パラメータ。"
            "hybrid 指示では `vpt_actions` (List[Dict]) と `fallback_command` "
            "(例: {'type': 'moveTo', 'args': {...}}) を期待する。"
        ),
    )
    safety_checks: List[str] = Field(default_factory=list)
    success_criteria: List[str] = Field(default_factory=list)
    fallback: str = ""


class PlanOut(BaseModel):
    plan: List[str] = Field(default_factory=list)
    resp: str = ""
    intent: str = Field(
        default="",
        description="LLM が推定したメイン意図（例: move/build/gather など）。",
    )
    arguments: PlanArguments = Field(
        default_factory=PlanArguments,
        description="座標や数量などの構造化パラメータ群。",
    )
    blocking: bool = Field(
        default=False,
        description="ユーザー確認が必要な場合に true。false なら即時実行してよい。",
    )
    react_trace: List[ReActStep] = Field(
        default_factory=list,
        description="Responses API から得た ReAct ループの素案。Observation は Mineflayer 実行結果で更新する。",
    )
    confidence: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="プラン全体の確信度 (0.0～1.0)。",
    )
    clarification_needed: Literal["none", "confirmation", "data_gap"] = Field(
        default="none",
        description="追加確認が必要かどうか (none/confirmation/data_gap)。",
    )
    detected_modalities: List[str] = Field(
        default_factory=list,
        description="入力内で認識したモダリティ（text/image など）。",
    )
    backlog: List[Dict[str, str]] = Field(
        default_factory=list,
        description="ActionGraph へ差し戻すためのバックログ候補。",
    )
    next_action: str = Field(
        default="execute",
        description="graph からの推奨遷移 (execute/chat など)。",
    )
    goal_profile: GoalProfile = Field(
        default_factory=GoalProfile,
        description="ゴール要約と優先度。",
    )
    constraints: List[ConstraintSpec] = Field(
        default_factory=list,
        description="実行上の制約条件一覧。",
    )
    execution_hints: List[ExecutionHint] = Field(
        default_factory=list,
        description="Mineflayer/MineDojo への補助ヒント。",
    )
    directives: List[ActionDirective] = Field(
        default_factory=list,
        description="各ステップに対応する構造化指示列。",
    )
    recovery_hints: List[str] = Field(
        default_factory=list,
        description="前回障壁から引き継いだ再計画ヒント。",
    )


class _StrictWireModel(BaseModel):
    """Responses Structured Outputs 用の strict object 共通設定。"""

    model_config = ConfigDict(extra="forbid")


class CoordinatesWire(_StrictWireModel):
    """座標の wire 表現。座標自体と各軸の欠損を nullable で表す。"""

    x: Optional[int] = Field(description="X 座標。未知または未指定の場合は null。")
    y: Optional[int] = Field(description="Y 座標。未知または未指定の場合は null。")
    z: Optional[int] = Field(description="Z 座標。未知または未指定の場合は null。")


class PlanArgumentsWire(_StrictWireModel):
    """PlanArguments の strict wire 表現。自由形式 notes は JSON 文字列で運ぶ。"""

    coordinates: Optional[CoordinatesWire] = Field(
        description="移動や採掘の起点となる座標。未指定の場合は null。"
    )
    quantity: Optional[int] = Field(
        ge=0,
        description="要求された数量。未指定の場合は null。",
    )
    target: Optional[str] = Field(
        description="対象ブロックやアイテムの名称。未指定の場合は null。"
    )
    notes: Optional[str] = Field(
        description=(
            "補足情報を JSON object の JSON 文字列で指定する。"
            "未指定の場合は null。"
        )
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="引数推定の確信度 (0.0～1.0)。",
    )
    clarification_needed: Literal["none", "confirmation", "data_gap"] = Field(
        description="追加確認の種類 (none/confirmation/data_gap)。"
    )
    detected_modalities: List[str] = Field(
        description="入力に含まれるモダリティ（例: text, image）。"
    )


class ReActStepWire(_StrictWireModel):
    """ReActStep の strict wire 表現。"""

    thought: str = Field(description="思考の要約。")
    action: str = Field(description="実行する行動。")
    observation: str = Field(description="観測結果。")


class ConstraintSpecWire(_StrictWireModel):
    """ConstraintSpec の strict wire 表現。"""

    label: str = Field(description="制約のラベル。")
    rationale: str = Field(description="制約の理由。")
    severity: Literal["soft", "hard"] = Field(description="制約の重大度。")


class GoalProfileWire(_StrictWireModel):
    """GoalProfile の strict wire 表現。"""

    summary: str = Field(description="ゴールの要約。")
    category: str = Field(description="ゴールのカテゴリ。")
    priority: Literal["low", "medium", "high"] = Field(description="優先度。")
    success_criteria: List[str] = Field(description="成功条件。")
    blockers: List[str] = Field(description="阻害要因。")


class ExecutionHintWire(_StrictWireModel):
    """ExecutionHint の strict wire 表現。"""

    key: str = Field(description="ヒントのキー。")
    value: str = Field(description="ヒントの値。")
    source: str = Field(description="ヒントの出所。")


class ActionDirectiveWire(_StrictWireModel):
    """ActionDirective の strict wire 表現。args は未知キーを含む JSON 文字列。"""

    directive_id: str = Field(description="directive の識別子。")
    step: str = Field(description="対応する計画ステップ。")
    label: str = Field(description="表示用ラベル。")
    category: str = Field(description="実行カテゴリ。")
    executor: Literal["mineflayer", "minedojo", "chat", "hybrid"] = Field(
        description="実行先。"
    )
    args: Optional[str] = Field(
        description=(
            "executor 固有引数を JSON object の JSON 文字列で指定する。"
            "未指定の場合は null。"
        )
    )
    safety_checks: List[str] = Field(description="安全確認項目。")
    success_criteria: List[str] = Field(description="成功条件。")
    fallback: str = Field(description="失敗時の補助手順。")


class PlanOutWire(_StrictWireModel):
    """PlanOut の Responses Structured Outputs 専用 wire schema。"""

    plan: List[str] = Field(description="実行手順。")
    resp: str = Field(description="プレイヤーへ返す短い説明。")
    intent: str = Field(description="推定したメイン意図。")
    arguments: PlanArgumentsWire = Field(description="構造化された実行パラメータ。")
    blocking: bool = Field(description="ユーザー確認が必要な場合は true。")
    react_trace: List[ReActStepWire] = Field(description="ReAct の思考・行動・観測履歴。")
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="プラン全体の確信度 (0.0～1.0)。",
    )
    clarification_needed: Literal["none", "confirmation", "data_gap"] = Field(
        description="追加確認が必要かどうか。"
    )
    detected_modalities: List[str] = Field(description="入力内のモダリティ。")
    backlog: List[str] = Field(
        description=(
            "ActionGraph へ差し戻すバックログ候補。各要素は JSON object の"
            " JSON 文字列で指定する。"
        )
    )
    next_action: str = Field(description="graph からの推奨遷移。")
    goal_profile: GoalProfileWire = Field(description="ゴール要約と優先度。")
    constraints: List[ConstraintSpecWire] = Field(description="実行上の制約条件一覧。")
    execution_hints: List[ExecutionHintWire] = Field(description="実行補助ヒント。")
    directives: List[ActionDirectiveWire] = Field(description="各ステップに対応する指示列。")
    recovery_hints: List[str] = Field(description="再計画へ引き継ぐヒント。")


class PlanOutWireConversionError(ValueError):
    """strict wire の JSON carrier を runtime object へ戻せない場合のエラー。"""


def _decode_json_object_carrier(value: Optional[str], *, field_name: str) -> Dict[str, Any]:
    """JSON carrier を object へ変換し、型不一致を黙って捨てない。"""

    if value is None:
        return {}
    try:
        decoded = json.loads(value)
    except (TypeError, json.JSONDecodeError) as exc:
        raise PlanOutWireConversionError(
            f"{field_name} must contain a valid JSON object string"
        ) from exc
    if not isinstance(decoded, dict):
        raise PlanOutWireConversionError(
            f"{field_name} JSON carrier must decode to an object"
        )
    return decoded


def _coordinates_from_wire(value: Optional[CoordinatesWire]) -> Optional[Dict[str, int]]:
    """wire 座標を既存 runtime の部分座標 dict へ変換する。"""

    if value is None:
        return None
    coordinates = {
        key: axis
        for key, axis in value.model_dump().items()
        if axis is not None
    }
    return coordinates or None


def wire_to_plan_out(payload: PlanOutWire | Mapping[str, Any]) -> PlanOut:
    """strict wire payload を既存 runtime PlanOut へ変換する。"""

    wire = payload if isinstance(payload, PlanOutWire) else PlanOutWire.model_validate(payload)
    data = wire.model_dump()
    data["arguments"]["coordinates"] = _coordinates_from_wire(wire.arguments.coordinates)
    data["arguments"]["notes"] = _decode_json_object_carrier(
        wire.arguments.notes,
        field_name="arguments.notes",
    )
    data["backlog"] = [
        _decode_json_object_carrier(entry, field_name=f"backlog[{index}]")
        for index, entry in enumerate(wire.backlog)
    ]
    data["directives"] = []
    for index, directive in enumerate(wire.directives):
        directive_data = directive.model_dump()
        directive_data["args"] = _decode_json_object_carrier(
            directive.args,
            field_name=f"directives[{index}].args",
        )
        data["directives"].append(directive_data)
    return PlanOut.model_validate(data)


def parse_plan_out_wire(payload: Mapping[str, Any]) -> PlanOut:
    """辞書 payload を wire schema 検証後に runtime PlanOut へ変換する。"""

    try:
        wire = PlanOutWire.model_validate(payload)
    except ValidationError:
        raise
    return wire_to_plan_out(wire)


class BarrierNotificationError(RuntimeError):
    """障壁通知生成で通信系エラーが発生したことを示す基底例外。"""


class BarrierNotificationTimeout(BarrierNotificationError):
    """Responses API 呼び出しが所定時間内に完了しなかったことを示す例外。"""


class BarrierNotification(BaseModel):
    """障壁通知用のメッセージをパースするためのスキーマ。"""

    message: str


class PreActionReview(BaseModel):
    """低確信度プランの確認質問を受け取る専用スキーマ。"""

    message: str


def normalize_directives(plan_out: PlanOut) -> None:
    """PlanOut 内の directives を手順と同期させる。"""

    directives: List[ActionDirective] = []
    for idx, step in enumerate(plan_out.plan):
        directive = plan_out.directives[idx] if idx < len(plan_out.directives) else ActionDirective()
        directive.directive_id = directive.directive_id or f"step-{idx + 1}"
        directive.step = directive.step or step
        if not directive.label:
            directive.label = directive.step[:24]
        if not directive.category:
            directive.category = plan_out.intent or ""
        directives.append(directive)

    plan_out.directives = directives


__all__ = [
    "ActionDirective",
    "ActionDirectiveWire",
    "BarrierNotification",
    "BarrierNotificationError",
    "BarrierNotificationTimeout",
    "ConstraintSpecWire",
    "ConstraintSpec",
    "CoordinatesWire",
    "ExecutionHint",
    "ExecutionHintWire",
    "GoalProfile",
    "GoalProfileWire",
    "PlanArguments",
    "PlanArgumentsWire",
    "PlanOut",
    "PlanOutWire",
    "PlanOutWireConversionError",
    "PreActionReview",
    "ReActStep",
    "ReActStepWire",
    "normalize_directives",
    "parse_plan_out_wire",
    "wire_to_plan_out",
]
