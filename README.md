# Riichi Mahjong Studio

Riichi Mahjong Studio is a local desktop application for practicing
Riichi Mahjong and reviewing branching game records. The public edition is
currently an early alpha.

> 中文说明：这是立直麻将练习与复盘桌面程序的公开开发版本。目前不附带任何
> AI 引擎、模型权重或音效包，需要相关功能时须另行安装兼容组件。

## Current status

Version: `0.4.0-alpha.1`

This repository intentionally contains:

- no bundled decision engine, opponent-analysis engine, runtime, or model weight;
- no sound effects (volume and voice preferences remain reserved for a future
  open or original sound pack);
- no organization-specific branding, icon, access restriction, or expiry date;
- no private development logs, game records, or local configuration.

The application starts with an empty engine catalog. Compatible engines and
models are discovered from user-installed packages. The package format and
host communication contract are being published separately in the sibling
`riichi-engine-protocol` project. Opponent-analysis source is being prepared in
the sibling `riichi-opponent-analysis` project.

## Development

Requirements:

- Node.js 22 or newer;
- Python 3.11 or newer for the local environment service.

```text
npm ci --ignore-scripts
npm run type-check
npm run build
```

Run the individual JavaScript tests under `electron/` with Node, and run the
Python suite with `python -m unittest discover -s python/environment -p
'test_*.py'` after adding `python/environment` to `PYTHONPATH`.

Copy `config.example.json` to `config.json` only when a local configuration is
needed. `config.json` is intentionally ignored by Git.

### VS Code debugging

Open this repository folder in VS Code, select
`Riichi Mahjong Studio：调试主程序与界面`, and press F5. The tracked launch
configuration uses `.mjai-runtime/debug/config.json`; that directory is ignored
by Git and excluded from application packaging. Engine packages placed under
the ignored `engines/` directory and records under `records/` are local-only as
well.

Copy `.vscode/launch.local.env.example` to `.vscode/launch.local.env` and set
`MJAI_BACKEND_PYTHON` to a Python environment containing the release
dependencies. The local env file is ignored and must never be committed.

## Compatibility names

The product is not based on, endorsed by, or distributed with Mortal. The name
“Mortal” remains only where the application explicitly imports or identifies
the public report format produced by the external Mortal review service. See
`docs/terminology.md`.

## License

Riichi Mahjong Studio is licensed under the Apache License 2.0. Bundled
third-party code and artwork retain their own terms; see
`THIRD_PARTY_NOTICES.md`.
