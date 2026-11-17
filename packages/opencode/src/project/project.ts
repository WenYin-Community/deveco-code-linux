import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { and, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm"
import { sanitizePath } from "@opencode-ai/core/sanitize-path"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectDirectoryTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Flag } from "@opencode-ai/core/flag/flag"
import { GlobalBus } from "@/bus/global"
import { which } from "@opencode-ai/core/util/which"
import { Command } from "@/command"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer, Scope, Context, Stream, Types, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppProcess } from "@opencode-ai/core/process"
import { ProjectV2 } from "@opencode-ai/core/project"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AbsolutePath, NonNegativeInt, optionalOmitUndefined } from "@opencode-ai/core/schema"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { sniffAttachmentMime } from "@/util/media"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import path from "node:path"
import { fileURLToPath } from "node:url"

const ProjectVcs = Schema.Literal("git")

const MAX_ICON_BYTES = 512 * 1024
const MAX_ICON_DATA_URL_LENGTH = Math.ceil(MAX_ICON_BYTES / 3) * 4 + 32
const MAX_ICON_DIMENSION = 4096
const MAX_ICON_PIXELS = 16_777_216
const ALLOWED_ICON_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const ProjectIcon = Schema.Struct({
  url: optionalOmitUndefined(Schema.String.check(Schema.isMaxLength(MAX_ICON_DATA_URL_LENGTH))),
  override: optionalOmitUndefined(Schema.String.check(Schema.isMaxLength(MAX_ICON_DATA_URL_LENGTH))),
  color: optionalOmitUndefined(Schema.String),
})

const ProjectCommands = Schema.Struct({
  start: optionalOmitUndefined(
    Schema.String.annotate({ description: "Startup script to run when creating a new workspace (worktree)" }),
  ),
})

const ProjectTime = Schema.Struct({
  created: NonNegativeInt,
  updated: NonNegativeInt,
  initialized: optionalOmitUndefined(NonNegativeInt),
})

export const Info = Schema.Struct({
  id: ProjectV2.ID,
  worktree: Schema.String,
  vcs: optionalOmitUndefined(ProjectVcs),
  name: optionalOmitUndefined(Schema.String),
  icon: optionalOmitUndefined(ProjectIcon),
  commands: optionalOmitUndefined(ProjectCommands),
  time: ProjectTime,
  sandboxes: Schema.Array(Schema.String),
}).annotate({ identifier: "Project" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Event = {
  Updated: EventV2.define({ type: "project.updated", schema: Info.fields }),
}

type Row = typeof ProjectTable.$inferSelect

export function fromRow(row: Row): Info {
  const icon =
    row.icon_url || row.icon_url_override || row.icon_color
      ? {
          url: row.icon_url ?? undefined,
          override: row.icon_url_override ?? undefined,
          color: row.icon_color ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs ? Schema.decodeUnknownSync(ProjectVcs)(row.vcs) : undefined,
    name: row.name ?? undefined,
    icon,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      initialized: row.time_initialized ?? undefined,
    },
    sandboxes: row.sandboxes,
    commands: row.commands ?? undefined,
  }
}

export const UpdateInput = Schema.Struct({
  projectID: ProjectV2.ID,
  name: Schema.optional(Schema.String),
  icon: Schema.optional(ProjectIcon),
  commands: Schema.optional(ProjectCommands),
})
export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  icon: Schema.optional(ProjectIcon),
  commands: Schema.optional(ProjectCommands),
}).annotate({ identifier: "ProjectUpdateInput" })
export type UpdatePayload = Types.DeepMutable<Schema.Schema.Type<typeof UpdatePayload>>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Project.NotFoundError", {
  projectID: ProjectV2.ID,
}) {}

export class InvalidIconError extends Schema.TaggedErrorClass<InvalidIconError>()("Project.InvalidIconError", {
  reason: Schema.String,
  field: Schema.optional(Schema.String),
}) {}

export function validateIconBytes(
  bytes: Uint8Array,
  maxBytes = MAX_ICON_BYTES,
  declaredMime?: string,
  field = "icon.override",
): InvalidIconError | void {
  if (bytes.length > maxBytes) return new InvalidIconError({ reason: "icon_too_large", field })
  const sniffed = sniffAttachmentMime(bytes, "")
  if (!sniffed || !ALLOWED_ICON_MIMES.has(sniffed))
    return new InvalidIconError({ reason: "unrecognized_image_format", field })
  if (declaredMime && declaredMime !== sniffed) return new InvalidIconError({ reason: "image_mime_mismatch", field })
  const dimensions = readIconDimensions(bytes, sniffed)
  if (!dimensions) return new InvalidIconError({ reason: "invalid_image", field })
  if (
    dimensions.width > MAX_ICON_DIMENSION ||
    dimensions.height > MAX_ICON_DIMENSION ||
    dimensions.width * dimensions.height > MAX_ICON_PIXELS
  )
    return new InvalidIconError({ reason: "icon_dimensions_too_large", field })
}

const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function validateIconDataUrl(value: string | undefined, field = "icon.override") {
  if (!value) return Effect.succeed<InvalidIconError | void>(undefined)
  if (value.length > MAX_ICON_DATA_URL_LENGTH)
    return Effect.succeed<InvalidIconError | void>(new InvalidIconError({ reason: "icon_too_large", field }))
  const match = DATA_URL_RE.exec(value)
  if (!match || !BASE64_RE.test(match[2]))
    return Effect.succeed<InvalidIconError | void>(new InvalidIconError({ reason: "invalid_data_url", field }))
  const bytes = Buffer.from(match[2], "base64")
  const error = validateIconBytes(bytes, MAX_ICON_BYTES, match[1].toLowerCase(), field)
  if (error) return Effect.succeed<InvalidIconError | void>(error)
  return decodeIcon(bytes, field)
}

function validateIconUrl(value: string | undefined) {
  if (!value || value.startsWith("data:")) return validateIconDataUrl(value, "icon.url")
  const url = URL.canParse(value) ? new URL(value) : undefined
  if (url?.protocol === "https:") return Effect.succeed<InvalidIconError | void>(undefined)
  return Effect.succeed<InvalidIconError | void>(
    new InvalidIconError({ reason: "invalid_icon_url", field: "icon.url" }),
  )
}

function decodeIcon(bytes: Uint8Array, field: string) {
  return Effect.tryPromise(() => {
    ;(globalThis as typeof globalThis & { __DEVECO_PHOTON_WASM_PATH?: string }).__DEVECO_PHOTON_WASM_PATH =
      path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
    return import("@silvia-odwyer/photon-node")
  }).pipe(
    Effect.flatMap((photon) =>
      Effect.try({
        try: () => {
          const image = photon.PhotonImage.new_from_byteslice(bytes)
          image.free()
        },
        catch: () => new InvalidIconError({ reason: "invalid_image", field }),
      }),
    ),
    Effect.match({
      onFailure: (error) =>
        error instanceof InvalidIconError
          ? error
          : new InvalidIconError({ reason: "image_decoder_unavailable", field }),
      onSuccess: () => undefined,
    }),
  )
}

function readIconDimensions(bytes: Uint8Array, mime: string) {
  if (mime === "image/png") {
    if (bytes.length < 24 || ascii(bytes, 12, 16) !== "IHDR") return
    return { width: uint32(bytes, 16), height: uint32(bytes, 20) }
  }
  if (mime === "image/gif") {
    return readGifDimensions(bytes)
  }
  if (mime === "image/webp") return readWebpDimensions(bytes)
  return readJpegDimensions(bytes)
}

function readJpegDimensions(bytes: Uint8Array) {
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  for (let offset = 2; offset + 8 < bytes.length; ) {
    if (bytes[offset] !== 0xff) return
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset]
    if (frames.has(marker)) return { width: uint16(bytes, offset + 6), height: uint16(bytes, offset + 4) }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset++
      continue
    }
    const length = uint16(bytes, offset + 1)
    if (length < 2 || offset + 1 + length > bytes.length) return
    offset += 1 + length
  }
}

function readGifDimensions(bytes: Uint8Array) {
  if (bytes.length < 14) return
  let width = uint16le(bytes, 6)
  let height = uint16le(bytes, 8)
  let offset = 13 + ((bytes[10] & 0x80) === 0 ? 0 : 3 * 2 ** ((bytes[10] & 0x07) + 1))
  while (offset < bytes.length) {
    const marker = bytes[offset++]
    if (marker === 0x3b) return { width, height }
    if (marker === 0x21) {
      if (offset >= bytes.length) return
      offset = skipGifSubBlocks(bytes, offset + 1) ?? bytes.length
      continue
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return
    width = Math.max(width, uint16le(bytes, offset) + uint16le(bytes, offset + 4))
    height = Math.max(height, uint16le(bytes, offset + 2) + uint16le(bytes, offset + 6))
    const packed = bytes[offset + 8]
    offset += 9 + ((packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1))
    if (offset >= bytes.length) return
    offset = skipGifSubBlocks(bytes, offset + 1) ?? bytes.length
  }
}

function skipGifSubBlocks(bytes: Uint8Array, start: number) {
  for (let offset = start; offset < bytes.length; ) {
    const size = bytes[offset]
    if (size === 0) return offset + 1
    if (offset + 1 + size > bytes.length) return
    offset += 1 + size
  }
}

function readWebpDimensions(bytes: Uint8Array) {
  if (bytes.length < 30) return
  const kind = ascii(bytes, 12, 16)
  if (kind === "VP8X") return { width: 1 + uint24le(bytes, 24), height: 1 + uint24le(bytes, 27) }
  if (kind === "VP8L" && bytes[20] === 0x2f)
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    }
  if (kind === "VP8 " && ascii(bytes, 23, 26) === "\u009d\u0001*")
    return { width: uint16le(bytes, 26) & 0x3fff, height: uint16le(bytes, 28) & 0x3fff }
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function uint16(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function uint16le(bytes: Uint8Array, offset: number) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function uint24le(bytes: Uint8Array, offset: number) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

function uint32(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  /**
   * Per-instance setup. Subscribes to the `/init` slash command for the
   * current instance and stamps the project's initialized timestamp when it
   * fires. Subscription lifetime is tied to the per-instance state scope.
   */
  readonly init: () => Effect.Effect<void>
  readonly fromDirectory: (directory: string) => Effect.Effect<{ project: Info; sandbox: string }>
  readonly discover: (input: Info) => Effect.Effect<void, InvalidIconError>
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: ProjectV2.ID) => Effect.Effect<Info | undefined>
  readonly update: (input: UpdateInput) => Effect.Effect<Info, NotFoundError | InvalidIconError>
  readonly initGit: (input: { directory: string; project: Info }) => Effect.Effect<Info>
  readonly setInitialized: (id: ProjectV2.ID) => Effect.Effect<void>
  readonly sandboxes: (id: ProjectV2.ID) => Effect.Effect<string[]>
  readonly addSandbox: (id: ProjectV2.ID, directory: string) => Effect.Effect<void>
  readonly removeSandbox: (id: ProjectV2.ID, directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Project") {}

type GitResult = { code: number; text: string; stderr: string }

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const proc = yield* AppProcess.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const projectV2 = yield* ProjectV2.Service
    const projectDirectories = yield* ProjectDirectories.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const { db } = yield* Database.Service

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        const handle = yield* spawner.spawn(
          ChildProcess.make("git", args, { cwd: opts?.cwd, extendEnv: true, stdin: "ignore" }),
        )
        const [text, stderr] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
          { concurrency: 2 },
        )
        const code = yield* handle.exitCode
        return { code, text, stderr } satisfies GitResult
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed({ code: 1, text: "", stderr: "" } satisfies GitResult)),
    )

    const emitUpdated = (data: Info) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          project: data.id,
          payload: { type: Event.Updated.type, properties: data },
        }),
      )

    const fakeVcs = Schema.decodeUnknownSync(Schema.optional(ProjectVcs))(Flag.DEVECO_FAKE_VCS)

    const scope = yield* Scope.Scope

    const migrateProjectId = Effect.fn("Project.migrateProjectId")(function* (
      oldID: ProjectV2.ID | undefined,
      newID: ProjectV2.ID,
    ) {
      if (!oldID) return
      if (oldID === ProjectV2.ID.global) return
      if (oldID === newID) return

      yield* db
        .transaction(
          (d) =>
            Effect.gen(function* () {
              const oldProject = yield* d.select().from(ProjectTable).where(eq(ProjectTable.id, oldID)).get()
              const newProject = yield* d.select().from(ProjectTable).where(eq(ProjectTable.id, newID)).get()
              if (oldProject && !newProject) {
                yield* d
                  .insert(ProjectTable)
                  .values({
                    ...oldProject,
                    id: newID,
                    time_updated: Date.now(),
                  })
                  .run()
              }

              // Project directories may be shared across distinct
              // checkouts which have diverged. Clear the directory
              // list and rely on it being re-populated to ensure
              // accuracy
              yield* d.delete(ProjectDirectoryTable).where(eq(ProjectDirectoryTable.project_id, oldID)).run()

              yield* d
                .update(SessionTable)
                .set({ project_id: newID, time_updated: sql`${SessionTable.time_updated}` })
                .where(eq(SessionTable.project_id, oldID))
                .run()
              yield* d
                .update(WorkspaceTable)
                .set({ project_id: newID })
                .where(eq(WorkspaceTable.project_id, oldID))
                .run()

              if (oldProject) yield* d.delete(ProjectTable).where(eq(ProjectTable.id, oldID)).run()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const saveProjectDirectory = Effect.fn("Project.saveProjectDirectory")(function* (input: {
      projectID: ProjectV2.ID
      directory: string
    }) {
      if (input.projectID === ProjectV2.ID.global) return
      const opened = AbsolutePath.make(FSUtil.resolve(input.directory))
      yield* projectDirectories
        .create({
          directory: opened,
          projectID: input.projectID,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project directory persistence failed", { projectID: input.projectID, cause }),
          ),
        )
    })

    // Port of opencode's markerless adoption (upstream dev): when a directory
    // gains a VCS identity, the directory-keyed ("markerless", vcs-null)
    // projects whose worktree now resolves into it are adopted, and their
    // sessions follow the resolved identity. The global transit — an empty
    // repo with no remote and no commits — is a legitimate destination: the
    // sessions follow it there, and move on once a remote or root commit
    // gives the repo a stable identity.
    const adoptInto = Effect.fn("Project.adoptInto")(function* (
      projectID: ProjectV2.ID,
      directory: string,
      previous: ProjectV2.ID | undefined,
    ) {
      const range = { lo: AbsolutePath.make(directory), hi: AbsolutePath.make(directory + "\uffff") }
      const markerless = yield* db
        .select({ id: ProjectTable.id, worktree: ProjectTable.worktree })
        .from(ProjectTable)
        .where(
          and(
            isNull(ProjectTable.vcs),
            ne(ProjectTable.id, projectID),
            gte(ProjectTable.worktree, range.lo),
            lte(ProjectTable.worktree, range.hi),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const adopted = yield* Effect.filter(markerless, (candidate) =>
        Effect.gen(function* () {
          const found = yield* fs
            .up({ targets: [".git"], start: candidate.worktree, stop: directory })
            .pipe(Effect.orElseSucceed(() => [] as string[]))
          if (!found[0]) return false
          return path.resolve(path.dirname(found[0])) === path.resolve(directory)
        }),
      )
      const sources = [
        ...new Set([previous ?? ProjectV2.ID.global, ProjectV2.ID.global, ...adopted.map((row) => row.id)]),
      ].filter((id) => id !== projectID)
      if (sources.length === 0) return
      yield* db
        .update(SessionTable)
        .set({ project_id: projectID, time_updated: sql`${SessionTable.time_updated}` })
        .where(
          and(
            inArray(SessionTable.project_id, sources),
            isNull(SessionTable.workspace_id),
            or(
              adopted.length ? inArray(SessionTable.project_id, adopted.map((row) => row.id)) : undefined,
              and(gte(SessionTable.directory, range.lo), lte(SessionTable.directory, range.hi)),
            ),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const fromDirectory = Effect.fn("Project.fromDirectory")(function* (directory: string) {
      yield* Effect.logInfo("fromDirectory", { directory: sanitizePath(directory) })

      const data = yield* projectV2.resolve(AbsolutePath.make(directory))
      const worktree = data.id === ProjectV2.ID.make("global") && !data.vcs ? "/" : data.directory

      // Phase 2: upsert
      const projectID = ProjectV2.ID.make(data.id)
      yield* migrateProjectId(data.previous ? ProjectV2.ID.make(data.previous) : undefined, projectID)
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get().pipe(Effect.orDie)
      const existing = row
        ? fromRow(row)
        : {
            id: projectID,
            worktree,
            vcs: data.vcs?.type ?? fakeVcs,
            sandboxes: [] as string[],
            time: { created: Date.now(), updated: Date.now() },
          }

      if (flags.experimentalIconDiscovery) yield* discover(existing).pipe(Effect.ignore, Effect.forkIn(scope))

      const result: Info = {
        ...existing,
        worktree: projectID === ProjectV2.ID.global ? worktree : existing.worktree,
        vcs: data.vcs?.type ?? fakeVcs,
        time: { ...existing.time, updated: Date.now() },
      }
      if (
        projectID !== ProjectV2.ID.global &&
        data.directory !== result.worktree &&
        !result.sandboxes.includes(data.directory)
      )
        result.sandboxes.push(data.directory)
      result.sandboxes = yield* Effect.forEach(
        result.sandboxes,
        (s) =>
          fs.exists(s).pipe(
            Effect.orDie,
            Effect.map((exists) => (exists ? s : undefined)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))

      yield* db
        .insert(ProjectTable)
        .values({
          id: result.id,
          worktree: AbsolutePath.make(result.worktree),
          vcs: result.vcs ?? null,
          name: result.name,
          icon_url: result.icon?.url,
          icon_url_override: result.icon?.override,
          icon_color: result.icon?.color,
          time_created: result.time.created,
          time_updated: result.time.updated,
          time_initialized: result.time.initialized,
          sandboxes: result.sandboxes.map((sandbox) => AbsolutePath.make(sandbox)),
          commands: result.commands,
        })
        .onConflictDoUpdate({
          target: ProjectTable.id,
          set: {
            worktree: AbsolutePath.make(result.worktree),
            vcs: result.vcs ?? null,
            name: result.name,
            icon_url: result.icon?.url,
            icon_url_override: result.icon?.override,
            icon_color: result.icon?.color,
            time_updated: result.time.updated,
            time_initialized: result.time.initialized,
            sandboxes: result.sandboxes.map((sandbox) => AbsolutePath.make(sandbox)),
            commands: result.commands,
          },
        })
        .run()
        .pipe(Effect.orDie)

      // Supersedes the exact-directory global-to-project move: sessions from
      // the previous identity, the global transit, or an adopted markerless
      // project follow the resolved identity when their directory is inside
      // the resolved worktree (or unconditionally once their project was
      // adopted, mirroring upstream's session projector).
      yield* adoptInto(projectID, data.directory, data.previous ? ProjectV2.ID.make(data.previous) : undefined)

      yield* saveProjectDirectory({
        projectID,
        directory: data.directory,
      })

      yield* emitUpdated(result)
      if (projectID !== ProjectV2.ID.global && data.vcs?.type === "git") {
        yield* projectV2.commit({ store: data.vcs.store, id: data.id })
      }
      return { project: result, sandbox: data.vcs ? data.directory : worktree }
    })

    const discover = Effect.fn("Project.discover")(function* (input: Info) {
      if (input.vcs !== "git") return
      if (input.icon?.override) return
      if (input.icon?.url) return

      const matches = yield* fs
        .glob("**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
          cwd: input.worktree,
          absolute: true,
          include: "file",
        })
        .pipe(Effect.orDie)
      const shortest = matches.sort((a, b) => a.length - b.length)[0]
      if (!shortest) return

      const stat = yield* fs.stat(shortest).pipe(Effect.orDie)
      if (stat.size > MAX_ICON_BYTES) return

      const buffer = yield* fs.readFile(shortest).pipe(Effect.orDie)
      const bytes = new Uint8Array(buffer)
      const mime = sniffAttachmentMime(bytes, "")
      if (validateIconBytes(bytes, MAX_ICON_BYTES, mime)) return
      if (yield* decodeIcon(bytes, "icon.url")) return

      const base64 = Buffer.from(buffer).toString("base64")
      const url = `data:${mime};base64,${base64}`
      yield* update({ projectID: input.id, icon: { url } }).pipe(
        Effect.catchTag("Project.NotFoundError", () => Effect.void),
      )
    })

    const list = Effect.fn("Project.list")(function* () {
      return (yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)).map(fromRow)
    })

    const get = Effect.fn("Project.get")(function* (id: ProjectV2.ID) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const update = Effect.fn("Project.update")(function* (input: UpdateInput) {
      const overrideError = yield* validateIconDataUrl(input.icon?.override)
      const urlError = yield* validateIconUrl(input.icon?.url)
      const iconError = overrideError ?? urlError
      if (iconError) yield* iconError

      const result = yield* db
        .update(ProjectTable)
        .set({
          name: input.name,
          icon_url: input.icon?.url,
          icon_url_override: input.icon?.override,
          icon_color: input.icon?.color,
          commands: input.commands,
          time_updated: Date.now(),
        })
        .where(eq(ProjectTable.id, input.projectID))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!result) return yield* new NotFoundError({ projectID: input.projectID })
      const data = fromRow(result)
      yield* emitUpdated(data)
      return data
    })

    const initGit = Effect.fn("Project.initGit")(function* (input: { directory: string; project: Info }) {
      if (input.project.vcs === "git") return input.project
      if (!(yield* Effect.sync(() => which("git")))) throw new Error("Git is not installed")
      const result = yield* git(["init", "--quiet"], { cwd: input.directory })
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.text.trim() || "Failed to initialize git repository")
      }
      const { project } = yield* fromDirectory(input.directory)
      return project
    })

    const setInitialized = Effect.fn("Project.setInitialized")(function* (id: ProjectV2.ID) {
      yield* db
        .update(ProjectTable)
        .set({ time_initialized: Date.now() })
        .where(eq(ProjectTable.id, id))
        .run()
        .pipe(Effect.orDie)
    })

    const initState = yield* InstanceState.make(
      Effect.fn("Project.initState")(function* (ctx) {
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Command.Event.Executed.type || event.location?.directory !== ctx.directory)
            return Effect.void
          const data = event.data as EventV2.Data<typeof Command.Event.Executed>
          return data.name === Command.Default.INIT ? setInitialized(ctx.project.id) : Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
      }),
    )

    const init = Effect.fn("Project.init")(function* () {
      yield* InstanceState.get(initState)
    })

    const sandboxes = Effect.fn("Project.sandboxes")(function* (id: ProjectV2.ID) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return []
      const data = fromRow(row)
      return yield* Effect.forEach(
        data.sandboxes,
        (dir) =>
          fs.isDir(dir).pipe(
            Effect.orDie,
            Effect.map((ok) => (ok ? dir : undefined)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((arr) => arr.filter((x): x is string => x !== undefined)))
    })

    const addSandbox = Effect.fn("Project.addSandbox")(function* (id: ProjectV2.ID, directory: string) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      if (!row) throw new Error(`Project not found: ${id}`)
      const sandbox = AbsolutePath.make(directory)
      const sboxes = [...row.sandboxes]
      if (!sboxes.includes(sandbox)) sboxes.push(sandbox)
      const result = yield* db
        .update(ProjectTable)
        .set({ sandboxes: sboxes, time_updated: Date.now() })
        .where(eq(ProjectTable.id, id))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!result) throw new Error(`Project not found: ${id}`)
      yield* emitUpdated(fromRow(result))
    })

    const removeSandbox = Effect.fn("Project.removeSandbox")(function* (id: ProjectV2.ID, directory: string) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
      if (!row) throw new Error(`Project not found: ${id}`)
      const sandbox = AbsolutePath.make(directory)
      const sboxes = row.sandboxes.filter((s) => s !== sandbox)
      const result = yield* db
        .update(ProjectTable)
        .set({ sandboxes: sboxes, time_updated: Date.now() })
        .where(eq(ProjectTable.id, id))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!result) throw new Error(`Project not found: ${id}`)
      yield* emitUpdated(fromRow(result))
    })

    return Service.of({
      init,
      fromDirectory,
      discover,
      list,
      get,
      update,
      initGit,
      setInitialized,
      sandboxes,
      addSandbox,
      removeSandbox,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.provide(ProjectDirectories.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export const use = serviceUse(Service)

export const node = LayerNode.make(layer, [
  FSUtil.node,
  AppProcess.node,
  CrossSpawnSpawner.node,
  ProjectV2.node,
  ProjectDirectories.node,
  EventV2Bridge.node,
  RuntimeFlags.node,
  Database.node,
])

export * as Project from "./project"
