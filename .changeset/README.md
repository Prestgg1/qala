# Changesets

Every PR that changes a published package adds one: `bunx changeset`, pick the bump, write one line for users.
The four `@qala/*` packages are versioned together. The Release workflow turns pending changesets into a
"Version packages" PR; merging that PR publishes to npm and creates a GitHub release.
