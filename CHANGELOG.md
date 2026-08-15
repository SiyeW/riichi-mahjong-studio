# Changelog

This project follows Semantic Versioning. Versions below `1.0.0` may include
incompatible changes.

## [Unreleased]

<div lang="zh-CN">

### 中文

- 修复无法加载声明立直麻将引擎协议 2.1 的引擎程序包的问题。同一引擎中无法使用的输出不再影响其他兼容输出。
- 修复牌山面板在加载完成后宽度突变的问题。
- 修复引擎管理中深青色和深灰色条目在选中后无法区分的问题。

</div>

<div lang="ja-JP">

### 日本語

- リーチ麻雀エンジンプロトコル 2.1 を宣言するエンジンパッケージを読み込めない問題を修正しました。同じエンジンに利用できない出力が含まれていても、対応するほかの出力は引き続き使用できます。
- 牌山パネルの読み込み完了時に横幅が変わる問題を修正しました。
- エンジン管理で、濃い青緑色と濃い灰色の項目が選択時に同じ色になる問題を修正しました。

</div>

<div lang="en-US">

### English

- Fix loading of engine packages that declare Riichi Engine Protocol 2.1. Unsupported outputs no longer prevent other compatible outputs from the same engine from being used.
- Fix the wall panel changing width when loading completes.
- Fix dark teal and dark gray items becoming indistinguishable when selected in the engine manager.

</div>

## [0.4.0] - 2026-08-15

<div lang="zh-CN">

### 中文

- 支持对局练习和牌谱研究，可以回看牌局、建立分支并为节点添加评注。
- 支持打开和保存 `.mjtrain` 存档，以及导入 Mortal 在线分析和天凤自定义牌谱。导入后可以重建未知牌山并进入对局模式。
- 兼容立直麻将引擎协议 v2。可以分别选择每项输出使用的引擎，同一引擎也可以同时提供多项输出。
- 支持动作推荐、对手向听预测和牌张铳率预测。评估表可以显示指标名称和引擎提供的附加数据。
- 可以根据输出能力筛选引擎，分别加载或卸载已配置的引擎，并在下次启动时恢复此前的加载状态。
- 支持安装和选择外部音效包。
- 改进跳过鸣牌和其他响应选择在牌局分支与分析结果中的显示。
- 增加牌桌位置设置，并改进引擎管理、设置界面和程序状态显示。
- 改进未保存牌谱的恢复；如果关闭程序时仍有未保存的修改，下次启动时可以从关闭的位置继续。
- 重写使用和开发文档，提供中文、日文和英文版本。发布包附带主程序许可证和第三方许可文件。

</div>

<div lang="ja-JP">

### 日本語

- 対局練習と牌譜検討に対応し、対局の振り返り、分岐の作成、ノードへのコメント記録ができます。
- `.mjtrain` 形式の牌譜を開いて保存できるほか、Mortal オンライン解析と天鳳カスタム牌譜をインポートできます。インポート後は、未確定部分の牌山を再構築して対局モードへ移ることもできます。
- リーチ麻雀エンジンプロトコル v2 に対応しました。出力ごとに使用するエンジンを選択でき、1 つのエンジンに複数の出力を割り当てることもできます。
- 行動選択、対戦相手のシャンテン状態、牌ごとの放銃率を解析できます。評価表には、指標名とエンジンが提供する追加データも表示されます。
- 対応する出力でエンジンを絞り込み、設定済みのエンジンを個別に読み込みまたは解除できます。終了時に読み込まれていたエンジンは、次回起動時に復元されます。
- 外部効果音パックを導入して選択できます。
- 鳴きを見送った場面やその他の応答選択について、牌譜の分岐と解析結果での表示を改善しました。
- 牌卓の位置設定を追加し、エンジン管理、設定画面、アプリケーションの状態表示を改善しました。
- 未保存の牌譜を復元できるよう改善しました。変更を保存せずに終了した場合は、次回起動時に終了した位置から再開できます。
- 利用者向けおよび開発者向けドキュメントを書き直し、中国語、日本語、英語で提供します。配布パッケージには、本体のライセンスと第三者ライセンスの文書も収録しています。

</div>

<div lang="en-US">

### English

- Add play and research workflows for reviewing games, creating branches, and recording comments on individual nodes.
- Open and save `.mjtrain` records, and import Mortal online analysis and Tenhou custom game records. Unknown walls can be reconstructed after import so that the game can be continued in play mode.
- Add support for Riichi Engine Protocol v2. Users can assign an engine to each output separately or use one engine for multiple outputs.
- Support action recommendations, opponent shanten predictions, and tile-specific deal-in probability predictions. The evaluation table also shows metric names and additional data supplied by engines.
- Filter engines by their available outputs and load or unload each configured engine independently. Engines that were loaded when the application closed are restored on the next launch.
- Install and select external sound packs.
- Improve how skipped calls and other reaction choices appear in game branches and analysis results.
- Add table-position settings and improve engine management, application settings, and status information.
- Improve recovery of unsaved records. If the application closes with unsaved changes, the next session can continue from the same position.
- Rewrite the user and development documentation in Chinese, Japanese, and English. Release packages include the application license and third-party license files.

</div>

## [0.4.0-alpha.3] - 2026-08-12

<div lang="zh-CN">

### 中文

- 兼容立直麻将引擎协议 v2 草案。一个引擎可以提供多种分析结果，用户可以分别选择每项受支持的结果由哪个引擎提供。
- 可以根据引擎提供的结果筛选和选择引擎，并分别加载或卸载各个已配置的引擎。
- 评估表现在会显示指标名称，以及引擎提供的附加数据。
- 牌桌位置可以选择靠左、居中或靠右，并保持一致的边距。
- 改进对跳过鸣牌和其他响应选择的处理与分析。
- 下次启动时恢复程序关闭前仍处于加载状态的引擎。
- 在状态栏显示程序内存和系统可用内存。
- 改进关闭程序时对未保存牌谱的恢复。

</div>

<div lang="ja-JP">

### 日本語

- リーチ麻雀エンジンプロトコル v2 ドラフトに対応しました。1つのエンジンから複数種類の分析結果を受け取り、対応する結果ごとに使用するエンジンを選べます。
- エンジンが提供する結果で絞り込み、設定済みの各エンジンを個別にロードまたはアンロードできます。
- 評価表に指標名とエンジンが提供する追加データを表示します。
- 牌卓の位置を左、中央、右から選択でき、端との間隔も統一しました。
- 鳴きを見送った場面やその他の応答選択の処理と分析を改善しました。
- 終了時にロードされていたエンジンを次回起動時に復元します。
- ステータスバーにアプリの使用メモリとシステムの空きメモリを表示します。
- アプリ終了時の未保存牌譜の復元を改善しました。

</div>

<div lang="en-US">

### English

- Add support for the Riichi Engine Protocol v2 draft. Engines may provide
  several kinds of analysis, and users can choose which engine supplies each
  supported result.
- Make it easier to filter and select engines by the results they provide, and
  load or unload each configured engine independently.
- Improve the decision evaluation table to show metric names and additional
  data provided by engines.
- Add left, center, and right table-position options with consistent edge
  spacing.
- Improve the handling and analysis of skipped calls and other reaction choices.
- Restore engines that were loaded when the application was last closed.
- Show application memory and available system memory in the status bar.
- Improve recovery of unsaved records when closing the application.

</div>

## [0.4.0-alpha.2] - 2026-08-05

- Add discovery and configuration of external engine and model packages through
  Riichi Engine Protocol.
- Add discoverable sound packs and sound-pack selection in the application
  settings.
- Improve game-record importing, wall reconstruction, branching, and storage
  efficiency.
- Improve the unloaded state, application title, settings layout, and licensing
  information shown in the application.
- Rewrite the project documentation in multiple languages, and add reproducible
  local development, testing, debugging, and Windows build workflows.
- Include the application license and third-party attribution in packaged
  application resources.

## [0.4.0-alpha.1] - 2026-08-02

- Initial development release.
- Add branching game records, decision analysis, opponent analysis, and engine
  package management.
- Add external game-record import and export.
