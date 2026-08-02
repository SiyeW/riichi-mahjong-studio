# Changelog

This project follows Semantic Versioning. Versions below `1.0.0` may include
incompatible changes.

## [Unreleased]

- Add multilingual project documentation and a project-local Conda backend
  environment.
- Add reproducible commands for building the Python backend and Windows
  application.
- Add VS Code launch and task definitions with an ignored, isolated debug
  configuration and local Python-environment override.
- Expand the About panel with application licensing, third-party attribution,
  and maintainer information, and expose declared engine legal documents in
  the engine manager.
- Include the Apache-2.0 license in packaged application resources.
- Add engine and model package discovery through Riichi Engine Protocol.
- Improve wall reconstruction and branching game-record handling.
- Add an opt-in local corpus checker for regression-testing recent external
  `.mjtrain` records.

## [0.4.0-alpha.1] - 2026-08-02

- Initial development release.
- Add branching game records, decision analysis, opponent analysis, and engine
  package management.
- Add external game-record import and export.
