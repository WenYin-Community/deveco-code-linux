import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { sanitizePath } from "@opencode-ai/core/sanitize-path"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import {
  DirectoryUnreadableError,
  ForbiddenError,
  InvalidRequestError,
  SessionDirectoryMissingError,
  SessionNotFoundError,
} from "../errors"
import type { LocationServices } from "../groups/location"

/** Optional deployment policy; the standalone server has no product account requirement. */
export const SessionAdmission = Context.Reference<() => Promise<void>>("@opencode/SessionAdmission", {
  defaultValue: () => async () => {},
})

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  {
    provides: LocationServices
  }
>()("@opencode/HttpApiSessionLocation", {
  error: [
    DirectoryUnreadableError,
    ForbiddenError,
    InvalidRequestError,
    SessionDirectoryMissingError,
    SessionNotFoundError,
  ],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(SessionV2.ID)

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service
    const locations = yield* LocationServiceMap
    const admit = yield* SessionAdmission

    // Draining a rejected request body lets the HTTP connection be reused after an error answer.
    const drain = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      yield* request.arrayBuffer.pipe(Effect.ignore)
    })

    // Every rejection in this middleware goes through here: the request body is unread when a
    // handler is never reached, and leaving it that way strands the connection.
    const rejection = <E>(error: E) => drain.pipe(Effect.andThen(Effect.fail(error)))

    return SessionLocationMiddleware.of((effect, options) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const sessionID = yield* decodeSessionID(route.params.sessionID).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                message: "Invalid session ID",
                field: "sessionID",
              }),
          ),
          Effect.catch((error) => rejection(error)),
        )
        const row = yield* db
          .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) {
          return yield* rejection(
            new SessionNotFoundError({
              sessionID,
              message: `Session not found: ${sessionID}`,
            }),
          )
        }

        if (options.endpoint.name === "session.prompt") {
          yield* Effect.tryPromise({
            try: admit,
            catch: (error) =>
              new ForbiddenError({ message: error instanceof Error ? error.message : "Product setup required" }),
          }).pipe(Effect.catch((error) => rejection(error)))
        }

        // Booting the location services calls fs.realPath on the directory and dies when it
        // is gone, so reject a missing directory here to keep the failure typed. A directory
        // that cannot be inspected is a different failure and must not be reported as missing:
        // the client would then offer to migrate the session somewhere else, a data move based
        // on a permission problem.
        const state = yield* fs.checkDir(row.directory)
        if (state !== "available") {
          yield* Effect.logWarning(
            state === "missing" ? "session directory is missing" : "session directory cannot be read",
            { sessionID, directory: sanitizePath(row.directory) },
          )
          return yield* rejection(
            state === "missing"
              ? new SessionDirectoryMissingError({
                  sessionID,
                  directory: row.directory,
                  message: `The session working directory no longer exists: ${row.directory}`,
                })
              : new DirectoryUnreadableError({
                  directory: row.directory,
                  message: `The session working directory cannot be read: ${row.directory}`,
                }),
          )
        }

        return yield* effect.pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory: AbsolutePath.make(row.directory),
                workspaceID: row.workspaceID ? WorkspaceV2.ID.make(row.workspaceID) : undefined,
              }),
            ),
          ),
        )
      }),
    )
  }),
).pipe(Layer.provide(FSUtil.defaultLayer))
