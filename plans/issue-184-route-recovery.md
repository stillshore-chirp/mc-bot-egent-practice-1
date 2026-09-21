# Task Plan: Issue #184 — 合流経路の安全な再選択

## Metadata
- Owner: Codex
- Branch: `codex/issue-184-route-recovery`
- Related issue: #184
- Last updated (UTC): 2026-09-21

## 1. 目的
- 実ゲームで観測した経由地点の床条件による即時停止と、区間移動の時間超過を切り分け、安全な経由地点がある場合に合流を継続できるようにする。
- 安全停止と非漏洩の診断を維持し、許可されたNode Bot単体の再起動後に実環境で確認する。

## 2. 非目標
- 未観測・液体・危険地形を通行可能として扱うこと、時間制限を根拠なく延長すること、無制限に再試行すること。
- Paper/Pythonの再起動、Bridge設定・権限・認証情報の変更、保護領域の推定、Issue/PRのcloseやmerge。
- プレイヤー識別子、精密座標、チャット本文、実ログ原文を公開物へ残すこと。

## 3. 対象範囲
- Nodeの合流waypoint選択、区間timeout診断、対応する回帰テスト。
- 仕様の変更点を移動設計文書へ反映し、Node単体の実環境観測を記録する。
- WebSocketの公開エラー、チャット文言、Python/Bridgeの契約は維持する。

## 4. マイルストーン
| ID | マイルストーン | 状態 | メモ |
| --- | --- | --- | --- |
| M1 | 実ログと最新mainを照合 | Done | 合流命令は到達。床条件停止と約30秒のtimeoutを区別 |
| M2 | 安全な候補選択・固定値診断と回帰テスト | Pending | 危険・未観測では従来通り停止 |
| M3 | Bot単体の反映と再観測 | Pending | ユーザーはBotのみ再起動を許可。world操作は別判断 |
| M4 | commit・PR・latest HEAD CI・review | Pending | 既存Issue #184を参照 |

## 5. 優先度付き小タスク
- [ ] P0: 同じ高さの対象でも安全な1段上下候補を検査する回帰と実装。
- [ ] P0: 液体・未知・2段差ではfail-closedを維持する。
- [ ] P1: timeoutの発生源・停止処理を固定分類だけで診断する。
- [ ] P1: Node test/build、公開安全性、実環境のread-only事前・事後観測を確認する。
- [ ] P1: 最新HEADのCI・review・thread・mergeabilityを確認する。

## 6. 受け入れ条件
- [ ] 安全な同列1段候補では`goto`を開始でき、危険・未観測候補では開始しない。
- [ ] timeout時の診断は発生源と停止処理を区別し、プレイヤーやworldの実値を含まない。
- [ ] 公開エラー、チャット、既存の移動安全条件を維持する。
- [ ] 実ゲーム再試行の結果を観測事実と未確認事項に分ける。

## 7. 検証コマンド
- [ ] `bash scripts/run-node-bot.sh test`
- [ ] `bash scripts/run-node-bot.sh build`
- [ ] `git diff --check`
- [ ] latest HEADのCIとPR review/thread確認
- [ ] Bot接続・位置・周辺hazard・再呼びかけ結果のread-only確認

## 8. 基本スモークテスト
- 手順: 修正前に失敗するfake Bot回帰を確認し、修正後に安全な1段候補だけ移動が始まることを確認する。実ゲームではBotのみ再起動してread-only状態を再観測し、ユーザーによる1回の呼びかけを照合する。
- 期待結果: 到達または固定理由による安全停止。接続状態とtimeout発生源を取り違えない。

## 9. 再開コマンド
- `git status --short --branch`
- `gh issue view 184 --repo stillshore-chirp/mc-bot-egent-practice-1`
- `gh pr list --repo stillshore-chirp/mc-bot-egent-practice-1 --head codex/issue-184-route-recovery`

## 10. 既知 Blocker
- 実worldの候補ブロック詳細と保護領域は未確認。読み取り専用の照会で確認できない場合、Codexから移動命令を出さない。
- 約30秒timeoutの実際の停止箇所は、現行ログだけでは確定できない。

## 11. Rollback
- Node Botのみ前の診断版bind mountへ戻す。Paper/Pythonとworldを変更しない。

## 12. ステータスログ
- 2026-09-21: PR #188はmainへマージ済み。実ゲームの合流命令はBotへ届くが、経由地点の床条件による即時停止と約30秒のtimeoutが残る。Botの接続と位置取得は確認済み。ユーザーは修正後のNode Bot単体再起動を許可。

## 13. 停止時の最終状態
- 最終状態: In progress
- 停止理由:
- 再開条件:
- 次の最短アクション: 安全な候補選択の回帰テストと実装を確認する。
