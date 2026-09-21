# Task Plan: Issue #184 — 合流時のBot利用不可診断

## Metadata
- Owner: Codex
- Branch: `codex/issue-184-bot-state-diagnostics`
- Related issue: #184
- Last updated (UTC): 2026-09-21

## 1. 目的
- 合流が `rendezvous_bot_unavailable` で停止した判定箇所を、個人情報を含まない固定値のログから識別できるようにする。
- マージ済みの合流修正と診断コードを、許可されたローカルBotへ安全に反映し、接続と再試行の実環境結果を確認する。

## 2. 非目標
- 調査前に接続原因を断定すること、外部チャット文言・エラーコード・移動安全条件を変更すること。
- PaperやBridgeの設定変更・再起動、認証情報変更、Issue/PRのcloseやmerge。
- ワールド変更、危険地形への強制移動、ログへのプレイヤー名・座標・チャット・raw例外の記録。

## 3. 対象範囲
- Nodeの合流判定ログと回帰テスト、必要な設計記述。
- 元の稼働環境のread-only事前確認、許可されたBot更新・再起動、再観測。

## 4. マイルストーン
| ID | 内容 | 状態 | 確認点 |
| --- | --- | --- | --- |
| M1 | 原因候補と安全な反映手順を確定 | Done | 実ログとコード仮説を分離し、元作業ツリーを保護 |
| M2 | 固定スキーマ診断と回帰テスト | Done | 全5分岐、非漏洩、既存契約維持を確認 |
| M3 | commit・PR・CI・review | Pending | latest HEADの証跡 |
| M4 | ローカルBotへ反映し実環境再確認 | Pending | 接続・状態・実失敗段階・安全停止 |

## 5. 優先度付き小タスク
- [x] P0: `rendezvous_bot_unavailable` の全分岐に固定phaseログを付ける。
- [x] P0: 位置欠損・Bot欠損・移動中の欠損を回帰テストに固定する。
- [x] P0: ログへ機微情報を出さず、既存の安全停止を維持する。
- [ ] P1: Nodeテスト・ビルド、公開安全性、PR・CI・reviewを確認する。
- [ ] P1: 稼働環境を再観測後、Botだけを安全に更新・再起動し結果を確認する。

## 6. 受け入れ条件
- [x] fake Botで各失敗箇所を固定値の診断イベントから区別できる。
- [x] 公開エラーコード・応答回数・移動の安全判定を変えない。
- [x] 公開物と診断ログにチャット、対象識別子、座標、secret、raw例外を含めない。
- [ ] ローカルBotの実コードと接続状態を確認し、再試行の結果と未確認範囲を記録する。

## 7. 検証コマンド
- [x] `bash scripts/run-node-bot.sh test`（22 files / 228 tests passed）
- [x] `bash scripts/run-node-bot.sh build`
- [x] `git diff --check`
- [ ] latest HEADのCI・review・thread・mergeability確認
- [ ] Bot起動状態、接続状態、診断イベントのread-only照合

## 8. 基本スモークテスト
- 手順: fake Botで各欠損を再現し、公開エラーと固定診断を確認する。実環境では再起動後に接続と許可済みの再試行を確認する。
- 期待結果: 原因を決め打ちせず、失敗段階と安全停止を分類できる。

## 9. 再開コマンド
- `git status --short --branch`
- `gh issue view 184 --repo stillshore-chirp/mc-bot-egent-practice-1`
- `gh pr list --repo stillshore-chirp/mc-bot-egent-practice-1 --head codex/issue-184-bot-state-diagnostics`

## 10. 既知 Blocker
- 前回の実ログではBot利用不可の具体的なguardが識別できない。
- Paper BridgeのHTTP不調は別系統で、今回のエラーとの因果は未確定。

## 11. Rollback
- Bot再起動前の参照revisionと状態を確認し、異常ならBotの変更のみ元へ戻す。Paperやワールドは変更しない。

## 12. ステータスログ
- 2026-09-21: 固定エラー応答とMinecraft接続の同時観測を分離。Issue #184に診断範囲を記録し、最新mainから隔離worktreeを作成。
- 2026-09-21: 5分岐の固定診断と非漏洩回帰を追加。Node 22 files / 228 tests、build、diff checkを確認。反証レビューでP0/P1なし。実環境の原因は未確定。

## 13. 停止時の最終状態
- 最終状態: In progress
- 停止理由:
- 再開条件:
- 次の最短アクション: 診断コードと安全なBot反映手順を確認する。
