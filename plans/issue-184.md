# Task Plan: Issue #184 — 話者への安全な合流と製品目標像

## Metadata
- Owner: Codex
- Branch: `codex/come-here-player-rendezvous`
- Related issue / ticket: #184
- Last updated (UTC): 2026-09-21

## 1. 目的 (Goal)
- チャット話者の「こっちに来て」に対し、ゲーム内で観測できる話者とボットの位置を使い、安全に合流する。
- 視覚・聴覚・座標付きの客観的な局所観測記憶を核とする目標像を、現状と区別して文書化する。

## 2. 非目標 (Non-goals)
- 画像・音声知覚および長期空間記憶の一括実装。
- 許可なしの実ゲーム移動、永続データの削除・移行、READMEの廃止方針の撤回。

## 3. 対象範囲 (Scope)
- Pythonのチャット→計画→実行経路、Nodeのプレイヤー位置・移動契約、Paper Bridgeの認証付き位置照会、関連テスト。
- `docs/product_vision.md`、READMEの文書導線、必要な移動設計文書。
- 影響を受ける契約: Python/Node WebSocket command/result、Paper Bridge HTTP位置照会、チャット応答の送信回数。

## 4. マイルストーン
| ID | マイルストーン | 状態 | メモ |
| --- | --- | --- | --- |
| M1 | 実環境観測と実装契約・重複原因の切り分け | Done | 1入力・3件の状態照会・2応答・追従0件。重複の有力経路とNodeコマンド欠落を確認 |
| M2 | 話者への合流と異常系・重複応答の修正 | Done | Paper位置照会、Node有界合流・180秒deadline・同一Bot移動ロック、Python話者routing・210秒受信待機・一意通知。Java/Node/Pythonテスト通過、実ゲームE2Eは未実施 |
| M3 | 製品目標像と現状の境界を文書化 | Done | `docs/product_vision.md`を追加し、READMEの廃止記載を保持 |
| M4 | 検証、自己レビュー、非Draft PR配送 | Done | コードHEAD `2953dcf` の3 CI成功、mergeable、レビュー・コメント・thread 0件を確認。計画書最終コミット後も最新HEADを再確認する |

## 5. 優先度付き小タスク
- [x] P0: 話者の同定、対象位置取得、合流経路、安全停止。
- [x] P0: 単一入力に対する重複応答の再現テストと修正。
- [x] P0: Python/Nodeのコマンドと結果契約を揃える。
- [x] P0: Mineflayerの追跡範囲外に備え、Paper側の認証付き位置照会とNode fallbackを加える。
- [x] P1: 失敗理由と回復手段が分かるチャット応答。
- [x] P1: ユーザー提示の製品目標像を明文化する。

## 6. 受け入れ条件 (Acceptance Criteria)
- [x] Issue #184の5つの受け入れ条件を、各テスト・文書・実環境証跡に対応付ける。
- [x] 実ゲームでの移動が未許可なら未検証範囲として明記する。

| Issue受け入れ条件 | 現時点の証跡と境界 |
| --- | --- |
| 話者同定・座標再入力なしの合流開始 | Python `tests/test_chat_pipeline.py`の実Orchestratorスタブ経路、Node `navigationController.test.ts`の近距離Entity/遠距離Bridge経路、Paper resolver/handlerテスト。実ゲーム到着は未検証 |
| 移動・離脱・位置未取得・経路なし・危険停止と一意通知 | Node `navigationController.test.ts`・`playerPositionBridge.test.ts`、Python `test_move_handler.py`・`test_chat_pipeline.py`。実地形での安全判断は未検証 |
| 二重応答を出さない | Python `test_chat_pipeline.py`のchat確認分岐と合流失敗/成功の送信回数テスト。実行時のplanner分岐値は未観測 |
| Python/Node契約と境界・異常テスト | `followPlayer`ディスパッチ、固定`rendezvous_*`結果、Node全184件・Python全184件・Bridgeテスト成功。通信断の結果は未確認として通知 |
| 視覚・聴覚・客観記憶の目標像 | `docs/product_vision.md`、README導線、移動設計の現状/目標/未検証の分離 |

## 7. 検証コマンド (Verification)
- [x] `bash scripts/run-node-bot.sh test` — 22 files / 184 passed、Node build成功
- [x] `python -m pytest tests`（既存環境のvenv入口）— 184 passed
- [x] `bash scripts/build-bridge-plugin.sh` — 成功、Bridge Javaテスト成功
- [x] `docker compose --profile paper -f docker-compose.yml -f docker-compose.paper.yml config --quiet` — 成功。起動・実ワールド移動は未実施
- [x] `git diff --check`
- [x] 文書のリンクと公開安全性の確認。

## 8. 基本スモークテスト
- 手順: スタブ化したチャット受信→話者解決→移動コマンド→結果通知を通す。実ゲーム操作は別途明示許可後。
- 期待結果: 正常系は座標再入力を要求せず合流を開始し、異常系は安全に停止して結果を一度だけ通知する。

### チャット UI/UX の状態確認

| 状態 | プレイヤーに見える意味と次の行動 | 検証 |
| --- | --- | --- |
| 受理・安全確認中 | 呼びかけを受け、合流可能か調べている | Python 回帰テスト |
| 到着 | 話者に合流したことを一度だけ通知する。座標は表示しない | Python/Node 正常系テスト |
| 話者不在・位置未取得 | 対象や位置を解決できない理由を示し、再呼びかけを案内する | Python/Node 異常系テスト |
| 危険・経路なし・距離上限 | 移動を停止したことと、対象の近くで再試行する選択肢を示す | Python/Node 境界テスト |
| 競合中・処理時間超過 | 別の移動を重ねず安全停止し、再試行の条件を示す | Python/Node 競合・deadlineテスト |
| 状態観測失敗 | 安全確認できないため移動を開始せず、接続確認を案内する | Python 回帰テスト |
| 通信断・結果未確認 | 到着や停止を断定せず、Botの接続・動作状況の確認を案内する | Python 通信異常テスト。実ゲーム未検証 |

初見のプレイヤーは座標や対象名を入力せずに呼びかけられ、受理・結果・停止理由をチャットの文面だけで判別できる。色、アイコン、視覚的配置に依存せず、Minecraft の既存チャット入力・読み上げ設定を変更しない。熟練者も再入力なしで同じ短い導線を使える。反証側では、二重通知、到着未確認なのに成功通知、失敗時の無断再計画、位置や生ログの露出、危険時の掘削継続を重点的に確認する。実ゲームの画面・キーボード操作・音声読み上げは未検証であり、テスト結果を実画面の証拠に置き換えない。

## 9. 再開コマンド
- `git switch codex/come-here-player-rendezvous`
- `git status --short --branch`
- `gh issue view 184 --repo stillshore-chirp/mc-bot-egent-practice-1`

## 10. 既知 Blocker
- 実ゲーム移動によるE2Eは、明示許可がない限り実施しない。
- 重複応答の旧実行時plannerフラグは未観測。コード上の二重送信経路を修正し、回帰テストで送信責務を固定した。実ゲームでの再確認は未実施。

## 11. Feature Flag / Rollback
- Flag: 既存の起動・コマンド境界を維持し、必要時に対象commitをrevertする。
- Rollback 手順: ワールドや永続記憶への操作を伴わないコード・文書変更を責務単位で戻す。

## 12. ステータスログ
- 2026-09-21: mainを最新化し作業ブランチを作成。Issue #184作成。実環境では1入力、3件の位置収集、2件の同趣旨応答、移動実行0件を観測。Nodeの`followPlayer`未配線とPythonの二重送信経路を確認。実行時のplanner分岐値は未観測として保持。遠距離のEntity欠損に備えるPaper照会を追加スコープとしてIssueへ記録。
- 2026-09-21: Paper・Node・Pythonの合流契約と異常系テストを追加。Bridge Javaテスト/ビルド、Node 167件/ビルド、Python 157件、Compose構成、diff checkが成功。実ゲームE2Eは許可待ちとして未実施。製品目標像を文書化し、UI/UXの状態・反証観点を記録。
- 2026-09-21: 反証レビューで判明したtimeout後の移動継続、移動競合、伝言の誤昇格、Python/Nodeの待機時間不整合を修正。さらに明確な呼び寄せと誤分類された伝言のログ経路で、話者名・原文・対象名が残らないよう再点検し、ChatQueue、前回チャットsnapshot、実plannerの正常/異常ログ回帰テストを追加した。Node 184件/ビルド、Python 184件、diff checkが成功。非Draft PR #185 に変更と検証結果を反映した。コードHEAD `2953dcf` のPython・Node・Bridge CIはすべて成功、mergeable、レビュー・コメント・thread は0件。実ワールド操作は未実施。

## 13. 停止時の最終状態
- 最終状態: Done（実装・文書・PR配送）。実ワールドE2Eのみ Blocked（操作許可待ち）。Issue #184はOpenを維持。
- 停止理由: 実ワールド移動を含むE2Eは明示許可がないため実施しない。
- 再開条件: ワールド操作の対象・範囲についてユーザーから明示許可があること。
- 次の最短アクション: 計画書の最終コミット後に最新HEADのCI・PRレビューを再確認し、許可が得られた場合のみ実ワールドE2Eを行う。
