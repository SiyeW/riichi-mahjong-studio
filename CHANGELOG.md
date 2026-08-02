# Changelog

This project follows Semantic Versioning. Versions below `1.0.0` describe a
public API and application that may still change incompatibly.

## [Unreleased]

- Reserve integration points for separately distributed engines, models, and
  sound packs.
- Continue terminology and public-release review.
- Pin the vendored MahjongRepository/mahjong source to upstream `v2.0.0` and
  record the concrete MIT-licensed killer_mortal_gui CSS adaptations.
- Replace the libriichi-specific shuffled-wall conversion with the host's own
  physical wall representation.

## [0.4.0-alpha.1] - 2026-08-02

- Prepare the first public-development source tree.
- Remove organization-specific branding and icon assets.
- Remove version-expiry and temporary-access mechanisms.
- Exclude all bundled engines, runtimes, model weights, and sound effects.
- Replace private built-in engine defaults with an empty, discoverable package
  catalog.
- Separate the engine communication contract and opponent-analysis source into
  independent projects.
