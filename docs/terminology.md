# Terminology

The following names define the public architecture. They are deliberately
provider-neutral unless a specific external format is being identified.

| Public term | Meaning |
| --- | --- |
| decision engine | An optional external engine that evaluates player actions. |
| opponent-analysis engine | An optional external engine that estimates opponent state. |
| engine package | User-installed executable metadata conforming to the package contract. |
| model package | User-installed weight metadata associated with a compatible engine. |
| engine protocol | The separately versioned JSON-RPC communication contract. |
| analysis source | Stable identity used to distinguish cached results from different engines or models. |

## Compatibility-specific names

`Mortal` is used only when referring to Mortal itself or to its public online
review-report format. Import functions and persisted record source identifiers
that contain `mortal-report` are compatibility boundaries, not bundled engine
identities. They should not be reused for generic decision-engine features.

`mjai` identifies the established event vocabulary used at compatibility
boundaries. New host-specific concepts should use the neutral terms above.

Old private product names, organization initials, built-in model nicknames, and
expiry terminology are not part of the public vocabulary.
