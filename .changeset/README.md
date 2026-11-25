# Changesets

Every PR that changes a published package adds one: `bunx changeset`, pick the bump, write one line for users.
`@qala/core`, `@qala/cli`, `@qala/client` and `@qala/crdt` are versioned together (`fixed` in config.json).
`@qala/jobs` is versioned on its own for now: it starts at 0.0.0 in the repo so its first changeset (`minor`)
publishes 0.1.0; it can join the fixed group once it has been released. The Release workflow turns pending changesets into a
"Version packages" PR; merging that PR publishes to npm and creates a GitHub release.
