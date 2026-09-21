# Node 側が受け付ける JSON コマンド（WS 経由）

- chat: `{ "type": "chat", "args": { "text": "こんにちは" } }`
- moveTo: `{ "type": "moveTo", "args": { "x": 100, "y": 64, "z": -30 } }`
- equipItem: `{ "type": "equipItem", "args": { "toolType": "pickaxe", "destination": "hand" } }`
- mineBlocks: `{ "type": "mineBlocks", "args": { "positions": [{"x":1,"y":64,"z":-3}] } }`
- placeBlock: `{ "type": "placeBlock", "args": { "block": "oak_planks", "position": {"x":2,"y":65,"z":5}, "face": "north", "sneak": true } }`
- followPlayer: `{ "type": "followPlayer", "args": { "target": "ExamplePlayer", "stopDistance": 2, "maintainLineOfSight": true } }`（完全一致で解決したオンライン対象への一回限りの合流。近距離entityまたは認証済みPaper Bridge位置照会を使い、遠距離は最大16区間の短いwaypointへ分割して再観測する。合流全体には既定180秒の絶対deadlineがあり、約256ブロック相当の区間上限またはdeadline内に到着を確認できない場合は成功にしない。掘削fallbackなし。`maintainLineOfSight:true` は到着直前の再観測を要求し、移動中の連続視線追従は提供しない。`false` は `rendezvous_line_of_sight_unsupported` で拒否する。同一Botへの合流実行中は `rendezvous_busy` を返し、`moveTo` 実行中は同じコードで合流を拒否する。合流中の`moveTo`は `navigation_busy` を返す。timeout/deadline時は停止操作と有限graceを経て、gotoが解消しない場合にBotを切断する。失敗時は `rendezvous_*` の固定エラーコードを返し、チャット本文・対象名・座標をログへ残さない）
- attackEntity: `{ "type": "attackEntity", "args": { "target": "zombie", "mode": "melee", "chaseDistance": 6 } }`
- craftItem: `{ "type": "craftItem", "args": { "item": "oak_planks", "amount": 3, "useCraftingTable": false } }`
- mineOre: `{ "type": "mineOre", "args": { "ores": ["redstone_ore"], "scanRadius": 12, "maxTargets": 3 } }`
