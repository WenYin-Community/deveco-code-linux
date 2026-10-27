import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { sanitizePath } from "@opencode-ai/core/sanitize-path"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { DirectoryUnreadableError, InvalidRequestError } from "../errors"

export const LocationQuery = Schema.Struct({
  location: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      workspace: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "LocationQuery" })

export const locationQueryOpenApi = OpenApi.annotations({
  transform: (operation) => {
    const parameters = operation.parameters
    if (!Array.isArray(parameters)) return operation
    return {
      ...operation,
      parameters: parameters.map((parameter) =>
        parameter?.name === "location" && parameter?.in === "query"
          ? { ...parameter, style: "deepObject", explode: true }
          : parameter,
      ),
    }
  },
})

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        workspaceID: location.workspaceID,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

export type LocationServices = Layer.Success<ReturnType<typeof LocationServiceMap.get>>

export class LocationMiddleware extends HttpApiMiddleware.Service<
  LocationMiddleware,
  {
    provides: LocationServices
  }
>()("@opencode/HttpApiLocation", {
  error: [DirectoryUnreadableError, InvalidRequestError],
}) {}

export const LocationGroup = HttpApiGroup.make("server.location")
  .add(
    HttpApiEndpoint.get("location.get", "/api/location", {
      query: LocationQuery,
      success: Location.Info,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.location.get",
          summary: "Get location",
          description: "Resolve the requested location or the server default location.",
        }),
      ),
  )
  .middleware(LocationMiddleware)

function ref(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-deveco-workspace"]
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-deveco-directory"] ? decode(request.headers["x-deveco-directory"]) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
    workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined,
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const locations = yield* LocationServiceMap
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const target = ref(request)
        // Booting the location services calls fs.realPath on the directory and dies when it is
        // gone, so reject an unknown directory here to keep the failure typed. A directory that
        // exists but cannot be inspected is reported as a server error instead of "missing": the
        // client must not act on a permission problem as if the path had been deleted.
        const state = yield* fs.checkDir(target.directory)
        if (state === "missing") {
          yield* Effect.logWarning("requested location directory is missing", {
            directory: sanitizePath(target.directory),
          })
          return yield* new InvalidRequestError({
            message: `The requested location directory no longer exists: ${target.directory}`,
            field: "location",
          })
        }
        if (state === "unreadable") {
          yield* Effect.logWarning("requested location directory cannot be read", {
            directory: sanitizePath(target.directory),
          })
          return yield* new DirectoryUnreadableError({
            directory: target.directory,
            message: `The requested location directory cannot be read: ${target.directory}`,
          })
        }
        return yield* effect.pipe(Effect.provide(locations.get(target)))
      }),
    )
  }),
).pipe(Layer.provide(FSUtil.defaultLayer))
