export * as SkillTool from "./skill"

import path from "path"
import { pathToFileURL } from "url"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { PluginBoot } from "../plugin/boot"
import { SkillV2 } from "../skill"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "skill"
const FILE_LIMIT = 10
const FILES_WHITELIST = "FILES.md"

export const Input = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from the available skills list" }),
})

export const Output = Schema.Struct({
  name: Schema.String,
  directory: Schema.String,
  output: Schema.String,
})

export const description = [
  "Load a specialized skill when the task at hand matches one of the available skills in the system context.",
  "",
  "Use this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill.",
  "",
  "The skill name must match one of the available skills in the system context.",
].join("\n")

export const toModelOutput = (skill: SkillV2.Info, files: ReadonlyArray<string>) => {
  const directory = path.dirname(skill.location)
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    `Base directory for this skill: ${pathToFileURL(directory).href}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "",
    skill.content.trim(),
    "</skill_content>",
  ].join("\n")
}

/**
 * Companion list for a skill directory. A `FILES.md` whitelist, when present, is
 * the single source of truth for which paths the skill exposes (comments and
 * `@note ` lines are supported); otherwise fall back to a limited listing of the
 * skill's files, which is just a sample.
 */
const listSkillFiles = (fs: FSUtil.Interface, directory: string) =>
  Effect.gen(function* () {
    const whitelist = path.join(directory, FILES_WHITELIST)
    if (yield* fs.existsSafe(whitelist)) {
      const content = yield* fs.readFileString(whitelist)
      const { notes, files } = content.split("\n").reduce(
        (acc, line) => {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith("#")) return acc
          if (trimmed.startsWith("@note ")) acc.notes.push(trimmed.slice(6))
          else acc.files.push(path.resolve(directory, trimmed))
          return acc
        },
        { notes: [] as string[], files: [] as string[] },
      )
      const existing = yield* Effect.all(
        files.map((file) => fs.existsSafe(file).pipe(Effect.map((ok) => (ok ? file : null)))),
        { concurrency: "unbounded" },
      )
      return [...notes, ...existing.filter((file): file is string => file !== null)]
    }
    return yield* fs
      .glob("**/*", { cwd: directory, absolute: true, include: "file", dot: true })
      .pipe(Effect.map((all) => all.filter((file) => path.basename(file) !== "SKILL.md").toSorted().slice(0, FILE_LIMIT)))
  })

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const boot = yield* PluginBoot.Service
    const skills = yield* SkillV2.Service
    const permission = yield* PermissionV2.Service
    yield* boot.wait()
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const current = yield* skills.list()
              const skill = current.find((skill) => skill.name === input.name)
              if (!skill) return yield* unableToLoad(input.name)
              return yield* Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [skill.name],
                  save: [skill.name],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const directory = path.dirname(skill.location)
                const files = path.basename(skill.location) === "SKILL.md" ? yield* listSkillFiles(fs, directory) : []
                return {
                  name: skill.name,
                  directory,
                  output: toModelOutput(skill, files),
                }
              }).pipe(Effect.mapError((error) => unableToLoad(input.name, error)))
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
