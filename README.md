[English](#english) | [中文](#%E4%B8%AD%E6%96%87) | [日本語](#%E6%97%A5%E6%9C%AC%E8%AA%9E)

---

## English

### Riichi Mahjong Studio

A desktop application for studying and practicing Riichi Mahjong. It can import
and export game records, load third-party engines, and assign their outputs to
decision analysis, opponent shanten prediction, and tile-specific deal-in risk.

Still in early development, with more engine capabilities and protocol
refinements planned. Feedback, discussion, and code contributions are welcome.

Engines and model weights are distributed separately. Install a compatible
engine package and any model it requires to use the corresponding analysis
features. Source code for the companion opponent-analysis engine is available in
[`riichi-opponent-analysis`](https://github.com/SiyeW/riichi-opponent-analysis);
trained model weights are not included.

Engine communication and package formats are defined in
[`riichi-engine-protocol`](https://github.com/SiyeW/riichi-engine-protocol).
Third-party engine development is welcome.

### Development

#### Requirements

- Node.js 22 or newer
- Miniconda, Miniforge, or another Conda-compatible environment manager
- Windows PowerShell for Windows packaging

#### Install the Node.js dependencies

```powershell
npm ci
```

#### Create the Python backend environment

Backend development and packaging use a project-local environment:

```powershell
.\setup-environment.ps1
```

The development launcher uses `.conda-backend` automatically. To override it,
set `MJAI_BACKEND_PYTHON` in `.vscode/launch.local.env`.

#### Run the application

```powershell
npm run dev
```

Starts Vite and Electron together. Engines, models, game records, logs, and
runtime configuration created during development are ignored by Git.

#### Run the checks

```powershell
npm run type-check
npm run build
$tests = Get-ChildItem -LiteralPath electron -Filter '*.test.js' -Recurse |
  Select-Object -ExpandProperty FullName
node --test $tests
$env:PYTHONPATH = (Resolve-Path 'python\environment').Path
.\.conda-backend\python.exe -m unittest discover -s python\environment -p 'test_*.py'
Remove-Item Env:PYTHONPATH
```

#### Debug with VS Code

Copy `.vscode/launch.local.env.example` to `.vscode/launch.local.env`, select
`RMS: Debug`, and press F5.

### Build the Windows application

Build the Python backend only:

```powershell
npm run build:backend:win
```

Output: `release/backend/environment-service/`

Build the complete unpacked Windows application:

```powershell
npm run package:win
```

Output: `release/electron/`

The package includes the backend, application license, and third-party notices,
but not engine runtimes, model weights, game records, or local configuration.

### Local configuration

Copy `config.example.json` to `config.json` if local configuration is needed.
Local settings and installed engines do not affect tracked source or packaged
output.

### Terminology

See [`docs/terminology.md`](docs/terminology.md).

### License

Licensed under the Apache License 2.0. Third-party code and assets retain their
respective licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

---

## 中文

### 立直麻将研究室

一款用于立直麻将对局研究和对战练习的桌面程序，支持导入、导出外部牌谱，也可以加载第三方引擎，并分别使用它们提供的结果进行决策分析、对手向听预测和各牌张的放铳风险预测。

目前仍处于早期开发阶段，引擎协议和支持的功能还会继续完善。欢迎试用、提交 Issue、参与讨论和贡献代码！

引擎和模型权重需要另行安装。我们制作的对手分析引擎源码位于 [`riichi-opponent-analysis`](https://github.com/SiyeW/riichi-opponent-analysis) 仓库，其中暂不提供训练完成的模型权重。

引擎通信协议和程序包格式在 [`riichi-engine-protocol`](https://github.com/SiyeW/riichi-engine-protocol) 仓库中维护。欢迎开发兼容的第三方引擎！

### 开发环境

#### 前置要求

- Node.js 22 或更高版本
- Miniconda、Miniforge 或其他兼容 Conda 的环境管理工具
- Windows PowerShell，用于 Windows 打包

#### 安装 Node.js 依赖

```powershell
npm ci
```

#### 创建 Python 后端环境

后端开发和打包使用项目目录内的独立环境：

```powershell
.\setup-environment.ps1
```

开发启动器会自动使用 `.conda-backend`。如需使用其他兼容的 Python 可执行文件，请在 `.vscode/launch.local.env` 中设置 `MJAI_BACKEND_PYTHON`。

#### 启动程序

```powershell
npm run dev
```

该命令会同时启动 Vite 开发服务器和 Electron 主程序。开发时安装或生成的引擎、模型、牌局存档、日志和运行时配置均不受 Git 跟踪。

#### 运行检查

```powershell
npm run type-check
npm run build
$tests = Get-ChildItem -LiteralPath electron -Filter '*.test.js' -Recurse |
  Select-Object -ExpandProperty FullName
node --test $tests
$env:PYTHONPATH = (Resolve-Path 'python\environment').Path
.\.conda-backend\python.exe -m unittest discover -s python\environment -p 'test_*.py'
Remove-Item Env:PYTHONPATH
```

#### 使用 VS Code 调试

将 `.vscode/launch.local.env.example` 复制为 `.vscode/launch.local.env`，然后选择 `RMS: Debug` 并按 F5。

### 构建 Windows 应用程序

只构建 Python 后端：

```powershell
npm run build:backend:win
```

输出目录：`release/backend/environment-service/`

构建完整的 Windows 免安装目录版：

```powershell
npm run package:win
```

输出目录：`release/electron/`

打包内容包括主程序后端、许可证和第三方声明，不包括引擎运行时、模型权重、牌局存档和本地配置。

### 本地配置

如需本地配置，可将 `config.example.json` 复制为 `config.json`。调整本地设置或安装本地引擎不会影响仓库代码和打包结果。

### 术语表

详见 [`docs/terminology.md`](docs/terminology.md)。

### 许可证

采用 Apache License 2.0。第三方代码和素材适用各自的许可条款，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

---

## 日本語

### Riichi Mahjong Studio

リーチ麻雀の牌譜検討や対戦練習に使えるデスクトップアプリケーションです。
外部牌譜のインポートとエクスポートに対応し、サードパーティー製エンジンの出力を
意思決定の分析、対戦相手のシャンテン状態、牌ごとの放銃リスクの予測に割り当てられます。

現在は初期開発段階です。今後もエンジンプロトコルを整備し、対応機能を増やして
いく予定です。フィードバック、議論への参加、コードへの貢献を歓迎します。

エンジンとモデルの重みは別途インストールしてください。対戦相手分析エンジンの
ソースコードは
[`riichi-opponent-analysis`](https://github.com/SiyeW/riichi-opponent-analysis)
で公開しています。学習済みの重みは現在、付属していません。

エンジン通信プロトコルとパッケージ形式は、
[`riichi-engine-protocol`](https://github.com/SiyeW/riichi-engine-protocol)
で管理しています。互換性のあるサードパーティー製エンジンの開発も歓迎します。

### 開発環境

#### 必要条件

- Node.js 22 以降
- Miniconda、Miniforge、または Conda 互換の環境管理ツール
- Windows パッケージ作成用の Windows PowerShell

#### Node.js 依存関係のインストール

```powershell
npm ci
```

#### Python バックエンド環境の作成

バックエンドの開発とパッケージ作成には、プロジェクト内の専用環境を使用します。

```powershell
.\setup-environment.ps1
```

開発ランチャーは `.conda-backend` を自動的に使用します。別の互換 Python
実行ファイルを使用する場合は、`.vscode/launch.local.env` に
`MJAI_BACKEND_PYTHON` を設定してください。

#### アプリケーションの起動

```powershell
npm run dev
```

Vite 開発サーバーと Electron アプリケーションが同時に起動します。開発中に導入
または作成したエンジン、モデル、対局記録、ログ、実行時設定は Git の追跡対象外
です。

#### チェックの実行

```powershell
npm run type-check
npm run build
$tests = Get-ChildItem -LiteralPath electron -Filter '*.test.js' -Recurse |
  Select-Object -ExpandProperty FullName
node --test $tests
$env:PYTHONPATH = (Resolve-Path 'python\environment').Path
.\.conda-backend\python.exe -m unittest discover -s python\environment -p 'test_*.py'
Remove-Item Env:PYTHONPATH
```

#### VS Code でのデバッグ

`.vscode/launch.local.env.example` を `.vscode/launch.local.env` にコピーし、
`RMS: Debug` を選択して F5 を押します。

### Windows アプリケーションのビルド

Python バックエンドだけをビルドする場合：

```powershell
npm run build:backend:win
```

出力先：`release/backend/environment-service/`

展開済みの Windows アプリケーション全体をビルドする場合：

```powershell
npm run package:win
```

出力先：`release/electron/`

パッケージにはバックエンド、アプリケーションのライセンス、第三者通知が含まれます。
エンジンランタイム、モデルの重み、対局記録、ローカル設定は含まれません。

### ローカル設定

ローカル設定が必要な場合は、`config.example.json` を `config.json` にコピー
してください。ローカル設定の変更やローカルエンジンの導入が、リポジトリの
コードやパッケージの出力に影響することはありません。

### 用語集

詳しくは [`docs/terminology.md`](docs/terminology.md) を参照してください。

### ライセンス

Apache License 2.0 で提供されます。第三者のコードと素材には、それぞれの
ライセンス条件が適用されます。詳しくは
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) を参照してください。
