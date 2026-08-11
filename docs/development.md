### [中文](#%E4%B8%AD%E6%96%87) | [日本語](#%E6%97%A5%E6%9C%AC%E8%AA%9E) | [English](#english)

## 中文

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

#### 使用 VS Code 调试

将 `.vscode/launch.local.env.example` 复制为 `.vscode/launch.local.env`，然后选择 `RMS: Debug` 并按 F5。

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

引擎通信和程序包格式由 [riichi-engine-protocol](https://github.com/SiyeW/riichi-engine-protocol) 定义。

---

## 日本語

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

開発ランチャーは `.conda-backend` を自動的に使用します。別の互換 Python 実行ファイルを使用する場合は、`.vscode/launch.local.env` に `MJAI_BACKEND_PYTHON` を設定してください。

#### アプリケーションの起動

```powershell
npm run dev
```

Vite 開発サーバーと Electron アプリケーションが同時に起動します。開発中に導入または作成したエンジン、モデル、対局記録、ログ、実行時設定は Git の追跡対象外です。

#### VS Code でのデバッグ

`.vscode/launch.local.env.example` を `.vscode/launch.local.env` にコピーし、`RMS: Debug` を選択して F5 を押します。

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

パッケージにはバックエンド、アプリケーションのライセンス、第三者通知が含まれます。エンジンランタイム、モデルの重み、対局記録、ローカル設定は含まれません。

エンジン通信とパッケージ形式は [riichi-engine-protocol](https://github.com/SiyeW/riichi-engine-protocol) で定義されています。

---

## English

### Development environment

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

The development launcher uses `.conda-backend` automatically. To override it, set `MJAI_BACKEND_PYTHON` in `.vscode/launch.local.env`.

#### Run the application

```powershell
npm run dev
```

This starts Vite and Electron together. Engines, models, game records, logs, and runtime configuration created during development are ignored by Git.

#### Debug with VS Code

Copy `.vscode/launch.local.env.example` to `.vscode/launch.local.env`, select `RMS: Debug`, and press F5.

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

The package includes the backend, application license, and third-party notices, but not engine runtimes, model weights, game records, or local configuration.

Engine communication and package formats are defined by [riichi-engine-protocol](https://github.com/SiyeW/riichi-engine-protocol).
