import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@opencode-ai/core/util/glob"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { sanitizePath } from "@opencode-ai/core/sanitize-path"
import { Discovery } from "./discovery"
import { Defaults } from "./defaults"
import { isRecord } from "@/util/record"
import { SkillPreference } from "./preference"
import { Runtime } from "@opencode-ai/core/runtime"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const DEVECO_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

export const Scope = Schema.Literals(["global", "project", "builtin"])
export type Scope = Schema.Schema.Type<typeof Scope>

export const Status = Schema.Struct({
  ...Info.fields,
  scope: Scope,
  enabled: Schema.Boolean,
})
export type Status = Schema.Schema.Type<typeof Status>

export const UpdateInput = Schema.Struct({
  scope: Scope,
  enabled: Schema.Boolean,
})
export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type Entry = Info & { scope: Scope }

type State = {
  skills: Record<string, Entry>
}

type DiscoveryState = {
  matches: Array<{ path: string; scope: Scope }>
}

type ScanState = {
  matches: Map<string, Scope>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly statuses: () => Effect.Effect<Status[]>
  readonly setEnabled: (name: string, scope: Scope, enabled: boolean) => Effect.Effect<Status, NotFoundError>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

const add = Effect.fnUntraced(function* (
  state: State,
  match: { path: string; scope: Scope },
  events: EventV2Bridge.Service["Service"],
) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match.path),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match.path}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match.path, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match.path,
    })
  }

  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match.path,
    content: md.content,
    scope: match.scope,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts: { skillScope: Scope; dot?: boolean; logScope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts.logScope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.logScope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.set(match, opts.skillScope)
  }
})

function projectScope(target: string, directory: string, worktree: string): Scope {
  for (const root of [directory, ...(worktree === "/" ? [] : [worktree])]) {
    const relative = path.relative(root, target)
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return "project"
  }
  return "global"
}

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  disableDefaultSkills: boolean,
  directory: string,
  worktree: string,
  projectID: string,
) {
  const state: ScanState = { matches: new Map() }

  if (!disableDefaultSkills) {
    const defaultDir = yield* Defaults.ensure(InstallationVersion, fsys).pipe(Effect.orDie)
    yield* scan(state, defaultDir, SKILL_PATTERN, { skillScope: "builtin" })
  }

  const externalDirs: string[] = []
  if (Runtime.current.mode === "default" && !disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, skillScope: "global", logScope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, skillScope: "project", logScope: "project" })
    }
  }

  // Project Skills remain repository-scoped even when Studio mode disables
  // project .deveco configuration files. Only Skill manifests are scanned here.
  if (Runtime.current.mode === "default") {
    const projectSkillDirs = yield* fsys
      .up({ targets: [".deveco"], start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    for (const dir of projectSkillDirs) {
      yield* scan(state, dir, DEVECO_SKILL_PATTERN, { skillScope: "project", logScope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  const isolatedProject = Runtime.current.mode === "deveco-studio" ? Global.projectConfig(projectID) : undefined
  for (const dir of configDirs) {
    const knownGlobal = dir === global.config || dir === path.join(global.home, ".deveco")
    yield* scan(state, dir, DEVECO_SKILL_PATTERN, {
      skillScope: dir === isolatedProject ? "project" : knownGlobal ? "global" : projectScope(dir, directory, worktree),
    })
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: sanitizePath(dir) })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN, {
      skillScope: item.startsWith("~/") ? "global" : projectScope(dir, directory, worktree),
    })
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN, { skillScope: "global" })
    }
  }

  return {
    matches: Array.from(state.matches, ([match, scope]) => ({ path: match, scope })),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const disabled = Effect.fn("Skill.disabled")(function* () {
      const ctx = yield* InstanceState.context
      return yield* Effect.promise(() => SkillPreference.disabled(global.config, ctx.project.id))
    })
    const isBlocked = (info: Entry, blocked: { global: Set<string>; project: Set<string> }) =>
      info.scope === "builtin" ? false : blocked[info.scope].has(info.name)
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          flags.disableDefaultSkills,
          ctx.directory,
          ctx.worktree,
          ctx.project.id,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {} }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (!info || isBlocked(info, yield* disabled())) return undefined
      return info
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      const blocked = yield* disabled()
      if (info && !isBlocked(info, blocked)) return info
      return yield* new NotFoundError({
        name,
        available: Object.keys(s.skills)
          .filter((item) => !isBlocked(s.skills[item], blocked))
          .toSorted(),
      })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      const blocked = yield* disabled()
      return Object.values(s.skills).filter((item) => !isBlocked(item, blocked))
    })

    const statuses = Effect.fn("Skill.statuses")(function* () {
      const s = yield* InstanceState.get(state)
      const blocked = yield* disabled()
      return Object.values(s.skills)
        .map((item) => ({ ...item, enabled: !isBlocked(item, blocked) }))
        .toSorted((a, b) => a.name.localeCompare(b.name))
    })

    const setEnabled = Effect.fn("Skill.setEnabled")(function* (name: string, scope: Scope, enabled: boolean) {
      if (scope === "builtin")
        return yield* new NotFoundError({ name, available: Object.keys((yield* InstanceState.get(state)).skills).toSorted() })
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (!info || info.scope !== scope)
        return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
      const ctx = yield* InstanceState.context
      yield* Effect.promise(() => SkillPreference.setEnabled(global.config, ctx.project.id, scope, name, enabled))
      return { ...info, enabled }
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      const s = yield* InstanceState.get(state)
      const blocked = yield* disabled()
      return Array.from(
        new Set(
          Object.values(s.skills)
            .filter((item) => !isBlocked(item, blocked))
            .map((item) => path.dirname(item.location)),
        ),
      )
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const blocked = yield* disabled()
      const list = Object.values(s.skills)
        .filter((item) => !isBlocked(item, blocked))
        .toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, require, all, statuses, setEnabled, dirs, available })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make(layer, [
  Discovery.node,
  Config.node,
  EventV2Bridge.node,
  FSUtil.node,
  Global.node,
  RuntimeFlags.node,
])

export * as Skill from "."
