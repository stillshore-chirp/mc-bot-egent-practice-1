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
- Nodeの合流判定ログと回帰テスト、ステータス送信ログ・spanの最小化、必要な設計記述。
- 元の稼働環境のread-only事前確認、許可されたBot更新・再起動、再観測。

## 4. マイルストーン
| ID | 内容 | 状態 | 確認点 |
| --- | --- | --- | --- |
| M1 | 原因候補と安全な反映手順を確定 | Done | 実ログとコード仮説を分離し、元作業ツリーを保護 |
| M2 | 固定スキーマ診断と回帰テスト | Done | 全5分岐、非漏洩、既存契約維持を確認 |
| M3 | commit・PR・CI・review | Done | 診断実装HEADはCI成功・review指摘なし。記録のみの追加commit後もlatest HEADを確認する |
| M4 | ローカルBotへ反映し実環境再確認 | Blocked | Bot単体の更新・接続・状態確認は完了。再呼びかけ未観測で失敗段階は未確定 |

## 5. 優先度付き小タスク
- [x] P0: `rendezvous_bot_unavailable` の全分岐に固定phaseログを付ける。
- [x] P0: 位置欠損・Bot欠損・移動中の欠損を回帰テストに固定する。
- [x] P0: ログへ機微情報を出さず、既存の安全停止を維持する。
- [x] P1: ステータス応答のNode送信ログ・spanを固定値化し、wire応答を維持する。
- [x] P1: Nodeテスト・ビルド、公開安全性、診断実装HEADのPR・CI・reviewを確認する。
- [x] P1: 稼働環境を再観測後、Botだけを安全に更新・再起動して接続・状態を確認する。
- Blocked: ゲーム内からの再呼びかけ結果と診断イベントの照合。

## 6. 受け入れ条件
- [x] fake Botで各失敗箇所を固定値の診断イベントから区別できる。
- [x] 公開エラーコード・応答回数・移動の安全判定を変えない。
- [x] 公開物と診断ログにチャット、対象識別子、座標、secret、raw例外を含めない。
- [x] ローカルBotの実コードと接続状態を確認し、再試行が未観測である範囲を記録する。

## 7. 検証コマンド
- [x] `bash scripts/run-node-bot.sh test`（22 files / 230 tests passed）
- [x] `bash scripts/run-node-bot.sh build`
- [x] `git diff --check`
- [x] 診断実装HEAD `16fd3e8` のCI成功、review・threadなし、mergeableを確認
- [x] Bot起動・Minecraft接続・read-onlyの位置、所持品、周辺状態を確認
- 作業記録更新後のlatest HEADのCI・review・thread・mergeabilityはcommit後にPRで確認する。
- Blocked: ゲーム内からの再呼びかけ後の診断イベント照合。

## 8. 基本スモークテスト
- 手順: fake Botで各欠損を再現し、公開エラーと固定診断を確認する。実環境では再起動後に接続と許可済みの再試行を確認する。
- 期待結果: 原因を決め打ちせず、失敗段階と安全停止を分類できる。

## 9. 再開コマンド
- `git status --short --branch`
- `gh issue view 184 --repo stillshore-chirp/mc-bot-egent-practice-1`
- `gh pr list --repo stillshore-chirp/mc-bot-egent-practice-1 --head codex/issue-184-bot-state-diagnostics`

## 10. 既知 Blocker
- 再呼びかけ未観測のため、追加した診断イベントで実環境のguardをまだ識別できない。
- Paper BridgeのHTTP不調は別系統で、今回のエラーとの因果は未確定。

## 11. Rollback
- Bot再起動前の参照revisionと状態を確認し、異常ならBotの変更のみ元へ戻す。Paperやワールドは変更しない。

## 12. ステータスログ
- 2026-09-21: 固定エラー応答とMinecraft接続の同時観測を分離。Issue #184に診断範囲を記録し、最新mainから隔離worktreeを作成。
- 2026-09-21: 5分岐の固定診断と非漏洩回帰を追加。Node 22 files / 228 tests、build、diff checkを確認。反証レビューでP0/P1なし。実環境の原因は未確定。
- 2026-09-21: 実ステータス照会前にNodeのgatherStatus送信ログが完全な応答を記録し得ると判明。ログ・spanを固定値化し、wire応答を維持する回帰を追加。Node 22 files / 230 tests、build、diff checkを確認。Python側など別の呼び出し元は返答を別途ログへ書き得るため、実運用ではNodeへの直接照会を要約表示する。
- 2026-09-21: PR #188の診断実装HEAD `16fd3e8` でPython・Node・BridgeのCI成功、Codex review/comment/threadなし、mergeableを確認。Paper/Pythonを再起動せずNode Botのみ診断ブランチへ切り替え、Minecraftへの再接続とspawnを確認した。Nodeへ直接行ったread-only照会で位置・所持品・周辺環境が取得可能、体力・満腹度は最大、観測範囲の液体・空洞・敵対Mobは0。Bridge HTTPが使えず保護領域を確認できないため、Codexから移動命令は出していない。ゲーム内からの再呼びかけの結果は未観測。

## 13. 停止時の最終状態
- 最終状態: Blocked（診断実装とNode再接続は完了。再現結果の確認待ち）
- 停止理由: ゲーム内からの再呼びかけが未観測で、実環境の失敗分岐と合流結果を確定できない。Bridge HTTPが使えず、Codexからの移動命令に必要な保護領域確認もできない。
- 再開条件: ユーザーがゲーム内で「come here」を一度送信し、その旨を共有する。または保護領域をread-onlyで確認できる環境が整う。
- 次の最短アクション: 送信後のNode/Pythonログから固定診断イベントと応答コードのみを照合し、Issue #184へ公開安全な結果を追記する。
