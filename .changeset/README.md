# Changesets

Every change to a published package (`@horagon/sdk` in Tier 1) adds one file here:

```bash
pnpm changeset
```

Pick the package, the bump (0.x: `minor` for new API, `patch` for fixes) and write one line
for the changelog. Publishing (`release.yml`, npm provenance) arrives in Tier 2; until then
`pnpm changeset version` is run by hand before a tag.
