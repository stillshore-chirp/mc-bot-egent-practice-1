# Task Plan: issue-181-strict-planout-schema

## Metadata
- Owner: Codex
- Branch: `codex/issue-180-openai-base-url`
- Delivery: `#180/#181共同配送branch`（実branch: `codex/issue-180-openai-base-url`）
- Related issue / ticket: GitHub Issue #181
- Last updated (UTC): 2026-09-21
- Source status file（必要時）: N/A

## 1. 目的 (Goal)
- Responses Structured Outputs 用の PlanOut wire schema を strict 契約へ移行する。
- runtime の `coordinates`、`notes`、directive `args`、`backlog` の dict 契約と未知キーを adapter で維持する。

## 2. 非目標 (Non-goals)
- Minecraft/Mineflayer/Bridge の E2E（今回の runtime acceptance では executor/Minecraft 操作を行わない）。
- planner 以外の runtime protocol、モデル設定、JSON 互換経路の全面改修。
- commit、push、PR、merge、deploy。

## 3. 対象範囲 (Scope)
- 変更対象: `python/planner/models.py`、`python/planner/__init__.py`、`python/planner/graph.py`、必要時 `python/planner/prompts.py`、`tests/test_planner_responses_payload.py`、`tests/test_planout_strict_schema.py`。
- 契約: PlanOut の Responses schema、wire→runtime adapter、既存 legacy JSON parse。

## 4. マイルストーン
| ID | マイルストーン | 状態 (Done/Blocked/Cancelled) | メモ |
| --- | --- | --- | --- |
| M1 | strict wire DTO と adapter の設計・実装 | Done | 全 properties required、nullable、defaultなし、全 object strict |
| M2 | payload/parser/prompt の接続 | Done | PlanOut wire schema を payload の正本にした |
| M3 | 回帰テストと runtime acceptance | Done | Compose 3 services healthy、plan() 1回、strict schema/wire conversion 成功 |

## 5. 優先度付き小タスク
- [x] P0: strict DTO、座標固定 object、JSON文字列 carrier、明示的 decode validation。
- [x] P0: wire schema payload と response parser を接続し、legacy JSON 経路を維持する。
- [x] P1: recursive schema、round-trip、未知 args、malformed carrier、payload 回帰を追加する。
- [x] P2: wire 型説明を prompt と整合させる。

## 6. 受け入れ条件 (Acceptance Criteria)
- [x] `to_strict_json_schema` 出力が全 object `additionalProperties:false`、`required == properties`、defaultなし。
- [x] wire→runtime で座標、notes、directive args、backlog の既存 dict と未知キーを保持する。
- [x] 不正 carrier は空値へ黙って変換せず、明示的 validation error として既存安全 fallback へ流れる。
- [x] plan/replan の payload は wire schema を使い、恒久 `json_object` fallback を追加しない。
- [x] 関連 pytest が成功する。
- [x] runtime acceptance: Compose 3 services healthy、`plan()` 1回、strict schema accepted、wire converted、nonempty plan（3 steps/3 directives）、outcome success。executor/Minecraft 操作なし。
- [ ] Minecraft/Mineflayer/Bridge E2E は未実施のまま記録する。

## 7. 検証コマンド (Verification)
- [x] `.venv/bin/python -m pytest tests/test_planout_strict_schema.py tests/test_planner_responses_payload.py`
- [x] `.venv/bin/python -m pytest tests/test_langgraph_scenarios.py`
- [x] `git diff --check`

## 8. 基本スモークテスト
- 手順: fake Responses output で wire payload、未知 args、座標、notes、backlog、壊れた carrier を順に parse する。
- 期待結果: strict schema が gate し、valid payload は従来 PlanOut、invalid payload は明示的 parse failure/fallback になる。
- runtime acceptance 結果: Compose 3 services healthy、`plan()` 1回で strict schema accepted、wire converted、nonempty plan（3 steps/3 directives）、outcome success。executor/Minecraft 操作なし。

## 9. 再開コマンド
- `.venv/bin/python -m pytest tests/test_planout_strict_schema.py tests/test_planner_responses_payload.py`

## 10. 既知 Blocker
- なし。Minecraft/Mineflayer/Bridge E2E は未実施であり、必要時は別途明示承認を得る。

## 11. Feature Flag / Rollback（必要時のみ）
- Flag: なし。
- Rollback 手順: 変更した planner schema/adapter commit の revert を別途判断する。

## 12. ステータスログ
- 2026-09-21: 現行 PlanOut schema の default/map 違反、runtime field 利用、legacy normalize を確認。strict wire DTO 案で実装開始。
- 2026-09-21: strict wire DTO、JSON carrier adapter、payload/parser/prompt、recursive schema と round-trip 回帰を実装。対象3 suite 44 passed、diff check 成功。
- 2026-09-21: structured output の legacy fallback を禁止する明示境界、graph star export 回帰、carrier 型違反/不正 JSON の実 graph 回帰を追加。対象3 suite 47 passed。
- 2026-09-21: runtime acceptance を公開安全な粒度で確認。Compose 3 services healthy、`plan()` 1回、strict schema accepted、wire converted、3 steps/3 directives の nonempty plan、outcome success。executor/Minecraft 操作なし。Minecraft E2E は未実施。

## 13. 停止時の最終状態
- 最終状態: Done
- 停止理由（Blocked/Cancelled の場合は必須）: なし。strict schema と runtime acceptance は完了。
- 再開条件: Minecraft/Mineflayer/Bridge E2E が必要になった場合は明示承認を得る。
- 次の最短アクション: 親laneで差分と runtime 証跡を確認し、統合判断する。
