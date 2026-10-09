# Skill Authoring

How skills are stored, and how to add a built-in one.

## Where does a skill belong?

Decide by intent, not by convenience:

| Kind | Source you edit | Runtime location | Use for |
| --- | --- | --- | --- |
| **Built-in** | `packages/opencode/resources/skills/<name>/SKILL.md` — the project owns it | `~/.local/share/deveco/skills/<name>/`, extracted from the binary at startup | Skills that must evolve with releases, be reviewed in a PR, or reach every user |
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

`packages/opencode/resources/skills/` is the **source of truth**. Nothing else can
produce a built-in skill.

- Build-time embedding: `packages/opencode/script/build.ts` → `DEVECO_DEFAULT_SKILLS`
- Runtime extraction: `packages/opencode/src/skill/defaults.ts`

## Adding a built-in skill

Creating the directory is not enough. The build and extraction pipeline discovers
a new skill automatically, but several **hand-maintained lists** do not — update
all of them:

1. **`packages/opencode/resources/skills/<name>/SKILL.md`** — the skill itself
   (see format below).
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

The log must print `Loaded N default skills` with N one higher than before.

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
