import path from "path"
import { pathToFileURL } from "url"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"
import DFX_FILES from "./dfx-files.txt"
import { loadSavedDevEcoHome } from "./lib/env"

const FILES_WHITELIST = "FILES.md"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

const DevEcoRequiredSkills = new Set(["hmos-arkui-develop-skill"])

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service
    const fsys = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill
            .require(params.name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          if (DevEcoRequiredSkills.has(info.name) && !process.env.DEVECO_HOME?.trim()) {
            const home = yield* Effect.promise(loadSavedDevEcoHome)
            if (!home) {
              throw new Error(
                "DEVECO_HOME environment variable is not configured. PLEASE set your DEVECO_HOME path manually and restart.",
              )
            }
            process.env.DEVECO_HOME = home
          }

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const dir = path.dirname(info.location)
          const base = pathToFileURL(dir).href

          // Harness supplies DFX resources; retain the host curated companion list
          // until the installed skill supplies its own FILES.md.
          const content = (yield* fsys.existsSafe(path.join(dir, FILES_WHITELIST)))
            ? yield* fsys.readFileString(path.join(dir, FILES_WHITELIST)).pipe(Effect.orDie)
            : info.name === "hmos-dfx-analyzer"
              ? DFX_FILES
              : undefined
          if (content !== undefined) {
            const { notes, files } = content.split("\n").reduce(
              (acc, line) => {
                const trimmed = line.trim()
                if (!trimmed || trimmed.startsWith("#")) return acc
                if (trimmed.startsWith("@note ")) {
                  acc.notes.push(trimmed.slice(6))
                } else {
                  acc.files.push(path.resolve(dir, trimmed))
                }
                return acc
              },
              { notes: [] as string[], files: [] as string[] },
            )
            const existing = yield* Effect.all(
              files.map((f) => fsys.existsSafe(f).pipe(Effect.map((ok) => (ok ? f : null)))),
              { concurrency: "unbounded" },
            )
            const entries = [...notes, ...existing.filter((f): f is string => f !== null)]
            return {
              title: `Loaded skill: ${info.name}`,
              output: render(info.name, info.content, base, entries),
              metadata: {
                name: info.name,
                dir,
              },
            }
          }

          const files = yield* ripgrep.find({
            cwd: dir,
            pattern: "!**/SKILL.md",
            hidden: true,
            follow: false,
            signal: ctx.abort,
            limit: 10,
          })
          const entries = files.map((file) => path.resolve(dir, file.path))

          return {
            title: `Loaded skill: ${info.name}`,
            output: render(info.name, info.content, base, entries),
            metadata: {
              name: info.name,
              dir,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/**
 * The companion list goes **before** the skill body on purpose: tool output is
 * capped (50 KB / 2000 lines by default) and a skill whose SKILL.md alone exceeds
 * that cap — `hmos-dfx-analyzer` is ~52 KB — would otherwise lose its whole
 * `<skill_files>` block to truncation, which silently degrades the skill instead
 * of failing.
 */
function render(name: string, content: string, base: string, entries: string[]) {
  return [
    `<skill_content name="${name}">`,
    `# Skill: ${name}`,
    "",
    `Base directory for this skill: ${base}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    entries.map((entry) => `<file>${entry}</file>`).join("\n"),
    "</skill_files>",
    "",
    content.trim(),
    "</skill_content>",
  ].join("\n")
}
