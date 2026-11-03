# Architecture

## Directory Structure

```
deveco-code/
├── packages/              # Bun workspace packages (see package.json → workspaces)
│   ├── opencode/          # CLI core: agents, sessions, tools, config, skills
│   ├── core/              # Shared primitives: paths, fs, flock, config, catalog
│   ├── tui/               # Terminal UI (SolidJS via @opentui)
│   ├── cli/               # CLI command framework and entry points
│   ├── server/            # HTTP API server: routes, handlers, middleware
│   ├── app/               # App frontend (SolidJS)
│   ├── ui/                # Shared UI component library
│   ├── llm/               # Model providers, protocols, tool runtime
│   ├── plugin/            # Plugin system
│   ├── sdk/               # JavaScript SDK + OpenAPI spec
│   ├── script/            # Shared build/release script helpers
│   ├── http-recorder/     # Record and replay Effect HTTP traffic for tests
│   ├── effect-drizzle-sqlite/   # Effect + Drizzle SQLite layer
│   └── effect-sqlite-node/      # Effect SQLite driver for Node
├── integrations/          # Editor integrations (intellij-plugin)
├── script/                # Build and release scripts
├── specs/                 # Feature specifications
├── docs/                  # Project docs: user guide + subsystem design notes
├── patches/               # Patches applied to dependencies
├── assets/                # Static assets
├── .opencode/             # OpenCode self-configuration (agents, commands, skills)
└── .deveco/               # Project-scoped config, created at runtime (not committed)
```

Directories only — file-level contents are not listed, so this stays accurate as
files are added. Keep it in sync when a package is added or removed.

`specs/` is listed in `.gitignore`, but a handful of files inside it are tracked
anyway; they arrive with upstream syncs rather than through `git add`.

## Skill Storage Invariant

Built-in and user skills live in **separate, non-overlapping directories**, and
the location is part of the contract: a skill placed in the wrong directory
silently stops working at the next upgrade. The only source of built-in skills
is `packages/opencode/resources/skills/`.

See [docs/skill-authoring.md](docs/skill-authoring.md) for the directory layout
and the authoring convention.

## Sub-package Spec Index

- [packages/opencode/AGENTS.md](packages/opencode/AGENTS.md)
- [packages/app/AGENTS.md](packages/app/AGENTS.md)
