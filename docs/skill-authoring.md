# Skill Authoring

How skills are stored, and how to add a built-in one.

## Where does a skill belong?

Decide by intent, not by convenience:

| Kind | Source you edit | Runtime location | Use for |
| --- | --- | --- | --- |
| **Built-in (repo)** | `packages/opencode/resources/skills/<name>/SKILL.md` — the project owns it | `~/.local/share/deveco/skills/<name>/`, extracted from the binary at startup | Skills that must evolve with releases, be reviewed in a PR, or reach every user |
| **Built-in (CLI)** | `@deveco/deveco-cli-common/skills/<name>/` — the CLI team owns it | Same directory | Skills the CLI ships and updates with its own release |
| **User (global)** | `~/.config/deveco/skills/<name>/SKILL.md` — you own it | The same directory | Personal skills for one machine |
| **User (project)** | `<repo>/.deveco/skills/<name>/SKILL.md` — you own it | The same directory | Skills that travel with a repository |

If the project is expected to maintain the skill, it is built-in. A user directory
is a per-machine scratch space — the project cannot version, review, or ship what
lives there.

The reverse mistake is worse: a personal or experimental skill placed in
`resources/skills/` is compiled into the binary and shipped to every user, and
cannot be recalled from releases that already went out.

### Do not hand-edit the runtime directory

`~/.local/share/deveco/skills/` is a **runtime artifact**, not a workspace. It is
wiped and re-extracted on every version change, so anything written there is lost.
Under the IDE plugin the same directory lives under the DevEco Studio cache path.

### Every location that gets scanned

The two-mode split above is the decision you make. At runtime the loader scans
more than the directories named in the table:

| Location | Scope | Default |
| --- | --- | --- |
| The built-in data directory (see above) | builtin | on |
| `<repo>/.deveco/{skill,skills}/`, walking up to the worktree | project | on |
| `~/.config/deveco/skills/`, `~/.deveco/skills/` | global | on |
| `<repo>/.agents/skills/` and `~/.agents/skills/`, walking up | project / global | on |
| `<repo>/.claude/skills/` and `~/.claude/skills/`, walking up | project / global | **off** — `DEVECO_DISABLE_CLAUDE_CODE_SKILLS` defaults to `true` |
| `skills.paths` / `skills.urls` from config | per entry | on when configured |

`.agents/` and `.claude/` are interoperability paths for other tools, not this
project's convention. A skill the project maintains belongs in
`resources/skills/`, not in either of them. `.opencode/skills/` is **not**
scanned by this fork — it is an upstream leftover, and a skill placed there
never loads.

## How built-in skills are delivered

Two sources are merged at build time; a CLI copy wins over a repository copy of
the same name:

1. `packages/opencode/resources/skills/` — this repository.
2. `<deveco-cli>-common/skills/` — the installed CLI package, restricted to the
   names in `CLI_BUNDLED_SKILLS` (`packages/opencode/script/skill-sources.ts`).
   A whitelisted skill missing from the package fails the build.

The package is resolved from the `@deveco/deveco-cli` shell dependency pinned in
`packages/opencode/package.json`; `<shell>-common` ships as its
`optionalDependency`. The lookup order and pre-release scope handling live in
`packages/opencode/script/skill-sources.ts`.

### Overlays: repository-owned companion files

A CLI copy replaces the **whole** skill, so a file this repository owns but the
CLI does not publish cannot survive the merge. Such a file belongs in an
**overlay**: a directory under `packages/opencode/resources/skills/<name>/`
containing no `SKILL.md`. Overlay files are applied on top of the merged skill
(the same path wins), fail the build when they match no built-in skill, and are
part of the embedded hash.

`hmos-dfx-analyzer/FILES.md` is the only overlay today. It is a **deveco-code
convention**: `src/tool/skill.ts` reads it to list exactly those companion paths
in `<skill_files>` when the skill loads. The CLI package does not ship it (CLI
1.0.0 folded the same list into its `SKILL.md`), and without the overlay the tool
falls back to a sampled `rg --files` list — the skill still loads, but the
curated paths (the four `analyzer.md` routes, the collect scripts) are replaced
by whatever sorts first, including `test-cases/` and `.version`.

- Build-time embedding: `packages/opencode/script/skill-sources.ts` (used by
  `build.ts`) → `DEVECO_DEFAULT_SKILLS` + `DEVECO_DEFAULT_SKILLS_HASH`
- Runtime extraction: `packages/opencode/src/skill/defaults.ts`

The hash covers the merged content, so the runtime marker is
`${version}+${hash}`: a same-version rebuild whose skill content changed still
re-extracts. Under `bun dev` there is no injected hash, the marker stays `local`,
and only `resources/skills/` is read — CLI-sourced skills are absent by design.
Link them into `.deveco/skills/` when you need them while developing.

## Adding a built-in skill

Creating the directory is not enough. The build and extraction pipeline discovers
a new skill automatically, but several **hand-maintained lists** do not — update
all of them:

1. **`packages/opencode/resources/skills/<name>/SKILL.md`** — the skill itself
   (see format below). For a CLI-sourced skill, add its name to
   `CLI_BUNDLED_SKILLS` in `packages/opencode/script/skill-sources.ts` instead
   and bump `@deveco/deveco-cli` to a release that ships it. Repository-owned
   companion files for a CLI-sourced skill go in the same directory **without**
   a `SKILL.md` (see "Overlays" above).
2. **`packages/opencode/src/tool/skill.ts`** — `DevEcoRequiredSkills`. Add the
   skill **only if** it needs the HarmonyOS SDK; membership makes the skill fail
   to load when `DEVECO_HOME` is unset.
3. **`integrations/intellij-plugin/src/main/kotlin/org/deveco/code/session/model/ChatModels.kt`**
   — `DEVECO_DEFAULT_SKILLS` (command-kind fallback).
4. **`integrations/intellij-plugin/src/main/kotlin/org/deveco/code/session/ui/composer/SlashCommandPopup.kt`**
   — `KNOWN_COMMANDS` (slash-command description key).
5. **`integrations/intellij-plugin/src/main/resources/messages/MyMessageBundle.properties`**
   and **`MyMessageBundle_zh_CN.properties`** — two keys per skill
   (`slash.command.<name>` and `slash.command.<name>.desc`), in both locales.
6. **`docs/deveco-code-docs.html`** — the built-in skill table.

Verify:

```sh
cd packages/opencode && bun run build
```

The log must print `Loaded N default skills (L local + C @<scope>/deveco-cli-common@<version> + O overlay, hash=…)`
with N unchanged — the two bundled skills moved from the repository to the CLI
package, so the total stays the same — plus a per-skill digest. `O` counts the
overlay directories; it must not inflate `L`.

> **These lists have drifted before.** The runtime handles a rename by rebuilding
> the directory wholesale, but the lists above are not rebuilt — a rename or a
> delete must be applied to all six places by hand.

## `SKILL.md` format

Frontmatter:

- `name` — **required**. Lowercase, hyphen-separated, at most 64 characters. By
  convention it matches the directory name. The CLI never checks this, but the
  IDE does rely on it: for **user** skills the IDE keys its slash-command list
  by the *directory* name and joins it against the backend's *frontmatter* names,
  so a mismatch makes the skill disappear from the IDE's `/` popup and its
  enable/disable toggle stop working. Keep the two identical.
- `description` — **required in practice**. A skill without one is silently
  filtered out and never reaches the model.
- `license`, `compatibility`, `metadata` — optional.

`packages/opencode/resources/skills/customize-deveco/SKILL.md` is a worked example.

## Rules that are easy to get wrong

- **Never add a `.version` file.** The extractor writes that marker, and its
  presence is the only thing that marks a directory as program-owned. Adding one
  to a user skill gets it deleted on the next upgrade; removing one from a
  built-in skill freezes it at its old content permanently.
- **Built-in detection is by marker file, not by name.** Do not change that check
  to a name-based one.
- **Built-in skills are never written to a user directory**, and user skills are
  never loaded from `resources/skills/` at runtime.
- `Defaults.ensure()` runs under `Effect.orDie`; an unhandled failure aborts
  instance creation. New filesystem work inside it needs its own `Effect.catch`.

## Related

- [ARCHITECTURE.md](../ARCHITECTURE.md) → "Skill Storage Invariant"
- [AGENTS.md](../AGENTS.md) → "Skills"
