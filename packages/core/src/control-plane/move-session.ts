export * as MoveSession from "./move-session"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { DirectoryUnavailableError } from "../project/copy"
import { ProjectTable } from "../project/sql"
import { sanitizePath } from "../sanitize-path"
import { SessionV2 } from "../session"
import { SessionExecution } from "../session/execution"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { AbsolutePath, RelativePath } from "../schema"
import path from "path"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

export class DestinationProjectMismatchError extends Schema.TaggedErrorClass<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: ProjectV2.ID,
    actual: ProjectV2.ID,
  },
) {}

export class ApplyChangesError extends Schema.TaggedErrorClass<ApplyChangesError>()("MoveSession.ApplyChangesError", {
  message: Schema.String,
}) {}

export class CaptureChangesError extends Schema.TaggedErrorClass<CaptureChangesError>()(
  "MoveSession.CaptureChangesError",
  {
    message: Schema.String,
  },
) {}

export class ResetSourceChangesError extends Schema.TaggedErrorClass<ResetSourceChangesError>()(
  "MoveSession.ResetSourceChangesError",
  {
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export type Error =
  | SessionV2.NotFoundError
  // Reused from `ProjectCopy` on purpose: copying a project and moving a session both mean "this
  // directory cannot be used", and one class keeps the wire shape and the client messages
  // identical. The tag is never exposed to the caller (the HTTP layer maps it to a message).
  | DirectoryUnavailableError
  | DestinationProjectMismatchError
  | CaptureChangesError
  | ApplyChangesError
  | ResetSourceChangesError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ControlPlaneMoveSession") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const events = yield* EventV2.Service
    const project = yield* ProjectV2.Service
    const session = yield* SessionV2.Service

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      const current = yield* session.get(input.sessionID)
      const directory = AbsolutePath.make(input.destination.directory)

      // The destination has to be usable: `project.resolve` derives the project identity from
      // what it finds on disk, so a vanished path would silently resolve to a `dir:` hash, get a
      // project row inserted for a worktree that is not there, and leave the session pointing at
      // a directory no process can boot. A directory that merely cannot be read is refused for
      // the same reason (see `FSUtil.checkDir`): rewriting the session over a permission problem
      // is worse than telling the user to fix the directory.
      //
      // This runs before the same-directory shortcut on purpose: a destination that vanished is
      // an error even when it is also the directory the session already points at, otherwise the
      // caller would be told the move succeeded while the session still cannot be opened.
      if ((yield* fs.checkDir(directory)) !== "available") return yield* new DirectoryUnavailableError({ directory })
      if (current.location.directory === directory) return

      // An unreadable source is refused rather than treated as deleted: the directory is still
      // there and the user may get access back, so crossing projects on the strength of a
      // failed stat would move the user's session out from under a perfectly usable checkout.
      //
      // This also has to run before `project.resolve`, which walks up the tree looking for a
      // repository — the very walk that fails on a directory nobody may read.
      const sourceState = yield* fs.checkDir(current.location.directory)
      if (sourceState === "unreadable") {
        return yield* new DirectoryUnavailableError({ directory: current.location.directory })
      }
      const source = yield* project.resolve(current.location.directory)
      const destination = yield* project.resolve(directory)
      // A session outlives the directory it was created in: worktrees get deleted, and the user
      // then continues that session from another checkout. Once the directory is gone,
      // `project.resolve` has nothing left to derive an identity from and degrades to a `dir:`
      // hash of the vanished path, while the destination resolves to a real project. Refusing
      // the move would therefore strand the session on a directory that can never come back.
      // The check still applies to live directories: moving a session between two existing
      // projects would silently relocate an agent that is working in the other repository.
      const sourceExists = sourceState === "available"
      if (current.projectID !== destination.id) {
        if (sourceExists) {
          return yield* new DestinationProjectMismatchError({ expected: current.projectID, actual: destination.id })
        }
        yield* Effect.logWarning("moving session whose directory is missing into another project", {
          sessionID: input.sessionID,
          sourceDirectory: sanitizePath(current.location.directory),
          sourceProjectID: current.projectID,
          destinationProjectID: destination.id,
        })
        // `SessionTable.project_id` references `ProjectTable.id` and that row is written by the
        // app layer when a directory instance boots, so the move target normally has one. Make
        // it idempotent here anyway, exactly like `SessionV2.create`: the Moved event is already
        // durable when it is projected, and dying on a foreign key violation would leave the
        // session on the deleted directory with no way to recover it. A conflict means the
        // destination is an existing project that resolves to the same id; its row keeps the
        // worktree it was created with, which is the intended trade: the id already names the
        // project, and a session move does not get to rewrite where a project lives.
        yield* db
          .insert(ProjectTable)
          .values({ id: destination.id, worktree: destination.directory, vcs: destination.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }

      // Capturing changes requires the source working tree to exist: every git command runs with
      // the source directory as cwd, so patching would fail with ENOENT and abort the move with
      // CaptureChangesError even though only the session location has to be rewritten. Skip the
      // whole transfer (including the source reset below) when the tree is already gone.
      const patch =
        input.moveChanges && sourceExists && source.directory !== destination.directory
          ? yield* git
              .patch(current.location.directory)
              .pipe(Effect.mapError((error) => new CaptureChangesError({ message: error.message })))
          : ""
      if (patch) {
        yield* git
          .applyPatch({ directory, patch })
          .pipe(Effect.mapError((error) => new ApplyChangesError({ message: error.message })))
      }

      const relative = path.relative(destination.directory, directory).replaceAll("\\", "/")

      // The workspace binding belongs to the session's storage rather than to its directory, so
      // carry it over instead of dropping it on the new location — but only within the same
      // project: workspaces are project-scoped (`WorkspaceTable.project_id`), so keeping a
      // binding across a project move would point the session at a workspace that no longer
      // belongs to it. `projectID` travels with the event because the projection has to move the
      // session into the destination project, which for a missing source directory is not
      // derivable from the old project id.
      yield* events.publish(SessionEvent.Moved, {
        sessionID: input.sessionID,
        location: Location.Ref.make({
          directory,
          workspaceID: current.projectID === destination.id ? current.location.workspaceID : undefined,
        }),
        projectID: destination.id,
        // Moving into the project root has no subdirectory; an empty string would be a different
        // value in the event payload while reading it back yields `undefined` anyway.
        subdirectory: relative !== "" ? RelativePath.make(relative) : undefined,
        timestamp: yield* DateTime.now,
      })

      if (patch) {
        yield* git.softResetChanges(current.location.directory).pipe(
          Effect.mapError(
            (error) =>
              new ResetSourceChangesError({
                directory: current.location.directory,
                message: error.message,
                cause: error.cause,
              }),
          ),
        )
      }
    })

    return Service.of({ moveSession })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionV2.defaultLayer),
)
