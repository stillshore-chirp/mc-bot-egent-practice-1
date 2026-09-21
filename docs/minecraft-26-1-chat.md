# 26.1系クライアントの日本語チャット接続

この文書は既存のPaper 1.21.11環境を維持したまま、Mac版Minecraft Java 26.1系でチャットを試すための構成と検証範囲を記録します。このリポジトリ全体の機能を再認定するものではありません。

## 版の組み合わせ

| 対象 | 版 | 役割 |
|---|---|---|
| Paper | 1.21.11 | サーバーとワールドを維持する |
| ViaVersion | 5.12.0 | 26.1系の新しいクライアントを1.21.11へ接続する |
| Mineflayer Bot | 1.21.11 | サーバー本来のプロトコルで接続する |
| Mac版Javaクライアント | 26.1系 | 日本語チャットを入力する |

新しいクライアントを古いサーバーへ接続する方向なので、ViaBackwardsは追加しません。Composeの`bridge`は`MODRINTH_PROJECTS=viaversion:5.12.0`でViaVersionの版を固定します。`MC_VERSION`はPaperとBotの共通版で、**26.1に変更しません**。既存の`.env`に値がある場合は`MC_VERSION=1.21.11`を確認してください。26.1系への対応範囲は[ViaVersionの版定義](https://github.com/ViaVersion/ViaVersion/blob/master/api/src/main/java/com/viaversion/viaversion/api/protocol/version/ProtocolVersion.java)と[5.12.0リリース](https://github.com/ViaVersion/ViaVersion/releases/tag/5.12.0)を参照してください。Composeのプラグイン指定方法は[itzgの公式文書](https://github.com/itzg/docker-minecraft-server/blob/master/docs/mods-and-plugins/modrinth.md)に従います。

Botの依存ライブラリに含まれる`minecraft-protocol`は26.1をサポートしていません。`minecraft-data`の版一覧だけを根拠に26.1をBotへ渡さず、両ライブラリが対応する1.21.11へフォールバックします。

## 適用境界

リポジトリのCompose設定を変更しても、すでに稼働しているPaperにはViaVersionは読み込まれません。既存サーバーへ反映する際は、ワールドのバックアップ、プラグインの導入、計画したサーバー再起動、版と接続の再確認が必要です。この作業で稼働中サーバーの更新や再起動は実施しません。

新しいワールドを使う隔離テストでは、Paper 1.21.11とViaVersion 5.12.0の起動後、クライアントを隔離ポートへ接続します。Macで日本語入力を有効にし、Minecraftのチャット欄で変換・確定後に送信します。「いまどこ？」への即時返信は同じ隔離サーバーに接続したNode Botで確認できます。Pythonエージェントが生成する応答も確認する場合は、Pythonエージェントを隔離したBotへ接続します。実運用サーバーのBotをテスト先へ切り替えません。

## 検証記録

2026-09-21、既存ワールドと別の一時ディレクトリを使い、Paper 1.21.11とViaVersion 5.12.0の起動を確認しました。サーバーステータス照会は1.21.11のプロトコル774と26.1のプロトコル775に、それぞれ要求版と同じ番号で応答しました。これはプラグインの読込とステータス変換の証跡です。

Mac版26.1クライアントの隔離サーバーへのログイン、日本語の直接入力と送信、同じ隔離サーバーへ接続したリポジトリのNode Botによる受信を確認しました。「いまどこ？」への現在位置返信はBotの送信イベントとクライアントの受信ログの両方で確認しました。BotのPythonエージェント経由の応答は、この検証に含めていません。

稼働中の既存サーバーにはViaVersionを適用していないため、既存ワールド上での26.1クライアント接続、日本語送信、Bot応答は未検証です。公開する証跡にサーバー住所、プレイヤー識別子、チャット全文、運用ログ原文を含めません。
