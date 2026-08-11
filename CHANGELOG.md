# Changelog

This project follows Semantic Versioning. Versions below `1.0.0` may include
incompatible changes.

## [Unreleased]

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
