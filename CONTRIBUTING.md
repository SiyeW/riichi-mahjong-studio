# Contributing

This repository is in an early public migration stage. Please keep changes
small, tested, and independent of non-public assets.

Do not commit:

- model weights, engine executables, or private runtime packages;
- captured sound effects or artwork without a redistributable license;
- local `config.json`, game records, logs, tokens, or machine-specific paths;
- organization-specific branding or time-limited access controls.

New third-party material must include its upstream URL, exact revision, license,
and required notice in `THIRD_PARTY_NOTICES.md`. Engine integrations should use
the separately published `riichi-engine-protocol` contract rather than adding a
private built-in path.

Before submitting a change, run the TypeScript check, renderer build, Electron
unit tests, Python unit tests, and the repository audit described in
`docs/public-release-checklist.md`.
