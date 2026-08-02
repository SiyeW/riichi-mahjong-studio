# Changelog

This project follows Semantic Versioning. Versions below `1.0.0` describe a
public API and application that may still change incompatibly.

## [Unreleased]

- Align public-facing spelling and status identifiers.
- Standardise game and rule-system prose on `立直麻将` and `Riichi Mahjong`.
- Add VS Code launch and task definitions with an ignored, isolated debug
  configuration and local Python-environment override.
- Expand the About panel with application licensing, third-party attribution,
  and maintainer information, and expose declared engine legal documents in
  the engine manager.
- Include the Apache-2.0 license in packaged application resources.
- Reserve integration points for separately distributed engines, models, and
  sound packs.
- Continue terminology and public-release review.
- Pin the vendored MahjongRepository/mahjong source to upstream `v2.0.0` and
  record the concrete MIT-licensed killer_mortal_gui CSS adaptations.
- Replace the libriichi-specific shuffled-wall conversion with the host's own
  physical wall representation.
- Add an opt-in local corpus checker for regression-testing recent external
  `.mjtrain` records without copying them into the repository.

## [0.4.0-alpha.1] - 2026-08-02

- Prepare the first public-development source tree.
- Remove organization-specific branding and icon assets.
- Remove version-expiry and temporary-access mechanisms.
- Exclude all bundled engines, runtimes, model weights, and sound effects.
- Replace private built-in engine defaults with an empty, discoverable package
  catalog.
- Separate the engine communication contract and opponent-analysis source into
  independent projects.
