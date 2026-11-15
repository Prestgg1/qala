---
title: Getting started
---

# Getting started


Requirements: [Bun](https://bun.sh) ≥ 1.3, Node.js ≥ 24 (only to install scriptc), PostgreSQL, Linux or macOS. The packages are not on npm yet; use the repository:

```sh
git clone https://github.com/Prestgg1/qala && cd qala && bun install
alias qala="bun $PWD/packages/cli/src/bin.ts"

qala new ../my-api --core $PWD/packages/core/src/index.ts
cd ../my-api && bun install
qala make:model task
qala make:repository task      # abstract repository in domain + Postgres implementation
qala make:service task
qala make:controller tasks --resource
qala make:migration create_tasks
qala migrate
qala dev                       # Bun, hot reload
qala build && qala start       # native binary
```

Next: [Project layout](./project-layout), then [Controllers](./controllers).


