# Public release checklist

Use this checklist for every public tag and distribution build.

## Source and assets

- [ ] No model weights, engine executables, private runtimes, sound captures,
  game records, local configuration, logs, or credentials are tracked.
- [ ] Every copied dependency and asset has an upstream URL, exact revision,
  license, and required notice.
- [ ] The application icon and sound pack are original or redistributable; until
  then, neither is included in release artifacts.
- [ ] Compatibility references to third-party product names are confined to
  explicit import/export boundaries.

## Behavior

- [ ] The application starts with an empty engine catalog.
- [ ] Missing optional engines produce a clear unavailable state, not a private
  built-in fallback.
- [ ] There is no expiry date, network-time check, temporary access token, or
  organization-specific restriction.
- [ ] Type checking, renderer build, Electron tests, Python tests, and protocol
  validation pass from a clean checkout.

## Version and provenance

- [ ] `package.json` and `CHANGELOG.md` agree on the version.
- [ ] Pre-release maturity is reflected by a SemVer suffix such as `alpha.N`.
- [ ] Bundled source snapshots are pinned to upstream commits.
- [ ] Engine protocol compatibility is stated independently from application
  version compatibility.
- [ ] Training datasets and model weights have separate provenance records;
  dataset availability alone is not treated as authorization for a model.
