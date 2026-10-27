import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@opencode-ai/core/git"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { DirectoryUnavailableError } from "@opencode-ai/core/project/copy"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const directories = ProjectDirectories.layer.pipe(Layer.provide(database), Layer.provide(events))
const projector = SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events))
const project = Project.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(directories),
)
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(events),
  Layer.provide(project),
  Layer.provide(store),
  Layer.provide(SessionExecution.noopLayer),
)
const layer = MoveSession.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(events),
  Layer.provide(project),
  Layer.provide(sessions),
)
const it = testEffect(
  Layer.mergeAll(layer, database, events, directories, project, projector, store, SessionExecution.noopLayer, sessions),
)

function abs(input: string) {
  return AbsolutePath.make(input)
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.autocrlf false`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await fs.writeFile(path.join(directory, "tracked.txt"), "initial\n")
  await $`git add tracked.txt`.cwd(directory).quiet()
  await $`git commit -m root`.cwd(directory).quiet()
}

// `initRepo` gives every repository the same tree, author and commit message, so two of them can
// resolve to the same root-commit hash (and therefore the same project id) when they are created
// within the same second. A distinct remote per repository keeps the project ids apart.
async function initRepoWithRemote(directory: string, remote: string) {
  await initRepo(directory)
  await $`git remote add origin ${remote}`.cwd(directory).quiet()
}

// `session_message` stores the encoded message beside the columns that hold `id`, `type` and
// `session_id`, so build the row exactly the way the projector does instead of hand-writing the
// JSON payload: the history is only meaningful if it decodes back into the message it came from.
function messageRow(
  sessionID: SessionV2.ID,
  message: SessionMessage.Message,
  seq: number,
): typeof SessionMessageTable.$inferInsert {
  const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
  return {
    id: SessionMessage.ID.make(id),
    session_id: sessionID,
    type,
    seq,
    time_created: DateTime.toEpochMillis(message.time.created),
    data,
  }
}

describe("MoveSession", () => {
  it.live("moves session changes to another project directory", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(`${root.path}-move-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(root.path).quiet())
      const moved = abs(yield* Effect.promise(() => fs.realpath(destination)))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "new\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move",
          directory: source,
          title: "move",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved }, moveChanges: true }),
      )

      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("initial\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(source, "untracked.txt")).exists())).toBe(false)
      expect(
        yield* db
          .select({ directory: SessionTable.directory, path: SessionTable.path })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
        // The destination is the project root itself, so there is no subdirectory: null, not "".
      ).toEqual({ directory: moved, path: null })
    }),
  )

  it.live("moves within a checkout without transferring existing changes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = abs(path.join(source, "packages"))
      yield* Effect.promise(() => fs.mkdir(destination))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "new\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_nested")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-nested",
          directory: source,
          title: "move nested",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: destination }, moveChanges: true }),
      )

      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(
        yield* db
          .select({ directory: SessionTable.directory, path: SessionTable.path })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: destination, path: "packages" })
    }),
  )

  it.live("moves nested session changes without cleaning unrelated files", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const sourceDirectory = abs(path.join(source, "packages"))
      yield* Effect.promise(() => fs.mkdir(sourceDirectory))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "tracked.txt"), "initial\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "staged.txt"), "initial\n"))
      yield* Effect.promise(() => $`git add packages/tracked.txt packages/staged.txt`.cwd(source).quiet())
      yield* Effect.promise(() => $`git commit -m packages`.cwd(source).quiet())
      const destination = abs(`${root.path}-move-nested-destination`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destination, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${destination} HEAD`.cwd(source).quiet())
      const moved = abs(path.join(yield* Effect.promise(() => fs.realpath(destination)), "packages"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "tracked.txt"), "changed\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "staged.txt"), "staged\n"))
      yield* Effect.promise(() => $`git add packages/staged.txt`.cwd(source).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(sourceDirectory, "untracked.txt"), "new\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "unrelated\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(source, "untracked.txt"), "unrelated\n"))

      const projectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_nested_checkout")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-nested-checkout",
          directory: sourceDirectory,
          title: "move nested checkout",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: moved }, moveChanges: true }),
      )

      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "tracked.txt"), "utf8"))).toBe("changed\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "staged.txt"), "utf8"))).toBe("staged\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(moved, "untracked.txt"), "utf8"))).toBe("new\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(sourceDirectory, "tracked.txt"), "utf8"))).toBe(
        "initial\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(sourceDirectory, "untracked.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => fs.readFile(path.join(sourceDirectory, "staged.txt"), "utf8"))).toBe(
        "staged\n",
      )
      expect(yield* Effect.promise(() => $`git status --porcelain -- packages/staged.txt`.cwd(source).text())).toBe(
        "M  packages/staged.txt\n",
      )
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "tracked.txt"), "utf8"))).toBe("unrelated\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(source, "untracked.txt"), "utf8"))).toBe("unrelated\n")
    }),
  )

  // A deleted working directory used to make the session unreachable: the server answered 409
  // SessionDirectoryMissingError and the only recovery the TUI offered ("continue") opened an
  // empty session, so the history was effectively thrown away. The move below is that recovery:
  // the same session id, its messages and its workspace are carried over to the directory the
  // user is working from, and its owning project follows, because the vanished directory never
  // had more than a placeholder project id derived from its own path.
  it.live("moves a session out of a deleted working directory into the current project", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepoWithRemote(root.path, "https://example.test/missing-source.git"))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))

      const currentPath = `${root.path}-move-current`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(currentPath, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => fs.mkdir(currentPath))
      yield* Effect.promise(() => initRepoWithRemote(currentPath, "https://example.test/current-project.git"))
      const current = abs(yield* Effect.promise(() => fs.realpath(currentPath)))

      const sourceProjectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const destinationProjectID = (yield* Project.Service.use((service) => service.resolve(current))).id
      expect(destinationProjectID).not.toBe(sourceProjectID)

      const sessionID = SessionV2.ID.make("ses_move_missing_directory")
      const workspaceID = WorkspaceV2.ID.make("wrk_move_missing_directory")
      const historyID = SessionMessage.ID.make("msg_move_missing_directory")
      const { db } = yield* Database.Service
      // The project and session rows outlive the checkout, which is what keeps an old session
      // listable and openable after its directory is deleted.
      yield* db
        .insert(ProjectTable)
        .values({ id: sourceProjectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: sourceProjectID,
          workspace_id: workspaceID,
          slug: "move-missing-directory",
          directory: source,
          title: "move missing directory",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      const history = new SessionMessage.Synthetic({
        id: historyID,
        sessionID,
        type: "synthetic",
        text: "history that has to survive the move",
        time: { created: DateTime.makeUnsafe(1) },
      })
      yield* db
        .insert(SessionMessageTable)
        .values([messageRow(sessionID, history, 0)])
        .run()
        .pipe(Effect.orDie)
      // The instance the session is opened from has already booted on `current`, so that project
      // row exists before the move; this is the shape of the real request.
      yield* db
        .insert(ProjectTable)
        .values({
          id: destinationProjectID,
          worktree: current,
          vcs: "git",
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* Effect.promise(() => fs.rm(source, { recursive: true, force: true }))

      // `moveChanges` stays true because that is what the TUI sends when the user asks to carry
      // changes along. There is no working tree left to capture, so the transfer has to be skipped
      // instead of failing the whole move on a missing source directory.
      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: current }, moveChanges: true }),
      )

      const moved = yield* SessionV2.Service.use((service) => service.get(sessionID))
      expect(moved.projectID).toBe(destinationProjectID)
      expect(moved.location.directory).toBe(current)
      // Workspaces are project-scoped (`WorkspaceTable.project_id`), so the binding cannot
      // survive a move into another project: keeping it would point the session at a
      // workspace of the project it just left.
      expect(moved.location.workspaceID).toBeUndefined()
      expect(moved.subpath).toBeUndefined()

      // Same session, same history: a session that was deleted and recreated would have cascaded
      // its messages and parts away with it.
      expect(yield* SessionV2.Service.use((service) => service.messages({ sessionID }))).toEqual([history])
      // Session lists are filtered by project, so a session left on the old project id would be
      // invisible from the directory it was just moved into.
      expect(
        (yield* SessionV2.Service.use((service) => service.list({ project: destinationProjectID }))).map(
          (info) => info.id,
        ),
      ).toEqual([sessionID])
    }),
  )

  // The destination project row is normally written by the app layer when a directory instance
  // boots. The move must still work when it is not there yet: the Moved event is durable before it
  // is projected, so dying on the foreign key would leave the session stranded on the deleted
  // directory with no way to recover it. `SessionV2.create` materializes the same row the same way.
  it.live("creates the destination project row when that directory was never opened", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepoWithRemote(root.path, "https://example.test/unopened-source.git"))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))

      const currentPath = `${root.path}-unopened-current`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(currentPath, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => fs.mkdir(currentPath))
      yield* Effect.promise(() => initRepoWithRemote(currentPath, "https://example.test/unopened-current.git"))
      const current = abs(yield* Effect.promise(() => fs.realpath(currentPath)))

      const sourceProjectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const destinationProjectID = (yield* Project.Service.use((service) => service.resolve(current))).id
      const sessionID = SessionV2.ID.make("ses_move_unopened_directory")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: sourceProjectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: sourceProjectID,
          slug: "move-unopened",
          directory: source,
          title: "move unopened",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() => fs.rm(source, { recursive: true, force: true }))

      yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: current }, moveChanges: true }),
      )

      expect(
        yield* db
          .select({ worktree: ProjectTable.worktree, vcs: ProjectTable.vcs })
          .from(ProjectTable)
          .where(eq(ProjectTable.id, destinationProjectID))
          .get(),
      ).toEqual({ worktree: current, vcs: "git" })
      expect(
        yield* db
          .select({ project_id: SessionTable.project_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ project_id: destinationProjectID })
    }),
  )

  // The relaxation above only covers directories that are gone. Relocating a live session into a
  // different project would move an agent that is working in another repository, so it stays an
  // error and nothing about the session must change.
  it.live("rejects moving a session between two live project directories", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepoWithRemote(root.path, "https://example.test/live-source.git"))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))

      const destinationPath = `${root.path}-live-destination`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(destinationPath, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => fs.mkdir(destinationPath))
      yield* Effect.promise(() => initRepoWithRemote(destinationPath, "https://example.test/live-destination.git"))
      const destination = abs(yield* Effect.promise(() => fs.realpath(destinationPath)))

      const sourceProjectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_live_directory")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: sourceProjectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: sourceProjectID,
          slug: "move-live",
          directory: source,
          title: "move live",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const error = yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: destination }, moveChanges: true }),
      ).pipe(Effect.flip)

      expect(error).toBeInstanceOf(MoveSession.DestinationProjectMismatchError)
      const unchanged = yield* SessionV2.Service.use((service) => service.get(sessionID))
      expect(unchanged.projectID).toBe(sourceProjectID)
      expect(unchanged.location.directory).toBe(source)
    }),
  )

  // Project identity is derived from the filesystem: resolving a directory that does not exist
  // yields a synthetic dir:<sha1> project instead of failing, so without this check the move
  // would insert a project row for a path nobody can open and rewrite the session into it.
  it.live("rejects moving a session into a directory that does not exist", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepoWithRemote(root.path, "https://example.test/gone-source.git"))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))
      const destination = `${root.path}-gone-destination`

      const sourceProjectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_gone_destination")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: sourceProjectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: sourceProjectID,
          slug: "move-gone-destination",
          directory: source,
          title: "move gone destination",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const error = yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: abs(destination) }, moveChanges: false }),
      ).pipe(Effect.flip)

      expect(error).toBeInstanceOf(DirectoryUnavailableError)
      // The error carries the requested path, not a resolved one: it does not exist.
      expect((error as DirectoryUnavailableError).directory).toBe(abs(destination))
      const unchanged = yield* SessionV2.Service.use((service) => service.get(sessionID))
      expect(unchanged.projectID).toBe(sourceProjectID)
      expect(unchanged.location.directory).toBe(source)
    }),
  )

  // The same-directory shortcut used to run before the destination check, so a session asked to
  // move onto the very directory it already points at was reported as moved even when that
  // directory was gone: recovery would clear its dialog and leave the user on a session that
  // still cannot be opened. The destination is validated first now, and that includes this case.
  it.live("rejects a move onto the session's own deleted directory", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepoWithRemote(root.path, "https://example.test/self-move.git"))
      const source = abs(yield* Effect.promise(() => fs.realpath(root.path)))

      const sourceProjectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_onto_itself")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: sourceProjectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: sourceProjectID,
          slug: "move-onto-itself",
          directory: source,
          title: "move onto itself",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() => fs.rm(source, { recursive: true, force: true }))

      const error = yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: source }, moveChanges: false }),
      ).pipe(Effect.flip)

      expect(error).toBeInstanceOf(DirectoryUnavailableError)
      expect((error as DirectoryUnavailableError).directory).toBe(source)
      const unchanged = yield* SessionV2.Service.use((service) => service.get(sessionID))
      expect(unchanged.projectID).toBe(sourceProjectID)
      expect(unchanged.location.directory).toBe(source)
    }),
  )

  // An unreadable directory is not a deleted one: the checkout is still there and the user may get
  // access back. Treating it as deleted would let the session cross into another project on the
  // strength of a failed stat, so the move is refused instead of silently relocating the agent.
  it.live("refuses to move a session out of a directory it cannot read", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      // Permissions do not stop root, so the state under test is unreachable there.
      if (process.getuid?.() === 0) return

      const parent = path.join(root.path, "locked")
      yield* Effect.promise(() => fs.mkdir(parent))
      const sourcePath = path.join(parent, "checkout")
      yield* Effect.promise(() => fs.mkdir(sourcePath))
      yield* Effect.promise(() => initRepoWithRemote(sourcePath, "https://example.test/unreadable-source.git"))
      const source = abs(yield* Effect.promise(() => fs.realpath(sourcePath)))

      const destinationPath = path.join(root.path, "destination")
      yield* Effect.promise(() => fs.mkdir(destinationPath))
      yield* Effect.promise(() =>
        initRepoWithRemote(destinationPath, "https://example.test/unreadable-destination.git"),
      )
      const destination = abs(yield* Effect.promise(() => fs.realpath(destinationPath)))

      const sourceProjectID = (yield* Project.Service.use((service) => service.resolve(source))).id
      const sessionID = SessionV2.ID.make("ses_move_unreadable_source")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: sourceProjectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: sourceProjectID,
          slug: "move-unreadable",
          directory: source,
          title: "move unreadable",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      // Lock the parent, not the checkout: the session directory itself has to stay a directory.
      // The finalizer restores the mode first, otherwise the temporary directory cannot be removed.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.chmod(parent, 0o755)).pipe(
          Effect.andThen(Effect.promise(() => fs.rm(parent, { recursive: true, force: true }))),
          Effect.ignore,
        ),
      )
      yield* Effect.promise(() => fs.chmod(parent, 0o000))

      const error = yield* MoveSession.Service.use((service) =>
        service.moveSession({ sessionID, destination: { directory: destination }, moveChanges: false }),
      ).pipe(Effect.flip)

      expect(error).toBeInstanceOf(DirectoryUnavailableError)
      expect((error as DirectoryUnavailableError).directory).toBe(source)
      const unchanged = yield* SessionV2.Service.use((service) => service.get(sessionID))
      expect(unchanged.projectID).toBe(sourceProjectID)
      expect(unchanged.location.directory).toBe(source)
    }),
  )
})
